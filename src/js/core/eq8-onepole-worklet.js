/**
 * 1-poliger (6dB/Okt) Highpass/Lowpass als AudioWorkletProcessor -- für
 * eq8s Flankensteilheiten 6 und 18dB/Okt (s. core/inserts.js#eq8BuildBandNodes).
 *
 * Der erste Anlauf (makeOnePoleLowpass()-artige Rückkopplungsschleife aus
 * GainNode+1-Sample-DelayNode) war GEMESSEN ungenau: die Web-Audio-Spec
 * verlangt für jeden ZYKLUS im Audiographen mindestens EINEN vollen
 * Render-Quantum (128 Samples) Verzögerung, bevor er aufgelöst wird --
 * eine "1-Sample"-DelayNode in einer Rückkopplungsschleife bekommt also in
 * der Praxis effektiv ~128 Samples Verzögerung statt der beabsichtigten
 * EINEN, was die tatsächliche Grenzfrequenz um denselben Faktor verschiebt
 * (gemessen: ein auf 4000Hz gesetzter "Tiefpass" dämpfte bereits deutlich
 * bei 100Hz). Ein AudioWorkletProcessor rechnet die Rekursion dagegen
 * SAMPLE-FÜR-SAMPLE im eigenen JS-Code, ganz ohne native Rückkopplungs-
 * schleife im Graphen -- kein Zyklus, keine Quantum-Latenz, exakt die
 * beabsichtigte Grenzfrequenz. Dieselben 1-Pol-Koeffizientenformeln wie
 * bereits in machines/acidbass-worklet.js#OnePole (dort für den TB-303-
 * Filter genutzt, hier unverändert übernommen).
 *
 * `cutoff` ist ein echtes AudioParam (a-rate) statt Message-Passing --
 * lässt sich also genau wie bei einem nativen BiquadFilterNode per
 * setTargetAtTime() sanft ziehen (Touch-Drag im EQ8-Graphen), ohne
 * Message-Latenz oder Sprünge.
 *
 * Wie bei acidbass-worklet.js: exportiert nur den Quelltext als String --
 * RackWerk wird als EINE gebündelte index.html ausgeliefert (s. README),
 * der String wird zur Laufzeit per Blob-URL an audioWorklet.addModule()
 * übergeben (s. core/inserts.js#eq8EnsureOnePoleWorklet). Eigener globaler
 * Scope ohne Zugriff auf unsere ES-Module, deshalb komplett eigenständig.
 */
export const EQ8_ONEPOLE_WORKLET_SRC = `
class RackwerkOnePoleProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'cutoff', defaultValue: 1000, minValue: 1, maxValue: 22000, automationRate: 'a-rate' }];
  }
  constructor(options) {
    super();
    this.highpass = options.processorOptions?.highpass === true;
    // Ein Zustand (x1/y1) PRO Kanal -- ein Stereo-Signal darf sich nicht
    // einen einzigen Zustand teilen, sonst bluten die Kanäle ineinander.
    this.x1 = [];
    this.y1 = [];
  }
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    const cutoffParam = parameters.cutoff;
    const sr = sampleRate;
    for (let ch = 0; ch < output.length; ch++) {
      const inCh = input[ch];
      const outCh = output[ch];
      let x1 = this.x1[ch] || 0;
      let y1 = this.y1[ch] || 0;
      for (let i = 0; i < outCh.length; i++) {
        const cutoff = cutoffParam.length > 1 ? cutoffParam[i] : cutoffParam[0];
        const x = Math.exp((-2 * Math.PI * cutoff) / sr);
        let b0, b1, a1;
        if (this.highpass) {
          b0 = 0.5 * (1 + x); b1 = -0.5 * (1 + x); a1 = x;
        } else {
          b0 = 1 - x; b1 = 0; a1 = x;
        }
        const inSample = inCh ? inCh[i] : 0;
        const y = b0 * inSample + b1 * x1 + a1 * y1;
        x1 = inSample;
        y1 = y;
        outCh[i] = y;
      }
      this.x1[ch] = x1;
      this.y1[ch] = y1;
    }
    return true;
  }
}
registerProcessor('rackwerk-eq8-onepole', RackwerkOnePoleProcessor);
`;
