/**
 * AudioEngine — zentrale Verwaltung des AudioContext.
 *
 * Warum so gebaut:
 * - Mobile Browser (und Capacitor-WebViews) erlauben Audio erst nach einer
 *   Nutzergeste. Der Context wird deshalb erst in unlock() erzeugt/resumed.
 * - Alle Maschinen hängen an einem gemeinsamen Master-Bus mit Limiter,
 *   damit nichts clippt, egal wie viele Maschinen spielen.
 * - Singleton: eine App = ein AudioContext (mehrere sind auf iOS fragil).
 */
class AudioEngine {
  constructor() {
    /** @type {AudioContext|null} */
    this.ctx = null;
    /** @type {GainNode|null}  Master-Summe, hier docken Maschinen an */
    this.masterBus = null;
    /** @type {DynamicsCompressorNode|null} */
    this.limiter = null;
    this.unlocked = false;
  }

  /**
   * Muss aus einer Nutzergeste heraus aufgerufen werden (pointerdown/click).
   * Idempotent — mehrfacher Aufruf schadet nicht.
   */
  async unlock() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)({
        latencyHint: 'interactive',
      });
      this.#buildMasterChain();
    }
    if (this.ctx.state !== 'running') {
      await this.ctx.resume();
    }
    this.unlocked = this.ctx.state === 'running';
    return this.unlocked;
  }

  #buildMasterChain() {
    const ctx = this.ctx;

    this.masterBus = ctx.createGain();
    // Bewusst Headroom lassen: Der Limiter soll Sicherheitsnetz sein,
    // kein Dauer-Effekt. Ständiges Pumpen macht Transienten (v. a. den
    // Kick-Attack) von Anschlag zu Anschlag hörbar unterschiedlich,
    // weil die Gain-Reduktion vom restlichen Mix-Moment abhängt.
    this.masterBus.gain.value = 0.65;

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -2;
    this.limiter.knee.value = 1;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.003;
    // Langsameres Release: Falls er doch arbeitet, bleibt die Reduktion
    // über die Hits hinweg gleichmäßiger statt pro Schlag zu springen.
    this.limiter.release.value = 0.25;

    this.masterBus.connect(this.limiter);
    this.limiter.connect(ctx.destination);
  }

  /** Aktuelle Audio-Zeit (Sekunden), 0 solange nicht entsperrt. */
  get now() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  /**
   * Rundet eine geplante Startzeit auf die nächste Render-Quantum-Grenze
   * AUF (128 Samples). Web-Audio-Engines rechnen in 128er-Blöcken; je nach
   * Browser werden Quellen-Starts unterschiedlich in den Block einsortiert.
   * Bei streng periodischen Triggern wird daraus ein hörbares Muster:
   * 0,5 s Kick-Abstand bei 48 kHz = 24 000 Samples = 187,5 Blöcke → jeder
   * zweite Schlag liegt anders im Block und klingt minimal anders (v. a.
   * der Attack von Sounds mit Pitch-Hüllkurve). Auf der Blockgrenze ist
   * jeder Anschlag identisch ausgerichtet; Kosten: max. ~2,7 ms Versatz.
   */
  quantizeTime(t) {
    if (!this.ctx) return t;
    const quantum = 128 / this.ctx.sampleRate;
    return Math.ceil(t / quantum) * quantum;
  }
}

/** App-weites Singleton */
export const engine = new AudioEngine();
