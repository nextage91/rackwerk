/**
 * mic-recorder — nimmt das Mikrofon als rohes, unkomprimiertes 32-Bit-
 * Float-WAV auf (für Sampler-Aufnahmen, s. machines/sampler.js), NICHT
 * über MediaRecorder: dessen verlustbehaftete Codecs (Opus/AAC, je nach
 * Browser mit knapper, für Sprachmemos statt Musik ausgelegter Standard-
 * Bitrate) klangen für Sample-Zwecke spürbar dumpfer/komprimierter, s.
 * Nutzer-Feedback. Läuft stattdessen über denselben geteilten AudioContext
 * wie der Rest der App (engine.ctx, s. audio-engine.js -- "eine App = ein
 * AudioContext") via createMediaStreamSource + ScriptProcessorNode:
 * AudioWorklet wäre der modernere Weg, bräuchte hier aber ein separat zu
 * ladendes Worklet-Modul (eigene Datei ausserhalb des Bundle-Mechanismus
 * von build-preview.py) -- für dieses kurze, nicht-echtzeitkritische
 * Capture-nur-in-den-Speicher genügt der einfachere, weiterhin unterstützte
 * ScriptProcessorNode völlig.
 *
 * Erster Ort im Code, der Mikrofon- (nicht Kamera-)Zugriff anfragt; der
 * Berechtigungsdialog erscheint beim ersten Aufruf. Deshalb ist start()
 * async: die Freigabe muss erst abgewartet werden, bevor der Capture-Pfad
 * überhaupt aufgebaut werden kann.
 */
import { engine } from './audio-engine.js';

/** Baut einen 32-Bit-Float-WAV-Blob (unkomprimiertes PCM, IEEE-Float-Tag 3)
 *  aus den gesammelten Mono-Callback-Blöcken -- bit-genau das, was der
 *  ScriptProcessorNode geliefert hat, keine Quantisierung/Kompression. */
function encodeWavFloat32(chunks, sampleRate) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const samples = new Float32Array(total);
  let o = 0;
  for (const c of chunks) { samples.set(c, o); o += c.length; }

  const BYTES_PER_SAMPLE = 4;
  const dataSize = samples.length * BYTES_PER_SAMPLE;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const writeStr = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);           // fmt-Chunk-Grösse
  view.setUint16(20, 3, true);            // Format-Tag 3 = IEEE Float
  view.setUint16(22, 1, true);            // 1 Kanal (Mono, s. start())
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * BYTES_PER_SAMPLE, true); // Byte-Rate
  view.setUint16(32, BYTES_PER_SAMPLE, true);              // Block-Align
  view.setUint16(34, BYTES_PER_SAMPLE * 8, true);          // Bits/Sample
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    view.setFloat32(offset, samples[i], true);
    offset += 4;
  }
  return new Blob([buf], { type: 'audio/wav' });
}

class MicRecorder {
  constructor() {
    this.stream = null;
    this.source = null;
    this.processor = null;
    this.silence = null;
    /** @type {Float32Array[]} Ein Eintrag pro onaudioprocess-Callback. */
    this.chunks = [];
    this.startedAt = 0;
    this._active = false;
  }

  get supported() {
    const AC = window.AudioContext || window.webkitAudioContext;
    return !!navigator.mediaDevices?.getUserMedia && !!AC;
  }

  get active() {
    return this._active;
  }

  get elapsed() {
    return this.active ? (performance.now() - this.startedAt) / 1000 : 0;
  }

  /** @returns {Promise<boolean>} true, wenn wirklich aufgenommen wird
   *  (false bei fehlender Unterstützung; wirft, wenn die Mikro-Freigabe
   *  verweigert wird — der Aufrufer zeigt dafür einen eigenen Hinweis). */
  async start() {
    if (this.active || !this.supported) return false;
    // Alle drei Verarbeitungs-Constraints explizit AUS: ohne das fragt
    // getUserMedia() mit den Browser-Defaults (meist alle drei AN) an --
    // Auto-Gain/Noise-Gate/Echo-Cancellation verfälschen das aufgenommene
    // Instrument (pumpender Pegel, gated Ausklang), für einen Sampler will
    // man das unbearbeitete Rohsignal. channelCount:1 passt zum Mono-WAV-
    // Encoder unten (Telefon-Mikros sind ohnehin faktisch mono).
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    const ctx = engine.ctx;
    this.source = ctx.createMediaStreamSource(this.stream);
    this.processor = ctx.createScriptProcessor(4096, 1, 1);
    this.chunks = [];
    this.processor.onaudioprocess = (e) => {
      // Kopie nötig: der Callback darf denselben Float32Array beim
      // nächsten Aufruf wiederverwenden (Browser-Implementierung, nicht
      // garantiert neu alloziert).
      this.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    // Stiller Gain-Pfad zum Destination: ein ScriptProcessorNode ohne
    // verbundenes Ziel bekommt in manchen Browsern gar keine
    // onaudioprocess-Aufrufe (WebAudio-Spec-Eigenheit, s. auch die
    // Offline-Test-Harnesses dieses Projekts). Gain 0 verhindert
    // hörbares Mic-Monitoring/Feedback (Mikro und Lautsprecher sitzen am
    // Telefon dicht beieinander), hält den Graphen aber "ziehend".
    this.silence = ctx.createGain();
    this.silence.gain.value = 0;
    this.source.connect(this.processor);
    this.processor.connect(this.silence);
    this.silence.connect(ctx.destination);
    this.startedAt = performance.now();
    this._active = true;
    return true;
  }

  /** @returns {Promise<{blob: Blob, seconds: number}|null>} */
  async stop() {
    if (!this.active) return null;
    const seconds = this.elapsed;
    const sampleRate = engine.ctx.sampleRate;
    const chunks = this.chunks;
    this.#teardown();
    return { blob: encodeWavFloat32(chunks, sampleRate), seconds };
  }

  /** Abbrechen ohne Ergebnis (z. B. Popup zu, während aufgenommen wird). */
  cancel() {
    if (!this.active) return;
    this.#teardown();
  }

  #teardown() {
    this.processor.onaudioprocess = null;
    this.source.disconnect();
    this.processor.disconnect();
    this.silence.disconnect();
    this.stream.getTracks().forEach((t) => t.stop()); // Mikro-Indikator/Ressource freigeben
    this.source = null;
    this.processor = null;
    this.silence = null;
    this.stream = null;
    this.chunks = [];
    this._active = false;
  }
}

export const micRecorder = new MicRecorder();
