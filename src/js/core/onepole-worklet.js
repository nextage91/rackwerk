/**
 * 1-poliger (6dB/Okt) Highpass/Lowpass als AudioWorkletProcessor.
 *
 * Gemeinsame 1-Pol-Stufe für ALLE Stellen im Projekt, die eine brauchen:
 *   - eq8s Flankensteilheiten 6 und 18dB/Okt (s. inserts.js#eq8BuildBandNodes)
 *   - der Damping-Filter im Reverb-Tank und in den Resonator-Delaylines
 *     (s. inserts.js#makeOnePoleLowpass)
 *
 * Der erste Anlauf (Rückkopplungsschleife aus GainNode+1-Sample-DelayNode,
 * ursprünglich für das Reverb-Damping gebaut) war GEMESSEN ungenau: die
 * Web-Audio-Spec
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
 * übergeben (s. core/inserts.js#ensureOnePoleWorklet). Eigener globaler
 * Scope ohne Zugriff auf unsere ES-Module, deshalb komplett eigenständig.
 */
export const ONEPOLE_WORKLET_SRC = `
/** Unterhalb dieser Schwelle wird der Filterzustand hart auf 0 gesetzt.
 *  1e-30 entspricht ~-600dBFS, liegt also unhörbar weit unter jedem
 *  Nutzsignal -- aber viele Grössenordnungen ÜBER der Denormal-Grenze von
 *  float64 (~2.2e-308). Ohne das klingt ein Filterzustand nach dem
 *  Verstummen des Eingangs exponentiell weiter gegen (nie exakt) null und
 *  landet irgendwann dauerhaft im Denormal-Bereich, wo Gleitkomma-
 *  Arithmetik auf vielen CPUs deutlich langsamer wird -- und zwar
 *  PERMANENT, weil der Zustand von dort nie wieder herausfindet. Kostet
 *  einen Vergleich pro Block, verhindert eine dauerhaft mitlaufende
 *  Grundlast pro stillgelegtem EQ-Band. */
const DENORMAL_FLOOR = 1e-30;

class RackwerkOnePoleProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'cutoff', defaultValue: 1000, minValue: 1, maxValue: 22000, automationRate: 'a-rate' }];
  }
  constructor(options) {
    super();
    this.highpass = options.processorOptions?.highpass === true;
    // Ein Zustand (x1/y1) PRO Kanal -- ein Stereo-Signal darf sich nicht
    // einen einzigen Zustand teilen, sonst bluten die Kanäle ineinander.
    // Feste Float64Array-Puffer statt wachsender JS-Arrays: die Kanalzahl
    // steht beim Anlegen fest (s. outputChannelCount in inserts.js), ein
    // dynamisch wachsendes Array würde beim ersten Schreiben pro Kanal
    // reallozieren -- auf dem Audio-Thread grundsätzlich zu vermeiden.
    this.x1 = new Float64Array(32);
    this.y1 = new Float64Array(32);

    // Koeffizienten-Cache. Math.exp() ist die teuerste Einzeloperation in
    // dieser Schleife, der Cutoff ist aber im Normalfall (Regler steht
    // still) über den ganzen Block KONSTANT -- Web Audio signalisiert das
    // dadurch, dass das a-rate-Parameter-Array dann nur EIN Element hat.
    // Vorher wurde Math.exp() bedingungslos pro Sample gerechnet: 128
    // identische Aufrufe pro Block und Kanal, bei mehreren Bändern in
    // Stereo schnell vierstellig pro Render-Quantum -- komplett umsonst.
    this.lastCutoff = -1;
    this.b0 = 1; this.b1 = 0; this.a1 = 0;
  }

  updateCoeffs(cutoff) {
    if (cutoff === this.lastCutoff) return;
    this.lastCutoff = cutoff;
    const x = Math.exp((-2 * Math.PI * cutoff) / sampleRate);
    if (this.highpass) {
      this.b0 = 0.5 * (1 + x);
      this.b1 = -0.5 * (1 + x);
      this.a1 = x;
    } else {
      this.b0 = 1 - x;
      this.b1 = 0;
      this.a1 = x;
    }
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    const cutoffParam = parameters.cutoff;
    // Länge 1 = über den ganzen Block konstant (Regler steht still, der
    // Normalfall); Länge 128 = wird gerade automatisiert/gezogen.
    const modulated = cutoffParam.length > 1;
    if (!modulated) this.updateCoeffs(cutoffParam[0]);

    for (let ch = 0; ch < output.length; ch++) {
      const inCh = input[ch];
      const outCh = output[ch];
      let x1 = this.x1[ch];
      let y1 = this.y1[ch];

      if (modulated) {
        for (let i = 0; i < outCh.length; i++) {
          this.updateCoeffs(cutoffParam[i]);
          const inSample = inCh ? inCh[i] : 0;
          const y = this.b0 * inSample + this.b1 * x1 + this.a1 * y1;
          x1 = inSample;
          y1 = y;
          outCh[i] = y;
        }
      } else {
        // Koeffizienten in lokale Konstanten ziehen -- spart pro Sample
        // drei Property-Zugriffe und erlaubt der Engine, sie durchgehend
        // in Registern zu halten.
        const b0 = this.b0, b1 = this.b1, a1 = this.a1;
        for (let i = 0; i < outCh.length; i++) {
          const inSample = inCh ? inCh[i] : 0;
          const y = b0 * inSample + b1 * x1 + a1 * y1;
          x1 = inSample;
          y1 = y;
          outCh[i] = y;
        }
      }

      // Denormal-Schutz (s. DENORMAL_FLOOR oben) -- einmal pro Block statt
      // pro Sample: der Zustand braucht nach dem Verstummen ohnehin viele
      // Blöcke, um überhaupt so klein zu werden, ein Block Verzögerung
      // beim Nullsetzen ist also folgenlos.
      if (y1 > -DENORMAL_FLOOR && y1 < DENORMAL_FLOOR) y1 = 0;
      if (x1 > -DENORMAL_FLOOR && x1 < DENORMAL_FLOOR) x1 = 0;
      // NaN/Infinity-Notbremse: ohne das würde EIN einziger kaputter Wert
      // (etwa ein NaN aus einem vorgeschalteten Insert) sich über den
      // Rekursionszustand y1 DAUERHAFT festsetzen -- das Band bliebe für
      // den Rest der Session stumm bzw. gäbe NaN weiter, ohne dass
      // irgendetwas es je zurücksetzt.
      if (!Number.isFinite(y1) || !Number.isFinite(x1)) { x1 = 0; y1 = 0; }

      this.x1[ch] = x1;
      this.y1[ch] = y1;
    }
    return true;
  }
}
registerProcessor('rackwerk-onepole', RackwerkOnePoleProcessor);
`;
