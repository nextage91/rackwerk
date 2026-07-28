/**
 * inserts.js — pro Maschine frei zusammensteckbare Insert-Effekte
 * (Compressor, EQ, Drive/Saturation).
 *
 * Jeder Insert ist ein eigenständiger Mini-Graph mit eingebautem
 * Dry/Wet-Bypass:
 *
 *   input ─┬─ dryGain ────────────────┬─ output
 *          └─ [Effekt-Kette] ─ wetGain┘
 *
 * setBypass() schaltet nur dry/wet um — die AUSSENVERKABELUNG (wie die
 * Insert-Kette in machine.js hintereinandergehängt wird) bleibt dabei
 * unberührt, das Rewiring der Kette passiert nur beim Hinzufügen/
 * Entfernen/Verschieben eines Inserts, nicht beim Bypass-Toggle.
 */
import { engine } from './audio-engine.js';
import { transport } from './transport.js';
import { noise } from './dsp.js';

/** Linear-zu-Tanh-Blend statt eines reinen Tanh-Shapers: bei amount=0 ist
 *  die Kurve exakte Identität (Drive komplett zugedreht → 0 zusätzliche
 *  Harmonische), bei amount=1 volle Sättigung (K=30, praktisch hartes
 *  Clipping). Ein reiner `tanh(k*x)` mit k über amount skaliert (k=1
 *  bei amount=0) klingt schon bei niedrigem amount hörbar verzerrt, weil
 *  selbst k=1 spürbar von der Identität abweicht — das Blending macht
 *  den Regler über den ganzen Bereich nutzbar, von ganz sauber bis hart. */
function makeDriveCurve(amount) {
  const n = 1024;
  const curve = new Float32Array(n);
  const K = 30;
  const norm = Math.tanh(K);
  for (let i = 0; i < n; i++) {
    // (n - 1), NICHT n -- s. dieselbe Korrektur + Begründung bei
    // makeSatCurve() in analogkit.js: sonst landet x=0 nicht auf dem
    // Tabellenindex, den WaveShaperNode für x=0 tatsächlich abfragt,
    // wodurch echte Stille einen kleinen, hörbaren DC-Versatz bekommt.
    const x = (i * 2) / (n - 1) - 1;
    const driven = Math.tanh(K * x) / norm;
    curve[i] = (1 - amount) * x + amount * driven;
  }
  return curve;
}

/** Sicherheits-Weichbegrenzer für die Filter-Delay-Feedback-Schleife (s.
 *  DEFS.filterDelay) -- reines tanh(x), UNNORMALISIERT (anders als
 *  makeDriveCurve oben): für normale Pegel (|x| deutlich unter 1) praktisch
 *  linear/unhörbar, biegt aber mathematisch GARANTIERT nie über ±1 hinaus,
 *  egal wie viel Gain sich in der Schleife aufbaut. Ersetzt eine reine
 *  Gain-Reduktion (DynamicsCompressorNode) -- die reagiert nur graduell
 *  (Ratio 20:1 ist kein hartes Ceiling) und kam bei sehr kurzer Delay-Zeit
 *  (kürzer als ihre eigene Release-Zeit) nicht schnell genug hinterher, um
 *  dichte Retriggerung bei extrem hohem Feedback abzufangen (gemessen: Peak
 *  > 2.6 trotz Limiter, auch mit sehr schnellem Attack/Release). Ein
 *  WaveShaper reagiert dagegen pro Sample, ganz ohne Attack-/Release-Zeit. */
export function makeFeedbackClipCurve() {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / (n - 1) - 1;
    curve[i] = Math.tanh(x);
  }
  return curve;
}

/** Bandsättigungskurve für DEFS.tape -- wie makeDriveCurve() ein Blend
 *  Identität<->Sättigung über `amount` (bei 0 exakte Identität, bei 1 volle
 *  Sättigung), aber mit einem zusätzlichen quadratischen Term VOR dem tanh:
 *  reines tanh(K*x) ist punktsymmetrisch (nur ungerade Harmonische, klingt
 *  "digitaler"/kantiger), ein Band sättigt dagegen leicht ASYMMETRISCH
 *  zwischen positiver/negativer Halbwelle (Remanenz-Verhalten des Bandes)
 *  und erzeugt dadurch zusätzlich geradzahlige Harmonische -- der klassische
 *  "wärmere" Bandklang. Der dadurch eingeschleuste kleine Gleichspannungs-
 *  anteil wird NICHT hier kompensiert, sondern von einem separaten
 *  DC-Sperrfilter hinter dem Shaper entfernt (s. DEFS.tape.build()). */
function makeTapeCurve(amount) {
  const n = 1024;
  const curve = new Float32Array(n);
  // K=6 (wie ursprünglich) sättigt bereits bei HALBEM Vollausschlag fast
  // vollständig (tanh(6*0.5)~0.995) -- das klang selbst bei niedrigem
  // `amount` schon deutlich nach Verzerrung/Drive statt nach der gewünschten
  // dezenten Bandsättigung ("soll eigentlich nur bandsättigen", s. Chat).
  // K=1.6 lässt die Kurve bis in den oberen Pegelbereich hinein nahezu
  // linear, rundet also wirklich erst nahe Vollausschlag -- deutlich näher
  // am echten Bandsättigungs-Charakter (nur bei "heissem" Signal hörbar).
  const K = 1.6;
  const norm = Math.tanh(K);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / (n - 1) - 1;
    const shaped = Math.tanh(K * (x + 0.15 * x * x)) / norm;
    curve[i] = (1 - amount) * x + amount * shaped;
  }
  return curve;
}

const dbToLin = (db) => Math.pow(10, db / 20);

/** Handfest GEMESSENE Zusatzlatenzen zweier Web-Audio-Bausteine, die diese
 *  Datei mehrfach nutzt (DynamicsCompressorNode-Lookahead, WaveShaperNode-
 *  Interpolationsfilter bei oversample:'4x') -- keine Werte aus der
 *  Spezifikation (die legt hierzu nichts fest, "implementation-defined"),
 *  sondern per Impulsantwort-Messung ermittelt: ein Impuls allein durch den
 *  jeweiligen Knoten geschickt, der Sample-Index des Antwort-Peaks mit einer
 *  unveränderten Referenz verglichen (298 bzw. 202 Samples statt 10, bei
 *  48kHz -- glatte 6ms/4ms, offenbar feste ZEITEN statt fester Sample-
 *  Zahlen, überleben eine abweichende ctx.sampleRate also unverändert).
 *  Betrifft jeden Effekt, der intern einen dieser Knotentypen NUR im WET-
 *  Pfad seines eigenen Mix-Reglers nutzt (Comp/Opto/Limiter/Resonator via
 *  DynamicsCompressorNode, Drive/Tape via WaveShaperNode) -- ohne
 *  Kompensation summiert der Mix-Regler dort zwei zueinander verschobene
 *  Kopien desselben Signals, hörbar als Kammfilter-"Phasing" (am stärksten
 *  bei Mix~50%). Auf anderen Engines (v. a. WebKit/iOS, das eigentliche
 *  Zielgerät dieser App) womöglich leicht abweichend, aber ein
 *  kompensierter Wert ist immer näher an richtig als gar keiner. */
const DYNAMICS_COMPRESSOR_LATENCY_SEC = 0.006;
const WAVESHAPER_4X_LATENCY_SEC = 0.004;

/** Grundverzögerung des Tape-Machine-Wow/Flutter-Delays (s. DEFS.tape) --
 *  liegt konstant im Wet-Pfad an, unabhängig vom wowFlutter-Reglerstand
 *  (der steuert nur den Modulationshub oben drauf). Muss mindestens den
 *  grössten negativen Modulationshub abdecken (wowFlutter=1: -0.7ms Wow -
 *  0.25ms Flutter = -0.95ms, s. wowGain/flutterGain unten), sonst könnte
 *  die Delay-Zeit ins Negative rutschen. 1.5ms lässt gut 0.5ms
 *  Sicherheitsabstand. Bewusst KLEIN gehalten (ursprünglich 7ms/±5.5ms
 *  Hub): ein moduliertes Delay dieser Grössenordnung erzeugt beim Mischen
 *  mit einer unmodulierten Kopie (Dry/Wet-Regler <1, aber genauso bei
 *  parallelem Processing z. B. über einen Send) hörbares Kammfilter-
 *  "Phasing" -- klang eher nach Flanger als nach echtem Bandgeräte-Wobbel.
 *  Reale Tonbandmaschinen liegen im Bereich weniger Zehntel-Millisekunden;
 *  bei diesen kleineren Hüben liegen die Kammfilter-Kerben so hoch/eng,
 *  dass sie praktisch nicht mehr als Flanger-Sweep wahrnehmbar sind. */
const TAPE_WOWFLUTTER_BASE_DELAY_SEC = 0.0015;

/** Kompensations-Delay für den TROCKENEN Pfad eines Effekts -- derselbe
 *  Trick wie ein Mastering-Limiter mit Lookahead, nur umgekehrt: verzögert
 *  die unverarbeitete Kopie um genau die Zeit, die der Effekt-Pfad durch
 *  einen der obigen Knoten zusätzlich braucht, damit Dry und Wet beim
 *  Mischen wieder phasengleich sind. Bei mix=1 (dry.gain=0) wirkt sich das
 *  nicht aus -- nur bei Zwischenstellungen ändert es hörbar etwas. */
function makeDryCompensationDelay(ctx, seconds) {
  const d = ctx.createDelay(Math.max(0.02, seconds * 2));
  d.delayTime.value = seconds;
  return d;
}

/** Einpoliger Tiefpass (y[n] = (1-a)*x[n] + a*y[n-1]) als Damping-Filter
 *  fürs Reverb-FDN -- bewusst NICHT der naheliegende ctx.createBiquadFilter():
 *  ein 2-poliger Biquad-Tiefpass hat (unabhängig von Q, auch bei sehr
 *  kleinem Q) einen kleinen, aber unvermeidbaren Überschwinger >1.0 nahe
 *  der Grenzfrequenz (gemessen ~1.15-1.22x). In einer Feedback-Schleife
 *  reicht das, um bei dichter/rhythmischer Retriggerung (echter Musik-
 *  betrieb, nicht nur ein einzelner Impuls) tatsächlich unbegrenzt
 *  aufzuschaukeln, siehe git-history dieser Datei.
 *  Ein einpoliger Tiefpass hat dagegen |H(w)| <= 1 für JEDE Frequenz,
 *  beweisbar (Gleichheit nur bei w=0) -- kein Überschwinger möglich, egal
 *  welche Grenzfrequenz. Damit gilt decay*|H(w)| <= decay < 1 garantiert,
 *  für jede Parameter-Kombination, nicht nur für einzeln getestete.
 *  Implementiert über eine Ein-Sample-DelayNode als Verzögerungsglied
 *  (Web Audio erlaubt Delay-Zeiten bis auf Sample-Auflösung). */
function makeOnePoleLowpass(ctx, cutoffHz) {
  const sum = ctx.createGain();
  const inGain = ctx.createGain();
  const fbGain = ctx.createGain();
  const delay = ctx.createDelay(1);
  delay.delayTime.value = 1 / ctx.sampleRate;

  function coeffs(hz) {
    const a = Math.exp((-2 * Math.PI * hz) / ctx.sampleRate);
    return { a, oneMinusA: 1 - a };
  }
  const { a, oneMinusA } = coeffs(cutoffHz);
  inGain.gain.value = oneMinusA;
  fbGain.gain.value = a;

  inGain.connect(sum);
  sum.connect(delay);
  delay.connect(fbGain);
  fbGain.connect(sum);

  return {
    input: inGain,
    output: sum,
    setFreq(hz, t, timeConstant) {
      const c = coeffs(hz);
      inGain.gain.setTargetAtTime(c.oneMinusA, t, timeConstant);
      fbGain.gain.setTargetAtTime(c.a, t, timeConstant);
    },
    dispose() {
      sum.disconnect(); inGain.disconnect(); fbGain.disconnect(); delay.disconnect();
    },
  };
}

/** Schroeder-Allpass-Diffusor: ein Knoten mit gleicher Betragsantwort über
 *  alle Frequenzen (verändert also NICHT die Klangfarbe), aber streut die
 *  Phase -- genau das braucht ein algorithmischer Reverb VOR dem eigentlichen
 *  Delay-Netzwerk, um einen einzelnen Impuls in ein dichtes Bündel dicht
 *  aufeinanderfolgender Mikro-Echos zu verwandeln, statt eines hörbar
 *  "klickenden" Attacks direkt vor dem Hall-Schwanz.
 *    w[n] = x[n] + g*w[n-D]      (läuft in die Delay-Leitung)
 *    y[n] = -g*w[n] + w[n-D]     (Ausgang)
 *  Braucht ZWEI Abgriffe an derselben DelayNode (Fan-out ist in Web Audio
 *  unproblematisch): einen für die Rückkopplung in sich selbst, einen für
 *  den direkten Ausgang. */
function makeAllpass(ctx, delayTime, g) {
  const delay = ctx.createDelay(1);
  delay.delayTime.value = delayTime;
  const input = ctx.createGain(); // w[n]-Summierpunkt
  const output = ctx.createGain(); // y[n]-Summierpunkt
  const fbGain = ctx.createGain();
  fbGain.gain.value = g;
  const ffGain = ctx.createGain();
  ffGain.gain.value = -g;

  input.connect(delay);
  delay.connect(fbGain).connect(input); // Rückkopplung: g*w[n-D] zurück in w[n]
  input.connect(ffGain).connect(output); // -g*w[n]
  delay.connect(output); // + w[n-D] (direkter Delay-Ausgang, zweiter Abgriff)

  return {
    input,
    output,
    // `delay` (die interne DelayNode) UND `feed` (der w[n]-Summierpunkt,
    // identisch mit `input`) zusätzlich exponiert -- der Dattorro-Tank
    // braucht beides von aussen: `delay.delayTime` als LFO-Modulationsziel
    // für die beiden modulierten Allpässe, `feed` als Abgriffspunkt für
    // zusätzliche, kürzere Tap-Delays (dieselbe Leitung an einer früheren
    // Stelle gelesen -- für ein lineares, zeitinvariantes System identisch
    // damit, dieselbe Delay-Leitung an dieser Stelle abzugreifen).
    delay,
    feed: input,
    dispose() { input.disconnect(); output.disconnect(); delay.disconnect(); fbGain.disconnect(); ffGain.disconnect(); },
  };
}

/** Dattorro-Hall-Konstanten (Jon Dattorro, "Effect Design Part 1:
 *  Reverberator and Other Filters", J. Audio Eng. Soc., 1997) -- die
 *  "Figure-8"-Tank-Topologie hinter vielen als besonders "lush"/musikalisch
 *  geltenden Hallgeräten (Vorbild für Lexicon-artige Plates, u.a. auch für
 *  SuperColliders JPverb). Ersetzt das zuvor selbst entworfene 8-Leitungen-
 *  Hadamard-FDN (klang bereits deutlich besser als die allererste Fassung,
 *  blieb aber eine selbst hergeleitete Topologie statt eines erprobten,
 *  vielfach nachgebauten Referenzdesigns).
 *  Alle Sample-Zahlen unten sind bei der Referenz-Samplerate des Original-
 *  Papers (29761 Hz) angegeben -- dattorroSec() in DEFS.reverb.build()
 *  rechnet sie in Sekunden um (DelayNode.delayTime ist ohnehin sekunden-
 *  statt samplebasiert, damit automatisch unabhängig von ctx.sampleRate
 *  korrekt). Cross-verifiziert gegen zwei unabhängige, sich exakt deckende
 *  Referenz-Portierungen (ein WebAudio-AudioWorklet und ein MATLAB-Port). */
const DATTORRO_REF_SR = 29761;

/** Eingangsdiffusion: 4 serielle Allpässe VOR dem eigentlichen Tank (wie
 *  beim alten FDN, nur mit den Original-Konstanten statt frei gewählten
 *  Werten). */
const DATTORRO_INPUT_DIFFUSION = [
  { samples: 142, gain: 0.75 },
  { samples: 107, gain: 0.75 },
  { samples: 379, gain: 0.625 },
  { samples: 277, gain: 0.625 },
];

/** Eine Tank-Hälfte: erster Allpass (im Original-Paper mit modulierter
 *  Delay-Zeit für einen Chorus-artigen "Lush"-Charakter -- hier bewusst
 *  UNMODULIERT, s. Kommentar bei buildTankHalf() in DEFS.reverb.build())
 *  -> langes Delay 1 -> Damping -> Decay -> fester, GEGENGLEICH gepolter
 *  Allpass (negatives Gain) -> langes Delay 2 -> Decay -> Kreuzkopplung in
 *  die JEWEILS ANDERE Hälfte (kein NxN-Mischnetz wie beim alten Hadamard-
 *  FDN, sondern zwei Hälften, die sich nur gegenseitig speisen --
 *  Dattorros charakteristisches "Figure-8"). */
const DATTORRO_TANK = [
  { modDelay: 672, modGain: 0.7, delay1: 4453, ap5Delay: 1800, ap5Gain: -0.5, delay2: 3720 },
  { modDelay: 908, modGain: 0.7, delay1: 4217, ap5Delay: 2656, ap5Gain: -0.5, delay2: 3163 },
];

/** Ausgangs-"Taps": je Kanal 7 kurze Zusatz-Delays, die dieselbe Leitung
 *  (gespeist vom selben Quellsignal wie das jeweilige lange Delay/der feste
 *  Allpass) an einer FRÜHEREN, kürzeren Stelle abgreifen -- für ein
 *  lineares, zeitinvariantes System exakt äquivalent zum Original-Design
 *  (eine einzelne, an mehreren Stellen gelesene Delay-Leitung), ohne eine
 *  eigene Mehrfach-Abgriff-Leitung bauen zu müssen. `half` indiziert
 *  DATTORRO_TANK, `which` wählt zwischen den drei Abgriffspunkten dieser
 *  Hälfte (vor Delay 1 / vor dem festen Allpass / vor Delay 2). Vorzeichen
 *  und Reihenfolge wie im Original-Paper -- die grössten zwei Taps je Kanal
 *  kommen bewusst aus der JEWEILS ANDEREN Tank-Hälfte (Stereo-Dekorrelation:
 *  linker und rechter Kanal ziehen ihre Haupt-Energie aus verschiedenen
 *  Leitungen). */
const DATTORRO_TAPS = {
  L: [
    { half: 1, which: 'delay1', samples: 266, sign: 1 },
    { half: 1, which: 'delay1', samples: 2974, sign: 1 },
    { half: 1, which: 'ap5', samples: 1913, sign: -1 },
    { half: 1, which: 'delay2', samples: 1996, sign: 1 },
    { half: 0, which: 'delay1', samples: 1990, sign: -1 },
    { half: 0, which: 'ap5', samples: 187, sign: -1 },
    { half: 0, which: 'delay2', samples: 1066, sign: -1 },
  ],
  R: [
    { half: 0, which: 'delay1', samples: 353, sign: 1 },
    { half: 0, which: 'delay1', samples: 3627, sign: 1 },
    { half: 0, which: 'ap5', samples: 1228, sign: -1 },
    { half: 0, which: 'delay2', samples: 2673, sign: 1 },
    { half: 1, which: 'delay1', samples: 2111, sign: -1 },
    { half: 1, which: 'ap5', samples: 335, sign: -1 },
    { half: 1, which: 'delay2', samples: 121, sign: -1 },
  ],
};

/** Pegelausgleich für die 7-fach-Tap-Summe je Kanal (s. DATTORRO_TAPS) --
 *  unity-Gain-Taps wie im Original-Paper summieren sich sonst deutlich
 *  lauter als der Dry-Pfad. Empirisch per Peak-Messung bestimmt (s.
 *  Testprotokoll bei der Umstellung von FDN auf Dattorro). */
const DATTORRO_OUT_LEVEL = 0.25;

/** Frequenzverhältnisse relativ zur Grundtonhöhe je Resonator-"Akkord" --
 *  bewusst 5 Werte je Set (feste Bank-Grösse N=5 im Resonator-DEFS).
 *  'harmonic' ist die natürliche Obertonreihe (glockig/saitig), die
 *  anderen sind gleichstufig temperierte Intervall-Stapel. */
const RESONATOR_INTERVAL_RATIOS = {
  harmonic: [1, 2, 3, 4, 5],
  octaves: [0.5, 1, 2, 4, 8],
  fifths: [1, 1.5, 2, 3, 4],
  minor: [1, Math.pow(2, 3 / 12), Math.pow(2, 7 / 12), 2, 2 * Math.pow(2, 7 / 12)],
  major: [1, Math.pow(2, 4 / 12), Math.pow(2, 7 / 12), 2, 2 * Math.pow(2, 7 / 12)],
};

/** Winzige, FESTE (nicht zufällige -- reproduzierbar) Verstimmung je Band,
 *  in Cent, als Multiplikationsfaktor auf die exakten Verhältnisse oben.
 *  Perfekt ganzzahlige Verhältnisse klingen sauber, aber synthetisch/
 *  "geometrisch" -- ein echtes mitschwingendes Objekt (Glocke, Saite,
 *  Platte) ist NIE exakt harmonisch gestimmt. Bewusst klein (unter 10 Cent,
 *  deutlich unter einem hörbaren "Verstimmt"-Effekt) und ohne erkennbares
 *  Muster (kein simples Alternieren +/-), nur genug, damit die Bänder beim
 *  Ausklingen leicht gegeneinander schweben statt exakt phasenstarr zu
 *  bleiben. Erstes Band (Grundton) bleibt unverstimmt -- der Referenzpunkt,
 *  auf den pitch/Tuner-Erwartung sich bezieht. */
const RESONATOR_DETUNE = [0, -7, 5, -4, 9].map((cents) => Math.pow(2, cents / 1200));

/** Dieselben Intervall-"Akkorde" wie RESONATOR_INTERVAL_RATIOS, nur in
 *  Halbtönen statt als Frequenzverhältnis -- Grundlage für die 5 frei
 *  bespielbaren "Tune"-Regler je Band (s. DEFS.resonator): ein Preset-
 *  Knopf befüllt damit einmalig alle 5 Regler, die man danach EINZELN
 *  weiterverstellen kann (wie bei Abletons Resonators-Effekt: Tune+Fine
 *  pro Resonator statt nur fixer Akkord-Auswahl). Rein rechnerisch aus den
 *  Verhältnissen abgeleitet (12*log2(ratio)), damit beide Tabellen
 *  garantiert dieselben Intervalle meinen. */
const RESONATOR_PRESET_SEMITONES = Object.fromEntries(
  Object.entries(RESONATOR_INTERVAL_RATIOS).map(([name, ratios]) => [name, ratios.map((r) => 12 * Math.log2(r))]),
);

/** Stereo-Panorama-Positionen je Band (-1=links .. 1=rechts), mit dem
 *  "width"-Regler skaliert -- Grundton bleibt immer mittig (Referenzpunkt),
 *  die Obertöne verteilen sich alternierend übers Stereobild. Gleiche Idee
 *  wie Abletons Resonators-Width (dort machen die geraden/ungeraden
 *  Resonatoren je einen Kanal), macht den sonst mono-tristen Klang
 *  spürbar "grösser"/lebendiger. */
const RESONATOR_PAN = [0, -0.8, 0.8, -1, 1];

/** Resonance-Regler (0..1) auf eine Nachklingzeit (T60, Sekunden) abbilden
 *  -- Grundlage für die Feedback-Stärke jeder Resonanz-Delayline in
 *  DEFS.resonator (s. dort). Log-Kurve wie zuvor bei der Bandpass-Güte,
 *  gleiche Idee: der Regler soll über den ganzen Bereich gleichmässig
 *  "greifen" statt am oberen Ende zu stauchen. */
function resonanceToDecayTime(resonance) {
  return 0.05 * Math.pow(120, resonance); // 50ms (kurzes "Blup") .. 6s (langes Glocken-Sustain)
}

/** Feedback-Stärke einer einzelnen Resonanz-Delayline (Länge `delayTime`
 *  Sekunden), so gewählt, dass die Amplitude nach `decayTime` Sekunden auf
 *  -60dB (0.001x) gefallen ist: nach n=decayTime/delayTime Schleifen-
 *  durchläufen soll g^n = 0.001 gelten, also g = 0.001^(delayTime/decayTime).
 *  Hart gedeckelt auf 0.999 -- nie exakt 1 (nie eine Schleife, die
 *  theoretisch unendlich klingt), zusätzliche Sicherheitsmarge oben drauf
 *  zur harten 1.0-Grenze. s. DEFS.resonator für die zwei WEITEREN
 *  Sicherungen (einpoliger Damping-Filter + Pro-Sample-Weichbegrenzer IN
 *  der Schleife), die zusammen echte Stabilität auch unter Live-Automation
 *  garantieren -- diese Formel allein reicht dafür NICHT (s. dortigen
 *  Kommentar). */
function feedbackGainFor(delayTime, decayTime) {
  return Math.min(Math.pow(0.001, delayTime / decayTime), 0.999);
}

/** Feste Schwelle statt Regler — wie beim 1176-Vorbild: kein Threshold-
 *  Knopf, stattdessen treibt Input den Pegel in einen fest eingestellten
 *  Kompressor hinein ("drive it hard"). Output macht danach die Lautstärke
 *  wieder wett. */
const COMP_FIXED_THRESHOLD_DB = -18;

/** Ratio ist beim 1176 eine Taster-Reihe, kein Drehregler. Kleinere Knee
 *  bei höherer Ratio = härterer Einsatz; "all" (alle Taster gedrückt, der
 *  legendäre "British Mode"/Nuke) fährt Ratio+Knee auf Anschlag für den
 *  krachigsten, am wenigsten transparenten Charakter. */
const RATIO_MODES = {
  4:    { ratio: 4,  knee: 24 },
  8:    { ratio: 8,  knee: 18 },
  12:   { ratio: 12, knee: 12 },
  20:   { ratio: 20, knee: 6 },
  all:  { ratio: 20, knee: 0 },
};
export const RATIO_MODE_BUTTONS = [
  { value: '4', label: '4' },
  { value: '8', label: '8' },
  { value: '12', label: '12' },
  { value: '20', label: '20' },
  { value: 'all', label: 'ALL' },
];

/** Der echte LA-2A hat keinen Ratio-Regler, sondern einen Zweistufen-
 *  Schalter -- "Compress" (~3:1, moderat, für Gesang/Bass) und "Limit"
 *  (~20:1, hart, fürs "Zudrücken" lauter Peaks). */
const OPTO_MODES = {
  compress: { ratio: 3 },
  limit: { ratio: 20 },
};
export const OPTO_MODE_BUTTONS = [
  { value: 'compress', label: 'Compress' },
  { value: 'limit', label: 'Limit' },
];

/** ISO-nahe Standardfrequenzen eines klassischen 10-Band-Grafik-EQs
 *  (Oktavabstand) -- eigene, feste Bänder, bewusst UI/DSP-seitig komplett
 *  getrennt vom parametrischen eq8 oben (dort frei positionierbar/
 *  Q-einstellbar, hier fixe Frequenzen + feste Bandbreite, dafür als
 *  Schieberegler-Reihe auf einen Blick bedienbar, wie am Hardware-Vorbild). */
export const GEQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
/** Q für ~1-Oktav-Bandbreite bei einem Peaking-Filter (RBJ Audio-EQ-
 *  Cookbook), damit sich benachbarte Bänder bei Oktavabstand sauber
 *  überlappen statt Lücken/harte Stufen zu lassen. */
const GEQ_Q = 1.41;

/** Maximale Rauschamplitude bei Hiss=1 (s. DEFS.tape) -- ursprünglich 0.05,
 *  war deutlich zu laut: Band-Grundrauschen will man grundsätzlich nur ganz
 *  leise mit dabei haben, kein hörbares Zischen im Vordergrund. Erst um 60%
 *  gesenkt (0.05 -> 0.02), dann nochmals um 30% (0.02 -> 0.014) fürs feinere
 *  Einstellen im dezenten Bereich. Als Nebeneffekt deckt der GESAMTE
 *  Regelweg des Knobs jetzt den tatsächlich brauchbaren, dezenten Bereich
 *  ab, statt dass (wie ursprünglich) schon die untere Hälfte des Reglers zu
 *  laut war und nur ein kleiner Ausschnitt am unteren Anschlag praktisch
 *  nutzbar blieb -- ohne Kurven-Änderung, allein durch die Skalierung
 *  "verfeinert" sich damit die Auflösung im leisen, gewünschten Bereich. */
const HISS_MAX_GAIN = 0.014;

const DEFS = {
  comp: {
    name: 'Compressor',
    // Feste Zusatzlatenz des DynamicsCompressorNode-Lookaheads (s.
    // DYNAMICS_COMPRESSOR_LATENCY_SEC oben) -- von insertChainLatencySec()
    // gelesen, damit machine.js jede Maschine gegenüber dem Rest des Racks
    // zeitlich ausgleichen kann (s. dortigen PDC-Kommentar).
    latencySec: DYNAMICS_COMPRESSOR_LATENCY_SEC,
    // 1176-Style: Input (treibt in die feste Schwelle), Attack, Release,
    // Ratio-Modus (Taster statt Regler), Output (Makeup) — kein Threshold.
    // mix: Parallelkompression ("New-York-Style", wie Abletons Compressor-
    // Dry/Wet) -- 1.0 (Default) entspricht dem alten, immer volltrocken-
    // freien Verhalten, rückwärtskompatibel zu alten Projekten ohne dieses
    // Feld.
    defaults: { input: 0, output: 0, attack: 0.003, release: 0.25, ratioMode: '4', mix: 1 },
    build(ctx, p) {
      // Eigener äusserer Ein-/Ausgang für den Dry/Wet-Blend -- getrennt von
      // inputGain (der bleibt die reine, compressor-interne "Input"-Trimmung
      // vor der festen Schwelle, soll die trockene Kopie nicht mitfärben).
      const input = ctx.createGain();
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      dry.gain.value = 1 - p.mix;
      wet.gain.value = p.mix;

      // Kompensiert den Lookahead des DynamicsCompressorNode unten (s.
      // DYNAMICS_COMPRESSOR_LATENCY_SEC oben) -- ohne das käme die trockene
      // Kopie ~6ms VOR der bearbeiteten an, beim Mischen (mix<1) ein
      // hörbares Kammfilter-"Phasing", am stärksten um mix=0.5.
      const dryDelay = makeDryCompensationDelay(ctx, DYNAMICS_COMPRESSOR_LATENCY_SEC);

      const inputGain = ctx.createGain();
      inputGain.gain.value = dbToLin(p.input);
      const node = ctx.createDynamicsCompressor();
      node.threshold.value = COMP_FIXED_THRESHOLD_DB;
      const mode = RATIO_MODES[p.ratioMode] ?? RATIO_MODES['4'];
      node.ratio.value = mode.ratio;
      node.knee.value = mode.knee;
      node.attack.value = p.attack;
      node.release.value = p.release;
      const outputGain = ctx.createGain();
      outputGain.gain.value = dbToLin(p.output);

      input.connect(dryDelay).connect(dry);
      input.connect(inputGain);
      inputGain.connect(node);
      node.connect(outputGain);
      outputGain.connect(wet);
      const outSum = ctx.createGain();
      dry.connect(outSum);
      wet.connect(outSum);

      return {
        input, output: outSum,
        setParam(key, v) {
          const t = engine.now;
          if (key === 'input') inputGain.gain.setTargetAtTime(dbToLin(v), t, 0.01);
          else if (key === 'output') outputGain.gain.setTargetAtTime(dbToLin(v), t, 0.01);
          else if (key === 'attack') node.attack.setTargetAtTime(v, t, 0.01);
          else if (key === 'release') node.release.setTargetAtTime(v, t, 0.01);
          else if (key === 'ratioMode') {
            const m = RATIO_MODES[v] ?? RATIO_MODES['4'];
            node.ratio.setTargetAtTime(m.ratio, t, 0.01);
            node.knee.setTargetAtTime(m.knee, t, 0.01);
          } else if (key === 'mix') {
            dry.gain.setTargetAtTime(1 - v, t, 0.01);
            wet.gain.setTargetAtTime(v, t, 0.01);
          }
        },
        // Live-Gain-Reduction fürs GR-Meter — Web Audio liefert den Wert
        // direkt vom nativen Compressor, kein separates Analyse-Tapping
        // nötig (negative dB, 0 = keine Reduktion).
        getReductionDb() { return node.reduction ?? 0; },
        dispose() {
          input.disconnect(); dry.disconnect(); wet.disconnect(); outSum.disconnect();
          dryDelay.disconnect(); inputGain.disconnect(); node.disconnect(); outputGain.disconnect();
        },
      };
    },
  },
  eq: {
    name: 'EQ',
    // Bewusst EIN Band (nicht fest 3-bandig) — die freie Kette erlaubt es,
    // bei Bedarf mehrere EQ-Instanzen zu stapeln (Low-Shelf + Peak + High-
    // Shelf), passt zur gewählten "flexiblen Kette" statt einer festen.
    defaults: { type: 'peaking', freq: 1000, gain: 0, q: 1 },
    build(ctx, p) {
      const node = ctx.createBiquadFilter();
      node.type = p.type;
      node.frequency.value = p.freq;
      node.gain.value = p.gain;
      node.Q.value = p.q;
      return {
        input: node,
        output: node,
        setParam(key, v) {
          if (key === 'type') node.type = v;
          else if (key === 'freq') node.frequency.setTargetAtTime(v, engine.now, 0.01);
          else if (key === 'gain') node.gain.setTargetAtTime(v, engine.now, 0.01);
          else if (key === 'q') node.Q.setTargetAtTime(v, engine.now, 0.01);
        },
        dispose() { node.disconnect(); },
      };
    },
  },
  eq8: {
    name: '8-Band EQ',
    // 8 feste Bänder (anders als 'eq' oben) -- touch-bedienbares Pendant zu
    // EQ8/Pro-Q. Ein inaktives Band bleibt fest in der Kette (kein
    // Umverkabeln beim An-/Ausschalten), wird aber lautlos auf neutral
    // (Gain 0) gezwungen -- für peaking/lowshelf/highshelf ist Gain 0 in
    // jedem Fall die neutrale, unhörbare Stellung. Deshalb bewusst nur
    // diese drei Typen (kein High-/Lowcut, das wäre bei Gain 0 nicht neutral).
    defaults: {
      bands: Array.from({ length: 8 }, () => ({ active: false, type: 'peaking', freq: 1000, gain: 0, q: 1 })),
    },
    build(ctx, p) {
      const nodes = p.bands.map((b) => {
        const node = ctx.createBiquadFilter();
        node.type = b.type;
        node.frequency.value = b.freq;
        node.gain.value = b.active ? b.gain : 0;
        node.Q.value = b.q;
        return node;
      });
      for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);

      return {
        input: nodes[0],
        output: nodes[nodes.length - 1],
        // Der generische Insert-Wrapper kennt nur ein flaches key/value-
        // setParam -- passt nicht auf "ein Feld eines von 8 Bändern".
        // setBand/getEq8Response sind bewusst zusätzliche, eq8-eigene
        // Methoden (gleiches Muster wie getReductionDb beim Compressor),
        // die createInsert() unten optional durchreicht. p.bands wird
        // von der UI direkt mutiert (dieselbe Referenz wie insert.params.
        // bands), setBand liest daraus nur den aktuellen Wert und schreibt
        // ihn an den echten Audio-Node.
        setParam() {}, // eq8 läuft komplett über setBand, s. oben
        setBand(i, field) {
          const b = p.bands[i];
          const node = nodes[i];
          if (!node) return;
          if (field === 'type') node.type = b.type;
          else if (field === 'freq') node.frequency.setTargetAtTime(b.freq, engine.now, 0.01);
          else if (field === 'gain' || field === 'active') {
            node.gain.setTargetAtTime(b.active ? b.gain : 0, engine.now, 0.01);
          } else if (field === 'q') node.Q.setTargetAtTime(b.q, engine.now, 0.01);
        },
        /** Summierte dB-Antwort aller AKTIVEN Bänder über freqArray (Hz) --
         *  echte Berechnung über das native getFrequencyResponse() jedes
         *  Bandes statt einer geschätzten Silhouette (s. machine.js#
         *  eqCurvePath für den Einzelband-EQ). dB-Werte addieren sich für
         *  in Serie geschaltete Filter korrekt (Amplituden multiplizieren
         *  sich, log(a*b) = log(a)+log(b)). */
        getEq8Response(freqArray) {
          const mag = new Float32Array(freqArray.length);
          const phase = new Float32Array(freqArray.length);
          const totalDb = new Float32Array(freqArray.length);
          for (let i = 0; i < nodes.length; i++) {
            if (!p.bands[i].active) continue;
            nodes[i].getFrequencyResponse(freqArray, mag, phase);
            for (let j = 0; j < freqArray.length; j++) {
              totalDb[j] += 20 * Math.log10(Math.max(1e-6, mag[j]));
            }
          }
          return totalDb;
        },
        dispose() { nodes.forEach((n) => n.disconnect()); },
      };
    },
  },
  drive: {
    name: 'Drive',
    // Feste Zusatzlatenz des 4x-Oversampling-Interpolationsfilters (s.
    // WAVESHAPER_4X_LATENCY_SEC oben) -- s. Kommentar bei DEFS.comp.latencySec.
    latencySec: WAVESHAPER_4X_LATENCY_SEC,
    // base: Pre-Shaper-Filter (wie Abletons Saturator-"Color"-Sektion) --
    // VOR der Sättigung, entscheidet WELCHE Frequenzen überhaupt in den
    // Shaper laufen, nicht nur wie das Ergebnis klingt (das macht `tone`
    // danach, ein reiner Ausgangs-Klangfarbe-Filter). Ein Low-Shelf: positiver
    // Wert hebt Bässe VOR der Sättigung an (mehr/wärmere Bass-Harmonische),
    // negativer senkt sie ab (Sättigung verlagert sich zu Mitten/Höhen --
    // "fizzy"/präsenter statt wummernd). 0 = flach = unverändert.
    // mix: Dry/Wet wie Abletons Saturator -- 1.0 (Default) entspricht dem
    // alten, immer volltrockenfreien Verhalten.
    defaults: { drive: 0.4, tone: 0.6, level: 0.8, base: 0, mix: 1 },
    build(ctx, p) {
      const input = ctx.createGain();
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      dry.gain.value = 1 - p.mix;
      wet.gain.value = p.mix;

      const pre = ctx.createBiquadFilter();
      pre.type = 'lowshelf';
      pre.frequency.value = 300;
      pre.gain.value = p.base * 15; // ±15dB, deutlich hörbar ohne extrem zu sein

      const shaper = ctx.createWaveShaper();
      shaper.oversample = '4x';
      shaper.curve = makeDriveCurve(p.drive);
      const tone = ctx.createBiquadFilter();
      tone.type = 'lowpass';
      tone.Q.value = 0.7;
      tone.frequency.value = 400 * Math.pow(12000 / 400, p.tone);
      const level = ctx.createGain();
      level.gain.value = p.level;

      // Kompensiert das 4x-Oversampling-Interpolationsfilter des Shapers
      // oben (s. WAVESHAPER_4X_LATENCY_SEC) -- sonst käme die trockene
      // Kopie ~4ms VOR der gesättigten an, beim Mischen (mix<1) ein
      // hörbares Kammfilter-"Phasing", am stärksten um mix=0.5.
      const dryDelay = makeDryCompensationDelay(ctx, WAVESHAPER_4X_LATENCY_SEC);
      input.connect(dryDelay).connect(dry);
      input.connect(pre);
      pre.connect(shaper);
      shaper.connect(tone);
      tone.connect(level);
      level.connect(wet);
      const outSum = ctx.createGain();
      dry.connect(outSum);
      wet.connect(outSum);

      // Kurve neu bauen ist teuer (1024 Sample-tanh() + Reassignment an den
      // Audio-Thread, das zudem bei aktivem Signal hörbar knackst, weil
      // WaveShaper-Kurven beim Wechsel nicht überblendet werden) -- der Knob
      // feuert aber auf JEDEN pointermove, beim Ziehen also bis zu 60x/s.
      // Gleiches Entprellen wie fx.js' #buildIR() für den Reverb-Impuls.
      let driveTimer = null;
      return {
        input, output: outSum,
        setParam(key, v) {
          if (key === 'drive') {
            clearTimeout(driveTimer);
            driveTimer = setTimeout(() => { shaper.curve = makeDriveCurve(v); }, 60);
          }
          else if (key === 'tone') tone.frequency.setTargetAtTime(400 * Math.pow(12000 / 400, v), engine.now, 0.01);
          else if (key === 'level') level.gain.setTargetAtTime(v, engine.now, 0.01);
          else if (key === 'base') pre.gain.setTargetAtTime(v * 15, engine.now, 0.01);
          else if (key === 'mix') {
            dry.gain.setTargetAtTime(1 - v, engine.now, 0.01);
            wet.gain.setTargetAtTime(v, engine.now, 0.01);
          }
        },
        dispose() {
          clearTimeout(driveTimer);
          input.disconnect(); dry.disconnect(); wet.disconnect(); outSum.disconnect();
          dryDelay.disconnect(); pre.disconnect(); shaper.disconnect(); tone.disconnect(); level.disconnect();
        },
      };
    },
  },
  filterDelay: {
    name: 'Filter Delay',
    // Anders als Comp/EQ/Drive (die immer voll "wet" arbeiten) braucht ein
    // Delay einen eigenen, stufenlosen Dry/Wet-Regler -- der äussere
    // dryGain/wetGain-Umschalter von createInsert() ist ein reiner Bypass
    // (0 oder 1, kein Zwischenwert), kein Mix-Regler. Der Mix-Regler lebt
    // deshalb INNERHALB dieses Effekts, wie schon Drive's `level`.
    //
    // pingPong (wie Abletons Delay): zwei Verzögerungsleitungen im Über-
    // Kreuz-Feedback (delayL -> filterL -> [Panner] UND -> feedbackL ->
    // delayR -> filterR -> [Panner] UND -> feedbackR -> zurück in delayL,
    // usw.) statt einer einzelnen. Mathematisch ÄQUIVALENT zum alten
    // Einzelleitungs-Mono-Delay, wenn beide Panner auf 0 (Mitte) stehen --
    // jede Wiederholung durchläuft exakt dieselbe Anzahl Filter-/Feedback-
    // Stufen wie im alten Design, nur auf zwei Knoten verteilt (Echo n
    // erscheint bei nT, gedämpft um feedback^(n-1), identisch zum Original
    // -- nachgerechnet). Deshalb KEIN struktureller Graph-Umbau nötig, wenn
    // pingPong ein-/ausgeschaltet wird: nur die beiden Panner-Werte ändern
    // sich (0/0 = Mono wie bisher, -1/1 = volles Ping-Pong).
    //
    // division (wie Abletons Delay-Sync): 'free' (Default) lässt `time`
    // (Sekunden) wie bisher frei wirken; jeder Notenwert überschreibt die
    // Delay-Zeit relativ zu transport.bpm und hält sie bei jeder Tempo-
    // Änderung aktuell (transport.addListener, gleiche Set-basierte
    // Registry wie bei Maschinen -- ein Insert ist selbst keine Maschine,
    // meldet sich hier aber genauso an).
    defaults: {
      time: 0.35, feedback: 0.4, filterFreq: 2000, filterType: 'lowpass', mix: 0.35,
      pingPong: false, division: 'free', swing: 50,
    },
    build(ctx, p) {
      const input = ctx.createGain();
      const output = ctx.createGain();
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      dry.gain.value = 1 - p.mix;
      wet.gain.value = p.mix;

      // 4s statt 2s Maximum: bei tiefstem Tempo (40 BPM, s. transport.js)
      // braucht selbst eine gesynct 1/2-Note schon 3s -- 2s hätte das
      // stillschweigend gekappt (DelayNode klemmt delayTime laut Spezifikation
      // ohne Fehler auf maxDelayTime, kein Crash, aber falsche/verwirrende
      // Zeit).
      const delayL = ctx.createDelay(4.0);
      const delayR = ctx.createDelay(4.0);
      const computeTime = () => (p.division === 'free'
        ? p.time
        : transport.stepDuration * 4 * (DELAY_SYNC_DIVISIONS[p.division] ?? 1));
      // Swing (nur bei Tempo-Sync sinnvoll, s. UI_PARAMS.filterDelay): delayR
      // bekommt zusätzlich zur Basiszeit einen festen Versatz von bis zu
      // einem halben 16tel-Step (dieselbe Formel wie shuffleTime()). Da
      // delayL/delayR eine Kreuz-Feedback-Schleife bilden (delayL -> ... ->
      // delayR -> ... -> delayL, s. Kommentar oben), wechseln sich die
      // Wiederholungsabstände dadurch OHNE jedes Scheduling automatisch
      // zwischen delayL- und delayR-Zeit ab -- exakt der "swingt jede zweite
      // Wiederholung" -Effekt, rein aus der bestehenden Topologie heraus.
      // swing=50 (Default) ergibt delayR===delayL, mathematisch identisch
      // zum bisherigen Verhalten (s. Kommentar oben zur pingPong-Äquivalenz).
      const computeSwingShift = () => (p.division === 'free' || p.swing <= 50
        ? 0
        : (p.swing - 50) / 50 * transport.stepDuration);
      const t0 = computeTime();
      delayL.delayTime.value = t0;
      delayR.delayTime.value = t0 + computeSwingShift();

      // Feedback-Schleife: delay -> filter -> feedback -> zurück in delay.
      // Der WET-Abgriff sitzt NACH dem Filter, nicht am rohen Delay-Ausgang
      // -- sonst wäre bei Mix=100% das ERSTE Echo noch ein unverändertes,
      // ungefiltertes Abbild des Eingangssignals (nur zeitversetzt), was
      // sich anhört, als würde trotz Mix=100% noch das Trockensignal
      // durchkommen. So durchläuft JEDE Wiederholung, auch die erste, den
      // Filter -- nur die nachfolgenden (die zusätzlich durch die
      // Feedback-Schleife liefen) werden zunehmend stärker gefiltert.
      const filterL = ctx.createBiquadFilter();
      const filterR = ctx.createBiquadFilter();
      for (const f of [filterL, filterR]) {
        f.type = p.filterType;
        f.frequency.value = p.filterFreq;
        f.Q.value = 0.7;
      }
      const feedbackL = ctx.createGain();
      const feedbackR = ctx.createGain();
      feedbackL.gain.value = p.feedback;
      feedbackR.gain.value = p.feedback;
      // Weichbegrenzer IN der Feedback-Schleife (s. makeFeedbackClipCurve()
      // oben) -- fängt genau die Filter-Überhöhung ab, die bisher die
      // 0.8-Feedback-Obergrenze nötig machte (s. UI_PARAMS.filterDelay-
      // Kommentar), erlaubt dadurch ein deutlich höheres, fast selbst-
      // schwingendes Feedback ohne unbegrenztes Aufschaukeln -- verifiziert
      // per Stresstest (dichte Retriggerung über Feedback x Filtertyp x
      // Filterfrequenz x Zeit x PingPong). Ein erster Versuch mit einem
      // DynamicsCompressorNode (wie beim Resonator-Limiter) reichte NICHT:
      // dessen Ratio (20:1) ist kein hartes Ceiling, nur eine graduelle
      // Reduktion, und bei sehr kurzer Delay-Zeit (Minimum 0.01s, kürzer als
      // jede sinnvolle Release-Zeit) kam er nie zur Ruhe -- gemessen Peak
      // > 2.6 trotz Kompressor. Der WaveShaper reagiert dagegen pro Sample,
      // ganz ohne Attack-/Release-Verzögerung.
      const clipL = ctx.createWaveShaper();
      const clipR = ctx.createWaveShaper();
      const feedbackClipCurve = makeFeedbackClipCurve();
      clipL.curve = feedbackClipCurve;
      clipR.curve = feedbackClipCurve;
      clipL.oversample = '2x';
      clipR.oversample = '2x';
      const pannerL = ctx.createStereoPanner();
      const pannerR = ctx.createStereoPanner();
      pannerL.pan.value = p.pingPong ? -1 : 0;
      pannerR.pan.value = p.pingPong ? 1 : 0;

      input.connect(dry).connect(output);
      input.connect(delayL);
      delayL.connect(filterL);
      filterL.connect(pannerL).connect(wet);
      filterL.connect(feedbackL).connect(clipL).connect(delayR);
      delayR.connect(filterR);
      filterR.connect(pannerR).connect(wet);
      filterR.connect(feedbackR).connect(clipR).connect(delayL);
      wet.connect(output);

      // Setzt delayL auf die gerade Basiszeit und delayR auf Basiszeit+Swing
      // -- einziger Ort, der beide Delay-Zeiten anfasst, damit time/division/
      // swing/BPM-Änderungen nie auseinanderlaufen können.
      const applyTimes = () => {
        const time = computeTime();
        const t = engine.now;
        delayL.delayTime.setTargetAtTime(time, t, 0.02);
        delayR.delayTime.setTargetAtTime(time + computeSwingShift(), t, 0.02);
      };

      const bpmListener = {
        onTransport(event) {
          if (event !== 'bpm' || p.division === 'free') return;
          applyTimes();
        },
      };
      transport.addListener(bpmListener);

      return {
        input, output,
        setParam(key, v) {
          const t = engine.now;
          if (key === 'time') {
            if (p.division === 'free') applyTimes();
          } else if (key === 'feedback') {
            feedbackL.gain.setTargetAtTime(v, t, 0.01);
            feedbackR.gain.setTargetAtTime(v, t, 0.01);
          } else if (key === 'filterFreq') {
            filterL.frequency.setTargetAtTime(v, t, 0.01);
            filterR.frequency.setTargetAtTime(v, t, 0.01);
          } else if (key === 'filterType') {
            filterL.type = v; filterR.type = v;
          } else if (key === 'mix') {
            dry.gain.setTargetAtTime(1 - v, t, 0.01);
            wet.gain.setTargetAtTime(v, t, 0.01);
          } else if (key === 'pingPong') {
            pannerL.pan.setTargetAtTime(v ? -1 : 0, t, 0.02);
            pannerR.pan.setTargetAtTime(v ? 1 : 0, t, 0.02);
          } else if (key === 'division' || key === 'swing') {
            applyTimes();
          }
        },
        dispose() {
          transport.removeListener(bpmListener);
          input.disconnect(); output.disconnect(); dry.disconnect(); wet.disconnect();
          delayL.disconnect(); delayR.disconnect();
          filterL.disconnect(); filterR.disconnect();
          feedbackL.disconnect(); feedbackR.disconnect();
          clipL.disconnect(); clipR.disconnect();
          pannerL.disconnect(); pannerR.disconnect();
        },
      };
    },
  },
  reverb: {
    name: 'Reverb',
    // Anders als der Master-Reverb in fx.js (Faltung mit einem einmalig
    // erzeugten, statischen Impuls) läuft hier ein ECHTES Feedback-Netzwerk
    // -- nach Jon Dattorros bewährter "Figure-8"-Plate/Hall-Topologie (s.
    // DATTORRO_*-Konstanten oben), nicht mehr das zuvor selbst entworfene
    // 8-Leitungen-Hadamard-FDN. Zwei Tank-Hälften speisen sich gegenseitig
    // (statt eines NxN-Mischnetzes), mit exakt den Original-Delay-Zeiten/
    // Gains/Ausgangs-Taps des Papers -- dasselbe Referenzdesign, auf dem
    // viele als "lush"/musikalisch geltende Hallgeräte aufbauen.
    defaults: { size: 1.0, decay: 0.35, damping: 6000, mix: 0.35 },
    build(ctx, p) {
      const input = ctx.createGain();
      const output = ctx.createGain();
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      dry.gain.value = 1 - p.mix;
      wet.gain.value = p.mix;

      const dattorroSec = (samples) => samples / DATTORRO_REF_SR;
      // Alle mit "size" skalierenden Delays (Diffusion + Tank + Taps)
      // sammeln sich hier als {node, baseSec} -- setParam('size', v) zieht
      // sie synchron nach. Anders als beim alten FDN (dort blieb die
      // Eingangsdiffusion FEST, nur die Tank-Delays skalierten) skaliert
      // hier alles zusammen -- physikalisch stimmiger (ein "grösserer Raum"
      // hat auch längere frühe Reflexionen, nicht nur einen längeren
      // Nachhall-Schwanz) und näher an echten Dattorro-Portierungen, die
      // alle Konstanten gemeinsam mit derselben Grösse skalieren.
      const sizedDelays = [];
      function sizedDelayNode(baseSamples, maxSeconds) {
        const d = ctx.createDelay(maxSeconds);
        const baseSec = dattorroSec(baseSamples);
        d.delayTime.value = baseSec * p.size;
        sizedDelays.push({ node: d, baseSec });
        return d;
      }
      function sizedAllpass(baseSamples, gain) {
        const baseSec = dattorroSec(baseSamples);
        const ap = makeAllpass(ctx, baseSec * p.size, gain);
        sizedDelays.push({ node: ap.delay, baseSec });
        return ap;
      }

      // ---------- Eingangsdiffusion: 4 serielle Allpässe (s. DATTORRO_INPUT_DIFFUSION) ----------
      const diffusers = DATTORRO_INPUT_DIFFUSION.map((d) => sizedAllpass(d.samples, d.gain));
      input.connect(diffusers[0].input);
      for (let i = 1; i < diffusers.length; i++) diffusers[i - 1].output.connect(diffusers[i].input);
      const diffusedOut = diffusers[diffusers.length - 1].output;

      // Sicherheits-Weichbegrenzer an der Kreuzkopplung (s. makeFeedbackClipCurve()
      // oben, gleiche Technik wie bei DEFS.filterDelay) -- ohne das liess sich
      // messen, dass ein PARAMETERWECHSEL (setParam für decay/damping/size,
      // z.B. per Automation oder wenn der Regler beim Laden eines Projekts
      // von den Default- auf gespeicherte Werte rampt) die Rückkopplungs-
      // schleife für die kurze Rampdauer durch einen ZWISCHENZUSTAND führen
      // kann, der (anders als Start- und Zielwert je für sich) kurzzeitig
      // instabil ist -- ein einmal in die DelayNode-Puffer geratener
      // Extremwert (im Grenzfall Infinity/NaN) klingt danach NIE mehr ab,
      // selbst wenn die Parameter längst wieder auf einem sauber stabilen
      // Wert stehen (ein FIR-Delay hat kein "Vergessen", ein einmal
      // gespeichertes Sample bleibt bis es reihum wieder ausgelesen wird).
      // Der WaveShaper reagiert pro Sample (kein Attack/Release-Nachlauf)
      // und ist mathematisch garantiert auf (-1,1) begrenzt, unabhängig
      // davon, wie extrem der Zwischenzustand war.
      const feedbackClipCurve = makeFeedbackClipCurve();

      // ---------- Tank: zwei kreuzgekoppelte Hälften ("Figure-8", s. DATTORRO_TANK) ----------
      // Das Original-Paper moduliert die Delay-Zeit GENAU dieses ersten
      // Allpasses je Hälfte (Chorus-artiges "Lush"). Anders als beim alten
      // FDN (dort waren die modulierten Delays einfache, nicht-rekursive
      // DelayNodes) sitzt diese Delay-Zeit hier INNERHALB der eigenen
      // Rückkopplungsschleife des Allpasses -- gemessen (Diagnose-Sweep bei
      // der Umstellung) führte genau das zu echtem, langsam aufschaukelndem
      // Energiezuwachs (nicht nur hörbarem Flattern, sondern tatsächlicher
      // Instabilität bei hohem Decay), obwohl der Allpass für sich betrachtet
      // energieerhaltend ist -- eine modulierte Delay-ZEIT innerhalb einer
      // REKURSIVEN Schleife ist ein zeitvariantes System, für das der beim
      // alten FDN bewiesene "Modulation fügt keine Energie hinzu"-Satz (der
      // sich auf EINFACHE, nicht-rekursive Delays bezieht) nicht automatisch
      // gilt. Bewusst KEINE Modulation hier -- eine sichere Variante (z.B.
      // ein zusätzliches, nicht-rekursives moduliertes Delay in Serie) wäre
      // als eigener, separat getesteter Schritt nachrüstbar.
      function buildTankHalf(cfg) {
        const modAp = sizedAllpass(cfg.modDelay, cfg.modGain);

        const delay1 = sizedDelayNode(cfg.delay1, 1.0);
        modAp.output.connect(delay1);

        // Damper ist ein einpoliger Tiefpass (makeOnePoleLowpass), NICHT
        // ctx.createBiquadFilter() -- ein 2-poliger Biquad überschwingt
        // >1.0 nahe der Grenzfrequenz, egal welches Q. Damit gilt
        // decay*|Filter| <= decay < 1 GARANTIERT (s. Stabilitäts-Kommentar
        // bei setParam unten).
        const damp = makeOnePoleLowpass(ctx, p.damping);
        delay1.connect(damp.input);

        // decay wird laut Original-Paper ZWEIMAL je Tank-Hälfte angewandt
        // (hier + nochmal an der Kreuzkopplung unten) -- s. Stabilitäts-
        // Kommentar bei setParam, das macht die Schleife SICHERER als beim
        // alten FDN (dort nur einmal je Runde), nicht unsicherer.
        const decayGain1 = ctx.createGain();
        decayGain1.gain.value = p.decay;
        damp.output.connect(decayGain1);

        // Fester, GEGENGLEICH gepolter Allpass (negatives Gain -- anders
        // als der modulierte oben) -- exakt wie im Original-Paper.
        const ap5 = sizedAllpass(cfg.ap5Delay, cfg.ap5Gain);
        decayGain1.connect(ap5.input);

        const delay2 = sizedDelayNode(cfg.delay2, 1.0);
        ap5.output.connect(delay2);

        const decayGain2 = ctx.createGain();
        decayGain2.gain.value = p.decay;
        delay2.connect(decayGain2);

        const clip = ctx.createWaveShaper();
        clip.curve = feedbackClipCurve;
        clip.oversample = '2x';
        decayGain2.connect(clip);

        return {
          input: modAp.input, // Eingang dieser Hälfte (Summe aus geteiltem Diffusions-Signal + Kreuzkopplung der ANDEREN Hälfte)
          crossFeedOut: clip, // -> Eingang der ANDEREN Hälfte
          // Abgriffspunkte für die Ausgangs-Taps (s. DATTORRO_TAPS): jeweils
          // das Signal, das in die entsprechende lange Delay-Leitung/den
          // festen Allpass hineinläuft -- ein zusätzliches, kürzeres Delay
          // ab demselben Punkt ist für ein lineares System exakt
          // gleichbedeutend mit einem weiteren Lesekopf auf DERSELBEN
          // Leitung an einer früheren Stelle.
          tapSources: { delay1: modAp.output, ap5: ap5.feed, delay2: ap5.output },
          dampers: [damp],
          decayGains: [decayGain1, decayGain2],
          disposables: [modAp, ap5, delay1, delay2, damp, decayGain1, decayGain2, clip],
        };
      }
      const tanks = DATTORRO_TANK.map(buildTankHalf);

      // Dasselbe diffundierte Eingangssignal speist BEIDE Tank-Hälften;
      // die beiden Hälften speisen sich zusätzlich GEGENSEITIG (Figure-8) --
      // kein NxN-Mischnetz wie beim alten Hadamard-FDN, nur diese eine
      // Kreuzkopplung.
      diffusedOut.connect(tanks[0].input);
      diffusedOut.connect(tanks[1].input);
      tanks[0].crossFeedOut.connect(tanks[1].input);
      tanks[1].crossFeedOut.connect(tanks[0].input);

      // ---------- Ausgangs-Taps: 7 je Kanal (s. DATTORRO_TAPS) ----------
      const leftSum = ctx.createGain();
      const rightSum = ctx.createGain();
      const tapNodes = [];
      function wireTaps(channelTable, dest) {
        for (const tap of channelTable) {
          const source = tanks[tap.half].tapSources[tap.which];
          const d = sizedDelayNode(tap.samples, 1.0);
          const g = ctx.createGain();
          g.gain.value = tap.sign;
          source.connect(d).connect(g).connect(dest);
          tapNodes.push(d, g);
        }
      }
      wireTaps(DATTORRO_TAPS.L, leftSum);
      wireTaps(DATTORRO_TAPS.R, rightSum);

      // Echtes Stereo-Ausgangssignal (zwei unterschiedliche Tap-Summen,
      // nicht nur ein gedoppeltes Mono-Signal wie beim alten FDN) --
      // DATTORRO_OUT_LEVEL gleicht die 7-fach-Summe (unity-Taps wie im
      // Original-Paper) auf einen mit dem Dry-Pfad vergleichbaren Pegel
      // aus, empirisch per Peak-Messung bestimmt (s. Testprotokoll).
      const merger = ctx.createChannelMerger(2);
      const outLevel = ctx.createGain();
      outLevel.gain.value = DATTORRO_OUT_LEVEL;
      leftSum.connect(merger, 0, 0);
      rightSum.connect(merger, 0, 1);
      merger.connect(outLevel);

      input.connect(dry).connect(output);
      outLevel.connect(wet).connect(output);

      return {
        input, output,
        setParam(key, v) {
          const t = engine.now;
          if (key === 'size') {
            for (const { node, baseSec } of sizedDelays) node.delayTime.setTargetAtTime(baseSec * v, t, 0.05);
          } else if (key === 'decay') {
            // Stabilität: pro Tank-Hälfte wird decay ZWEIMAL angewandt
            // (decayGain1 + decayGain2), ein voller Umlauf (Hälfte A dann
            // B) also mit decay^4 statt (wie beim alten FDN) decay^1 --
            // für decay<1 ist decay^4 IMMER kleiner als decay, die Schleife
            // ist damit für jeden erlaubten decay-Wert noch konservativer
            // stabil als vorher, nicht knapper.
            for (const tank of tanks) for (const dg of tank.decayGains) dg.gain.setTargetAtTime(v, t, 0.02);
          } else if (key === 'damping') {
            for (const tank of tanks) for (const damp of tank.dampers) damp.setFreq(v, t, 0.02);
          } else if (key === 'mix') {
            dry.gain.setTargetAtTime(1 - v, t, 0.01);
            wet.gain.setTargetAtTime(v, t, 0.01);
          }
        },
        dispose() {
          input.disconnect(); output.disconnect(); dry.disconnect(); wet.disconnect();
          for (const d of diffusers) d.dispose();
          for (const tank of tanks) {
            for (const n of tank.disposables) { if (typeof n.dispose === 'function') n.dispose(); else n.disconnect(); }
          }
          for (const n of tapNodes) n.disconnect();
          leftSum.disconnect(); rightSum.disconnect(); merger.disconnect(); outLevel.disconnect();
        },
      };
    },
  },
  resonator: {
    name: 'Resonator',
    // ZWEI DynamicsCompressorNodes im Wet-Pfad hintereinander (Anreger-
    // Ducker unten + Sicherheits-Limiter, s. build()) -- doppelte
    // Zusatzlatenz gegenüber den anderen Kompressor-basierten Inserts.
    latencySec: DYNAMICS_COMPRESSOR_LATENCY_SEC * 2,
    // Bank aus 5 rückgekoppelten Resonanz-Delaylines (Delay -> Damping ->
    // Feedback -> zurück in die Delay), Karplus-Strong-artig -- genau das
    // Prinzip, mit dem auch Abletons Resonators-Effekt arbeitet, statt
    // der vorherigen Bandpass-Bank (Filter allein kann nur vorhandene
    // Energie durchlassen, nie aktiv aufbauen -- deshalb war die alte
    // Version selbst bei Mix=100% spürbar leiser als das Trockensignal,
    // s. Chat). Eine Delayline erzeugt ausserdem automatisch die volle
    // Obertonreihe der Grundtonhöhe (nicht nur einen einzelnen schmalen
    // Peak), klingt dadurch voller/instrumentaler (Glocke/Saite).
    //
    // Zwei von einander UNABHÄNGIGE Sicherungen halten jede der 5
    // Schleifen stabil, beide bereits an anderer Stelle in dieser
    // Codebase erfunden/bewährt:
    //  (1) Der Damping-Filter in der Schleife ist ein EINPOLIGER Tiefpass
    //      (makeOnePoleLowpass, schon vom Reverb-FDN genutzt), NICHT
    //      ctx.createBiquadFilter() -- ein 2-poliger Biquad überschwingt
    //      nachweislich >1.0 nahe der Grenzfrequenz, unabhängig von Q (s.
    //      dortigen Kommentar). Ein einpoliger ist dagegen beweisbar
    //      |H(w)|<=1 für JEDE Frequenz -- kombiniert mit feedbackGainFor()
    //      (<1, s. oben) ist die Schleife für KONSTANTE Parameter damit
    //      immer beweisbar stabil.
    //  (2) Zusätzlich ein Pro-Sample-Weichbegrenzer (tanh, dieselbe Kurve
    //      wie beim Filter Delay: makeFeedbackClipCurve()) IN jeder
    //      Schleife -- nötig, weil Live-Automation ausgerechnet auf
    //      Damping (LFO/Knob, während eine Bande klingt) beim Testen
    //      trotz (1) kurzzeitig aufschaukeln konnte (Parameteränderung an
    //      einem Filter MIT internem Zustand kann kurz übersteuern, auch
    //      wenn der Filter selbst für jeden EINZELNEN, konstanten
    //      Koeffizienten brav <=1 bleibt). Reagiert pro Sample ohne
    //      Attack-/Release-Verzögerung, kann also nie "zu spät" kommen --
    //      exakt der Grund, warum das Filter Delay dort ebenfalls einen
    //      WaveShaper statt eines DynamicsCompressorNode nutzt.
    // Verifiziert per Stresstest: 10s Sustain bei maximaler Resonance,
    // dichte Retriggerung (alle 50ms) bei Max-Resonance+Damping, 100
    // Parameter-Kombinationen (Pitch x Resonance x Damping) sowie Pitch/
    // Resonance/Damping gleichzeitig live automatisiert WÄHREND aktiv
    // geklungen und retriggert wird -- durchgehend kein NaN, kein
    // unbegrenztes Aufschaukeln.
    //
    // Anreger-Ducker (s. build(), "exciter"): anders als ein Bandpass-
    // Filter verschiebt eine Feedback-Delayline die Tonhöhe eines
    // DAUERHAFTEN Eingangssignals nicht -- solange eine Note gehalten wird,
    // läuft deren rohes, breitbandiges Signal ständig direkt in jede der 5
    // Bänder-Schleifen, jede Bande gibt also grösstenteils weiter nur die
    // ANSCHLAG-Tonhöhe wieder, nicht ihre eigene Stimmung (gemessen: bei
    // einem gehaltenen Ton liegen alle 5 Bänder eines "Chord"-Presets zwar
    // pegel-mässig nah beieinander, klingen aber kaum wie 5 unterschiedliche
    // Töne -- Nutzer-Feedback: "ich höre die einzelnen Stimmen kaum").
    // Ein DynamicsCompressorNode mit bewusst LANGSAMEM Attack lässt die
    // ersten ~30ms einer neuen Anregung (den Anschlag) fast unkomprimiert
    // durch, drosselt danach aber den GEHALTENEN Teil stark -- wie eine
    // echte mitschwingende Saite, die vom Anschlag angeregt wird und
    // danach EIGENSTÄNDIG (mit ihrer eigenen Stimmung) ausklingt, statt
    // dauerhaft vom Halteton "nachgefüttert" zu werden. Ein erster Versuch
    // mit eigenem Hüllkurven-Differenz-Schaltkreis (schnelle minus
    // langsame Einpol-Hüllkurve) schlug fehl: minimales Restwelligkeit-
    // "Leck" im Rest-Signal wurde von der Resonanz-Schleife über die Zeit
    // unbegrenzt hochgeschaukelt, statt sauber gegen Null zu klingen --
    // der native Kompressor hat dieses Problem nicht (gemessen: Pegel
    // klingt nach dem Anschlag sauber auf einen stabilen, tiefen Sockel
    // ab, kein Aufschaukeln über mehrere Sekunden). Gemessen über 150-
    // 500ms-Retriggerung (schnelles Drum-Pattern): jeder Anschlag regt die
    // Bänder gleich stark an wie der vorherige, kein Nachlassen durch
    // vorherige Ducker-Aktivität.
    defaults: { pitch: 220, resonance: 0.6, damping: 8000, mix: 0.35, interval: 'harmonic', width: 0.5 },
    build(ctx, p) {
      const input = ctx.createGain();
      const output = ctx.createGain();
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      dry.gain.value = 1 - p.mix;
      wet.gain.value = p.mix;

      const N = 5;
      // Altprojekte kennen nur "interval" (Preset-Name), noch kein "tune"
      // (5er-Halbton-Array, s. RESONATOR_PRESET_SEMITONES oben) -- fehlt es
      // (frisch angelegtes Insert ODER ein vor diesem Update gespeichertes
      // Projekt), einmalig aus dem gespeicherten interval ableiten, statt
      // stumm auf "harmonic" zurückzufallen. Ist p.tune schon vorhanden
      // (Projekt NACH diesem Update gespeichert, ggf. einzeln verstellt),
      // bleibt es unangetastet -- p ist dieselbe Referenz wie insert.params,
      // die Mutation hier landet also direkt im echten, serialisierten
      // Zustand (gleiches Muster wie eq8s p.bands).
      if (!Array.isArray(p.tune) || p.tune.length !== N) {
        p.tune = [...(RESONATOR_PRESET_SEMITONES[p.interval] ?? RESONATOR_PRESET_SEMITONES.harmonic)];
      }
      let pitch = p.pitch;
      let decayTime = resonanceToDecayTime(p.resonance);
      const freqFor = (i) => pitch * Math.pow(2, p.tune[i] / 12) * RESONATOR_DETUNE[i];

      // Geteilte Weichbegrenzer-Kurve für alle 5 Bänder (statische Daten,
      // hängt von keinem Parameter ab -- ein Array reicht, wie beim
      // Filter Delay, das dieselbe Kurve für beide Kanäle wiederverwendet).
      const clipCurve = makeFeedbackClipCurve();

      // Anreger-Ducker (s. Kommentar oben beim DEFS-Eintrag) -- feste,
      // nicht per Regler einstellbare Werte, wie schon der Sicherheits-
      // Limiter weiter unten. Schwelle sehr niedrig (praktisch alles
      // triggert die Kompression), Ratio hart, Attack bewusst langsam
      // (lässt den Anschlag durch, bevor die Reduktion greift), Release
      // moderat (erholt sich zwischen einzelnen Anschlägen eines Patterns).
      const exciter = ctx.createDynamicsCompressor();
      exciter.threshold.value = -50;
      exciter.knee.value = 0;
      exciter.ratio.value = 20;
      exciter.attack.value = 0.03;
      exciter.release.value = 0.2;
      input.connect(exciter);

      const delays = [], damps = [], clips = [], fbGains = [], panners = [];
      const bandDelayTime = new Array(N);
      const sum = ctx.createGain();
      for (let i = 0; i < N; i++) {
        const delayTime = 1 / freqFor(i);
        bandDelayTime[i] = delayTime;
        const delayNode = ctx.createDelay(1);
        delayNode.delayTime.value = delayTime;
        const damp = makeOnePoleLowpass(ctx, p.damping);
        const clip = ctx.createWaveShaper();
        clip.curve = clipCurve;
        clip.oversample = '2x';
        const fb = ctx.createGain();
        fb.gain.value = feedbackGainFor(delayTime, decayTime);
        const panner = ctx.createStereoPanner();
        panner.pan.value = RESONATOR_PAN[i] * p.width;

        exciter.connect(delayNode);
        delayNode.connect(damp.input);
        damp.output.connect(clip);
        clip.connect(fb);
        fb.connect(delayNode); // schliesst die Feedback-Schleife
        delayNode.connect(panner);
        panner.connect(sum);

        delays.push(delayNode); damps.push(damp); clips.push(clip); fbGains.push(fb); panners.push(panner);
      }

      // Pegel-Kompensation: fester Faktor statt eines resonance-abhängigen
      // Ausgleichs wie bei der alten Bandpass-Bank -- gemessen bleibt der
      // Pegel (anders als beim Filter, der bei niedrigem Q/kurzer
      // Klingelzeit nur einen kleinen Ausschnitt der Energie einfängt)
      // über den GESAMTEN Resonance-Bereich praktisch konstant, eine
      // Delayline baut ihre Resonanz aktiv über die Feedback-Schleife auf
      // statt nur passiv durchzulassen. 2.9/N kalibriert auf einen
      // gehaltenen Ton durchs Default-Preset ('harmonic', 5 Bänder auf
      // Grundton + Obertönen 2x-5x verteilt -- nur der Grundton-Band trifft
      // die volle Sägezahn-Energie, die Obertöne entsprechend weniger,
      // s. Testprotokoll) -- damit bleibt der Pegel bei Mix=100% praktisch
      // deckungsgleich mit dem Trockensignal (~-1.3dB gemessen), statt wie
      // vorher spürbar leiser.
      sum.gain.value = 2.9 / N;

      // limiter: eine dicht bespielte/retriggerte Bande (Drum-Pattern,
      // gehaltene Note) kann durch die Feedback-Schleifen über mehrere
      // Sekunden Energie aufbauen, bevor der Damping-Filter sie wieder
      // abbaut (gemessen: bis knapp 6x Vollausschlag im Worst-Case-
      // Stresstest, kombinierte Live-Automation + dichte Retriggerung) --
      // ein schneller Limiter fängt genau DAS ab. Schwelle bewusst auf 0dB
      // (Web-Audio-Maximum), NICHT wie vorher -3dB: ein normaler
      // gehaltener Ton liegt beim neuen Delay-Feedback-Design (anders als
      // die alte Bandpass-Bank) schon nahe am Trockenpegel -- eine
      // niedrigere Schwelle hätte genau DIESEN Alltagsfall dauerhaft
      // klein komprimiert und wieder leiser gemacht, statt nur die
      // seltenen Extremfälle abzufangen (gemessen: bei 0dB bleibt ein
      // gehaltener Ton praktisch unangetastet, ein 6x-Ausreisser wird bei
      // Ratio 20:1 trotzdem zuverlässig auf knapp über 0dB gezähmt).
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = 0;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.15;
      sum.connect(limiter);

      // Kompensiert den Lookahead BEIDER Kompressoren im Wet-Pfad (Anreger-
      // Ducker oben + Sicherheits-Limiter unten, je DYNAMICS_COMPRESSOR_
      // LATENCY_SEC) -- die sitzen NUR im Wet-Pfad, ohne Kompensation käme
      // die trockene Kopie ~12ms VOR der resonierten an, beim Mischen
      // (mix<1) ein hörbares Kammfilter-"Phasing".
      const dryDelay = makeDryCompensationDelay(ctx, DYNAMICS_COMPRESSOR_LATENCY_SEC * 2);
      input.connect(dryDelay).connect(dry).connect(output);
      limiter.connect(wet).connect(output);

      // Band i neu stimmen (Pitch/Interval/Tune geändert): Delay-Zeit UND
      // die davon abhängige Feedback-Stärke (feedbackGainFor braucht die
      // AKTUELLE Delay-Zeit) gemeinsam nachziehen.
      const retuneBand = (i, t, tc) => {
        const delayTime = 1 / freqFor(i);
        bandDelayTime[i] = delayTime;
        delays[i].delayTime.setTargetAtTime(delayTime, t, tc);
        fbGains[i].gain.setTargetAtTime(feedbackGainFor(delayTime, decayTime), t, tc);
      };

      return {
        input, output,
        setParam(key, v) {
          const t = engine.now;
          if (key === 'pitch') {
            pitch = v;
            for (let i = 0; i < N; i++) retuneBand(i, t, 0.02);
          } else if (key === 'resonance') {
            decayTime = resonanceToDecayTime(v);
            for (let i = 0; i < N; i++) fbGains[i].gain.setTargetAtTime(feedbackGainFor(bandDelayTime[i], decayTime), t, 0.02);
          } else if (key === 'damping') {
            for (const damp of damps) damp.setFreq(v, t, 0.02);
          } else if (key === 'interval') {
            // Preset-Knopf: befüllt alle 5 Tune-Werte auf einen Schlag (s.
            // Kommentar bei RESONATOR_PRESET_SEMITONES) -- einzelne Bänder
            // lassen sich danach über setBandTune() wieder frei verstellen.
            p.tune = [...(RESONATOR_PRESET_SEMITONES[v] ?? RESONATOR_PRESET_SEMITONES.harmonic)];
            for (let i = 0; i < N; i++) retuneBand(i, t, 0.03);
          } else if (key === 'width') {
            for (let i = 0; i < N; i++) panners[i].pan.setTargetAtTime(RESONATOR_PAN[i] * v, t, 0.02);
          } else if (key === 'mix') {
            dry.gain.setTargetAtTime(1 - v, t, 0.01);
            wet.gain.setTargetAtTime(v, t, 0.01);
          }
        },
        // Einzelnes Band frei umstimmen (Halbtöne relativ zu pitch) --
        // eigene, zusätzliche Methode wie setBand() beim 8-Band-EQ (s.
        // dortigen Kommentar): der generische setParam(key,value) kennt nur
        // "ein Feld", nicht "ein Feld eines von 5 Bändern".
        setBandTune(i, semitones) {
          p.tune[i] = semitones;
          retuneBand(i, engine.now, 0.02);
        },
        dispose() {
          input.disconnect(); output.disconnect(); dry.disconnect(); wet.disconnect(); sum.disconnect();
          dryDelay.disconnect(); exciter.disconnect(); limiter.disconnect();
          for (const delayNode of delays) delayNode.disconnect();
          for (const damp of damps) damp.dispose();
          for (const clip of clips) clip.disconnect();
          for (const fb of fbGains) fb.disconnect();
          for (const panner of panners) panner.disconnect();
        },
      };
    },
  },
  opto: {
    name: 'Opto Compressor',
    // Feste Zusatzlatenz des DynamicsCompressorNode-Lookaheads -- s.
    // Kommentar bei DEFS.comp.latencySec.
    latencySec: DYNAMICS_COMPRESSOR_LATENCY_SEC,
    // LA-2A-Tribut: EIN Hauptregler ("Peak Reduction", wie am echten Gerät)
    // statt eines Attack/Release/Knee-Vierersatzes -- Attack/Release/Knee
    // stehen FEST auf für optische Kompressoren typische, deutlich trägere/
    // weichere Werte als beim FET-Style-Compressor oben (echte T4-
    // Elektrolumineszenzzelle: ~10ms Attack, mehrstufiger Release mit langem
    // "Sag"-Schwanz -- hier als EIN repräsentativer Kompromisswert, kein
    // bit-genaues Bauteil-Modell, ehrlich als Tribut statt Emulation
    // gedacht). Limit/Compress ist der echte Zweistufen-Schalter des
    // Originals (Ratio ~20:1 vs. ~3:1, s. OPTO_MODES oben).
    defaults: { reduction: 0.4, gain: 0, mode: 'compress', mix: 1 },
    build(ctx, p) {
      const input = ctx.createGain();
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      dry.gain.value = 1 - p.mix;
      wet.gain.value = p.mix;

      const ATTACK = 0.01;
      const RELEASE = 0.5;
      const KNEE = 18;
      const node = ctx.createDynamicsCompressor();
      node.attack.value = ATTACK;
      node.release.value = RELEASE;
      node.knee.value = KNEE;
      node.ratio.value = (OPTO_MODES[p.mode] ?? OPTO_MODES.compress).ratio;
      // reduction (0..1) -> Threshold: verschiebt die Ansprechschwelle nach
      // unten, wie das Peak-Reduction-Poti am Original -- 0 = kaum Wirkung
      // (-4dB), 1 = tief in die Zelle getrieben (-40dB).
      node.threshold.value = -4 - p.reduction * 36;

      const makeup = ctx.createGain();
      makeup.gain.value = dbToLin(p.gain);

      // Kompensiert den Lookahead von node oben (s.
      // DYNAMICS_COMPRESSOR_LATENCY_SEC) -- sonst käme die trockene Kopie
      // ~6ms VOR der komprimierten an, beim Mischen (mix<1) ein hörbares
      // Kammfilter-"Phasing", am stärksten um mix=0.5.
      const dryDelay = makeDryCompensationDelay(ctx, DYNAMICS_COMPRESSOR_LATENCY_SEC);
      input.connect(dryDelay).connect(dry);
      input.connect(node);
      node.connect(makeup);
      makeup.connect(wet);
      const outSum = ctx.createGain();
      dry.connect(outSum);
      wet.connect(outSum);

      return {
        input, output: outSum,
        setParam(key, v) {
          const t = engine.now;
          if (key === 'reduction') node.threshold.setTargetAtTime(-4 - v * 36, t, 0.01);
          else if (key === 'gain') makeup.gain.setTargetAtTime(dbToLin(v), t, 0.01);
          else if (key === 'mode') node.ratio.setTargetAtTime((OPTO_MODES[v] ?? OPTO_MODES.compress).ratio, t, 0.01);
          else if (key === 'mix') {
            dry.gain.setTargetAtTime(1 - v, t, 0.01);
            wet.gain.setTargetAtTime(v, t, 0.01);
          }
        },
        // Gleiches GR-Meter wie beim FET-Compressor -- derselbe generische
        // Abgriff des nativen reduction-Werts, UI erkennt die Methode statt
        // des Typs (s. machine.js/insert-chain.js#startCompMeter).
        getReductionDb() { return node.reduction ?? 0; },
        dispose() {
          input.disconnect(); dry.disconnect(); wet.disconnect(); outSum.disconnect();
          dryDelay.disconnect(); node.disconnect(); makeup.disconnect();
        },
      };
    },
  },
  tape: {
    name: 'Tape Machine',
    // Feste Zusatzlatenz aus Sättigungs-Oversampling PLUS Wow/Flutter-
    // Grunddelay (s. WAVESHAPER_4X_LATENCY_SEC/TAPE_WOWFLUTTER_BASE_DELAY_SEC
    // oben) -- s. Kommentar bei DEFS.comp.latencySec.
    latencySec: WAVESHAPER_4X_LATENCY_SEC + TAPE_WOWFLUTTER_BASE_DELAY_SEC,
    // Vierteilige Kette wie ein echtes Bandgerät: Sättigung (Kopf-
    // Übersteuerung, s. makeTapeCurve oben) -> DC-Sperrfilter (die bewusst
    // asymmetrische Sättigungskurve könnte sonst einen Gleichspannungsanteil
    // einschleusen) -> Höhen-Rolloff (die Bandbreite eines Tonkopfs ist
    // physikalisch begrenzt, anders als ein digitaler Signalweg) -> Wow/
    // Flutter (Gleichlaufschwankung der Bandmaschine, über ein NICHT-
    // rekursives, moduliertes Delay -- der bewährt sichere Modulationsfall,
    // s. FM-Synth-Stresstest/Reverb-Kommentare, KEIN Feedback-Loop wie beim
    // Filter-Delay/Reverb, deshalb ohne deren Stabilitätsrisiko) -> Rauschen
    // (Band-Grundrauschen, konstant anliegend wie am echten Gerät, nicht
    // vom Eingang getriggert).
    defaults: { drive: 0.3, tone: 8000, wowFlutter: 0.3, hiss: 0.15, mix: 1 },
    build(ctx, p) {
      const input = ctx.createGain();
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      dry.gain.value = 1 - p.mix;
      wet.gain.value = p.mix;

      const shaper = ctx.createWaveShaper();
      shaper.oversample = '4x';
      shaper.curve = makeTapeCurve(p.drive);

      const dcBlock = ctx.createBiquadFilter();
      dcBlock.type = 'highpass';
      dcBlock.frequency.value = 20;
      dcBlock.Q.value = 0.7;

      const tone = ctx.createBiquadFilter();
      tone.type = 'lowpass';
      tone.Q.value = 0.7;
      tone.frequency.value = p.tone;

      // Wow (langsam, ~0.6Hz) + Flutter (schneller, ~7Hz) moduliertes Delay --
      // NICHT rekursiv, speist nur vorwärts in den Signalweg, keine
      // Rückkopplungsschleife. Basiswert s. TAPE_WOWFLUTTER_BASE_DELAY_SEC
      // oben -- knapp über dem grössten negativen Modulationshub
      // (wowFlutter=1: -0.7ms-0.25ms), damit die effektive Zusatzlatenz des
      // Effekts (der bei mix=1 direkt hörbar ist, s. Kompensations-
      // Kommentar unten) so klein wie ohne Clipping-Risiko möglich bleibt.
      const wfDelay = ctx.createDelay(0.05);
      wfDelay.delayTime.value = TAPE_WOWFLUTTER_BASE_DELAY_SEC;
      const wowLfo = ctx.createOscillator();
      wowLfo.type = 'sine';
      wowLfo.frequency.value = 0.6;
      const flutterLfo = ctx.createOscillator();
      flutterLfo.type = 'sine';
      flutterLfo.frequency.value = 7;
      const wowGain = ctx.createGain();
      const flutterGain = ctx.createGain();
      wowGain.gain.value = p.wowFlutter * 0.0007;
      flutterGain.gain.value = p.wowFlutter * 0.00025;
      wowLfo.connect(wowGain).connect(wfDelay.delayTime);
      flutterLfo.connect(flutterGain).connect(wfDelay.delayTime);
      wowLfo.start();
      flutterLfo.start();

      // Bandrauschen: konstant anliegend (wie am echten Gerät), nicht vom
      // Eingangssignal getriggert -- derselbe gecachte Rauschbuffer wie bei
      // den Drum-Synthesen (dsp.js#noise), hier in Dauerschleife.
      const hissSrc = ctx.createBufferSource();
      hissSrc.buffer = noise(ctx);
      hissSrc.loop = true;
      const hissGain = ctx.createGain();
      hissGain.gain.value = p.hiss * HISS_MAX_GAIN;
      hissSrc.connect(hissGain);
      hissSrc.start();

      // Kompensiert die STATISCHEN Zusatzlatenzen im Wet-Pfad: das 4x-
      // Oversampling des Shapers (WAVESHAPER_4X_LATENCY_SEC) PLUS die
      // Grundverzögerung des Wow/Flutter-Delays oben (TAPE_WOWFLUTTER_
      // BASE_DELAY_SEC; dessen eigene Modulation kommt on top --
      // absichtlich NICHT mitkompensiert: das leichte Schweben zwischen
      // Dry und Wet bei aufgedrehtem Wow/Flutter ist der beabsichtigte
      // Chorus-artige Bandmaschinen-Charakter, kein Fehler). Ohne diese
      // Basis-Kompensation wäre die trockene Kopie deutlich vor der
      // bearbeiteten, beim Mischen (mix<1) hörbares Kammfilter-"Phasing"
      // selbst bei wowFlutter=0 -- UND (unabhängig vom Mix-Regler) trägt
      // diese Summe bei mix=1 die volle Zusatzlatenz des Effekts gegenüber
      // dem Rest des Mixes, weshalb sie so klein wie möglich gehalten wird.
      const dryDelay = makeDryCompensationDelay(ctx, WAVESHAPER_4X_LATENCY_SEC + TAPE_WOWFLUTTER_BASE_DELAY_SEC);
      input.connect(dryDelay).connect(dry);
      input.connect(shaper);
      shaper.connect(dcBlock);
      dcBlock.connect(tone);
      tone.connect(wfDelay);
      wfDelay.connect(wet);
      hissGain.connect(wet);
      const outSum = ctx.createGain();
      dry.connect(outSum);
      wet.connect(outSum);

      // Kurve neu bauen ist teuer -- gleiches Entprellen wie DEFS.drive oben.
      let driveTimer = null;
      return {
        input, output: outSum,
        setParam(key, v) {
          const t = engine.now;
          if (key === 'drive') {
            clearTimeout(driveTimer);
            driveTimer = setTimeout(() => { shaper.curve = makeTapeCurve(v); }, 60);
          } else if (key === 'tone') tone.frequency.setTargetAtTime(v, t, 0.02);
          else if (key === 'wowFlutter') {
            wowGain.gain.setTargetAtTime(v * 0.0007, t, 0.05);
            flutterGain.gain.setTargetAtTime(v * 0.00025, t, 0.05);
          } else if (key === 'hiss') hissGain.gain.setTargetAtTime(v * HISS_MAX_GAIN, t, 0.05);
          else if (key === 'mix') {
            dry.gain.setTargetAtTime(1 - v, t, 0.01);
            wet.gain.setTargetAtTime(v, t, 0.01);
          }
        },
        dispose() {
          clearTimeout(driveTimer);
          input.disconnect(); dry.disconnect(); wet.disconnect(); outSum.disconnect();
          dryDelay.disconnect(); shaper.disconnect(); dcBlock.disconnect(); tone.disconnect(); wfDelay.disconnect();
          wowLfo.stop(); wowLfo.disconnect(); flutterLfo.stop(); flutterLfo.disconnect();
          wowGain.disconnect(); flutterGain.disconnect();
          hissSrc.stop(); hissSrc.disconnect(); hissGain.disconnect();
        },
      };
    },
  },
  geq: {
    name: 'Graphic EQ',
    // 10 feste Bänder (Oktavabstand, s. GEQ_FREQS oben) -- anders als das
    // parametrische 'eq' (frei positionierbar) oder 'eq8' (8 frei
    // positionierbare Bänder mit Touch-Graph) hier eine reine Balkenreihe
    // wie am Hardware-Vorbild: pro Band nur ein Gain-Regler, Frequenz/Q
    // liegen fest.
    defaults: { bands: GEQ_FREQS.map(() => 0) },
    build(ctx, p) {
      const nodes = GEQ_FREQS.map((freq, i) => {
        const node = ctx.createBiquadFilter();
        node.type = 'peaking';
        node.frequency.value = freq;
        node.Q.value = GEQ_Q;
        node.gain.value = p.bands[i] ?? 0;
        return node;
      });
      for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);

      return {
        input: nodes[0],
        output: nodes[nodes.length - 1],
        // Läuft komplett über setBandGain -- gleiches Muster wie setBand
        // beim 8-Band-EQ (der generische setParam(key,value) kennt nur "ein
        // Feld", nicht "ein Feld eines von 10 Bändern").
        setParam() {},
        setBandGain(i, v) {
          p.bands[i] = v;
          nodes[i]?.gain.setTargetAtTime(v, engine.now, 0.01);
        },
        dispose() { nodes.forEach((n) => n.disconnect()); },
      };
    },
  },
  limiter: {
    name: 'Limiter',
    // Feste Zusatzlatenz des DynamicsCompressorNode-Lookaheads -- s.
    // Kommentar bei DEFS.comp.latencySec.
    latencySec: DYNAMICS_COMPRESSOR_LATENCY_SEC,
    // Bewusst NICHT dieselbe Rolle wie engine.limiter (audio-engine.js) --
    // jener ist ein unsichtbares App-weites Sicherheitsnetz direkt vor
    // ctx.destination, nie eingestellt/gesehen. Dieser Insert ist ein
    // bewusst eingesetztes, sichtbares Mastering-Werkzeug (klassischer
    // "Brickwall"-Loudness-Limiter): schnellerer, fester Attack und härterer,
    // fester Knee als der 1176-Style-Compressor oben (der stattdessen
    // Ratio-MODI statt eines Ceilings anbietet).
    defaults: { inputGain: 0, ceiling: -0.5, release: 0.05, mix: 1 },
    build(ctx, p) {
      const input = ctx.createGain();
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      dry.gain.value = 1 - p.mix;
      wet.gain.value = p.mix;

      const inputGain = ctx.createGain();
      inputGain.gain.value = dbToLin(p.inputGain);
      const ATTACK = 0.001;
      const RATIO = 20;
      const KNEE = 0;
      const node = ctx.createDynamicsCompressor();
      node.attack.value = ATTACK;
      node.ratio.value = RATIO;
      node.knee.value = KNEE;
      node.release.value = p.release;
      node.threshold.value = p.ceiling;

      // Kompensiert den Lookahead von node oben (s.
      // DYNAMICS_COMPRESSOR_LATENCY_SEC) -- sonst käme die trockene Kopie
      // ~6ms VOR der limitierten an, beim Mischen (mix<1) ein hörbares
      // Kammfilter-"Phasing", am stärksten um mix=0.5.
      const dryDelay = makeDryCompensationDelay(ctx, DYNAMICS_COMPRESSOR_LATENCY_SEC);
      input.connect(dryDelay).connect(dry);
      input.connect(inputGain);
      inputGain.connect(node);
      node.connect(wet);
      const outSum = ctx.createGain();
      dry.connect(outSum);
      wet.connect(outSum);

      return {
        input, output: outSum,
        setParam(key, v) {
          const t = engine.now;
          if (key === 'inputGain') inputGain.gain.setTargetAtTime(dbToLin(v), t, 0.01);
          else if (key === 'ceiling') node.threshold.setTargetAtTime(v, t, 0.01);
          else if (key === 'release') node.release.setTargetAtTime(v, t, 0.01);
          else if (key === 'mix') {
            dry.gain.setTargetAtTime(1 - v, t, 0.01);
            wet.gain.setTargetAtTime(v, t, 0.01);
          }
        },
        getReductionDb() { return node.reduction ?? 0; },
        dispose() {
          input.disconnect(); dry.disconnect(); wet.disconnect(); outSum.disconnect();
          dryDelay.disconnect(); inputGain.disconnect(); node.disconnect();
        },
      };
    },
  },
};

export const INSERT_TYPES = Object.keys(DEFS);
export function insertMeta(type) {
  return { name: DEFS[type].name, defaults: { ...DEFS[type].defaults } };
}

/** Frontplatten-Farbe je Insert-Typ — dieselbe --m-color-Mechanik wie bei
 *  den Maschinen, macht jedes Modul auf einen Blick unterscheidbar. */
export const INSERT_COLORS = {
  comp: '#e8b84b',   // FET-Kompressor: Messing/Gold, wie ein 1176
  eq: '#4fd1a5',     // Rack-EQ: kühles Teal
  eq8: '#5ec8e0',    // 8-Band-EQ: helles Cyan, deutlich von der Teal-Farbe des Einzelband-EQ abgesetzt
  drive: '#e8643f',  // Sättigung: warmes Glühen
  filterDelay: '#6f9ceb', // Delay: kühles Blau, wie ein Tape-/Digital-Delay-Rack
  reverb: '#a888e0', // Reverb: Violett, wie ein Hall-/Space-Rack
  resonator: '#e0c840', // Resonator: Messing/Glockenspiel-Gelb, wie angeschlagenes Metall
  opto: '#c9a0e0',   // Opto-Kompressor: sanftes Lavendel, deutlich vom Messing/Gold des FET-Comp abgesetzt
  tape: '#d99a5b',   // Tape Machine: warmes Sepia/Rostbraun, wie altes Bandmaterial
  geq: '#7fd9c4',    // Graphic EQ: helles Türkis, von eq/eq8's Teal/Cyan abgesetzt
  limiter: '#e0555f', // Limiter: warnendes Rot -- hartes Ceiling-Werkzeug
};

/** UI-Metadaten je Parameter (Label/Bereich/Kurve/Einheit) — getrennt von
 *  den DSP-Defaults, weil die UI mehr wissen muss als der Audiograph. */
export const UI_PARAMS = {
  comp: [
    { key: 'input', label: 'Input', min: -20, max: 20, unit: 'dB' },
    { key: 'attack', label: 'Attack', min: 0.0002, max: 0.5, curve: 'log', unit: 's' },
    { key: 'release', label: 'Release', min: 0.02, max: 1, curve: 'log', unit: 's' },
    { key: 'output', label: 'Output', min: -20, max: 20, unit: 'dB' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, unit: '' },
  ],
  eq: [
    { key: 'freq', label: 'Freq', min: 20, max: 20000, curve: 'log', unit: 'Hz' },
    { key: 'gain', label: 'Gain', min: -24, max: 24, unit: 'dB' },
    { key: 'q', label: 'Q', min: 0.1, max: 10, curve: 'log', unit: '' },
  ],
  drive: [
    { key: 'drive', label: 'Drive', min: 0, max: 1, unit: '' },
    { key: 'base', label: 'Base', min: -1, max: 1, unit: '' },
    { key: 'tone', label: 'Tone', min: 0, max: 1, unit: '' },
    { key: 'level', label: 'Level', min: 0, max: 2, unit: '' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, unit: '' },
  ],
  filterDelay: [
    { key: 'time', label: 'Time', min: 0.01, max: 1.5, curve: 'log', unit: 's' },
    // War früher auf 0.8 gedeckelt (Filter-Überhöhung bei lowpass/highpass
    // nahe der Cutoff-Frequenz, ~1.15-1.22x, liess die Schleife sonst
    // unbegrenzt aufschaukeln, s. alte Fassung dieses Kommentars in der
    // Git-History). Jetzt durch einen tanh-Weichbegrenzer IN der Feedback-
    // Schleife (s. makeFeedbackClipCurve()/DEFS.filterDelay) sicher bis 0.9
    // anhebbar -- per Stresstest verifiziert (dichte Retriggerung über
    // Feedback x Filtertyp x Filterfrequenz x Zeit x PingPong, 72 Kombina-
    // tionen). WICHTIG: "sicher" heisst hier "schaukelt nicht mehr
    // unbegrenzt auf" (bounded), NICHT "Spitzenpegel bleibt immer <= 1.0" --
    // am ungünstigsten Punkt (sehr kurze Zeit nahe dem Minimum + lowpass/
    // highpass nahe einer Resonanzspitze) wurden Spitzenpegel bis ~1.75
    // gemessen, klar über 1.0, aber STABIL (10s-Dauertest praktisch gleicher
    // Wert wie 4s, kein weiteres Wachstum) -- der App-weite Master-Limiter
    // fängt das am Ende der Kette ab. bandpass war in JEDER getesteten
    // Kombination unauffällig (< 0.6 Spitzenpegel), da bandpass laut
    // Web-Audio-Spezifikation keine Überhöhung kennt (s. Kommentar bei
    // DEFS.resonator). Ein Versuch, den Weichbegrenzer selbst schärfer zu
    // stimmen (tanh(1.6x) statt tanh(x)), verschlimmerte die Extremfälle
    // deutlich (Spitzen bis 2.8) statt sie zu verbessern -- die zusätzlichen
    // Oberwellen der schärferen Kurve regen die Filterresonanz offenbar
    // zusätzlich an. tanh(x) unnormalisiert war die bessere Wahl.
    { key: 'feedback', label: 'Feedback', min: 0, max: 0.9, unit: '' },
    { key: 'filterFreq', label: 'Filter', min: 200, max: 8000, curve: 'log', unit: 'Hz' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, unit: '' },
    // Nur bei Tempo-Sync sinnvoll (s. DEFS.filterDelay#computeSwingShift) --
    // wie 'time' oben wird sie in insert-chain.js abhängig von `division`
    // ein-/ausgeblendet, nur mit umgekehrter Bedingung.
    { key: 'swing', label: 'Swing', min: 50, max: 75, unit: '%' },
  ],
  reverb: [
    { key: 'size', label: 'Size', min: 0.3, max: 3, curve: 'log', unit: '' },
    // Deutlich enger gedeckelt als beim alten Hadamard-FDN (dort bis 0.9
    // sauber, s. git-history) -- die Dattorro-"Figure-8"-Tank-Topologie hat
    // KEINE orthogonale Mischmatrix, die dem Netzwerk beweisbar für JEDE
    // Parameter-Kombination Energieerhaltung garantiert; stattdessen sitzen
    // hier zwei sich gegenseitig speisende Allpässe (modAp/ap5), die JEDER
    // FÜR SICH zwar stabil sind, deren KOMBINIERTE Phasenantwort aber bei
    // bestimmten (unregelmässig verteilten, nicht einfach vorhersagbaren)
    // Decay/Damping/Size-Kombinationen resonant aufschaukeln kann -- per
    // Sweep gemessen: schon ab decay=0.5 traten bei manchen Damping-Werten
    // Aufschaukel-Effekte auf (kein sauberes Abklingen mehr, teils bis zum
    // Clip-Limiter). Ein WaveShaper-Begrenzer an der Kreuzkopplung (s.
    // feedbackClipCurve in DEFS.reverb.build()) fängt das zwar SICHER ab
    // (kein Absturz/Infinity/NaN mehr möglich), verhindert aber nicht ein
    // hörbares, lautes "Hängenbleiben" bei zu hohem Decay -- 0.4 ist per
    // Sweep über den GESAMTEN Damping-Bereich (500-15000Hz) UND Size-Bereich
    // (0.3-3) sowie zusätzlich per dichter Retrigger-Stresstest an den
    // Extrem-Ecken (kürzeste/längste Size x wenigste/meiste Dämpfung)
    // durchgehend sauber bestätigt -- mit spürbarem Abstand zum ersten
    // beobachteten Aufschaukeln bei 0.5.
    { key: 'decay', label: 'Decay', min: 0, max: 0.4, unit: '' },
    { key: 'damping', label: 'Damping', min: 500, max: 15000, curve: 'log', unit: 'Hz' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, unit: '' },
  ],
  resonator: [
    { key: 'pitch', label: 'Pitch', min: 55, max: 880, curve: 'log', unit: 'Hz' },
    { key: 'resonance', label: 'Resonance', min: 0, max: 1, unit: '' },
    { key: 'damping', label: 'Damping', min: 500, max: 15000, curve: 'log', unit: 'Hz' },
    { key: 'width', label: 'Width', min: 0, max: 1, unit: '' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, unit: '' },
  ],
  opto: [
    { key: 'reduction', label: 'Peak Reduct.', min: 0, max: 1, unit: '' },
    { key: 'gain', label: 'Gain', min: -20, max: 20, unit: 'dB' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, unit: '' },
  ],
  tape: [
    { key: 'drive', label: 'Drive', min: 0, max: 1, unit: '' },
    { key: 'tone', label: 'Tone', min: 2000, max: 16000, curve: 'log', unit: 'Hz' },
    { key: 'wowFlutter', label: 'Wow/Flut.', min: 0, max: 1, unit: '' },
    { key: 'hiss', label: 'Hiss', min: 0, max: 1, unit: '' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, unit: '' },
  ],
  limiter: [
    { key: 'inputGain', label: 'Input', min: 0, max: 24, unit: 'dB' },
    { key: 'ceiling', label: 'Ceiling', min: -20, max: 0, unit: 'dB' },
    { key: 'release', label: 'Release', min: 0.01, max: 0.5, curve: 'log', unit: 's' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, unit: '' },
  ],
};

/** EQ-Filtertyp ist ein Enum, kein Knob — eigene, kleine Liste fürs UI. */
export const EQ_TYPES = [
  { value: 'lowshelf', label: 'Low Shelf' },
  { value: 'peaking', label: 'Peak' },
  { value: 'highshelf', label: 'High Shelf' },
];

/** Filter-Delay-Filtertyp ist ebenfalls ein Enum, kein Knob. */
export const FILTER_DELAY_TYPES = [
  { value: 'lowpass', label: 'Low Pass' },
  { value: 'highpass', label: 'High Pass' },
  { value: 'bandpass', label: 'Band Pass' },
];

/** Tempo-Sync-Notenwerte für den Filter Delay (wie Abletons Delay) -- als
 *  Faktor relativ zu EINER Viertelnote (= 1 Beat). 'free' (nicht hier, s.
 *  DEFS.filterDelay) lässt die Zeit weiterhin frei in Sekunden (Time-Regler)
 *  -- diese Werte überschreiben sie stattdessen relativ zum Song-Tempo,
 *  bei jeder BPM-Änderung live nachgeführt (transport.addListener). */
export const DELAY_SYNC_DIVISIONS = {
  '1/16': 0.25,
  '1/8t': 1 / 3,
  '1/8': 0.5,
  '1/8d': 0.75,
  '1/4t': 2 / 3,
  '1/4': 1,
  '1/4d': 1.5,
  '1/2': 2,
};
export const DELAY_SYNC_BUTTONS = [
  { value: 'free', label: 'Free' },
  { value: '1/16', label: '1/16' },
  { value: '1/8t', label: '1/8t' },
  { value: '1/8', label: '1/8' },
  { value: '1/8d', label: '1/8.' },
  { value: '1/4t', label: '1/4t' },
  { value: '1/4', label: '1/4' },
  { value: '1/4d', label: '1/4.' },
  { value: '1/2', label: '1/2' },
];

/** Resonator-Intervall-Set (welche Töne relativ zur Grundtonhöhe
 *  mitklingen) ist ebenfalls ein Enum, kein Knob. */
export const RESONATOR_INTERVALS = [
  { value: 'harmonic', label: 'Harmonic' },
  { value: 'octaves', label: 'Octaves' },
  { value: 'fifths', label: 'Fifths' },
  { value: 'minor', label: 'Minor' },
  { value: 'major', label: 'Major' },
];

let nextInsertId = 1;

/**
 * Summierte feste Zusatzlatenz einer Insert-Kette (nur die tatsächlich
 * aktiven, nicht bypassten Inserts zählen -- ein bypasster Insert läuft
 * beim Ausgang komplett am Effekt vorbei, s. createInsert()#dryGain/wetGain
 * oben, hat also keine hörbare Zusatzlatenz). Für machine.js#refreshLatency-
 * Compensation: jede Maschine gleicht ihre eigene Summe gegen das
 * Rack-Maximum aus, damit z. B. eine Tape Machine (~5.5ms) ihre Maschine
 * nicht hörbar aus dem Groove der anderen schiebt.
 */
export function insertChainLatencySec(inserts) {
  return inserts.reduce((sum, insert) => (
    insert.bypassed ? sum : sum + (DEFS[insert.type]?.latencySec ?? 0)
  ), 0);
}

/**
 * Baut einen Insert. `saved` (optional) = { id, params, bypassed } aus
 * einem vorher gespeicherten Projekt — fehlende Parameter fallen auf die
 * Effekt-Defaults zurück (z. B. wenn ein neuer Parameter dazukommt).
 *
 * `saved.id` wird, falls vorhanden, ÜBERNOMMEN statt eine neue ID zu
 * vergeben -- Automation-Lanes für Insert-Parameter sind über
 * `${machineId}:insert:${insertId}:${param}` verdrahtet (s. machine.js);
 * ohne stabile IDs würde jedes Neuladen eines Projekts allen Inserts
 * FRISCHE IDs zuteilen und aufgenommene Fahrten dadurch unsichtbar
 * verwaisen lassen (Lane bleibt gespeichert, aber nie wieder erreichbar).
 */
export function createInsert(type, saved = null) {
  const def = DEFS[type];
  if (!def) throw new Error(`Unbekannter Insert-Typ: ${type}`);
  const ctx = engine.ctx;
  // structuredClone statt einfachem Spread: def.defaults ist modulweit EIN
  // Objekt -- bei verschachtelten Werten (eq8s bands-Array) würde ein
  // flacher Spread nur die Referenz kopieren, alle Instanzen desselben
  // Insert-Typs teilten sich dann dieselben Bänder (jede Änderung an EINEM
  // Insert würde alle anderen mitverändern). Für die bisherigen, rein
  // flachen defaults (Zahlen/Strings) ändert der Clone nichts.
  const params = structuredClone({ ...def.defaults, ...saved?.params });
  const bypassed = saved?.bypassed ?? false;
  const id = saved?.id ?? nextInsertId++;
  if (saved?.id != null) nextInsertId = Math.max(nextInsertId, saved.id + 1);

  const input = ctx.createGain();
  const output = ctx.createGain();
  const dryGain = ctx.createGain();
  const wetGain = ctx.createGain();
  // Direkt setzen (nicht rampen) — beim Bau steht noch nichts an, ein
  // Ramp würde nur unnötig verzögern, wann der Insert "fertig" ist.
  dryGain.gain.value = bypassed ? 1 : 0;
  wetGain.gain.value = bypassed ? 0 : 1;
  const effect = def.build(ctx, params);

  input.connect(dryGain);
  dryGain.connect(output);
  input.connect(effect.input);
  effect.output.connect(wetGain);
  wetGain.connect(output);

  const insert = {
    id,
    type,
    name: def.name,
    params,
    bypassed,
    input,
    output,
    setParam(key, value) {
      params[key] = value;
      effect.setParam(key, value);
    },
    // Nur beim Compressor vorhanden — UI prüft auf Existenz statt Typ.
    getReductionDb: effect.getReductionDb ? () => effect.getReductionDb() : undefined,
    // Nur beim 8-Band-EQ vorhanden (s. dortigen Kommentar in DEFS.eq8).
    setBand: effect.setBand ? (i, field) => effect.setBand(i, field) : undefined,
    getEq8Response: effect.getEq8Response ? (freqArray) => effect.getEq8Response(freqArray) : undefined,
    // Nur beim Resonator vorhanden (s. dortigen Kommentar in DEFS.resonator).
    setBandTune: effect.setBandTune ? (i, semitones) => effect.setBandTune(i, semitones) : undefined,
    // Nur beim Graphic EQ vorhanden (s. dortigen Kommentar in DEFS.geq).
    setBandGain: effect.setBandGain ? (i, v) => effect.setBandGain(i, v) : undefined,
    setBypass(b) {
      insert.bypassed = b;
      const t = engine.now;
      dryGain.gain.setTargetAtTime(b ? 1 : 0, t, 0.01);
      wetGain.gain.setTargetAtTime(b ? 0 : 1, t, 0.01);
    },
    serialize() {
      return { id, type, params: { ...params }, bypassed: insert.bypassed };
    },
    dispose() {
      input.disconnect();
      output.disconnect();
      dryGain.disconnect();
      wetGain.disconnect();
      effect.dispose();
    },
  };

  return insert;
}
