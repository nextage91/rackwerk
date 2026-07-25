/**
 * mic-recorder — nimmt das Mikrofon per MediaRecorder auf (für Sampler-
 * Aufnahmen, s. machines/sampler.js). Analog zu recorder.js (Master-
 * Aufnahme), aber Quelle ist getUserMedia() (Rohsignal, Verarbeitungs-
 * Constraints bewusst aus, s. start()) statt der Master-Bus -- erster Ort
 * im Code, der Mikrofon- (nicht Kamera-)Zugriff anfragt;
 * der Berechtigungsdialog erscheint beim ersten Aufruf. Deshalb ist
 * start() hier (anders als recorder.js) async: die Freigabe muss erst
 * abgewartet werden, bevor der MediaRecorder überhaupt existiert.
 */
const MIME_CANDIDATES = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];

class MicRecorder {
  constructor() {
    this.rec = null;
    this.stream = null;
    this.chunks = [];
    this.startedAt = 0;
  }

  get supported() {
    return typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  }

  get active() {
    return this.rec?.state === 'recording';
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
    // getUserMedia({audio:true}) mit den Browser-Defaults (meist alle drei
    // AN) an. Auf iOS/WebKit schaltet genau das die geteilte Audio-Session
    // in einen "Recording"-Modus, der die GESAMTE App-Wiedergabelautstärke
    // drosselt -- und dieser Modus bleibt oft hängen, auch nachdem die
    // Aufnahme längst gestoppt ist (Stoppen der MediaStreamTracks setzt die
    // Audio-Session-Kategorie nicht zurück; s. Nutzer-Bugreport: alle
    // Instrumente dauerhaft leiser nach einer Sample-Aufnahme). Nebenbei
    // auch inhaltlich richtig fürs Sample-Recording: Auto-Gain/Noise-Gate/
    // Echo-Cancellation verfälschen das aufgenommene Instrument (pumpender
    // Pegel, gated Ausklang) -- für einen Sampler will man das unbearbeitete
    // Rohsignal, nicht auf Sprachtelefonie optimiertes Audio.
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const mime = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported?.(m));
    this.rec = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.chunks = [];
    this.rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.rec.start(250); // regelmäßige Chunks → nichts geht bei Abbruch verloren
    this.startedAt = performance.now();
    return true;
  }

  /** @returns {Promise<{blob: Blob, seconds: number}|null>} */
  stop() {
    if (!this.active) return Promise.resolve(null);
    const seconds = this.elapsed;
    return new Promise((resolve) => {
      this.rec.onstop = () => {
        const type = this.rec.mimeType || 'audio/webm';
        const blob = new Blob(this.chunks, { type });
        this.stream.getTracks().forEach((t) => t.stop()); // Mikro-Indikator/Ressource freigeben
        this.rec = null;
        this.stream = null;
        resolve({ blob, seconds });
      };
      this.rec.stop();
    });
  }

  /** Abbrechen ohne Ergebnis (z. B. Popup zu, während aufgenommen wird). */
  cancel() {
    if (!this.active) return;
    this.rec.onstop = () => { this.stream.getTracks().forEach((t) => t.stop()); };
    this.rec.stop();
    this.rec = null;
    this.stream = null;
  }
}

export const micRecorder = new MicRecorder();
