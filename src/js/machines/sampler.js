/**
 * Sampler — 8-Pad-Sample-Kit. Wie BeatBox/AnalogKit (Pads + gemeinsames
 * Step-Grid + A/B/C/D-Pattern-Bank), aber jedes Pad spielt ein selbst
 * geladenes oder per Mikrofon aufgenommenes Sample statt eines
 * synthetisierten Klangs.
 *
 * Bewusst KEINE Unterklasse von TrackedDrumMachine: deren Klang-Trigger
 * (#trigger) ist eine private Methode (nicht überschreibbar), und
 * TRACK_DEFS ist ein statisches, zur Compile-Zeit fixes Klassenfeld --
 * hier bekommt aber jedes Pad zur Laufzeit ein beliebiges, vom Nutzer
 * zugewiesenes Sample. Der Pad/Pattern/Sends/Mixer-Teil ist deshalb bewusst
 * NACHGEBAUT statt geerbt (dieselbe Vorgehensweise, mit der BeatBox/
 * AnalogKit historisch erst dupliziert und danach zu TrackedDrumMachine
 * extrahiert wurden, s. dortiger Kommentar) -- etwas Doppelung jetzt ist
 * der sichere Weg, ohne die bestehenden Maschinen anzufassen.
 *
 * Samples selbst liegen NICHT im Projekt-JSON (zu groß für den synchronen
 * Autosave-Pfad, s. core/store.js), sondern in einer eigenen IndexedDB
 * (core/sample-store.js) -- serialize()/deserialize() transportieren nur
 * die Referenz-ID. Nur beim Datei-Export (main.js) werden die Rohdaten
 * zusätzlich als Base64 eingebettet, damit die Datei auf einem ANDEREN
 * Gerät/Profil eigenständig lauffähig ist.
 */
import { Machine } from './machine.js';
import { engine } from '../core/audio-engine.js';
import { transport, shuffleTime } from '../core/transport.js';
import { StepSeq, resizePattern } from '../ui/step-seq.js';
import { createPatternBank } from '../ui/pattern-bank.js';
import { automation } from '../core/automation.js';
import { song } from '../core/song.js';
import { undo } from '../core/undo.js';
import { hintOnce, showHintToast } from '../core/hints.js';
import { sampleStore, newSampleId, base64ToArrayBuffer } from '../core/sample-store.js';
import { store } from '../core/store.js';
import { micRecorder } from '../core/mic-recorder.js';
import { env, applyFilterEnv } from '../core/dsp.js';
import { FILTER_DELAY_TYPES } from '../core/inserts.js';

const PAD_COUNT = 8;
const PAD_HOLD_MS = 500; // gleiche Halten-Schwelle wie pattern-bank.js/jam-view.js

export class Sampler extends Machine {
  static meta = {
    type: 'sampler',
    name: 'Sampler',
    desc: '8-pad sample kit — load files or record from the mic',
    color: '#6fd6a0',
    model: 'RW-06',
  };

  buildAudio() {
    this.volume = 0.8;
    this.output.gain.value = this.volume;
    this.selected = 0;
    /** Index der solo geschalteten Spur, oder null */
    this.soloTrack = null;
    /** Shuffle/Groove (Prozent, 50 = kein Effekt), s. transport.js#
     *  shuffleTime -- ganzer Sampler statt pro Pad. */
    this.shuffle = 50;

    this.tracks = Array.from({ length: PAD_COUNT }, (_, i) => this.buildPad(`Pad ${i + 1}`));

    this.patterns = [this.emptySlot(), this.emptySlot(), this.emptySlot(), this.emptySlot()];
    this.patternIndex = 0;
    this.patterns[0].forEach((steps, ti) => { this.tracks[ti].steps = steps; });
  }

  /** Ein leeres Pad: eigener Panner + Delay/Reverb-Send parallel zum
   *  trockenen Pfad (panner -> this.output), nicht dahinter -- identischer
   *  Graph wie TrackedDrumMachine#buildAudio, damit ein gemuteter Kit-Bus
   *  trotzdem noch in die Master-Effekte nachklingen kann. Bewusst KEIN
   *  privates Feld (kein #): buildAudio() ruft das aus dem Konstruktor der
   *  Basisklasse Machine heraus auf, bevor die privaten Elemente DIESER
   *  Zwischenklasse existieren (reproduzierte Falle, s. TrackedDrumMachine#
   *  emptySlot/StepSequencedSynth#emptyPattern). */
  buildPad(name) {
    const panner = engine.ctx.createStereoPanner();
    panner.connect(this.output);
    const sendDelayNode = engine.ctx.createGain();
    sendDelayNode.gain.value = 0;
    panner.connect(sendDelayNode);
    sendDelayNode.connect(engine.delayBus);
    const sendReverbNode = engine.ctx.createGain();
    sendReverbNode.gain.value = 0;
    panner.connect(sendReverbNode);
    sendReverbNode.connect(engine.reverbBus);
    return {
      name, sampleId: null, buffer: null, loading: false,
      tune: 0, level: 0.9, pan: 0, sendDelay: 0, sendReverb: 0,
      // Trim: reiner Wiedergabe-Ausschnitt (kein destruktives Schneiden,
      // s. #trigger) -- trimEnd bleibt bis zum ersten Laden Infinity,
      // #resetTrim() setzt beide sobald buffer.duration bekannt ist.
      trimStart: 0, trimEnd: Infinity,
      // Amp-Hüllkurve (dsp.js#env) -- bewusst "transparente" Defaults
      // (langer Decay, kurzer Release), damit ein frisch geladenes Sample
      // sich unverändert anhört, bis man aktiv dreht.
      ampAttack: 0, ampDecay: 2.0, ampRelease: 0.05,
      // Filter + Filterhüllkurve (dsp.js#applyFilterEnv, identisch zu
      // SubSynth/PolySynth) -- Cutoff komplett offen, Env Amt aus.
      filterType: 'lowpass', cutoff: 20000, resonance: 0.707, envAmt: 0, fDecay: 0.2,
      panner, sendDelayNode, sendReverbNode,
    };
  }

  /** Leeres Pattern-Slot: eine leere 16-Step-Spur je Pad. Bewusst KEIN
   *  privates Feld (kein #) -- gleiche Falle wie bei TrackedDrumMachine#
   *  emptySlot (buildAudio läuft aus dem Basis-Konstruktor heraus, bevor
   *  private Elemente dieser Zwischenklasse existieren). */
  emptySlot() {
    return Array.from({ length: PAD_COUNT }, () => Array.from({ length: 16 }, () => ({ on: false })));
  }

  getParamForKnob(key) {
    // volume/shuffle liegen hier nicht in params (wie TrackedDrumMachine)
    // — alles andere (z. B. FX-Sends) beantwortet die Basisklasse
    if (key === 'volume') return this.volume;
    if (key === 'shuffle') return this.shuffle;
    return super.getParamForKnob(key);
  }

  /* ---------- Mixer: Pegel (Volume separat, nicht in params) ---------- */
  get level() { return this.volume; }
  setLevel(v) {
    v = Math.min(1, Math.max(0, v));
    this.volume = v;
    this.output.gain.setTargetAtTime(v, engine.now, 0.01);
    const knob = this.el?.querySelector('x-knob[data-p="volume"]');
    if (knob) knob.value = v;
  }

  onTransport(event) {
    if (event === 'stop') this.seq?.clearPlayhead();
  }

  /** Basisklasse kennt die Pad-Panner nicht — selbst aufräumen. */
  disposeAudio() {
    for (const tr of this.tracks) {
      tr.panner.disconnect();
      tr.meterAnalyser?.disconnect();
      tr.sendDelayNode.disconnect();
      tr.sendReverbNode.disconnect();
    }
  }

  /** Sends laufen bewusst am Gate vorbei (s. buildPad) — Mute soll sie
   *  unberührt lassen, Solo einer ANDEREN Maschine (oder ein geschlossenes
   *  Jam-Gate) aber wirklich nur das gewählte Instrument übrig lassen. */
  setSoloShadowed(shadowed) {
    // Machine's Konstruktor ruft refreshGates() bereits VOR buildAudio() auf.
    if (!this.tracks) return;
    for (const tr of this.tracks) {
      tr.sendDelayNode.gain.setTargetAtTime(shadowed ? 0 : tr.sendDelay, engine.now, 0.015);
      tr.sendReverbNode.gain.setTargetAtTime(shadowed ? 0 : tr.sendReverb, engine.now, 0.015);
    }
  }

  /** Analyser fürs Kanalzug-VU-Meter eines einzelnen Pads im Mixer. */
  getTrackMeterAnalyser(i) {
    const tr = this.tracks[i];
    if (!tr.meterAnalyser) {
      tr.meterAnalyser = engine.ctx.createAnalyser();
      tr.meterAnalyser.fftSize = 512;
      tr.panner.connect(tr.meterAnalyser);
    }
    return tr.meterAnalyser;
  }

  /** Trim-Grenzen an die tatsächliche Buffer-Länge geklemmt (defensiv --
   *  z. B. falls trimEnd noch von einem vorher geladenen, längeren Sample
   *  stammt und #resetTrim aus irgendeinem Grund übersprungen wurde). */
  #clampedTrim(tr) {
    const dur = tr.buffer.duration;
    const start = Math.min(Math.max(0, tr.trimStart), dur);
    const end = Math.max(start + 0.001, Math.min(tr.trimEnd, dur));
    return { start, end };
  }

  #trigger(tr, time) {
    this.pulse(time);
    if (!tr.buffer) return; // leeres oder noch ladendes Pad — kein Ton, kein Sonderfall nötig
    const t = engine.quantizeTime(time);
    const { start, end } = this.#clampedTrim(tr);

    const src = engine.ctx.createBufferSource();
    src.buffer = tr.buffer;
    src.playbackRate.value = 2 ** (tr.tune / 12); // Tune in Halbtönen

    // Filter + Filterhüllkurve -- dieselbe Funktion wie SubSynth/PolySynth
    // (dsp.js#applyFilterEnv), nur mit den Pad-eigenen Feldnamen.
    const filter = engine.ctx.createBiquadFilter();
    filter.type = tr.filterType;
    filter.Q.value = tr.resonance;
    applyFilterEnv(filter, t, tr);

    // Amp-Hüllkurve (dsp.js#env) -- peak ist direkt tr.level, spart einen
    // separaten Level-Gain-Node. Läuft unabhängig von der Trim-Dauer: ist
    // die Hüllkurve länger als der getrimmte Ausschnitt, endet die Quelle
    // einfach vorher (Stille), ohne Sonderfall; ist sie kürzer, "gated"
    // sie das Sample wie gewünscht ab.
    const ampEnv = env(engine.ctx, t, tr.level, tr.ampDecay, { attack: tr.ampAttack, release: tr.ampRelease });

    src.connect(filter).connect(ampEnv).connect(tr.panner);
    // Drei-Parameter-start(): spielt nur den getrimmten Ausschnitt, ohne
    // den Original-Buffer anzutasten (kein destruktives Schneiden).
    src.start(t, start, end - start);
  }

  /* ---------- Mixer: Pegel & Panorama pro Pad ---------- */
  setTrackLevel(i, v) {
    const tr = this.tracks[i];
    if (!tr) return;
    tr.level = Math.min(1, Math.max(0, v));
    if (i === this.selected) this.knobs.level.value = tr.level;
  }
  setTrackPan(i, v) {
    const tr = this.tracks[i];
    if (!tr) return;
    tr.pan = Math.min(1, Math.max(-1, v));
    tr.panner.pan.setTargetAtTime(tr.pan, engine.now, 0.01);
  }
  setTrackSend(i, which, v) {
    const tr = this.tracks[i];
    if (!tr) return;
    v = Math.min(1, Math.max(0, v));
    const key = which === 'delay' ? 'sendDelay' : 'sendReverb';
    const node = which === 'delay' ? tr.sendDelayNode : tr.sendReverbNode;
    tr[key] = v;
    node.gain.setTargetAtTime(v, engine.now, 0.01);
    if (i === this.selected) this.knobs[key].value = v;
  }

  /* ---------- Sequenzer ---------- */
  onStep(step, time) {
    // Relativ zu stepOffset statt zum rohen globalen Schritt, s. machine.js
    // und step-sequenced-synth.js#onStep() für die ausführliche Begründung.
    const len = this.tracks[0].steps.length;
    const idx = (((step - this.stepOffset) % len) + len) % len;
    // Shuffle/Groove -- ganzer Sampler auf einmal (s. buildAudio()/Chat),
    // nicht pro Pad, s. transport.js#shuffleTime.
    const t = shuffleTime(step, time, this.shuffle, transport.stepDuration);
    const delayMs = (t - engine.now) * 1000;
    this.seq?.flashStep(idx, delayMs, transport.stepDuration * 900);
    for (let i = 0; i < this.tracks.length; i++) {
      if (this.soloTrack != null && i !== this.soloTrack) continue;
      const tr = this.tracks[i];
      if (tr.steps[idx].on) this.#trigger(tr, t);
    }
  }

  /* ---------- Pattern-Bank (A/B/C/D) ---------- */
  setPatternIndex(i) {
    this.patternIndex = i;
    this.tracks.forEach((tr, ti) => { tr.steps = this.patterns[i][ti]; });
    this.patternBank?.setActive(i);
    this.seq?.setPattern(this.tracks[this.selected].steps);
    automation.setBars(this.id, this.seq?.bars ?? 1);
    this.onPatternChange?.();
  }

  /** Für Jam-Clip-Wiedergabe: Live-Sequenzer-Zustand direkt auf beliebige
   *  Daten binden, OHNE this.patterns/patternIndex zu berühren. */
  bindClipData(data) {
    this.tracks.forEach((tr, ti) => { tr.steps = data[ti]; });
    this.seq?.setPattern(this.tracks[this.selected].steps);
    automation.setBars(this.id, this.seq?.bars ?? 1);
  }

  /** s. StepSequencedSynth#getClipStepLength -- alle Spuren gleich lang. */
  getClipStepLength() {
    return this.tracks[0].steps.length;
  }

  #cloneSlot(i) {
    return this.patterns[i].map((steps) => steps.map((s) => ({ on: s.on })));
  }

  /** Für die Jam-Proto-Clip-Kacheln (jam-view.js). */
  hasPatternContent(i) {
    return this.patterns[i].some((steps) => steps.some((s) => s.on));
  }

  /** shape: 'drums' -- dieselbe Step-Form (N Spuren × 16 Steps {on}) wie
   *  BeatBox/AnalogKit, absichtlich wiederverwendet statt eines eigenen
   *  Shape-Namens: Copy/Paste zwischen Sampler und anderen 8-Pad-Kits
   *  funktioniert dadurch nebenbei mit (gleiche Spuranzahl vorausgesetzt). */
  addClipFromPattern(i) {
    return this.addClip({ name: `Pattern ${'ABCD'[i]}`, shape: 'drums', data: this.#cloneSlot(i), sourceSlot: i });
  }

  /** Für den Sample-Editor (Popup, s. openSampleEditor): #trigger ist
   *  privat, das Popup lebt als modulweite Funktion ausserhalb der Klasse
   *  (gleiches Muster wie openPadMenu/openRecordPopup). */
  previewPad(i) {
    this.#trigger(this.tracks[i], engine.ctx.currentTime);
  }

  /* ---------- Sample laden/aufnehmen/leeren ---------- */

  /** Datei-Auswahl (Dateisystem des Telefons) → dekodieren + ablegen.
   *  accept kombiniert den MIME-Wildcard MIT expliziten Dateiendungen --
   *  "audio/*" allein reicht auf vielen mobilen Datei-Pickern (v. a. iOS)
   *  nicht: .wav-Dateien werden dort je nach gemeldetem MIME-Typ
   *  (audio/x-wav, audio/wave, teils sogar application/octet-stream) nicht
   *  zuverlässig als "audio/*" erkannt und erscheinen dann ausgegraut oder
   *  gar nicht in der Auswahl. Explizite Endungen matchen unabhängig vom
   *  gemeldeten MIME-Typ. */
  loadPadFromFile(i) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*,.wav,.wave,.mp3,.m4a,.aac,.ogg,.flac,.aiff,.aif';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      const tr = this.tracks[i];
      tr.loading = true;
      this.#refreshPadUI();
      try {
        const arrBuf = await file.arrayBuffer();
        const id = newSampleId();
        // Erst ablegen (IndexedDB klont die Daten), DANN dekodieren --
        // decodeAudioData darf den ArrayBuffer detachen, das darf die
        // schon gespeicherte Kopie nicht mehr betreffen.
        await sampleStore.put(id, arrBuf);
        const buffer = await engine.ctx.decodeAudioData(arrBuf);
        tr.sampleId = id;
        tr.buffer = buffer;
        tr.trimStart = 0;
        tr.trimEnd = buffer.duration; // neues Audio -- alte Trim-Punkte wären bedeutungslos
      } catch (err) {
        console.error('Sampler: file could not be loaded as audio:', err);
        showHintToast('This file could not be loaded as audio.');
      } finally {
        tr.loading = false;
        this.#refreshPadUI();
      }
    });
    input.click();
  }

  /** Vom Aufnahme-Popup (openRecordPopup) nach dem Stoppen aufgerufen. */
  async assignRecording(i, blob) {
    const tr = this.tracks[i];
    tr.loading = true;
    this.#refreshPadUI();
    try {
      const arrBuf = await blob.arrayBuffer();
      const id = newSampleId();
      await sampleStore.put(id, arrBuf);
      const buffer = await engine.ctx.decodeAudioData(arrBuf);
      tr.sampleId = id;
      tr.buffer = buffer;
      tr.trimStart = 0;
      tr.trimEnd = buffer.duration; // neues Audio -- alte Trim-Punkte wären bedeutungslos
    } catch (err) {
      console.error('Sampler: recording could not be processed:', err);
      showHintToast('The recording could not be processed.');
    } finally {
      tr.loading = false;
      this.#refreshPadUI();
    }
  }

  /** Pad leeren — mit Undo-Angebot (wie removeInsert/deleteClip). Das
   *  Sample bleibt in der IndexedDB liegen (kein Cross-Referenz-Tracking
   *  über Projekte hinweg, s. Plan) -- Undo braucht deshalb keinen
   *  erneuten Ladevorgang, nur das Wiederanhängen derselben Referenz. */
  clearPad(i) {
    const tr = this.tracks[i];
    if (!tr.sampleId) return;
    const prev = { sampleId: tr.sampleId, buffer: tr.buffer, name: tr.name };
    tr.sampleId = null;
    tr.buffer = null;
    this.#refreshPadUI();
    undo.offer(`Sample cleared from "${tr.name}"`, () => {
      Object.assign(tr, prev);
      this.#refreshPadUI();
    });
  }

  /** Sample-Referenz aus der IndexedDB nachladen (Autosave/benanntes
   *  Projekt) -- läuft im Hintergrund, deserialize() bleibt synchron. Ein
   *  Trigger, der eintrifft bevor das fertig ist, bleibt einfach stumm
   *  (s. #trigger). */
  async #loadPadFromStore(i, sampleId) {
    const tr = this.tracks[i];
    tr.sampleId = sampleId;
    tr.loading = true;
    this.#refreshPadUI();
    try {
      const arrBuf = await sampleStore.get(sampleId);
      if (!arrBuf) throw new Error('Sample not found in local storage');
      tr.buffer = await engine.ctx.decodeAudioData(arrBuf);
    } catch (err) {
      console.warn(`Sampler: pad "${tr.name}" sample could not be loaded:`, err);
    } finally {
      tr.loading = false;
      this.#refreshPadUI();
    }
  }

  /** Eingebettetes Sample aus einer importierten (portablen) Projekt-Datei
   *  -- neue lokale ID vergeben (Kollisionsschutz), dann wie oben. */
  async #importEmbeddedSample(i, base64) {
    const tr = this.tracks[i];
    tr.loading = true;
    this.#refreshPadUI();
    try {
      const arrBuf = base64ToArrayBuffer(base64);
      const id = newSampleId();
      await sampleStore.put(id, arrBuf);
      tr.sampleId = id;
      tr.buffer = await engine.ctx.decodeAudioData(arrBuf);
    } catch (err) {
      console.warn(`Sampler: embedded sample for pad "${tr.name}" could not be imported:`, err);
    } finally {
      tr.loading = false;
      this.#refreshPadUI();
    }
  }

  /** Gemeinsames Feld-Set eines Pads für Projekt-Export UND Kit-Export
   *  (s. saveKit) -- ein Kit ist inhaltlich exakt ein Pad-Zustand ohne
   *  Pattern-Bezug, deshalb dieselbe Liste statt einer zweiten, separat
   *  gepflegten. */
  #serializeTrack(tr) {
    return {
      name: tr.name, sampleId: tr.sampleId, tune: tr.tune, level: tr.level, pan: tr.pan,
      sendDelay: tr.sendDelay, sendReverb: tr.sendReverb,
      trimStart: tr.trimStart, trimEnd: tr.trimEnd,
      ampAttack: tr.ampAttack, ampDecay: tr.ampDecay, ampRelease: tr.ampRelease,
      filterType: tr.filterType, cutoff: tr.cutoff, resonance: tr.resonance,
      envAmt: tr.envAmt, fDecay: tr.fDecay,
    };
  }

  /** Gegenstück zu #serializeTrack() -- wendet einen gespeicherten Pad-
   *  Zustand auf Pad i an. Gemeinsame Grundlage für deserialize() (Projekt
   *  laden) UND loadKit() (Kit laden, s.u.): beide transportieren exakt
   *  dieselben Pad-Felder, nur die Quelle (Projekt-JSON vs. lokal
   *  gespeichertes Kit) unterscheidet sich. */
  #applyTrackState(i, saved) {
    const tr = this.tracks[i];
    if (!tr || !saved) return;
    if (saved.name) tr.name = saved.name;
    tr.tune = saved.tune ?? 0;
    tr.level = saved.level ?? 0.9;
    this.setTrackPan(i, saved.pan ?? 0);
    // this.knobs existiert beim allerersten Laden noch nicht (deserialize
    // läuft vor buildControls) — direkt an Feld + Gain-Node schreiben statt
    // über setTrackSend, das erst nach dem Rendern sicher aufrufbar ist.
    // loadKit() läuft dagegen immer NACH buildControls, schreibt hier also
    // in ein bereits existierendes this.knobs -- #refreshPadUI()/#selectPad()
    // holen den Knob-Sync danach in beiden Fällen nach.
    tr.sendDelay = saved.sendDelay ?? 0;
    tr.sendDelayNode.gain.setTargetAtTime(tr.sendDelay, engine.now, 0.01);
    tr.sendReverb = saved.sendReverb ?? 0;
    tr.sendReverbNode.gain.setTargetAtTime(tr.sendReverb, engine.now, 0.01);
    // Trim/Hüllkurven/Filter -- trimEnd bleibt Infinity (voller Ausschnitt),
    // solange kein Sample geladen ist bzw. keine gespeicherte Grenze
    // vorliegt; #clampedTrim() klemmt das beim Triggern ohnehin auf die
    // tatsächliche Buffer-Länge.
    tr.trimStart = saved.trimStart ?? 0;
    tr.trimEnd = saved.trimEnd ?? Infinity;
    tr.ampAttack = saved.ampAttack ?? 0;
    tr.ampDecay = saved.ampDecay ?? 2.0;
    tr.ampRelease = saved.ampRelease ?? 0.05;
    tr.filterType = saved.filterType ?? 'lowpass';
    tr.cutoff = saved.cutoff ?? 20000;
    tr.resonance = saved.resonance ?? 0.707;
    tr.envAmt = saved.envAmt ?? 0;
    tr.fDecay = saved.fDecay ?? 0.2;
    // Sample: entweder eine eingebettete Datei (Import aus einer
    // portablen Projekt-Datei) oder eine Referenz auf eine schon lokal
    // vorhandene IndexedDB-ID (Autosave/benanntes Projekt/Kit) — beides
    // läuft asynchron im Hintergrund weiter. Hat der gespeicherte Zustand
    // KEIN Sample, muss das Pad explizit geleert werden (nicht nur "nichts
    // tun") -- bei deserialize() trifft das nie zu (frische Pads sind
    // ohnehin schon leer), aber loadKit()/dessen Undo wenden dies auch auf
    // ein BEREITS befülltes Pad an, das dann wirklich geleert werden muss.
    if (saved.sampleData) this.#importEmbeddedSample(i, saved.sampleData);
    else if (saved.sampleId) this.#loadPadFromStore(i, saved.sampleId);
    else { tr.sampleId = null; tr.buffer = null; }
  }

  serialize() {
    return {
      volume: this.volume,
      shuffle: this.shuffle,
      tracks: this.tracks.map((tr) => this.#serializeTrack(tr)),
      patterns: this.patterns.map((slot) => slot.map((steps) => steps.map((s) => ({ on: s.on })))),
      patternIndex: this.patternIndex,
      pan: this.pan,
    };
  }

  deserialize(state) {
    this.volume = state.volume ?? 0.8;
    this.output.gain.value = this.volume;
    this.shuffle = state.shuffle ?? 50;
    state.tracks?.forEach((saved, i) => this.#applyTrackState(i, saved));
    if (state.patterns) {
      this.patterns = state.patterns.map((slot) => slot.map((steps) => steps.map((s) => ({ on: !!s.on }))));
      this.patternIndex = state.patternIndex ?? 0;
    }
    while (this.patterns.length < 4) this.patterns.push(this.emptySlot());
    this.patternIndex = Math.min(this.patternIndex ?? 0, 3);
    this.tracks.forEach((tr, ti) => { tr.steps = this.patterns[this.patternIndex][ti]; });
    this.setPan(state.pan ?? 0);
  }

  /* ---------- Sample-Kits (Save/Load über Sessions hinweg) ----------
   * Ein Kit ist der reine Pad-Zustand (Samples + Klangformung), OHNE
   * Pattern-Bezug -- bewusst getrennt vom Projekt-Speichern (das die ganze
   * Rack-Session inkl. Patterns/anderer Maschinen sichert). Liegt wie
   * Projekte in localStorage (store.js), Schlüssel-Präfix "sampler-kit:" --
   * die eigentlichen Audiodaten bleiben in der IndexedDB (sample-store.js)
   * und werden nur per sampleId referenziert (gleiches Muster wie Projekte/
   * Autosave: funktioniert zuverlässig innerhalb desselben Geräts/Browser-
   * Profils, für Cross-Device-Transport gibt es weiterhin den Datei-Export). */
  saveKit(name) {
    store.set(`sampler-kit:${name}`, JSON.stringify({
      v: 1,
      tracks: this.tracks.map((tr) => this.#serializeTrack(tr)),
    }));
  }

  /** Ersetzt alle 8 Pads durch den gespeicherten Kit-Zustand -- mit Undo
   *  (wie jede andere ersetzende/löschende Aktion in der App), da dies den
   *  kompletten aktuellen Pad-Satz überschreibt. */
  loadKit(name) {
    const raw = store.get(`sampler-kit:${name}`);
    if (!raw) return;
    let data;
    try { data = JSON.parse(raw); } catch {
      showHintToast('This kit could not be loaded — the data seems to be damaged.');
      return;
    }
    const prevTracks = this.tracks.map((tr) => this.#serializeTrack(tr));
    const prevSelected = this.selected;
    (data.tracks ?? []).forEach((saved, i) => this.#applyTrackState(i, saved));
    this.#refreshPadUI();
    this.#selectPad(this.selected);
    undo.offer(`Kit "${name}" loaded`, () => {
      prevTracks.forEach((saved, i) => this.#applyTrackState(i, saved));
      this.#refreshPadUI();
      this.#selectPad(prevSelected);
    });
  }

  /* ---------- UI ---------- */
  buildControls(container) {
    // Pad-Parameter (Tune/Level/Sends) in einer eigenen, eingefärbten Reihe
    // MIT Pad-Name — sonst nicht erkennbar, dass diese Regler nur das
    // gewählte Pad betreffen, nicht das ganze Kit.
    const row = document.createElement('div');
    row.className = 'machine__row machine__row--track';
    row.innerHTML = `
      <span class="track-row__label" data-track-label></span>
      <x-knob label="Tune" min="-12" max="12" value="0" default="0" data-p="tune"></x-knob>
      <x-knob label="Level" min="0" max="1" value="0.9" data-p="level"></x-knob>
      <x-knob label="Send D" min="0" max="1" value="0" data-p="trackSendDelay"></x-knob>
      <x-knob label="Send R" min="0" max="1" value="0" data-p="trackSendReverb"></x-knob>
    `;
    row.addEventListener('input', (e) => {
      const key = e.target.dataset?.p;
      if (!key) return;
      const val = e.detail.value;
      if (key === 'trackSendDelay' || key === 'trackSendReverb') {
        this.setTrackSend(this.selected, key === 'trackSendDelay' ? 'delay' : 'reverb', val);
      } else {
        this.tracks[this.selected][key] = val;
      }
    });
    container.appendChild(row);
    this.trackLabelEl = row.querySelector('[data-track-label]');
    this.knobs = {
      tune: row.querySelector('[data-p="tune"]'),
      level: row.querySelector('[data-p="level"]'),
      sendDelay: row.querySelector('[data-p="trackSendDelay"]'),
      sendReverb: row.querySelector('[data-p="trackSendReverb"]'),
    };

    // Amp-Hüllkurve direkt im Panel statt nur im Sample-Editor (der
    // behält Trim/Filter, aber nicht mehr diese Regler -- eine einzige
    // Bedienstelle statt zweier auseinanderlaufender Kopien derselben
    // Felder). Gleiches Ranges/Kurven wie zuvor im Editor.
    const envRow = document.createElement('div');
    envRow.className = 'machine__row machine__row--track';
    envRow.innerHTML = `
      <span class="track-row__label">Envelope</span>
      <x-knob label="Attack" min="0.002" max="10" value="0.002" curve="log" unit="s" data-p="ampAttack"></x-knob>
      <x-knob label="Decay" min="0.05" max="5" value="2" curve="log" unit="s" data-p="ampDecay"></x-knob>
      <x-knob label="Release" min="0.01" max="10" value="0.05" curve="log" unit="s" data-p="ampRelease"></x-knob>
    `;
    envRow.addEventListener('input', (e) => {
      const key = e.target.dataset?.p;
      if (!key) return;
      this.tracks[this.selected][key] = e.detail.value;
    });
    container.appendChild(envRow);
    this.knobs.ampAttack = envRow.querySelector('[data-p="ampAttack"]');
    this.knobs.ampDecay = envRow.querySelector('[data-p="ampDecay"]');
    this.knobs.ampRelease = envRow.querySelector('[data-p="ampRelease"]');

    const volRow = document.createElement('div');
    volRow.className = 'machine__row';
    volRow.innerHTML = `
      <x-knob label="Kit Volume" min="0" max="1" value="0.8" data-p="volume" data-auto></x-knob>
      <x-knob label="Shuffle" min="50" max="75" value="${this.shuffle}" unit="%" data-p="shuffle" data-auto></x-knob>
    `;
    volRow.addEventListener('input', (e) => {
      const key = e.target.dataset?.p;
      if (key === 'volume') this.setLevel(e.detail.value);
      else if (key === 'shuffle') this.shuffle = e.detail.value;
    });
    container.appendChild(volRow);

    // Kits: der komplette Pad-Satz (Samples + Klangformung, ohne Patterns)
    // unter einem Namen sichern/wiederladen -- unabhängig von der laufenden
    // Rack-Session, damit ein selbst zusammengestelltes Kit auch in einem
    // ANDEREN Projekt/einer anderen Sitzung wieder verfügbar ist (anders als
    // "Save Project" oben, das die ganze Session inkl. Patterns/anderer
    // Maschinen sichert).
    const kitRow = document.createElement('div');
    kitRow.className = 'machine__row';
    kitRow.innerHTML = '<button type="button" class="m-btn m-btn--wide" data-open-kits>🎛 Kits (Save / Load)</button>';
    kitRow.querySelector('[data-open-kits]').addEventListener('click', () => openKitSheet(this));
    container.appendChild(kitRow);

    // Pro-Pad-Automation: Lane-Schlüssel entsteht aus dem gerade gewählten
    // Pad — jedes Pad hat eigene Fahrten (gleiches Muster wie
    // TrackedDrumMachine#buildControls).
    for (const param of ['tune', 'level', 'ampAttack', 'ampDecay', 'ampRelease']) {
      const applyForKey = (key, value) => {
        const trIdx = parseInt(key.split(':')[1], 10);
        this.tracks[trIdx][param] = value;
        if (trIdx === this.selected) this.knobs[param].value = value;
      };
      const getValueForKey = (key) => this.tracks[parseInt(key.split(':')[1], 10)][param];
      automation.registerDynamic(this.knobs[param], () => `${this.id}:${this.selected}:${param}`, applyForKey, getValueForKey);
      for (let ti = 0; ti < this.tracks.length; ti++) {
        const key = `${this.id}:${ti}:${param}`;
        automation.ensureTarget(key, this.knobs[param], (v) => applyForKey(key, v), () => getValueForKey(key));
      }
    }
    for (const [param, which] of [['sendDelay', 'delay'], ['sendReverb', 'reverb']]) {
      const applyForKey = (key, value) => {
        const trIdx = parseInt(key.split(':')[1], 10);
        this.setTrackSend(trIdx, which, value);
      };
      const getValueForKey = (key) => this.tracks[parseInt(key.split(':')[1], 10)][param];
      automation.registerDynamic(this.knobs[param], () => `${this.id}:${this.selected}:${param}`, applyForKey, getValueForKey);
      for (let ti = 0; ti < this.tracks.length; ti++) {
        const key = `${this.id}:${ti}:${param}`;
        automation.ensureTarget(key, this.knobs[param], (v) => applyForKey(key, v), () => getValueForKey(key));
      }
    }

    // Pads: kurz antippen = anspielen + auswählen; halten = Laden/
    // Aufnehmen/Leeren-Menü (openPadMenu).
    const pads = document.createElement('div');
    pads.className = 'pads';
    this.padEls = this.tracks.map((tr, i) => {
      const pad = document.createElement('button');
      pad.type = 'button';
      pad.className = 'pad';
      let holdTimer = null;
      let held = false;
      pad.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        held = false;
        holdTimer = setTimeout(() => {
          held = true;
          openPadMenu(this, i, pad);
        }, PAD_HOLD_MS);
      });
      const cancelHold = () => clearTimeout(holdTimer);
      pad.addEventListener('pointerup', () => {
        cancelHold();
        if (held) return;
        if (!tr.buffer) {
          hintOnce('sampler-pad-empty', () => showHintToast(
            'Hold a pad to load a file or record from the mic.'
          ));
          this.#selectPad(i);
          return;
        }
        if (this.isLiveRecording) {
          tr.steps[this.liveStepIndex(tr.steps.length)].on = true;
        }
        this.#trigger(tr, engine.ctx.currentTime);
        this.#selectPad(i);
      });
      pad.addEventListener('pointerleave', cancelHold);
      pad.addEventListener('pointercancel', cancelHold);
      pads.appendChild(pad);
      return pad;
    });
    container.appendChild(pads);
    this.#refreshPadUI();

    this.patternBank = createPatternBank({
      index: this.patternIndex,
      shape: 'drums',
      onSwitch: (i) => { this.setPatternIndex(i); song.recordPattern(this.id, i); },
      getSlot: (i) => this.#cloneSlot(i),
      putSlot: (i, data) => {
        this.patterns[i] = data.map((steps) => steps.map((s) => ({ on: !!s.on })));
        this.setPatternIndex(i);
      },
      onAddClip: (i) => this.addClipFromPattern(i),
    });
    container.appendChild(this.patternBank.el);

    // Ein Grid für alle Pads — zeigt immer das gewählte
    this.seq = new StepSeq(this.tracks[0].steps, {
      pitch: false,
      onLengthChange: (bars) => {
        for (const tr of this.tracks) resizePattern(tr.steps, bars);
        this.seq.setPattern(this.tracks[this.selected].steps);
        automation.setBars(this.id, bars, { resize: true });
      },
    });
    container.appendChild(this.seq.el);
    automation.setBars(this.id, this.seq.bars);

    const ctrl = this.seq.el.querySelector('.stepseq__ctrl');
    this.soloBtn = document.createElement('button');
    this.soloBtn.className = 'm-btn m-btn--solo';
    this.soloBtn.textContent = 'SOLO';
    this.soloBtn.addEventListener('click', () => {
      this.soloTrack = this.soloTrack === this.selected ? null : this.selected;
      this.#refreshSoloUI();
    });
    ctrl.insertBefore(this.soloBtn, ctrl.querySelector('[data-clear]'));

    this.#selectPad(0);
  }

  #selectPad(i) {
    this.selected = i;
    const tr = this.tracks[i];
    this.padEls.forEach((p, j) => p.classList.toggle('is-selected', j === i));
    this.trackLabelEl.textContent = tr.name;
    this.seq.setPattern(tr.steps);
    this.knobs.tune.value = tr.tune;
    this.knobs.level.value = tr.level;
    this.knobs.sendDelay.value = tr.sendDelay;
    this.knobs.sendReverb.value = tr.sendReverb;
    // ampAttack darf laut Log-Kurve nie 0 anzeigen (min="0.002") -- ältere
    // Pads/Kits kennen aber noch den transparenten Default 0 (kein Attack).
    // Gleicher Klemm-Trick wie vorher im Sample-Editor.
    this.knobs.ampAttack.value = Math.max(0.002, tr.ampAttack);
    this.knobs.ampDecay.value = tr.ampDecay;
    this.knobs.ampRelease.value = tr.ampRelease;
    for (const param of ['tune', 'level', 'sendDelay', 'sendReverb', 'ampAttack', 'ampDecay', 'ampRelease']) {
      const lfoKey = `${this.id}:${i}:${param}`;
      this.knobs[param].classList.toggle('has-auto', automation.hasLane(lfoKey));
      this.knobs[param].classList.toggle('lane-lfo-muted', automation.isLfoActive(lfoKey) && automation.hasLane(lfoKey));
    }
    this.seq.el.querySelector('.stepseq__title').textContent = tr.name;
    this.#refreshSoloUI();
  }

  #refreshSoloUI() {
    this.soloBtn.classList.toggle('is-active', this.soloTrack === this.selected);
    this.padEls.forEach((p, j) => p.classList.toggle('is-solo', j === this.soloTrack));
  }

  /** Pad-Beschriftung + leer/lädt-Zustand (s. .pad--empty/.pad--loading
   *  in app.css) -- aufgerufen nach jedem Laden/Aufnehmen/Leeren UND einmal
   *  initial beim Rendern. */
  #refreshPadUI() {
    if (!this.padEls) return;
    this.tracks.forEach((tr, i) => {
      const pad = this.padEls[i];
      pad.textContent = tr.name;
      pad.classList.toggle('pad--empty', !tr.buffer && !tr.loading);
      pad.classList.toggle('pad--loading', !!tr.loading);
    });
  }

  /** Nach dem Umbenennen eines Pads (s. openPadRenamePopup) -- Pad-Kachel
   *  UND, falls das umbenannte Pad gerade gewählt ist, auch Panel-Kopf/
   *  Sequenzer-Titel (die nur #selectPad() auffrischt) nachziehen. */
  onPadRenamed(i) {
    this.#refreshPadUI();
    if (i === this.selected) this.#selectPad(i);
  }

  /** Nach dem Laden eines Projekts: LEDs/Solo an das gewählte Pad anpassen. */
  onLanesImported() {
    super.onLanesImported();
    this.#selectPad(this.selected);
  }
}

/* ---------- Halten-Menü (Laden/Aufnehmen/Leeren) ----------
 * Ein einzelnes, modulweites Popup (wie clipMenu/macroPop in jam-view.js
 * und der Kontext-Chip in pattern-bank.js) -- nie mehr als eines
 * gleichzeitig offen, auch bei mehreren Sampler-Instanzen im Rack. */
let padMenu = null;
const dismissPadMenu = () => {
  padMenu?.remove();
  padMenu = null;
  document.removeEventListener('pointerdown', onOutsidePadMenu, true);
};
const onOutsidePadMenu = (e) => { if (padMenu && !padMenu.contains(e.target)) dismissPadMenu(); };

function openPadMenu(sampler, i, anchorEl) {
  dismissPadMenu();
  const tr = sampler.tracks[i];
  padMenu = document.createElement('div');
  padMenu.className = 'pat-chip';

  const loadBtn = document.createElement('button');
  loadBtn.className = 'pat-chip__btn';
  loadBtn.textContent = '📁 Load File';
  loadBtn.addEventListener('click', () => { dismissPadMenu(); sampler.loadPadFromFile(i); });
  padMenu.appendChild(loadBtn);

  const recBtn = document.createElement('button');
  recBtn.className = 'pat-chip__btn';
  recBtn.textContent = '🎙 Record';
  recBtn.addEventListener('click', () => { dismissPadMenu(); openRecordPopup(sampler, i); });
  padMenu.appendChild(recBtn);

  // Immer sichtbar (nicht an tr.buffer gebunden wie Edit/Clear unten) --
  // ein Pad lässt sich schon VOR dem Laden eines Samples beschriften, z. B.
  // um vorab zu planen, was auf welches Pad soll.
  const renameBtn = document.createElement('button');
  renameBtn.className = 'pat-chip__btn';
  renameBtn.textContent = '🏷 Rename';
  renameBtn.addEventListener('click', () => { dismissPadMenu(); openPadRenamePopup(sampler, i, anchorEl); });
  padMenu.appendChild(renameBtn);

  if (tr.buffer) {
    const editBtn = document.createElement('button');
    editBtn.className = 'pat-chip__btn';
    editBtn.textContent = '✏️ Edit';
    editBtn.addEventListener('click', () => { dismissPadMenu(); openSampleEditor(sampler, i); });
    padMenu.appendChild(editBtn);
  }

  if (tr.sampleId) {
    const clearBtn = document.createElement('button');
    clearBtn.className = 'pat-chip__btn pat-chip__btn--danger';
    clearBtn.textContent = '🗑 Clear';
    clearBtn.addEventListener('click', () => { dismissPadMenu(); sampler.clearPad(i); });
    padMenu.appendChild(clearBtn);
  }

  document.body.appendChild(padMenu);
  const r = anchorEl.getBoundingClientRect();
  const left = Math.max(8, Math.min(
    window.innerWidth - padMenu.offsetWidth - 8,
    r.left + r.width / 2 - padMenu.offsetWidth / 2,
  ));
  padMenu.style.left = `${left}px`;
  padMenu.style.top = `${Math.max(8, r.top - padMenu.offsetHeight - 8)}px`;
  setTimeout(() => document.addEventListener('pointerdown', onOutsidePadMenu, true), 0);
  clearTimeout(padMenu.dismissTimer);
  padMenu.dismissTimer = setTimeout(dismissPadMenu, 6000); // bis zu vier Optionen zum Lesen
}

/* ---------- Pad umbenennen ----------
 * Gleiches Popup-Muster wie openRenamePopup() in machine.js (Textfeld +
 * Reset-Knopf, Aussen-Tap SPEICHERT statt zu verwerfen, Escape verwirft
 * explizit) -- hier eigenständig statt jene Funktion wiederzuverwenden, weil
 * sie fest an eine Machine-Instanz (machine.setLabel/machine.displayName)
 * gebunden ist, nicht an einen beliebigen Pad-Index. */
let padRenamePop = null;
const dismissPadRenamePop = (commit = true) => {
  if (!padRenamePop) return;
  if (commit) {
    const trimmed = padRenamePop._input.value.trim().slice(0, 24);
    padRenamePop._sampler.tracks[padRenamePop._padIndex].name = trimmed || `Pad ${padRenamePop._padIndex + 1}`;
    padRenamePop._sampler.onPadRenamed?.(padRenamePop._padIndex);
  }
  padRenamePop.remove();
  padRenamePop = null;
  document.removeEventListener('pointerdown', onOutsidePadRenamePop, true);
};
const onOutsidePadRenamePop = (e) => { if (padRenamePop && !padRenamePop.contains(e.target)) dismissPadRenamePop(true); };

function openPadRenamePopup(sampler, i, anchorEl) {
  dismissPadRenamePop();

  padRenamePop = document.createElement('div');
  padRenamePop.className = 'rename-pop';
  padRenamePop._sampler = sampler;
  padRenamePop._padIndex = i;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rename-pop__input';
  input.maxLength = 24;
  input.placeholder = `Pad ${i + 1}`;
  input.value = sampler.tracks[i].name;
  padRenamePop._input = input;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); dismissPadRenamePop(true); }
    else if (e.key === 'Escape') { e.preventDefault(); dismissPadRenamePop(false); }
  });
  padRenamePop.appendChild(input);

  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'rename-pop__reset';
  resetBtn.textContent = '↺';
  resetBtn.setAttribute('aria-label', 'Reset to default pad name');
  resetBtn.addEventListener('click', () => { input.value = ''; dismissPadRenamePop(true); });
  padRenamePop.appendChild(resetBtn);

  document.body.appendChild(padRenamePop);
  const r = anchorEl.getBoundingClientRect();
  const left = Math.max(8, Math.min(window.innerWidth - padRenamePop.offsetWidth - 8, r.left));
  padRenamePop.style.left = `${left}px`;
  padRenamePop.style.top = `${Math.max(8, r.top - padRenamePop.offsetHeight - 8)}px`;
  input.focus();
  input.select();
  setTimeout(() => document.addEventListener('pointerdown', onOutsidePadRenamePop, true), 0);
}

/* ---------- Sample-Kits (Sheet) ----------
 * Gleiches Grundgerüst wie das Projekte-Sheet in main.js (Namensfeld +
 * Speichern-Knopf, darunter eine Liste mit Load/Delete je Eintrag) -- hier
 * als eigenständiges, modulweites Sheet statt im statischen index.html-
 * Markup, weil es sampler-spezifisch ist (kann von JEDER Sampler-Instanz
 * im Rack geöffnet werden, aber nie mehr als eines gleichzeitig, gleiches
 * Singleton-Muster wie insertPickerEl in insert-chain.js). z-index 60 wie
 * sample-editor/rec-pop/pat-chip -- wird typischerweise AUS dem geöffneten
 * Vollbild-Editor heraus aufgerufen (.machine-focus, z-index 55). */
let kitSheetEl = null;

function openKitSheet(sampler) {
  if (!kitSheetEl) {
    kitSheetEl = document.createElement('div');
    kitSheetEl.className = 'sheet sheet--kit';
    kitSheetEl.hidden = true;
    kitSheetEl.innerHTML = `
      <div class="sheet__backdrop" data-close></div>
      <div class="sheet__panel" role="dialog" aria-label="Sample Kits">
        <div class="sheet__grip"></div>
        <h2 class="sheet__title">Sample Kits</h2>
        <div class="saverow">
          <input class="saverow__input" data-kit-name placeholder="Kit name" maxlength="40">
          <button type="button" class="m-btn saverow__btn" data-kit-save>Save</button>
        </div>
        <div class="sheet__list" data-kit-list></div>
      </div>
    `;
    document.body.appendChild(kitSheetEl);
    kitSheetEl.querySelector('[data-close]').addEventListener('click', () => {
      kitSheetEl.hidden = true;
    });
  }

  const nameInput = kitSheetEl.querySelector('[data-kit-name]');
  const list = kitSheetEl.querySelector('[data-kit-list]');

  const refreshList = () => {
    list.innerHTML = '';
    const names = store.keys()
      .filter((k) => k.startsWith('sampler-kit:'))
      .map((k) => k.slice('sampler-kit:'.length))
      .sort();
    if (!names.length) {
      list.innerHTML = '<p class="sheet__empty">No saved kits yet.</p>';
      return;
    }
    for (const name of names) {
      const item = document.createElement('div');
      item.className = 'sheet__item sheet__item--project';
      item.innerHTML = `
        <button type="button" class="project__load">${name}</button>
        <button type="button" class="project__delete" aria-label="Delete kit">✕</button>
      `;
      item.querySelector('.project__load').addEventListener('click', () => {
        sampler.loadKit(name);
        kitSheetEl.hidden = true;
      });
      item.querySelector('.project__delete').addEventListener('click', () => {
        store.remove(`sampler-kit:${name}`);
        refreshList();
      });
      list.appendChild(item);
    }
  };

  // Direktes Überschreiben statt addEventListener -- die Sheet-Instanz ist
  // modulweit (nur eine für alle Sampler im Rack), der Speichern-Knopf muss
  // aber IMMER die zuletzt öffnende Instanz treffen, nicht die erste, die
  // ihn je gebunden hat (addEventListener würde sich sonst über mehrere
  // Öffnungen hinweg aufsummieren).
  kitSheetEl.querySelector('[data-kit-save]').onclick = () => {
    const name = nameInput.value.trim() || 'Untitled Kit';
    sampler.saveKit(name);
    nameInput.value = '';
    refreshList();
  };

  nameInput.value = '';
  refreshList();
  kitSheetEl.hidden = false;
}

/* ---------- Aufnahme-Popup ----------
 * Eigenes, grösseres Popup (nicht der kleine Chip oben) -- Aufnehmen
 * braucht anhaltenden UI-Zustand (Start/Stop, laufende Zeit). Schliesst
 * sich bewusst NICHT bei Aussen-Tap, während gerade aufgenommen wird --
 * ein versehentlicher Tap soll keine laufende Aufnahme stillschweigend
 * verwerfen. */
let recPop = null;
let recTimerId = null;

function closeRecordPopup() {
  if (micRecorder.active) micRecorder.cancel();
  clearInterval(recTimerId);
  recTimerId = null;
  recPop?.remove();
  recPop = null;
}

function formatElapsed(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function openRecordPopup(sampler, i) {
  closeRecordPopup(); // sollte nie parallel offen sein, sicherheitshalber
  // Läuft der Transport gerade, mit ins Mikro bluten alle spielenden
  // Instrumente hörbar in die Aufnahme -- Popup öffnen heisst also sofort
  // stoppen (nicht erst beim Antippen von "Start"), nicht erst nach dem
  // Auftreten des Symptoms von Hand pausieren müssen.
  transport.stop();
  recPop = document.createElement('div');
  recPop.className = 'rec-pop';
  recPop.innerHTML = `
    <div class="rec-pop__head">
      <span class="rec-pop__title">Record — ${sampler.tracks[i].name}</span>
      <button type="button" class="rec-pop__close" aria-label="Cancel">✕</button>
    </div>
    <div class="rec-pop__time">0:00</div>
    <button type="button" class="rec-pop__btn">● Start</button>
  `;
  document.body.appendChild(recPop);
  const timeEl = recPop.querySelector('.rec-pop__time');
  const btn = recPop.querySelector('.rec-pop__btn');
  recPop.querySelector('.rec-pop__close').addEventListener('click', closeRecordPopup);

  btn.addEventListener('click', async () => {
    if (!micRecorder.active) {
      btn.disabled = true;
      try {
        await micRecorder.start();
      } catch (err) {
        console.error('Mic recording could not start:', err);
        showHintToast('Microphone access was denied or is unavailable.');
        closeRecordPopup();
        return;
      }
      btn.disabled = false;
      btn.textContent = '■ Stop';
      btn.classList.add('is-armed');
      recTimerId = setInterval(() => { timeEl.textContent = formatElapsed(micRecorder.elapsed); }, 200);
    } else {
      clearInterval(recTimerId);
      recTimerId = null;
      btn.disabled = true;
      const result = await micRecorder.stop();
      closeRecordPopup();
      if (result) await sampler.assignRecording(i, result.blob);
    }
  });
}

/* ---------- Sample-Editor (Trim + Filter) ----------
 * Grösseres Popup wie das Aufnahme-Popup, mit Wellenform + zwei ziehbaren
 * Trim-Marken, einem Preview-Button und den 4 Filter-Reglern. Die Amp-
 * Hüllkurve (Attack/Decay/Release) lebt NICHT mehr hier -- die steht jetzt
 * automatisierbar direkt im Hauptpanel (s. buildControls()), eine einzige
 * Bedienstelle statt zweier auseinanderlaufender Kopien derselben Felder.
 * Änderungen wirken sofort (kein "Übernehmen"-Schritt, wie jeder andere
 * Regler in der App). Die verbliebenen Filter-Regler bleiben bewusst NICHT
 * automatisierbar: die Knobs leben nur so lange wie das Popup, das
 * bestehende Automation-System geht von einem dauerhaft vorhandenen Knob-
 * Element aus (s. Tune/Level/Envelope-Reihen im Panel) -- für Sound-
 * Design-Regler, die man selten mitten in einer Aufnahme dreht, ist das
 * ein akzeptabler Verzicht statt echte Ephemeral-Knob-Unterstützung ins
 * Automation-System nachzurüsten. */
let sampleEditorPop = null;

function closeSampleEditor() {
  sampleEditorPop?.remove();
  sampleEditorPop = null;
}

function openSampleEditor(sampler, i) {
  dismissPadMenu();
  closeSampleEditor();
  const tr = sampler.tracks[i];

  const pop = document.createElement('div');
  pop.className = 'sample-editor';
  pop.innerHTML = `
    <div class="sample-editor__head">
      <span class="sample-editor__title">Edit — ${tr.name}</span>
      <button type="button" class="sample-editor__close" aria-label="Close">✕</button>
    </div>
    <div class="sample-editor__wave">
      <canvas class="sample-editor__canvas"></canvas>
    </div>
    <div class="sample-editor__trim-readout"></div>
    <button type="button" class="sample-editor__preview">▶ Preview</button>

    <div class="sample-editor__section">Filter</div>
    <div class="seg sample-editor__filter-type">
      ${FILTER_DELAY_TYPES.map((t) => `
        <button type="button" class="seg__btn${tr.filterType === t.value ? ' is-active' : ''}" data-filter-type="${t.value}">${t.label}</button>
      `).join('')}
    </div>
    <div class="sample-editor__knobs">
      <x-knob label="Cutoff" min="80" max="20000" value="${tr.cutoff}" curve="log" unit="Hz" data-p="cutoff"></x-knob>
      <x-knob label="Reso" min="0.5" max="20" value="${tr.resonance}" data-p="resonance"></x-knob>
      <x-knob label="Env Amt" min="0" max="1" value="${tr.envAmt}" data-p="envAmt"></x-knob>
      <x-knob label="F.Decay" min="0.03" max="1.5" value="${tr.fDecay}" curve="log" unit="s" data-p="fDecay"></x-knob>
    </div>
  `;
  document.body.appendChild(pop);
  sampleEditorPop = pop;

  pop.querySelector('.sample-editor__close').addEventListener('click', closeSampleEditor);
  pop.querySelector('.sample-editor__preview').addEventListener('click', () => sampler.previewPad(i));

  pop.querySelectorAll('[data-filter-type]').forEach((btn) => {
    btn.addEventListener('click', () => {
      tr.filterType = btn.dataset.filterType;
      pop.querySelectorAll('[data-filter-type]').forEach((b) => b.classList.toggle('is-active', b === btn));
    });
  });

  pop.querySelectorAll('.sample-editor__knobs x-knob').forEach((knob) => {
    knob.addEventListener('input', (e) => { tr[knob.dataset.p] = e.detail.value; });
  });

  setupWaveformEditor(
    pop.querySelector('.sample-editor__canvas'),
    pop.querySelector('.sample-editor__trim-readout'),
    tr,
  );
}

/** Peak-pro-Pixel-Wellenform (min/max je Spalte) über einen Ausschnitt
 *  [startIdx, endIdx) der Kanaldaten -- Standardansatz fürs Zeichnen
 *  langer Audiodaten in eine schmale, feste Breite, ohne jeden einzelnen
 *  Sample-Frame zu rendern. Der Ausschnitt ist das aktuelle Zoom-
 *  Sichtfenster (s. setupWaveformEditor); ohne Zoom deckt er die ganze
 *  Kanal-Länge ab. */
function computePeaks(data, width, startIdx = 0, endIdx = data.length) {
  const step = Math.max(1, Math.floor((endIdx - startIdx) / width));
  const peaks = [];
  for (let x = 0; x < width; x++) {
    let min = 0, max = 0;
    const s = startIdx + x * step;
    const e = Math.min(endIdx, s + step);
    for (let j = s; j < e; j++) {
      const v = data[j];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    peaks.push([min, max]);
  }
  return peaks;
}

const MIN_ZOOM_DUR = 0.02; // 20ms -- sinnvolle Grenze fürs Reinzoomen

/** Wellenform zeichnen + zwei ziehbare Trim-Marken, plus Zwei-Finger-Zoom
 *  (Pinch) und Ein-Finger-Pan im gezoomten Zustand, Doppel-Tap setzt den
 *  Zoom zurück. Trim-Handle-Drag folgt demselben Pointer-Idiom wie der
 *  X/Y-Pad (jam-view.js#buildXYPad): pointerdown/setPointerCapture/
 *  getBoundingClientRect-Clamping, hier für zwei statt einen Handle, die
 *  sich gegenseitig nicht überholen können. Zoom/Pan verschieben nur das
 *  Sichtfenster (viewStart/viewEnd) -- trimStart/trimEnd (echte
 *  Wiedergabegrenzen) sind davon unabhängig, nur ihre Bildschirmposition
 *  hängt vom aktuellen Sichtfenster ab (s. timeToX). */
function setupWaveformEditor(canvas, readout, tr) {
  const buffer = tr.buffer;
  const dur = buffer.duration;
  const sampleRate = buffer.sampleRate;
  const channelData = buffer.getChannelData(0);
  // trimEnd kann noch Infinity sein (Pad, das seit dem Laden nie
  // getriggert/editiert wurde) -- hier auf die echte Dauer klemmen.
  if (!Number.isFinite(tr.trimEnd) || tr.trimEnd > dur) tr.trimEnd = dur;
  tr.trimStart = Math.min(Math.max(0, tr.trimStart), dur);

  const cssWidth = 280;
  const cssHeight = 90;
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  canvas.width = cssWidth * dpr;
  canvas.height = cssHeight * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  hintOnce('sampler-editor-zoom', () => showHintToast(
    'Pinch the waveform to zoom in, double-tap to reset.'
  ));

  // Zoom-/Pan-Sichtfenster -- startet komplett rausgezoomt (volle Dauer).
  let viewStart = 0;
  let viewEnd = dur;
  let peaks = computePeaks(channelData, cssWidth, 0, channelData.length);

  const timeToX = (s) => ((s - viewStart) / (viewEnd - viewStart)) * cssWidth;
  const xToTime = (x) => viewStart + (x / cssWidth) * (viewEnd - viewStart);

  const draw = () => {
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    const mid = cssHeight / 2;
    ctx.strokeStyle = '#8a7f68';
    ctx.beginPath();
    for (let x = 0; x < cssWidth; x++) {
      const [min, max] = peaks[x];
      ctx.moveTo(x + 0.5, mid + min * mid);
      ctx.lineTo(x + 0.5, mid + max * mid);
    }
    ctx.stroke();

    const xs = timeToX(tr.trimStart);
    const xe = timeToX(tr.trimEnd);
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    ctx.fillRect(0, 0, Math.max(0, Math.min(cssWidth, xs)), cssHeight);
    const xeClamped = Math.max(0, Math.min(cssWidth, xe));
    ctx.fillRect(xeClamped, 0, cssWidth - xeClamped, cssHeight);
    ctx.fillStyle = '#ffb84d';
    if (xs >= -4 && xs <= cssWidth + 4) ctx.fillRect(xs - 1.5, 0, 3, cssHeight);
    if (xe >= -4 && xe <= cssWidth + 4) ctx.fillRect(xe - 1.5, 0, 3, cssHeight);

    readout.textContent = `${tr.trimStart.toFixed(2)}s – ${tr.trimEnd.toFixed(2)}s`;
  };
  draw();

  /** Sichtfenster nach Zoom/Pan neu einklemmen (nicht unter MIN_ZOOM_DUR,
   *  nicht über die Buffer-Grenzen hinaus), dann Peaks + Zeichnung
   *  auffrischen. */
  const applyView = () => {
    if (viewEnd - viewStart < MIN_ZOOM_DUR) {
      const c = (viewStart + viewEnd) / 2;
      viewStart = c - MIN_ZOOM_DUR / 2;
      viewEnd = c + MIN_ZOOM_DUR / 2;
    }
    if (viewStart < 0) { viewEnd -= viewStart; viewStart = 0; }
    if (viewEnd > dur) { viewStart -= (viewEnd - dur); viewEnd = dur; }
    viewStart = Math.max(0, viewStart);
    viewEnd = Math.min(dur, viewEnd);
    const startIdx = Math.floor(viewStart * sampleRate);
    const endIdx = Math.ceil(viewEnd * sampleRate);
    peaks = computePeaks(channelData, cssWidth, startIdx, endIdx);
    draw();
  };

  const HANDLE_HIT = 14; // px Trefferbereich um jeden Handle
  let dragging = null; // 'start' | 'end' | 'pan' | null
  let panStartX = 0;
  let panStartView = null;
  let lastTapAt = 0;

  const activePointers = new Map(); // pointerId -> {x, y}
  let pinch = null;

  const pointerDist = () => {
    const [a, b] = [...activePointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  const pointerMidX = (rect) => {
    const [a, b] = [...activePointers.values()];
    return (a.x + b.x) / 2 - rect.left;
  };

  canvas.addEventListener('pointerdown', (e) => {
    const rect = canvas.getBoundingClientRect();
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (activePointers.size === 2) {
      dragging = null; // eine evtl. laufende Handle-/Pan-Geste des ersten Fingers abbrechen
      pinch = {
        startDist: pointerDist(),
        midTime: xToTime(pointerMidX(rect)),
        startSpan: viewEnd - viewStart,
      };
      e.preventDefault();
      return;
    }
    if (activePointers.size > 2) return; // dritter Finger: ignorieren

    const now = performance.now();
    if (now - lastTapAt < 300) {
      lastTapAt = 0;
      viewStart = 0; viewEnd = dur;
      applyView();
      return;
    }
    lastTapAt = now;

    const x = e.clientX - rect.left;
    const xs = timeToX(tr.trimStart);
    const xe = timeToX(tr.trimEnd);
    if (Math.abs(x - xs) <= HANDLE_HIT && Math.abs(x - xs) <= Math.abs(x - xe)) {
      dragging = 'start';
    } else if (Math.abs(x - xe) <= HANDLE_HIT) {
      dragging = 'end';
    } else if (viewEnd - viewStart < dur - 0.001) {
      // reingezoomt und nicht auf einem Handle: Sichtfenster verschieben
      dragging = 'pan';
      panStartX = x;
      panStartView = { start: viewStart, end: viewEnd };
    } else {
      return;
    }
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!activePointers.has(e.pointerId)) return;
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const rect = canvas.getBoundingClientRect();

    if (pinch && activePointers.size === 2) {
      const ratio = pointerDist() / Math.max(1, pinch.startDist);
      const newSpan = Math.min(dur, Math.max(MIN_ZOOM_DUR, pinch.startSpan / ratio));
      const midRatio = pointerMidX(rect) / cssWidth;
      // Zeit unterm Pinch-Mittelpunkt bleibt fix, egal wie stark gezoomt wird.
      viewStart = pinch.midTime - newSpan * midRatio;
      viewEnd = viewStart + newSpan;
      applyView();
      return;
    }
    if (!dragging) return;
    if (dragging === 'pan') {
      const x = e.clientX - rect.left;
      const dt = ((x - panStartX) / cssWidth) * (panStartView.end - panStartView.start);
      viewStart = panStartView.start - dt;
      viewEnd = panStartView.end - dt;
      applyView();
      return;
    }
    const t = xToTime(e.clientX - rect.left);
    if (dragging === 'start') tr.trimStart = Math.min(t, tr.trimEnd - 0.01);
    else tr.trimEnd = Math.max(t, tr.trimStart + 0.01);
    draw();
  });

  const releasePointer = (e) => {
    activePointers.delete(e.pointerId);
    if (activePointers.size < 2) pinch = null;
    if (activePointers.size === 0) dragging = null;
  };
  canvas.addEventListener('pointerup', releasePointer);
  canvas.addEventListener('pointercancel', releasePointer);
}
