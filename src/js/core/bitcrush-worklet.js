/**
 * Bitcrusher (Sample-Rate-/Bit-Reduktion, wie Abletons "Redux") als
 * AudioWorkletProcessor.
 *
 * Zwei UNABHÄNGIGE Lo-Fi-Mechanismen in einem Knoten:
 *  - Bit-Tiefe (`bits`): reine Amplitudenquantisierung (Rundung auf eine
 *    feste Anzahl Stufen) -- könnte man auch mit einer WaveShaperNode-Kurve
 *    bauen (kein Speicherzustand nötig, reine Funktion des Momentanwerts,
 *    wie makeDriveCurve()/makeTapeCurve() in inserts.js), wird hier aber
 *    im selben Worklet miterledigt, weil Sample-Rate-Reduktion (s. u.)
 *    ohnehin einen eigenen Prozessor braucht.
 *  - Sample-Rate-Reduktion (`rate`): "Sample & Hold" -- ein Wert wird für
 *    mehrere echte Samples am Stück gehalten, bevor er durch den nächsten
 *    Eingangswert ersetzt wird. Das hat KEIN natives Web-Audio-Äquivalent
 *    (eine WaveShaperNode kennt nur den aktuellen Sample, kein Gedächtnis
 *    über die Zeit) und braucht daher zwingend eigenen, sample-genauen
 *    Zustand -- wie schon Gate/Frequency-Shifter/Beat-Repeat.
 *
 * BEWUSST keine Anti-Aliasing-Filterung vor der Dezimierung: das daraus
 * entstehende Aliasing (hohe Frequenzen falten sich zu neuen, unteren
 * Frequenzen) IST der gewünschte Effekt -- exakt der Klangcharakter alter
 * 8-Bit-Sampler/früher Digitalgeräte, die auch nicht anti-aliast haben.
 *
 * `jitter` verwackelt die Haltezeit zufällig um einen kleinen Prozentsatz
 * -- simuliert die unregelmässige Abtasttaktung billiger analoger Sample &
 * Hold-Schaltungen statt eines exakten digitalen Taktgebers, ein
 * klassischer zusätzlicher Lo-Fi-"Wackel"-Regler (wie Reduxs "Jitter").
 */
export const BITCRUSH_WORKLET_SRC = `
class RackwerkBitcrushProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rate', defaultValue: 8000, minValue: 200, maxValue: 48000, automationRate: 'k-rate' },
      { name: 'bits', defaultValue: 8, minValue: 1, maxValue: 16, automationRate: 'k-rate' },
      { name: 'jitter', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }
  constructor() {
    super();
    this.heldValue = new Float64Array(32);
    this.holdCounter = 1;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || !output.length || !output[0].length) return true;
    const rate = parameters.rate[0];
    const bits = parameters.bits[0];
    const jitter = parameters.jitter[0];
    const step = 1 / Math.pow(2, Math.max(1, Math.round(bits)) - 1);
    const basePeriod = sampleRate / Math.max(1, rate);
    const n = output[0].length;

    for (let i = 0; i < n; i++) {
      this.holdCounter -= 1;
      const needsNewSample = this.holdCounter <= 0;
      if (needsNewSample) {
        const jitterFactor = jitter > 0 ? 1 + (Math.random() * 2 - 1) * jitter * 0.5 : 1;
        this.holdCounter = Math.max(1, Math.round(basePeriod * jitterFactor));
      }
      for (let ch = 0; ch < output.length; ch++) {
        if (needsNewSample) {
          const inCh = input && input.length ? input[ch % input.length] : null;
          this.heldValue[ch] = inCh ? inCh[i] : 0;
        }
        const quantized = step * Math.round(this.heldValue[ch] / step);
        output[ch][i] = Math.max(-1, Math.min(1, quantized));
      }
    }
    return true;
  }
}
registerProcessor('rackwerk-bitcrush', RackwerkBitcrushProcessor);
`;
