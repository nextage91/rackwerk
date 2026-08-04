/**
 * Selbstschwingungsfähiger 4-poliger "Ladder"-Tiefpass als
 * AudioWorkletProcessor -- die generalisierte, von AcidBass losgelöste
 * Fassung der TB-303-Filter-Rekursion aus machines/acidbass-worklet.js
 * (dort im Detail hergeleitet/dokumentiert, s. dortiger Dateikopf für die
 * Open303/rosic_TeeBeeFilter-Quellenlage), jetzt als generischer Filtertyp
 * für SubSynth (s. machines/subsynth.js) nutzbar.
 *
 * Bewusst NICHT 1:1 übernommen (das bleibt AcidBass' Alleinstellungsmerkmal,
 * s. dortige Kommentare): die festen Vor-/Nachfilter (44.486Hz/24.167Hz
 * Fixhighpass fürs spezifische TB-303-Tonspektrum), Filter-FM vom
 * Oszillator, Overdrive-Vorstufe, Devil-Fish-Hi-Res-Skew. Was ÜBERNOMMEN
 * wird, ist der eigentliche Filterkern: die "Leapfrog"-4-Pol-Rekursion
 * (y1..y4) samt Sättigungsglied (tanh) IM Rückkopplungspfad -- genau DAS
 * unterscheidet einen echten Ladder-Filter von einer Biquad-Kaskade: die
 * Resonanz kann bis zur Selbstschwingung getrieben werden, OHNE unbegrenzt
 * aufzuschwingen, weil die Rückkopplungsschleife sich selbst sättigt
 * (Dioden-/Transistor-Verhalten der echten Schaltung) statt linear zu
 * bleiben wie bei einer Biquad-Q-Erhöhung.
 *
 * `frequency`/`Q` bewusst SO benannt (statt z. B. `cutoff`/`resonance`) und
 * mit demselben Wertebereich wie SubSynths bisheriger BiquadFilterNode
 * (Q: 0.5..20, s. UI-Knob in subsynth.js) -- macht diesen Worklet-Knoten
 * für SubSynths bestehenden Code (inkl. core/dsp.js#applyFilterEnv, das nur
 * `.frequency.setValueAtTime()/.setTargetAtTime()` braucht, kein
 * BiquadFilterNode-spezifisches Feature) praktisch ein Drop-in für den
 * bisherigen `ctx.createBiquadFilter()`-Aufruf, s. machines/subsynth.js.
 * `frequency` ist A-RATE (nicht k-rate wie beim SVF-Sweep-Filter oben) --
 * SubSynths Filterhüllkurve fährt `frequency` über einen kurzen, oft sehr
 * schnellen exponentiellen Abfall (der klassische "Acid-Squelch"), eine
 * Quantisierung auf Block-Rate (~2.9ms-Stufen) wäre bei kurzem fDecay
 * hörbar gestuft/zippernd. `Q` bleibt k-rate (in SubSynth ein reiner
 * Pro-Note-Konstantwert, keine Hüllkurve).
 *
 * Innen wird `Q` per einfacher linearer Abbildung auf den internen
 * Selbstschwingungs-Parameter `r` (0..1.2, s. AcidBass-Pendant
 * `resonanceSkewed`) umgerechnet -- kein Anspruch auf die exakte Devil-
 * Fish-Skew-Kurve, aber dieselbe grundlegende Charakteristik: bei Q nahe
 * dem Maximum (20) schwingt der Filter frei (r>1), bei niedrigem Q bleibt
 * er eine milde Resonanzspitze.
 */
export const LADDER_FILTER_WORKLET_SRC = `
const DENORMAL_FLOOR = 1e-30;
const flushDenormal = (v) => (v > -DENORMAL_FLOOR && v < DENORMAL_FLOOR ? 0 : v);
const ONE_OVER_SQRT2 = 0.70710678118654752440;
const STATE_LIMIT = 8;
const MAX_CHANNELS = 8;
// Feste Rückkopplungs-Hochpass-Grenzfrequenz -- wie AcidBass' feedbackHp
// (s. Dateikopf dort): verhindert, dass sich tieffrequente Gleichanteile in
// der Rückkopplungsschleife aufbauen.
const FEEDBACK_HP_HZ = 150;

class RackwerkLadderProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'frequency', defaultValue: 1000, minValue: 20, maxValue: 18000, automationRate: 'a-rate' },
      { name: 'Q', defaultValue: 4, minValue: 0.5, maxValue: 20, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    const sr = sampleRate;
    this.y1 = new Float64Array(MAX_CHANNELS);
    this.y2 = new Float64Array(MAX_CHANNELS);
    this.y3 = new Float64Array(MAX_CHANNELS);
    this.y4 = new Float64Array(MAX_CHANNELS);
    // Ein-poliger Rückkopplungs-Hochpass pro Kanal (Zustand x1/y1 je Kanal,
    // Koeffizienten fest -- feste Grenzfrequenz, s. FEEDBACK_HP_HZ oben).
    this.hpX1 = new Float64Array(MAX_CHANNELS);
    this.hpY1 = new Float64Array(MAX_CHANNELS);
    const hpX = Math.exp(-2 * Math.PI * FEEDBACK_HP_HZ / sr);
    this.hpB0 = 0.5 * (1 + hpX);
    this.hpB1 = -0.5 * (1 + hpX);
    this.hpA1 = hpX;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || !output.length || !output[0].length) return true;
    const numCh = Math.min(output.length, MAX_CHANNELS);
    const n = output[0].length;
    const freqParam = parameters.frequency;
    const freqConst = freqParam.length === 1;
    const q = parameters.Q[0];
    // Lineare Abbildung UI-Q (0.5..20) -> internes Selbstschwingungsmass r
    // (0..1.2) -- s. Dateikopf.
    const r = Math.max(0, Math.min(1.2, ((q - 0.5) / 19.5) * 1.2));

    for (let i = 0; i < n; i++) {
      const freq = Math.max(20, Math.min(18000, freqConst ? freqParam[0] : freqParam[i]));
      const wc = 2 * Math.PI * freq / sampleRate;
      const fx = wc * ONE_OVER_SQRT2 / (2 * Math.PI);
      const b0 = (0.00045522346 + 6.1922189 * fx) / (1 + 12.358354 * fx + 4.4156345 * fx * fx);
      let k = fx * (fx * (fx * (fx * (fx * (fx + 7198.6997) - 5837.7917) - 476.47308) + 614.95611) + 213.87126) + 16.998792;
      let g = k * 0.058823529411764705882352941176471; // 1/17
      g = (g - 1) * r + 1;
      g = g * (1 + r);
      k = k * r;

      for (let ch = 0; ch < numCh; ch++) {
        const inCh = input && input[ch] ? input[ch] : (input && input[0] ? input[0] : null);
        const x = inCh ? inCh[i] : 0;

        const fbRaw = Math.tanh(k * this.y4[ch]);
        const hpOut = this.hpB0 * fbRaw + this.hpB1 * this.hpX1[ch] + this.hpA1 * this.hpY1[ch];
        this.hpX1[ch] = fbRaw;
        this.hpY1[ch] = flushDenormal(hpOut);

        const y0 = x - hpOut;
        let y1 = this.y1[ch] + 2 * b0 * (y0 - this.y1[ch] + this.y2[ch]);
        let y2 = this.y2[ch] + b0 * (this.y1[ch] - 2 * this.y2[ch] + this.y3[ch]);
        let y3 = this.y3[ch] + b0 * (this.y2[ch] - 2 * this.y3[ch] + this.y4[ch]);
        let y4 = this.y4[ch] + b0 * (this.y3[ch] - 2 * this.y4[ch]);

        y1 = STATE_LIMIT * Math.tanh(y1 / STATE_LIMIT);
        y2 = STATE_LIMIT * Math.tanh(y2 / STATE_LIMIT);
        y3 = STATE_LIMIT * Math.tanh(y3 / STATE_LIMIT);
        y4 = STATE_LIMIT * Math.tanh(y4 / STATE_LIMIT);
        if (!Number.isFinite(y1) || !Number.isFinite(y2) || !Number.isFinite(y3) || !Number.isFinite(y4)) {
          y1 = 0; y2 = 0; y3 = 0; y4 = 0;
        }
        this.y1[ch] = y1; this.y2[ch] = y2; this.y3[ch] = y3; this.y4[ch] = y4;

        output[ch][i] = 2 * g * y4;
      }
    }
    return true;
  }
}
registerProcessor('rackwerk-ladder', RackwerkLadderProcessor);
`;
