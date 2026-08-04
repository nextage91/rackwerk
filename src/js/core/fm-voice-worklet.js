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
 *
 * NACHTRAG (CPU-Regression auf echten Geräten, iPhone 14 Pro geknackt/
 * überlastet): die feste 4x-Überabtastung + 3-stufige Filterkaskade PRO
 * SAMPLE, IMMER, unabhängig vom tatsächlichen Modulationsindex, kostet per
 * Offline-Benchmark bei PsySynths Extremfall (16 gehaltene Noten x 5
 * Unisono = 80 gleichzeitige fm-voice-Instanzen) ~140% des verfügbaren
 * Block-Zeitbudgets -- SICHER zu knapp, auch bei nur MODERATER
 * Stimmenzahl bereits >70%, praktisch nichts mehr übrig für den Rest der
 * App (Inserts, andere Maschinen, UI). Der teure Pfad ist aber nur
 * WIRKLICH nötig, wenn die legitimen FM-Seitenbänder (Carson-Bandbreite)
 * überhaupt in die Nähe von Nyquist kommen -- bei den meisten musikalisch
 * üblichen Einstellungen (moderater FM Amount/Ratio, kein Feedback) bleibt
 * das Seitenband-Spektrum WEIT darunter, oversamplen bringt dort nichts,
 * kostet aber trotzdem voll mit. Deshalb jetzt EINMAL PRO BLOCK (nicht pro
 * Sample -- unnötig, ein FM-Index ändert sich nie so schnell, dass Block-
 * Granularität hörbar wäre) eine grobe Carson-Abschätzung: nur wenn
 * `carrierFreq+modFreq+fmIndex+feedback` (alles als worst-case-Maximum
 * über den Block, falls a-rate-automatisiert) über ~0.4x der Sample-Rate
 * liegt, läuft der teure überabgetastete+gefilterte Pfad -- sonst ein
 * direkter, ungefilterter Einzelschritt pro Sample (kein Aliasing-Risiko,
 * weil die Seitenbänder dann ohnehin unter Nyquist bleiben). Per Offline-
 * Benchmark: der billige Pfad kostet bei 80 Stimmen nur noch ~19% des
 * Budgets statt ~140% -- UND per erneuter Alias-Messung bestätigt: an der
 * Alias-Unterdrückung bei tatsächlich extremen Einstellungen (wo der teure
 * Pfad weiterhin greift) ändert sich nichts.
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

    // Grobe Carson-Bandbreiten-Abschätzung, EINMAL pro Block (nicht pro
    // Sample -- s. Dateikopf-Nachtrag): worst-case Maximum über den Block,
    // falls a-rate-automatisiert (z. B. mitten in der FM-Index-Hüllkurve).
    const maxOf = (arr) => {
      if (arr.length === 1) return arr[0];
      let m = arr[0];
      for (let i = 1; i < arr.length; i++) if (arr[i] > m) m = arr[i];
      return m;
    };
    const estimatedMaxFreq = maxOf(carrierFreqP) + maxOf(modFreqP) + maxOf(fmIndexP) + maxOf(feedbackP);
    const needsOversample = estimatedMaxFreq > 0.4 * sampleRate;

    let carPhase = this.carPhase, modPhase = this.modPhase;
    const filters = this.filters;

    if (needsOversample) {
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
    } else {
      // Billiger Pfad: kein Aliasing-Risiko bei dieser Reglerstellung (s.
      // Dateikopf-Nachtrag), deshalb EIN direkter Phasenschritt pro Sample,
      // keine Überabtastung, kein Filter.
      for (let i = 0; i < n; i++) {
        const carrierFreq = carConst ? carrierFreqP[0] : carrierFreqP[i];
        const modFreq = modConst ? modFreqP[0] : modFreqP[i];
        const fmIndex = idxConst ? fmIndexP[0] : fmIndexP[i];
        const feedback = fbConst ? feedbackP[0] : feedbackP[i];
        const detune = detConst ? detuneP[0] : detuneP[i];
        const detuneMult = Math.pow(2, detune / 1200);
        const effCarrier = carrierFreq * detuneMult;
        const effMod = modFreq * detuneMult;

        const modSample = Math.sin(modPhase);
        const fbDev = modSample * feedback;
        modPhase = (modPhase + TWO_PI * (effMod + fbDev) / sampleRate) % TWO_PI;
        const carDev = modSample * fmIndex;
        carPhase = (carPhase + TWO_PI * (effCarrier + carDev) / sampleRate) % TWO_PI;
        const sample = Math.sin(carPhase);
        out[i] = Number.isFinite(sample) ? sample : 0;
      }
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
