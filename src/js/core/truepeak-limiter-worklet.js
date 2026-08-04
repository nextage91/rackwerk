/**
 * Brickwall-Limiter mit echter Inter-Sample-Peak-(True-Peak-)Erkennung, als
 * AudioWorkletProcessor -- Ersatz für die bisherige DynamicsCompressorNode-
 * Fassung von DEFS.limiter (core/inserts.js), die NUR die diskreten Sample-
 * Werte selbst gegen die Schwelle prüft.
 *
 * Warum das ein echtes Loch ist: ein DAC rekonstruiert zwischen zwei Samples
 * ein durchgehendes (bandbegrenztes) Signal -- bei scharfkantigem Programm-
 * material (übersteuerte/geclippte Quellen, harte Transienten, hochfrequenz-
 * reiche Wellenformen) kann dieses rekonstruierte Signal ZWISCHEN zwei
 * Samples höher ausschlagen als jeder einzelne Sample-Wert selbst (siehe
 * ITU-R BS.1770/EBU R128 "True Peak"). Ein reiner Sample-Peak-Limiter lässt
 * so ein Signal unangetastet durch, obwohl es beim Playback/erneuten
 * Wandeln/verlustbehafteten Kodieren echte Clipping-Artefakte erzeugen kann
 * (nachgemessen mit einem hart geclippten 8kHz-Ton: Sample-Peak 0.9, echter
 * rekonstruierter Peak ~1.01 -- über 0dBFS, obwohl scheinbar sicher).
 *
 * Ansatz: kubische Catmull-Rom-Interpolation (4 Stützstellen, 3 zusätzliche
 * Zwischenwerte bei 4x-Überabtastung) statt einer vollen Sinc-/FIR-
 * Überabtastung wie im Broadcast-Standard -- deutlich billiger, für ein
 * Echtzeit-Mastering-Werkzeug im Browser aber immer noch klar empfindlicher
 * als reine Sample-Peaks (bestätigt an geclipptem/Sägezahn-Testmaterial,
 * s. tools/dsp-tests/limiter-truepeak.mjs) und OHNE die grosse feste
 * Latenz eines langen FIR-Filters.
 *
 * Architektur: Lookahead-Limiter mit einem "Minimum-Hold"-Fenster --
 *  1. Für jedes eintreffende Sample wird (kanalübergreifend, stereo-
 *     verkoppelt -- ein Mastering-Limiter darf das Stereobild nicht durch
 *     unabhängige Gain-Reduktion pro Kanal verschieben) der interpolierte
 *     True-Peak geschätzt und daraus ein GEWÜNSCHTES Ziel-Gain (<=1)
 *     berechnet: wie stark müsste man DIESES eine Sample dämpfen, damit es
 *     die Ceiling nicht reisst.
 *  2. Der tatsächlich verwendete Gain für ein Sample ist das Minimum all
 *     dieser Ziel-Gains über die kommenden LOOKAHEAD Samples (ein "Minimum-
 *     Hold"-Fenster) -- dadurch beginnt die Dämpfung schon VOR dem
 *     eigentlichen Peak zu greifen (kein hörbarer Attack nötig, obwohl die
 *     Reaktion pro Sample technisch sofort ist), das Audio selbst wird
 *     exakt um LOOKAHEAD Samples verzögert ausgegeben, damit beides zeitlich
 *     zusammenpasst.
 *  3. Das Gain darf jederzeit SOFORT fallen (die Vorausschau hat es ja
 *     schon "kommen sehen"), aber nur mit der Release-Zeitkonstante wieder
 *     steigen -- klassisches Feedforward-Limiter-Verhalten, ohne die
 *     Pumpen-Artefakte eines reinen Attack/Release-Hüllkurvenfolgers.
 *
 * Der naive Scan über das Minimum-Hold-Fenster (ein simples "finde das
 * Minimum der letzten LOOKAHEAD Werte" ohne cleveren Monotonic-Deque-Trick)
 * kostet pro Sample O(LOOKAHEAD) -- bei ~150 Samples Fenstergrösse und 128
 * Samples/Block sind das ~19200 einfache Vergleiche pro Block, weit
 * innerhalb des Zeitbudgets (Block ist bei 48kHz ~2.7ms) und deutlich
 * weniger fehleranfällig als eine inkrementelle Datenstruktur.
 *
 * Wie bei allen Worklets hier: exportiert nur den Quelltext als String, per
 * Blob-URL zur Laufzeit geladen (s. core/inserts.js#ensureSimpleWorklet).
 */
export const TRUEPEAK_LIMITER_WORKLET_SRC = `
const LOOKAHEAD_MS = 3;
const OVERSAMPLE = 4;
const MAX_CHANNELS = 8;

class RackwerkTruePeakLimiterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'ceiling', defaultValue: -0.5, minValue: -20, maxValue: 0, automationRate: 'k-rate' },
      { name: 'release', defaultValue: 0.05, minValue: 0.01, maxValue: 0.5, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.lookahead = Math.max(16, Math.round(sampleRate * LOOKAHEAD_MS / 1000));
    // +8 Puffer: 2 Samples Vorlauf, bis eine Zielposition mit ihren vollen
    // 4 Interpolations-Stützstellen "final" ist (s. finalizeGainTarget unten),
    // plus etwas Sicherheitsabstand gegen Off-by-one an den Rändern.
    this.bufLen = this.lookahead + 8;
    this.delayBuf = [];
    for (let ch = 0; ch < MAX_CHANNELS; ch++) this.delayBuf.push(new Float64Array(this.bufLen));
    // EIN gemeinsamer Ziel-Gain-Ring -- Stereo-Kopplung: die stärkste
    // Dämpfungsanforderung irgendeines Kanals gilt für ALLE Kanäle.
    this.gainTarget = new Float64Array(this.bufLen).fill(1);
    this.writePos = 0;
    this.currentGain = 1;
    this.lastCeilingDb = NaN;
    this.ceilingLin = 1;
    this.lastReleaseS = NaN;
    this.releaseCoef = 0;
    // Für die Meter-Anzeige im Haupt-Thread (s. core/inserts.js#DEFS.limiter) --
    // dort kann kein Audio-Thread-Zustand direkt gelesen werden, deshalb
    // periodisch per Message zurückmelden (wie core/pitchtrack-worklet.js).
    this.samplesSinceReport = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || !output.length || !output[0].length) return true;

    const ceilingDb = parameters.ceiling[0];
    if (ceilingDb !== this.lastCeilingDb) {
      this.lastCeilingDb = ceilingDb;
      this.ceilingLin = Math.pow(10, ceilingDb / 20);
    }
    const releaseS = parameters.release[0];
    if (releaseS !== this.lastReleaseS) {
      this.lastReleaseS = releaseS;
      this.releaseCoef = Math.exp(-1 / (sampleRate * Math.max(0.001, releaseS)));
    }

    const numCh = Math.min(output.length, MAX_CHANNELS);
    const n = output[0].length;
    const bufLen = this.bufLen;
    const lookahead = this.lookahead;

    for (let i = 0; i < n; i++) {
      const wp = this.writePos;
      for (let ch = 0; ch < numCh; ch++) {
        const inCh = input && input[ch] ? input[ch] : (input && input[0] ? input[0] : null);
        this.delayBuf[ch][wp] = inCh ? inCh[i] : 0;
      }

      // Ziel-Gain für p = wp-2 finalisieren -- braucht s(p-1)..s(p+2), die
      // jetzt (nach dem Schreiben von wp=p+2) alle vorliegen.
      const p = (wp - 2 + bufLen) % bufLen;
      let maxPeak = 0;
      for (let ch = 0; ch < numCh; ch++) {
        const buf = this.delayBuf[ch];
        const s0 = buf[(p - 1 + bufLen) % bufLen];
        const s1 = buf[p];
        const s2 = buf[(p + 1) % bufLen];
        const s3 = buf[(p + 2) % bufLen];
        const a0 = -0.5 * s0 + 1.5 * s1 - 1.5 * s2 + 0.5 * s3;
        const a1 = s0 - 2.5 * s1 + 2 * s2 - 0.5 * s3;
        const a2 = -0.5 * s0 + 0.5 * s2;
        const a3 = s1;
        let peak = Math.abs(s1);
        for (let k = 1; k < OVERSAMPLE; k++) {
          const t = k / OVERSAMPLE;
          const v = ((a0 * t + a1) * t + a2) * t + a3;
          const av = v < 0 ? -v : v;
          if (av > peak) peak = av;
        }
        if (peak > maxPeak) maxPeak = peak;
      }
      this.gainTarget[p] = maxPeak > this.ceilingLin ? this.ceilingLin / maxPeak : 1;

      this.writePos = (wp + 1) % bufLen;

      // Minimum-Hold über das Lookahead-Fenster [readPos .. writePos-2]
      // (bis writePos-2, NICHT weiter -- nur bis dahin sind Ziel-Gains
      // bereits finalisiert, s. oben).
      const readPos = (this.writePos - lookahead + bufLen) % bufLen;
      const windowEnd = (this.writePos - 2 + bufLen) % bufLen;
      const winLen = (windowEnd - readPos + bufLen) % bufLen + 1;
      let windowMin = 1;
      for (let k = 0; k < winLen; k++) {
        const v = this.gainTarget[(readPos + k) % bufLen];
        if (v < windowMin) windowMin = v;
      }

      const releaseCandidate = 1 - (1 - this.currentGain) * this.releaseCoef;
      this.currentGain = windowMin < releaseCandidate ? windowMin : releaseCandidate;

      for (let ch = 0; ch < numCh; ch++) {
        output[ch][i] = this.delayBuf[ch][readPos] * this.currentGain;
      }
    }

    this.samplesSinceReport += n;
    if (this.samplesSinceReport >= 512) {
      this.samplesSinceReport = 0;
      const reductionDb = 20 * Math.log10(Math.max(1e-6, this.currentGain));
      this.port.postMessage({ reductionDb });
    }
    return true;
  }
}
registerProcessor('rackwerk-truepeak-limiter', RackwerkTruePeakLimiterProcessor);
`;
