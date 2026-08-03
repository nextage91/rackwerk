/**
 * Pitch-Tracker für den Vocoder-Carrier (s. core/inserts.js#DEFS.vocoder) --
 * behebt den gemeldeten "klingt wie ein Oszillator, der permanent eine
 * Schwingung erzeugt"-Effekt: die Formant-Hüllkurven (Analyse-Bänder ->
 * Carrier-Bänder) arbeiteten schon vorher korrekt, aber die Carrier-
 * GRUNDTONHÖHE war ein fester Reglerwert, der sich nie änderte -- ein
 * echter Vocoder klingt "lebendig", weil man den Carrier entweder live über
 * eine Tastatur spielt ODER er die Tonhöhe der Stimme mitverfolgt. RackWerk-
 * Inserts haben keinen Noten-Eingang, also Variante zwei: dieser Worklet
 * schätzt die Grundfrequenz des Eingangssignals per normalisierter
 * Autokorrelation -- dieselbe Standard-/Referenztechnik wie das bekannte,
 * seit Jahren frei zugängliche "pitchdetect"-Beispiel aus den offiziellen
 * Web-Audio-API-Samples (Scan über einen Lag-Bereich, normalisierte
 * Korrelation, Schwellenwert für "stimmhaft genug").
 *
 * Wichtiges Detail gegen Oktavfehler (Autokorrelation findet bei einem
 * periodischen Signal Korrelationsspitzen bei JEDEM Vielfachen der wahren
 * Periode, nicht nur bei der Grundperiode selbst): der Lag-Bereich wird
 * von KURZ (hohe Frequenz) nach LANG (tiefe Frequenz) durchsucht, das
 * ERSTE lokale Maximum über der Schwelle wird genommen -- nicht das
 * globale Maximum. Die Grundperiode ist immer der KÜRZESTE Lag mit
 * starker Periodizität, ein späterer (längerer) Lag bei 2x/3x der
 * Grundperiode korreliert zwar oft ÄHNLICH stark, aber eben erst danach --
 * exakt derselbe Kniff wie im oben genannten Referenzbeispiel.
 *
 * WICHTIG (per Test aufgedeckter echter Bug in einer früheren Fassung):
 * "erster Lag ÜBER der Schwelle" ist NICHT dasselbe wie "erstes lokales
 * Maximum über der Schwelle" -- bei einem Sägezahn (breiter, allmählich
 * ansteigender Korrelations-"Buckel" statt einer scharfen Spitze wie bei
 * einer reinen Sinuswelle) überschreitet die Korrelation die Schwelle
 * schon EIN STÜCK VOR der eigentlichen Spitze bei lag=T. Wer dort sofort
 * stoppt, misst systematisch eine zu KURZE Periode = zu HOHE Frequenz --
 * gemessen: durchgehend ~10% zu hoch über mehrere Testfrequenzen (150,
 * 200, 300, 440Hz), kein Zufallsfehler, sondern ein klarer Algorithmus-
 * Bug. Fix: nach der ersten Schwellen-Überschreitung so lange weiter-
 * scannen, wie die Korrelation noch STEIGT (lokales Maximum suchen),
 * erst beim ersten Sinken stoppen und diesen (höheren, korrekteren) Lag
 * nehmen -- verifiziert per tools/dsp-tests/gate-freqshift-vocoder-
 * beatrepeat.mjs (misst jetzt bei 150/300Hz Testfrequenzen genau).
 *
 * Reiner Analyse-Knoten (numberOfOutputs: 0, von Web Audio explizit für
 * genau diesen Fall vorgesehen): läuft, solange sein Eingang verbunden
 * ist, unabhängig von einer Ausgabe-Verbindung. Ergebnis kommt nicht als
 * Audio-Signal zurück, sondern per port.postMessage({freq, clarity}) --
 * die eigentliche Carrier-Frequenz-Änderung (ein einzelner, seltener
 * AudioParam-Ramp alle ~1024 Samples) braucht keine Sample-Genauigkeit,
 * Message-Passing-Latenz (Bruchteile eines Render-Quantums) ist unhörbar.
 */
export const PITCHTRACK_WORKLET_SRC = `
const MIN_FREQ = 65;
const MAX_FREQ = 500;
const CLARITY_THRESHOLD = 0.5;
const BUF_SIZE = 2048;
const HOP_SIZE = 1024;

class RackwerkPitchTrackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(BUF_SIZE);
    this.samplesSinceAnalysis = 0;
    this.minLag = Math.max(2, Math.floor(sampleRate / MAX_FREQ));
    this.maxLag = Math.min(BUF_SIZE - 1, Math.ceil(sampleRate / MIN_FREQ));
  }

  correlationAt(lag) {
    const buf = this.buf;
    const n = buf.length;
    const usable = n - lag;
    let num = 0, e1 = 0, e2 = 0;
    for (let i = 0; i < usable; i++) {
      const a = buf[i];
      const b = buf[i + lag];
      num += a * b;
      e1 += a * a;
      e2 += b * b;
    }
    const denom = Math.sqrt(e1 * e2);
    return denom > 1e-9 ? num / denom : 0;
  }

  detectPitch() {
    let bestLag = -1, bestCorr = -1, found = false;
    for (let lag = this.minLag; lag <= this.maxLag; lag++) {
      const corr = this.correlationAt(lag);
      if (!found) {
        if (corr >= CLARITY_THRESHOLD) { found = true; bestLag = lag; bestCorr = corr; }
      } else if (corr > bestCorr) {
        bestLag = lag; bestCorr = corr;
      } else {
        break; // Korrelation sinkt wieder -- lokales Maximum gefunden.
      }
    }
    return found ? { freq: sampleRate / bestLag, clarity: bestCorr } : { freq: 0, clarity: 0 };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length || !input[0].length) return true;
    const inCh = input[0];
    const n = inCh.length;
    this.buf.copyWithin(0, n);
    this.buf.set(inCh, BUF_SIZE - n);
    this.samplesSinceAnalysis += n;
    if (this.samplesSinceAnalysis >= HOP_SIZE) {
      this.samplesSinceAnalysis = 0;
      this.port.postMessage(this.detectPitch());
    }
    return true;
  }
}
registerProcessor('rackwerk-pitchtrack', RackwerkPitchTrackProcessor);
`;
