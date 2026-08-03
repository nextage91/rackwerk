/**
 * Frequenzverschiebung via Hilbert-Transformation + Einseitenband-Modulation
 * (SSB) -- ECHTE Frequenzverschiebung (ALLE Teiltöne um denselben Hz-Betrag
 * verschoben, dadurch bewusst INHARMONISCH/"glockig"/"metallisch"), nicht zu
 * verwechseln mit Pitch-Shifting (das die Verhältnisse der Teiltöne erhält
 * und darum harmonisch bleibt).
 *
 * Hilbert-Transformator: zwei parallele Kaskaden aus je 4 Allpass-Stufen
 * 2. Ordnung (die seit Jahrzehnten frei publizierten, weit verbreiteten
 * Koeffizienten für einen breitbandigen ~90°-Phasenteiler -- s. Bernie
 * Hutchins' "Musical Engineer's Handbook" bzw. das seither vielfach
 * reproduzierte musicdsp.org-Rezept, u. a. in etlichen Open-Source-
 * Frequenzschiebern verwendet). Aus dem Eingangssignal x entstehen so zwei
 * Zweige I (0°) und Q (~90° phasenverschoben über den ganzen Hörbereich) --
 * das "analytische Signal".
 *
 * Multipliziert mit einem Quadratur-Träger (sin/cos DERSELBEN Frequenz, aus
 * EINEM gemeinsamen Phasenakkumulator abgeleitet) ergibt sich die
 * verschobene Ausgabe:
 *   y = I*cos(wt) - sign(shift)*Q*sin(wt)
 * -- schiebt bei shift>0 nach oben, bei shift<0 nach unten (dieselbe Formel,
 * nur das Vorzeichen von Q dreht die Richtung um; der Akkumulator selbst
 * läuft immer mit |shift|, damit die Trägerfrequenz nie negativ wird).
 * Zwei UNABHÄNGIGE OszillatorNode-Instanzen für sin/cos würden bei jeder
 * Live-Automation von `shift` ihre relative 90°-Phase verlieren (jeder
 * Oszillator rundet seinen eigenen Phasenzähler für sich, s. DEFS.chorus im
 * Hauptmodul für dasselbe Grundproblem bei nur 180°) -- ein gemeinsamer
 * Akkumulator in einem Worklet bleibt dagegen exakt in Quadratur, egal wie
 * `shift` sich ändert. Da der Träger ohnehin sample-genau im Worklet
 * gebraucht wird, laufen die acht Allpass-Stufen gleich mit statt über
 * einen separaten IIRFilterNode-Signalpfad.
 */
export const FREQSHIFT_WORKLET_SRC = `
const HILBERT_A = [0.6923877778065, 0.9360654322959, 0.9882295226860, 0.9987488452737];
const HILBERT_B = [0.4021921162426, 0.8561710882420, 0.9722909545651, 0.9952884791278];
const TWO_PI = Math.PI * 2;

class Allpass2 {
  constructor(c) { this.c = c; this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0; }
  process(x0) {
    const y0 = this.c * (x0 - this.y2) + this.x2;
    this.x2 = this.x1; this.x1 = x0;
    this.y2 = this.y1; this.y1 = y0;
    if (!Number.isFinite(y0)) { this.x1 = this.x2 = this.y1 = this.y2 = 0; return 0; }
    return y0;
  }
}

class HilbertChannel {
  constructor() {
    this.a = HILBERT_A.map((c) => new Allpass2(c));
    this.b = HILBERT_B.map((c) => new Allpass2(c));
  }
  processI(x) { let y = x; for (const ap of this.a) y = ap.process(y); return y; }
  processQ(x) { let y = x; for (const ap of this.b) y = ap.process(y); return y; }
}

class RackwerkFreqShiftProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'shift', defaultValue: 0, minValue: -4000, maxValue: 4000, automationRate: 'a-rate' }];
  }
  constructor() {
    super();
    this.channels = [];
    this.phase = 0;
  }
  ensureChannels(n) { while (this.channels.length < n) this.channels.push(new HilbertChannel()); }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || !output.length || !output[0].length) return true;
    this.ensureChannels(output.length);
    const shiftP = parameters.shift;
    let phase = this.phase;
    const n = output[0].length;
    for (let i = 0; i < n; i++) {
      const shift = shiftP[shiftP.length > 1 ? i : 0];
      const freq = Math.abs(shift);
      const sign = shift < 0 ? -1 : 1;
      const s = Math.sin(phase);
      const c = Math.cos(phase);
      phase += (TWO_PI * freq) / sampleRate;
      if (phase > TWO_PI) phase -= TWO_PI;
      for (let ch = 0; ch < output.length; ch++) {
        const inCh = input && input.length ? input[ch % input.length] : null;
        const x = inCh ? inCh[i] : 0;
        const chan = this.channels[ch];
        const I = chan.processI(x);
        const Q = chan.processQ(x);
        output[ch][i] = I * c - sign * Q * s;
      }
    }
    this.phase = Number.isFinite(phase) ? phase : 0;
    return true;
  }
}
registerProcessor('rackwerk-freqshift', RackwerkFreqShiftProcessor);
`;
