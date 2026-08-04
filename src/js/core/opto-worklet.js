/**
 * Optischer Kompressor mit PROGRAMMABHÄNGIGEM Release ("T4-Memory-Effekt"),
 * als AudioWorkletProcessor -- Ersatz für die bisherige DEFS.opto-Fassung,
 * die eine native DynamicsCompressorNode mit einer EINZIGEN, festen
 * Release-Zeit (0.5s) nutzt.
 *
 * Was am Original (LA-2A, T4-Elektrolumineszenzzelle) fehlte: die Zelle hat
 * ein "Gedächtnis" -- ein kurzer, knapper Pegelausreisser klingt schnell
 * wieder ab, aber nach einer LÄNGEREN, starken Kompressionsphase bleibt die
 * Zelle noch eine Weile "eingedunkelt" und braucht sichtbar länger, um sich
 * zu erholen (klassisch beschrieben als: ~50% der Erholung in ~60-80ms,
 * der Rest zieht sich bei starker/lang anhaltender Kompression über
 * mehrere Sekunden). Eine feste Release-Zeit (egal ob 60ms oder 3s) kann
 * das GRUNDSÄTZLICH nicht abbilden, weil sie nicht davon abhängt, WIE die
 * Kompression bisher verlaufen ist ("Programm" = das Nutzsignal selbst).
 *
 * Ansatz: ein zusätzlicher, sehr langsamer "Memory"-Integrator verfolgt,
 * wie stark/lang zuletzt komprimiert wurde -- er speist sich aus der
 * geglätteten Gain-Reduction-Tiefe und wandert selbst nur träge (Zeit-
 * konstante MEMORY_TAU_S). Die tatsächlich für die Release-Hüllkurve
 * genutzte Zeitkonstante wird LIVE zwischen FAST_RELEASE_S (kurzer
 * Ausreisser, Memory niedrig) und SLOW_RELEASE_S (nach anhaltend starker
 * Kompression, Memory hoch) interpoliert -- kein bit-genaues Bauteil-
 * modell (dieselbe ehrliche "Tribut statt Emulation"-Haltung wie beim
 * bisherigen Attack/Release/Knee-Kompromiss, s. core/inserts.js#DEFS.opto),
 * aber GENAU der Mechanismus, der "Programmabhängigkeit" überhaupt erst
 * möglich macht (mit einer nativen DynamicsCompressorNode, die nur einen
 * EINZIGEN, konstanten .release-Wert kennt, ist das architektonisch
 * unmöglich -- deshalb jetzt ein eigener Gain-Computer statt der bisherigen
 * Fassung).
 *
 * Weich-Knie-Formel (Standard-Kompressor-Gain-Computer, z. B. Giannoulis/
 * Massberg/Reiss "Digital Dynamic Range Compressor Design") statt hartem
 * Knick -- passt zum Original, das ebenfalls keinen harten Schwellwert hat,
 * sondern durchgehend sanft komprimiert.
 *
 * Stereo-verkoppelt (Pegel-Erkennung nimmt den lauteren Kanal, dieselbe
 * Gain gilt für alle Kanäle) -- wie ein echter Stereo-Opto-Kompressor,
 * verhindert Stereobild-Verschiebung.
 */
export const OPTO_WORKLET_SRC = `
const MAX_CHANNELS = 8;
const ATTACK_S = 0.01;
const FAST_RELEASE_S = 0.06;
const SLOW_RELEASE_S = 3.0;
const MEMORY_TAU_S = 1.5;
// Reduktionstiefe (dB), bei der das Memory praktisch voll gesättigt ist
// (Release dann nahe SLOW_RELEASE_S) -- 15dB ist bereits deutlich hörbare
// Kompression, kein Extremfall.
const MEMORY_REFERENCE_DB = 15;

class RackwerkOptoProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -4, minValue: -40, maxValue: 0, automationRate: 'k-rate' },
      { name: 'ratio', defaultValue: 3, minValue: 1, maxValue: 20, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.attackCoeff = Math.exp(-1 / (sampleRate * ATTACK_S));
    this.fastReleaseCoeff = Math.exp(-1 / (sampleRate * FAST_RELEASE_S));
    this.slowReleaseCoeff = Math.exp(-1 / (sampleRate * SLOW_RELEASE_S));
    this.memoryCoeff = Math.exp(-1 / (sampleRate * MEMORY_TAU_S));
    this.smoothedReductionDb = 0;
    this.memory = 0;
    this.samplesSinceReport = 0;
    this.KNEE_DB = 18;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || !output.length || !output[0].length) return true;
    const numCh = Math.min(output.length, MAX_CHANNELS);
    const n = output[0].length;
    const thresholdDb = parameters.threshold[0];
    const ratio = parameters.ratio[0];
    const knee = this.KNEE_DB;

    for (let i = 0; i < n; i++) {
      let level = 0;
      for (let ch = 0; ch < numCh; ch++) {
        const inCh = input && input[ch] ? input[ch] : (input && input[0] ? input[0] : null);
        const v = inCh ? Math.abs(inCh[i]) : 0;
        if (v > level) level = v;
      }
      const levelDb = 20 * Math.log10(Math.max(level, 1e-6));
      const overDb = levelDb - thresholdDb;

      // Weiches Knie um die Schwelle (Standard-Gain-Computer-Formel).
      let targetReductionDb;
      if (overDb <= -knee / 2) targetReductionDb = 0;
      else if (overDb >= knee / 2) targetReductionDb = overDb * (1 - 1 / ratio);
      else {
        const x = overDb + knee / 2;
        targetReductionDb = ((1 - 1 / ratio) * x * x) / (2 * knee);
      }

      // Release-Zeitkonstante LIVE aus dem Memory ableiten -- der eigentliche
      // "T4-Memory"-Mechanismus, s. Dateikopf.
      const releaseCoeff = this.fastReleaseCoeff + (this.slowReleaseCoeff - this.fastReleaseCoeff) * this.memory;

      if (targetReductionDb > this.smoothedReductionDb) {
        this.smoothedReductionDb += (targetReductionDb - this.smoothedReductionDb) * (1 - this.attackCoeff);
      } else {
        this.smoothedReductionDb += (targetReductionDb - this.smoothedReductionDb) * (1 - releaseCoeff);
      }

      const memoryTarget = Math.max(0, Math.min(1, this.smoothedReductionDb / MEMORY_REFERENCE_DB));
      this.memory += (memoryTarget - this.memory) * (1 - this.memoryCoeff);

      const gain = Math.pow(10, -this.smoothedReductionDb / 20);
      for (let ch = 0; ch < numCh; ch++) {
        const inCh = input && input[ch] ? input[ch] : (input && input[0] ? input[0] : null);
        output[ch][i] = (inCh ? inCh[i] : 0) * gain;
      }
    }

    this.samplesSinceReport += n;
    if (this.samplesSinceReport >= 512) {
      this.samplesSinceReport = 0;
      this.port.postMessage({ reductionDb: -this.smoothedReductionDb });
    }
    return true;
  }
}
registerProcessor('rackwerk-opto', RackwerkOptoProcessor);
`;
