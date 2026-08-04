/**
 * Überabgetastete, alias-arme Zwei-Operatoren-FM-Stimme als
 * AudioWorkletProcessor -- ersetzt das bisherige Paar aus zwei nativen
 * `OscillatorNode`s (Carrier + Modulator, Modulator moduliert
 * car.frequency direkt) in machines/fmsynth.js/psysynth.js.
 *
 * Warum: native OscillatorNode-FM läuft OHNE jede interne Überabtastung an
 * der normalen Context-Sample-Rate. FM erzeugt bei ausreichendem
 * Modulationsindex legitime Seitenbänder weit über der Trägerfrequenz
 * hinaus (Carson-Bandbreite, Bessel-Funktions-Spektrum) -- reichen die über
 * Nyquist hinaus, MÜSSEN sie zurückfalten. Per Offline-Messung bestätigt
 * (s. tools/dsp-tests/fm-aliasing-measurement.mjs): bei realistisch
 * erreichbaren Reglerstellungen (Ratio 8, FM Amount voll) liegt in einem
 * eigentlich stillen Frequenzband ~17dB, mit vollem Feedback zusätzlich
 * ~45dB an zurückgefalteter Energie -- klar hörbares, ungewolltes Rauschen/
 * Aliasing statt des beabsichtigten FM-Klangcharakters.
 *
 * Ansatz: Carrier UND Modulator werden intern per Phasenakkumulation bei
 * OVERSAMPLE-facher Sample-Rate erzeugt (kein natives OscillatorNode nutzbar
 * -- ein Worklet kann keinen fremden Knoten "von innen" anzapfen, deshalb
 * komplett selbst geschrieben), danach über einen kaskadierten Tiefpass
 * (3 Biquad-Stufen, RBJ-Cookbook-Butterworth, Grenzfrequenz 0.45x der
 * AUSGABE-Sample-Rate) auf die reguläre Rate dezimiert. Per Offline-
 * Prototyp gegen eine 192kHz-Referenz verifiziert: 4x Überabtastung +
 * dieser Filter bringt beide obigen Testfälle auf praktisch identische
 * Werte wie die alias-freie Referenz (Rest-Differenz ~0dB).
 *
 * Nur EIN gemeinsames "detune" (Cent) für Carrier UND Modulator zugleich --
 * spiegelt, dass die Pitch-Swirl-LFO in PsySynth bisher car.detune UND
 * mod.detune gleichzeitig aus DERSELBEN Quelle speiste (kohärentes Vibrato
 * über beide Operatoren, s. dortiger Kommentar), nicht zwei unabhängige
 * Detune-Werte. PsySynths dritter Oszillator (Ring-Modulation) bleibt
 * bewusst ein natives OscillatorNode -- die Messung zeigt dort KEIN
 * relevantes Aliasing (Ring-Mod erzeugt nur zwei begrenzte Summen-/
 * Differenzfrequenzen, keine unbegrenzte Bessel-Seitenband-Reihe wie echte
 * FM), ein Umbau würde dort keinen hörbaren Unterschied bringen.
 *
 * Rein MONO (numberOfOutputs=1, ein Kanal) -- wie die bisherigen car/mod-
 * Oszillatoren auch: Stereo/Panning passiert erst NACH diesem Knoten (s.
 * PsySynths ringGain->panner-Kette), hier wird nur das Trägersignal selbst
 * erzeugt.
 */
export const FM_VOICE_WORKLET_SRC = `
const DENORMAL_FLOOR = 1e-30;
const flushDenormal = (v) => (v > -DENORMAL_FLOOR && v < DENORMAL_FLOOR ? 0 : v);
const OVERSAMPLE = 4;
const FILTER_STAGES = 3;
const TWO_PI = 2 * Math.PI;

class LpBiquad {
  constructor(cutoffHz, sr, Q = 0.7071067811865476) {
    const w0 = TWO_PI * cutoffHz / sr;
    const cosw0 = Math.cos(w0), sinw0 = Math.sin(w0);
    const alpha = sinw0 / (2 * Q);
    const b0 = (1 - cosw0) / 2, b1 = 1 - cosw0, b2 = (1 - cosw0) / 2;
    const a0 = 1 + alpha, a1 = -2 * cosw0, a2 = 1 - alpha;
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0;
    this.a1 = a1 / a0; this.a2 = a2 / a0;
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
  }
  process(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = flushDenormal(this.y1); this.y1 = flushDenormal(y);
    return y;
  }
}

class RackwerkFmVoiceProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'carrierFreq', defaultValue: 220, minValue: 0.01, maxValue: 20000, automationRate: 'a-rate' },
      { name: 'modFreq', defaultValue: 220, minValue: 0.01, maxValue: 20000, automationRate: 'a-rate' },
      { name: 'fmIndex', defaultValue: 0, minValue: 0, maxValue: 200000, automationRate: 'a-rate' },
      { name: 'feedback', defaultValue: 0, minValue: 0, maxValue: 2000, automationRate: 'a-rate' },
      { name: 'detune', defaultValue: 0, minValue: -2400, maxValue: 2400, automationRate: 'a-rate' },
    ];
  }

  constructor() {
    super();
    // Innere (überabgetastete) Sample-Rate steht erst fest, wenn wir die
    // ECHTE sampleRate kennen (global, hier bereits verfügbar) -- die
    // Filter-Grenzfrequenz bezieht sich bewusst auf die AUSGABE-Rate
    // (0.45x davon), nicht auf die innere Rate.
    const cutoff = 0.45 * sampleRate;
    const innerSr = sampleRate * OVERSAMPLE;
    this.filters = Array.from({ length: FILTER_STAGES }, () => new LpBiquad(cutoff, innerSr));
    this.carPhase = 0;
    this.modPhase = 0;
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    if (!output || !output.length || !output[0].length) return true;
    const out = output[0];
    const n = out.length;
    const innerSr = sampleRate * OVERSAMPLE;

    const carrierFreqP = parameters.carrierFreq;
    const modFreqP = parameters.modFreq;
    const fmIndexP = parameters.fmIndex;
    const feedbackP = parameters.feedback;
    const detuneP = parameters.detune;
    const carConst = carrierFreqP.length === 1;
    const modConst = modFreqP.length === 1;
    const idxConst = fmIndexP.length === 1;
    const fbConst = feedbackP.length === 1;
    const detConst = detuneP.length === 1;

    let carPhase = this.carPhase, modPhase = this.modPhase;
    const filters = this.filters;

    for (let i = 0; i < n; i++) {
      const carrierFreq = carConst ? carrierFreqP[0] : carrierFreqP[i];
      const modFreq = modConst ? modFreqP[0] : modFreqP[i];
      const fmIndex = idxConst ? fmIndexP[0] : fmIndexP[i];
      const feedback = fbConst ? feedbackP[0] : feedbackP[i];
      const detune = detConst ? detuneP[0] : detuneP[i];
      const detuneMult = Math.pow(2, detune / 1200);
      const effCarrier = carrierFreq * detuneMult;
      const effMod = modFreq * detuneMult;

      let sample = 0;
      for (let k = 0; k < OVERSAMPLE; k++) {
        const modSample = Math.sin(modPhase);
        const fbDev = modSample * feedback;
        modPhase = (modPhase + TWO_PI * (effMod + fbDev) / innerSr) % TWO_PI;
        const carDev = modSample * fmIndex;
        carPhase = (carPhase + TWO_PI * (effCarrier + carDev) / innerSr) % TWO_PI;
        let s = Math.sin(carPhase);
        for (let f = 0; f < filters.length; f++) s = filters[f].process(s);
        sample = s;
      }
      out[i] = Number.isFinite(sample) ? sample : 0;
    }

    if (!Number.isFinite(carPhase)) carPhase = 0;
    if (!Number.isFinite(modPhase)) modPhase = 0;
    this.carPhase = carPhase;
    this.modPhase = modPhase;
    return true;
  }
}
registerProcessor('rackwerk-fm-voice', RackwerkFmVoiceProcessor);
`;
