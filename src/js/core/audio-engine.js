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
    /** @type {GainNode|null}  Send-Bus zum Master-Delay (fx.js) */
    this.delayBus = null;
    /** @type {GainNode|null}  Send-Bus zum Master-Reverb (fx.js) */
    this.reverbBus = null;
    /** @type {AnalyserNode|null}  Master-Abgriff fürs VU-Meter */
    this.analyser = null;
    /** @type {GainNode|null}  Feste Anker-Punkte für MasterFX' Insert-Kette
     *  (s. fx.js#rewireMasterInsertChain) -- masterChainIn/-Out bleiben
     *  UNVERÄNDERT verbunden (masterBus->chainIn, chainOut->limiter),
     *  MasterFX splict seine 0..n Inserts nur ZWISCHEN den beiden um,
     *  genau wie Machine#rewireInsertChain zwischen output/panner. Leer
     *  verbindet chainIn direkt mit chainOut (Identität, kein Unterschied
     *  zum bisherigen Verhalten ohne Insert-Kette). */
    this.masterChainIn = null;
    this.masterChainOut = null;
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
    if (this.unlocked) this.#primeAudioPipeline();
    return this.unlocked;
  }

  /** Ein einziger, lautloser Sample-Frame direkt nach dem Aufwecken --
   *  ohne das bleibt die allererste AudioParam-Automation, die je auf
   *  dieser Session geplant wird (z. B. eine Oszillator-Tonhöhe beim
   *  ersten je gespielten Modular-Ton), auf manchen Geräten für ein paar
   *  Dutzend Millisekunden hörbar auf ihrem Startwert hängen, bevor sie
   *  greift (Nutzer-Bugreport: "vor der ersten Note im Modular höre ich
   *  noch einen höher gepitchten Sound" -- reproduzierbar exakt beim
   *  ersten Notenanschlag nach App-Start, danach nie wieder). Bekannter
   *  Kaltstart-Effekt frisch aufgeweckter AudioContexts, u. a. auf iOS
   *  Safari; das gängige Gegenmittel ist genau das hier: die Render-Pipeline
   *  einmal mit echtem (wenn auch lautlosem) Audiomaterial anlaufen lassen,
   *  BEVOR die erste echte Automation eines Nutzer-Tons drankommt. */
  #primeAudioPipeline() {
    const buffer = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.ctx.destination);
    src.start();
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

    // Anker-Punkte für MasterFX' frei bestückbare Insert-Kette -- direkt
    // verbunden, solange sie leer ist (s. Feld-Kommentar oben).
    this.masterChainIn = ctx.createGain();
    this.masterChainOut = ctx.createGain();
    this.masterBus.connect(this.masterChainIn);
    this.masterChainIn.connect(this.masterChainOut);
    this.masterChainOut.connect(this.limiter);
    this.limiter.connect(ctx.destination);

    // FX-Send-Busse: Maschinen docken hier zusätzlich an (Post-Fader).
    // Die Effekt-Ketten dahinter baut js/core/fx.js in init() auf und
    // führt sie zurück in den masterBus (→ läuft mit durch den Limiter).
    this.delayBus = ctx.createGain();
    this.reverbBus = ctx.createGain();

    // Abgriff für das VU-Meter — NACH dem Limiter, zeigt also das
    // tatsächliche Ausgangssignal (reiner Tap, geht nirgendwo hin)
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.limiter.connect(this.analyser);
  }

  /**
   * Einen pausierten Context wiederbeleben. iOS hält den AudioContext an,
   * wenn die App in den Hintergrund geht (z. B. Jam-Code per Messenger
   * verschicken) — und startet ihn NICHT von selbst wieder. Zustand ist
   * dann 'suspended' oder (iOS-eigen) 'interrupted'. Idempotent & billig:
   * bei laufendem Context passiert nichts.
   */
  resume() {
    if (this.ctx && this.ctx.state !== 'running') {
      this.ctx.resume().catch(() => { /* nächste Geste versucht es erneut */ });
    }
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
