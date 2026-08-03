/**
 * Noise Gate/Expander als AudioWorkletProcessor.
 *
 * Web Audio hat kein natives Gate/Expander-Node -- DynamicsCompressorNode
 * kann nur LAUTE Signale dämpfen (Kompression), niemals LEISE (die genau
 * entgegengesetzte Dynamikrichtung eines Gates). Ein Gate braucht darum
 * einen eigenen Hüllkurvenfolger + Schwellenvergleich, der pro Sample läuft
 * -- wie schon core/onepole-worklet.js (dortiger Kommentar: eine
 * Rückkopplungsschleife aus nativen Delay/Gain-Knoten bekommt durch die
 * Web-Audio-Zyklus-Mindestlatenz von einem Render-Quantum (128 Samples)
 * einen messbar falschen Zeitkonstanten-Wert, ein Worklet rechnet die
 * Rekursion dagegen exakt sample-für-Sample im eigenen JS-Code).
 *
 * Zwei getrennte Hüllkurven statt einer:
 *  - Detektor-Hüllkurve (this.env): FEST schnell (1ms Attack/50ms Release),
 *    unabhängig von den Regler-Werten -- reine Pegel-MESSUNG, soll nicht
 *    durch eine absichtlich langsame Release-Einstellung des Nutzers selbst
 *    "blind" für kurze Pegelspitzen werden.
 *  - Gate-Hüllkurve (this.gainState): die eigentliche, hörbare Verstärkung,
 *    geglättet mit den NUTZER-Reglern attack/release -- bestimmt wie schnell
 *    das Tor auf-/zufährt, unabhängig von der (immer schnellen) Erkennung.
 *
 * `range` (dB) ist der Boden im geschlossenen Zustand, NICHT hartes Muten
 * (0/-Infinity) -- ein reales Gate lässt meist einen Rest durch (typisch
 * -40 bis -80dB), volles Stummschalten klingt bei perkussiven Signalen
 * unnatürlich abgeschnitten ("Klick" am Übergang).
 */
export const GATE_WORKLET_SRC = `
const DET_ATTACK_COEFF = 1 - Math.exp(-1 / (sampleRate * 0.001));
const DET_RELEASE_COEFF = 1 - Math.exp(-1 / (sampleRate * 0.05));
const DENORMAL_FLOOR = 1e-30;

class RackwerkGateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -40, minValue: -80, maxValue: 0, automationRate: 'a-rate' },
      { name: 'attack', defaultValue: 0.005, minValue: 0.0002, maxValue: 0.5, automationRate: 'a-rate' },
      { name: 'release', defaultValue: 0.15, minValue: 0.005, maxValue: 2, automationRate: 'a-rate' },
      { name: 'range', defaultValue: -60, minValue: -80, maxValue: 0, automationRate: 'a-rate' },
    ];
  }
  constructor() {
    super();
    this.env = new Float64Array(32);
    // Startet OFFEN (1), nicht bei 0 -- sonst müsste sich das Tor beim
    // allerersten Ton erst "freispielen", statt sofort durchzulassen.
    this.gainState = new Float64Array(32).fill(1);
    this.lastAttack = -1; this.attCoeff = 0;
    this.lastRelease = -1; this.relCoeff = 0;
  }

  updateGainCoeffs(attack, release) {
    if (attack !== this.lastAttack) {
      this.lastAttack = attack;
      this.attCoeff = 1 - Math.exp(-1 / (sampleRate * Math.max(0.0002, attack)));
    }
    if (release !== this.lastRelease) {
      this.lastRelease = release;
      this.relCoeff = 1 - Math.exp(-1 / (sampleRate * Math.max(0.005, release)));
    }
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || !output.length) return true;
    const thresholdP = parameters.threshold;
    const attackP = parameters.attack;
    const releaseP = parameters.release;
    const rangeP = parameters.range;
    const modulated = thresholdP.length > 1 || attackP.length > 1 || releaseP.length > 1 || rangeP.length > 1;
    if (!modulated) this.updateGainCoeffs(attackP[0], releaseP[0]);

    for (let ch = 0; ch < output.length; ch++) {
      const inCh = input && input.length ? input[ch % input.length] : null;
      const outCh = output[ch];
      let env = this.env[ch];
      let gain = this.gainState[ch];
      for (let i = 0; i < outCh.length; i++) {
        const x = inCh ? inCh[i] : 0;
        if (modulated) this.updateGainCoeffs(attackP[attackP.length > 1 ? i : 0], releaseP[releaseP.length > 1 ? i : 0]);
        const rect = Math.abs(x);
        env += (rect - env) * (rect > env ? DET_ATTACK_COEFF : DET_RELEASE_COEFF);
        const thresholdDb = thresholdP[thresholdP.length > 1 ? i : 0];
        const rangeDb = rangeP[rangeP.length > 1 ? i : 0];
        const envDb = env > 1e-8 ? 20 * Math.log10(env) : -160;
        const targetLin = envDb >= thresholdDb ? 1 : Math.pow(10, rangeDb / 20);
        gain += (targetLin - gain) * (targetLin > gain ? this.attCoeff : this.relCoeff);
        outCh[i] = x * gain;
      }
      if (env < DENORMAL_FLOOR) env = 0;
      if (!Number.isFinite(env)) env = 0;
      if (!Number.isFinite(gain)) gain = 1;
      this.env[ch] = env;
      this.gainState[ch] = gain;
    }
    return true;
  }
}
registerProcessor('rackwerk-gate', RackwerkGateProcessor);
`;
