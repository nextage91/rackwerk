/**
 * Beat Repeat als AudioWorkletProcessor -- tempo-synchrones Stottern/
 * Wiederholen einer soeben live gespielten Audio-Scheibe (wie Abletons
 * "Beat Repeat"), mit denselben zwei Kernreglern wie das Original:
 *
 *  - chance: Wahrscheinlichkeit pro Intervall, dass STATT frischem Live-
 *    Signal die zuletzt eingefangene Scheibe NOCHMAL abgespielt wird.
 *  - decay: wie stark jede weitere Wiederholung DERSELBEN eingefrorenen
 *    Scheibe zusätzlich leiser wird (kumulativ, s. repeatCount unten).
 *
 * Funktionsweise: ein Ringpuffer nimmt IMMER das Live-Signal auf, egal in
 * welchem Zustand sich der Effekt gerade befindet. An jeder Intervall-
 * grenze (Länge = `intervalSec`, tempo-synchron von aussen gesetzt, s.
 * inserts.js#DEFS.beatRepeat) würfelt der Prozessor:
 *  - Treffer (< chance) UND es gibt bereits eine eingefrorene Scheibe UND
 *    die laufende Wiederholungs-Serie hat maxConsecutiveRepeats noch nicht
 *    erreicht: dieselbe Leseposition wie beim letzten Mal wird erneut
 *    abgespielt (nicht neu eingefangen) -- repeatCount steigt, die
 *    Lautstärke sinkt um (1-decay)^repeatCount.
 *  - sonst: die Leseposition wird auf die AKTUELLE Schreibposition gelegt
 *    (frisch eingefangen) und das Live-Signal läuft für dieses Intervall
 *    unverändert durch (repeatCount=0, Gain=1) -- bei chance=0 macht das
 *    dieses Insert zur reinen Durchleitung (keine hörbare Verzögerung, da
 *    im Frisch-Zustand IMMER live statt aus dem Puffer ausgegeben wird).
 *
 * Die maxConsecutiveRepeats-Grenze existiert, weil chance EXAKT 1 (Regler
 * auf Anschlag) sonst nie mehr in den frisch-eingefangen-Zweig zurück
 * könnte -- Math.random() ist per Definition immer < 1, der "sonst"-Zweig
 * wäre also, sobald einmal repeating=true, für immer unerreichbar. Da
 * decay dabei KUMULATIV wirkt (jede weitere Wiederholung multipliziert die
 * Lautstärke erneut mit (1-decay)), lief das unbegrenzt gegen null -- nach
 * wenigen Sekunden dauerhaft unhörbar leise, ohne je wieder lauter zu
 * werden (Nutzer-Bugreport "chance auf voll + wet auf 100 -- klingt
 * nichts", per Messung bestätigt: RMS fiel binnen 6s von Normallautstärke
 * auf ~1e-8 und blieb dort). Die erzwungene Neuaufnahme spätestens nach
 * maxConsecutiveRepeats Wiederholungen begrenzt den Lautstärkeabfall EINER
 * Serie -- bei chance<1 praktisch unsichtbar, weil der Zufalls-Ausstieg
 * dort ohnehin meist früher eintritt -- und garantiert bei chance=1
 * trotzdem dauerhaft hörbares, sich weiter veränderndes Stottern statt
 * permanenter Stille.
 *
 * Da der Ringpuffer beim Wiederholen exakt an der Stelle weiterliest, wo
 * die vorige Intervall-Länge live durchlief, enthält er zu diesem Zeitpunkt
 * bereits genau das Material der VORHERIGEN Runde -- kein zusätzlicher
 * Einfang-Schritt nötig, das Schreiben läuft ja ununterbrochen mit.
 */
export const BEATREPEAT_WORKLET_SRC = `
class RackwerkBeatRepeatProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'intervalSec', defaultValue: 0.125, minValue: 0.01, maxValue: 4, automationRate: 'k-rate' },
      { name: 'chance', defaultValue: 0.35, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'decay', defaultValue: 0.3, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }
  constructor() {
    super();
    // 4s Maximum -- dieselbe Obergrenze wie DEFS.filterDelay (langsamstes
    // Tempo + längste Notenwert-Auswahl bleibt darunter, s. dortigen
    // Kommentar zu delayL/delayR).
    this.ringLen = Math.ceil(sampleRate * 4.0);
    this.ring = [];
    this.writePos = 0;
    this.cyclePos = 0;
    this.cycleLen = Math.max(1, Math.round(sampleRate * 0.125));
    this.repeating = false;
    this.repeatCount = 0;
    this.repeatStartPos = 0;
    this.gain = 1;
    this.hasCapturedBefore = false;
    // Kurze An-/Abschwellzeit an JEDEM Grenze eines wiederholten Grains
    // (Start eines Repeats, Schleifen-Nahtstelle innerhalb einer laufenden
    // Wiederholungs-Serie, Rücksprung auf Live) -- ohne das springt der
    // Lesezeiger auf einen beliebigen Sample-Wert, der so gut wie nie zum
    // vorherigen passt (Nutzer-Bugreport "knackt/klickt", per Messung
    // bestätigt: Sample-zu-Sample-Sprünge exakt an den Intervallgrenzen,
    // ~15x grösser als bei einem glatten Signal möglich). NUR im "repeating"-
    // Zweig wirksam -- reines Live-Durchleiten (chance=0) bleibt unverändert
    // klickfrei, weil da nie der Lesezeiger springt.
    this.fadeSamples = Math.max(1, Math.round(sampleRate * 0.003));
    // s. Klassen-Kommentar oben -- verhindert, dass chance=1 den Gain
    // unbegrenzt gegen null laufen lässt.
    this.maxConsecutiveRepeats = 8;
  }
  ensureChannels(n) { while (this.ring.length < n) this.ring.push(new Float32Array(this.ringLen)); }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || !output.length || !output[0].length) return true;
    const chCount = Math.max(output.length, input && input.length ? input.length : 0, 1);
    this.ensureChannels(chCount);
    const intervalSec = parameters.intervalSec[0];
    const chance = parameters.chance[0];
    const decay = parameters.decay[0];
    const newCycleLen = Math.max(1, Math.round(intervalSec * sampleRate));
    const n = output[0].length;

    for (let i = 0; i < n; i++) {
      for (let ch = 0; ch < this.ring.length; ch++) {
        const inCh = input && input.length ? input[ch % input.length] : null;
        this.ring[ch][this.writePos] = inCh ? inCh[i] : 0;
      }
      if (this.cyclePos === 0) {
        this.cycleLen = newCycleLen;
        if (this.hasCapturedBefore && this.repeatCount < this.maxConsecutiveRepeats && Math.random() < chance) {
          this.repeating = true;
          this.repeatCount += 1;
          this.gain = Math.pow(1 - decay, this.repeatCount);
        } else {
          this.repeating = false;
          this.repeatCount = 0;
          this.gain = 1;
          this.repeatStartPos = this.writePos;
          this.hasCapturedBefore = true;
        }
      }
      let fadeEnv = 1;
      if (this.repeating) {
        const fadeLen = Math.min(this.fadeSamples, Math.floor(this.cycleLen / 2));
        const p = this.cyclePos % this.cycleLen;
        if (fadeLen > 0) {
          if (p < fadeLen) fadeEnv = p / fadeLen;
          else if (p >= this.cycleLen - fadeLen) fadeEnv = (this.cycleLen - 1 - p) / fadeLen;
        }
      }
      for (let ch = 0; ch < output.length; ch++) {
        if (this.repeating) {
          const idx = (this.repeatStartPos + (this.cyclePos % this.cycleLen)) % this.ringLen;
          output[ch][i] = this.ring[ch % this.ring.length][idx] * this.gain * fadeEnv;
        } else {
          const inCh = input && input.length ? input[ch % input.length] : null;
          output[ch][i] = inCh ? inCh[i] : 0;
        }
      }
      this.writePos = (this.writePos + 1) % this.ringLen;
      this.cyclePos = (this.cyclePos + 1) % this.cycleLen;
    }
    if (!Number.isFinite(this.gain)) this.gain = 1;
    return true;
  }
}
registerProcessor('rackwerk-beatrepeat', RackwerkBeatRepeatProcessor);
`;
