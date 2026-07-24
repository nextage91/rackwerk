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

const dbToLin = (db) => Math.pow(10, db / 20);

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
    dispose() { input.disconnect(); output.disconnect(); delay.disconnect(); fbGain.disconnect(); ffGain.disconnect(); },
  };
}

/** 4x4-Hadamard-Matrix, mit 1/2 normalisiert (orthogonal/energieerhaltend --
 *  wichtig für Stabilität: die Matrix selbst darf dem Feedback-Delay-Netzwerk
 *  KEINE Energie hinzufügen, nur zwischen den vier Leitungen umverteilen.
 *  Die eigentliche Abkling-Kontrolle sitzt separat in decayGain je Leitung). */
const HADAMARD_4 = [
  [0.5, 0.5, 0.5, 0.5],
  [0.5, -0.5, 0.5, -0.5],
  [0.5, 0.5, -0.5, -0.5],
  [0.5, -0.5, -0.5, 0.5],
];

/** 8x8-Hadamard-Matrix für den Reverb (s. DEFS.reverb) -- per Sylvester-
 *  Konstruktion aus HADAMARD_4 verdoppelt (H8 = [[H4,H4],[H4,-H4]]), bleibt
 *  dadurch garantiert orthogonal/energieerhaltend wie das 4x4-Original.
 *  HADAMARD_4s Einträge sind bereits mit 1/sqrt(4) normiert -- die simple
 *  Verdopplung ([row,row]/[row,-row]) ergibt Zeilen der Länge 8 mit doppelt
 *  so vielen, aber gleich grossen Einträgen (Zeilennorm² = 8*0.25 = 2 statt
 *  1) -- die zusätzliche Division durch sqrt(2) bringt sie zurück auf
 *  Zeilennorm 1 (= korrekt für 1/sqrt(8)-Normierung bei 8 Leitungen).
 *  Mehr Leitungen als beim ursprünglichen 4er-Netzwerk -- glattere, dichtere
 *  Diffusion (weniger hörbares periodisches "Flattern", s. Kommentar bei
 *  BASE_MS in DEFS.reverb). */
const HADAMARD_8 = [
  ...HADAMARD_4.map((row) => [...row, ...row].map((v) => v / Math.SQRT2)),
  ...HADAMARD_4.map((row) => [...row, ...row.map((v) => -v)].map((v) => v / Math.SQRT2)),
];

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

/** Resonance-Regler (0..1) auf eine Bandpass-Güte (Q) abbilden. Anders als
 *  bei Lowpass/Highpass ist ein hoher Q hier UNBEDENKLICH -- Web Audios
 *  Bandpass hat laut Spezifikation IMMER exakt 1.0 (0dB) Spitzenpegel GENAU
 *  auf der Mittenfrequenz, für JEDEN Q-Wert (gemessen bis Q=1000, kein
 *  Überschwingen möglich, s. DEFS.resonator). Hoher Q bedeutet hier nur
 *  schmalere Bandbreite = längeres Nachklingen (gemessen: Q=1 klingt ~5ms
 *  nach, Q=400 ~500ms -- exponentiell steigender Zusammenhang, daher log-
 *  artige statt lineare Kurve, damit der Regler über den ganzen Bereich
 *  gleichmässig "greift"). */
function resonanceToQ(resonance) {
  return 1 * Math.pow(400, resonance); // 1 (kurzes "Blup") .. 400 (langes Klingeln/Sustain)
}

/** Pegelausgleich für den Resonator: ein schmalbandigerer (höher-Q)
 *  Bandpass fängt bei einer kurzen/breitbandigen Anregung nur einen
 *  entsprechend kleineren Ausschnitt der Energie ein (gemessen: Spitzenpegel
 *  fällt ~1/Q). sqrt(Q) gleicht das nur teilweise aus -- bewusst nicht
 *  voll (1/Q komplett kompensieren würde niedrige Resonance-Werte unnötig
 *  laut machen), nur genug, damit "mehr Resonance" sich nach länger/
 *  dramatischer nachklingend anfühlt statt nach leiser. Auf Q=1 (kürzeste
 *  Klingelzeit) normiert, damit der Referenzpegel bei Resonance=0 unverändert
 *  bleibt. */
function makeupFor(q) {
  return Math.sqrt(q);
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

const DEFS = {
  comp: {
    name: 'Compressor',
    // 1176-Style: Input (treibt in die feste Schwelle), Attack, Release,
    // Ratio-Modus (Taster statt Regler), Output (Makeup) — kein Threshold.
    defaults: { input: 0, output: 0, attack: 0.003, release: 0.25, ratioMode: '4' },
    build(ctx, p) {
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
      inputGain.connect(node);
      node.connect(outputGain);
      return {
        input: inputGain,
        output: outputGain,
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
          }
        },
        // Live-Gain-Reduction fürs GR-Meter — Web Audio liefert den Wert
        // direkt vom nativen Compressor, kein separates Analyse-Tapping
        // nötig (negative dB, 0 = keine Reduktion).
        getReductionDb() { return node.reduction ?? 0; },
        dispose() { inputGain.disconnect(); node.disconnect(); outputGain.disconnect(); },
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
    defaults: { drive: 0.4, tone: 0.6, level: 0.8 },
    build(ctx, p) {
      const shaper = ctx.createWaveShaper();
      shaper.oversample = '4x';
      shaper.curve = makeDriveCurve(p.drive);
      const tone = ctx.createBiquadFilter();
      tone.type = 'lowpass';
      tone.Q.value = 0.7;
      tone.frequency.value = 400 * Math.pow(12000 / 400, p.tone);
      const level = ctx.createGain();
      level.gain.value = p.level;
      shaper.connect(tone);
      tone.connect(level);
      // Kurve neu bauen ist teuer (1024 Sample-tanh() + Reassignment an den
      // Audio-Thread, das zudem bei aktivem Signal hörbar knackst, weil
      // WaveShaper-Kurven beim Wechsel nicht überblendet werden) -- der Knob
      // feuert aber auf JEDEN pointermove, beim Ziehen also bis zu 60x/s.
      // Gleiches Entprellen wie fx.js' #buildIR() für den Reverb-Impuls.
      let driveTimer = null;
      return {
        input: shaper,
        output: level,
        setParam(key, v) {
          if (key === 'drive') {
            clearTimeout(driveTimer);
            driveTimer = setTimeout(() => { shaper.curve = makeDriveCurve(v); }, 60);
          }
          else if (key === 'tone') tone.frequency.setTargetAtTime(400 * Math.pow(12000 / 400, v), engine.now, 0.01);
          else if (key === 'level') level.gain.setTargetAtTime(v, engine.now, 0.01);
        },
        dispose() { clearTimeout(driveTimer); shaper.disconnect(); tone.disconnect(); level.disconnect(); },
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
    defaults: {
      time: 0.35, feedback: 0.4, filterFreq: 2000, filterType: 'lowpass', mix: 0.35,
    },
    build(ctx, p) {
      const input = ctx.createGain();
      const output = ctx.createGain();
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      dry.gain.value = 1 - p.mix;
      wet.gain.value = p.mix;

      // Feedback-Schleife: delay -> filter -> feedback -> zurück in delay.
      // Der WET-Abgriff sitzt NACH dem Filter, nicht am rohen Delay-Ausgang
      // -- sonst wäre bei Mix=100% das ERSTE Echo noch ein unverändertes,
      // ungefiltertes Abbild des Eingangssignals (nur zeitversetzt), was
      // sich anhört, als würde trotz Mix=100% noch das Trockensignal
      // durchkommen. So durchläuft JEDE Wiederholung, auch die erste, den
      // Filter -- nur die nachfolgenden (die zusätzlich durch die
      // Feedback-Schleife liefen) werden zunehmend stärker gefiltert.
      const delay = ctx.createDelay(2.0);
      delay.delayTime.value = p.time;
      const filter = ctx.createBiquadFilter();
      filter.type = p.filterType;
      filter.frequency.value = p.filterFreq;
      filter.Q.value = 0.7;
      const feedback = ctx.createGain();
      feedback.gain.value = p.feedback;

      input.connect(dry).connect(output);
      input.connect(delay);
      delay.connect(filter);
      filter.connect(wet).connect(output);
      filter.connect(feedback);
      feedback.connect(delay);

      return {
        input, output,
        setParam(key, v) {
          const t = engine.now;
          if (key === 'time') delay.delayTime.setTargetAtTime(v, t, 0.02);
          else if (key === 'feedback') feedback.gain.setTargetAtTime(v, t, 0.01);
          else if (key === 'filterFreq') filter.frequency.setTargetAtTime(v, t, 0.01);
          else if (key === 'filterType') filter.type = v;
          else if (key === 'mix') {
            dry.gain.setTargetAtTime(1 - v, t, 0.01);
            wet.gain.setTargetAtTime(v, t, 0.01);
          }
        },
        dispose() {
          input.disconnect(); output.disconnect(); dry.disconnect(); wet.disconnect();
          delay.disconnect(); filter.disconnect(); feedback.disconnect();
        },
      };
    },
  },
  reverb: {
    name: 'Reverb',
    // Anders als der Master-Reverb in fx.js (Faltung mit einem einmalig
    // erzeugten, statischen Impuls) läuft hier ein ECHTES Feedback-Delay-
    // Netzwerk (FDN) -- acht Delay-Leitungen, über eine Hadamard-Matrix
    // rückgekoppelt (ursprünglich vier, s. Kommentare bei N/BASE_MS unten:
    // zu wenig Leitungen liessen sich als leicht metallisches Klingeln
    // messen). Klingt dadurch weniger "eingefroren", mit einer leicht
    // lebendigen Qualität -- die algorithmische Bauart (statt Faltung), auf
    // die "Valhalla-Style" hier zielt.
    defaults: { size: 1.0, decay: 0.75, damping: 6000, mix: 0.35 },
    build(ctx, p) {
      const input = ctx.createGain();
      const output = ctx.createGain();
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      dry.gain.value = 1 - p.mix;
      wet.gain.value = p.mix;

      // Eingangsdiffusion: drei serielle Allpass-Diffusoren VOR dem
      // eigentlichen Netzwerk (ein dritter gegenüber der ersten Fassung
      // dazugekommen, abnehmende Delay-Zeit/Gain pro Stufe, klassisches
      // Schroeder-Diffusor-Muster) -- verwandeln den scharfen Eingangsimpuls
      // in ein NOCH dichteres Bündel aus Mikro-Echos, damit das FDN nicht
      // mit einem einzelnen "Klick" angeregt wird (der sonst als kurzes
      // Klicken vor dem eigentlichen Hall-Schwanz hörbar wäre).
      const diff1 = makeAllpass(ctx, 0.0047, 0.6);
      const diff2 = makeAllpass(ctx, 0.0033, 0.5);
      const diff3 = makeAllpass(ctx, 0.0022, 0.4);
      input.connect(diff1.input);
      diff1.output.connect(diff2.input);
      diff2.output.connect(diff3.input);

      // N=8 (vorher 4) mit der entsprechend vergrösserten HADAMARD_8 --
      // mehr Leitungen verteilen die zurückkommende Energie feiner, das
      // hörbare periodische "Flattern" der 4er-Fassung (gemessene, deutliche
      // Selbstähnlichkeit der Abkling-Hüllkurve alle ~30ms) wird spürbar
      // schwächer, ohne an der Stabilitäts-Mathematik unten etwas zu ändern
      // (eine orthogonale Matrix fügt dem Netzwerk nie Energie hinzu, ganz
      // gleich ob 4x4 oder 8x8 -- der Beweis bleibt N-unabhängig gültig).
      const N = 8;
      // Basis-Delay-Zeiten (ms) ungefähr verdoppelt gegenüber der ersten
      // Fassung (19.7-41.9 -> ~37-92) -- bei GLEICHEM decay-Regler (Obergrenze
      // weiterhin bewusst bei 0.9, s. Kommentar dort) verdoppelt eine doppelt
      // so lange Rundlaufzeit pro Iteration direkt die erreichbare Abkling-
      // dauer (gemessen: alte Fassung klang bei decay=0.9 nach spätestens
      // ~2s komplett aus -- viel zu kurz für einen überzeugenden "Hall",
      // eher ein langes Echo). Weiterhin bewusst NICHT auf einfache
      // Verhältnisse zueinander (vermeidet periodische Deckungen zwischen
      // den Leitungen -- die klingen als Flatterecho/metallisches Klingeln
      // statt als glatter Hall).
      const BASE_MS = [37.3, 43.1, 51.7, 58.9, 67.3, 74.1, 83.7, 91.9];
      // KEINE Delay-Zeit-Modulation (früher: ein leises LFO-Chorus pro
      // Leitung für einen "schwebenden" Valhalla-Charakter) -- so verlockend
      // das klanglich war, macht es das Netzwerk zeitvariant, wodurch die
      // übliche Stabilitätsgarantie (Loop-Gain < 1 bei fixer Delay-Zeit)
      // nicht mehr exakt gilt: unter dichter, rhythmischer Retriggerung
      // (echter Musikbetrieb, nicht nur ein einzelner Impuls) lief die
      // Schleife bei bestimmten Damping/Size-Kombinationen tatsächlich
      // unbegrenzt auf (gemessen: RMS im 6-stelligen Bereich nach 30s).
      // Damper ist ein einpoliger Tiefpass (makeOnePoleLowpass), NICHT
      // ctx.createBiquadFilter() -- ein 2-poliger Biquad überschwingt
      // >1.0 nahe der Grenzfrequenz, egal welches Q (s. Kommentar dort).
      // Mit beidem zusammen (kein Modulation-Zeitvarianz-Loch, Filter
      // beweisbar <= 1) gilt decay*|Filter| <= decay < 1 GARANTIERT, für
      // jede Parameter-Kombination -- verifiziert per Sweep über Decay x
      // Damping x Size unter dichter Retriggerung, nicht nur Einzelimpuls.
      const delays = [], dampers = [], decayGains = [], inGains = [];
      for (let i = 0; i < N; i++) {
        const d = ctx.createDelay(1.0);
        d.delayTime.value = (BASE_MS[i] / 1000) * p.size;
        const damp = makeOnePoleLowpass(ctx, p.damping);
        const dg = ctx.createGain();
        dg.gain.value = p.decay;

        d.connect(damp.input);
        damp.output.connect(dg);
        delays.push(d); dampers.push(damp); decayGains.push(dg);
      }

      // Eingang mit alternierendem Vorzeichen auf alle N Leitungen verteilen
      // -- mehr Dekorrelation zwischen den Leitungen als ein gleiches
      // Vorzeichen für alle.
      for (let i = 0; i < N; i++) {
        const g = ctx.createGain();
        g.gain.value = 0.5 * (i % 2 === 0 ? 1 : -1);
        diff3.output.connect(g).connect(delays[i]);
        inGains.push(g);
      }

      // Hadamard-Rückkopplungsmatrix (orthogonal/energieerhaltend, s.
      // HADAMARD_8 oben): decayGains[j] -> matrixGain[i][j] -> delays[i].
      // Die eigentliche Abkling-Kontrolle sitzt in decayGains, NICHT in der
      // Matrix selbst -- die darf dem Netzwerk keine Energie hinzufügen,
      // sonst wird die Schleife instabil.
      const matrixGains = [];
      for (let i = 0; i < N; i++) {
        matrixGains[i] = [];
        for (let j = 0; j < N; j++) {
          const g = ctx.createGain();
          g.gain.value = HADAMARD_8[i][j];
          decayGains[j].connect(g).connect(delays[i]);
          matrixGains[i][j] = g;
        }
      }

      // Ausgang: Summe aller N Leitungen (nach Damping/Decay, derselbe
      // Abgriff, den auch die Matrix liest) -- durch N geteilt, sonst
      // deutlich lauter als der Dry-Pfad.
      const outSum = ctx.createGain();
      outSum.gain.value = 1 / N;
      for (const dg of decayGains) dg.connect(outSum);

      input.connect(dry).connect(output);
      outSum.connect(wet).connect(output);

      return {
        input, output,
        setParam(key, v) {
          const t = engine.now;
          if (key === 'size') {
            for (let i = 0; i < N; i++) delays[i].delayTime.setTargetAtTime((BASE_MS[i] / 1000) * v, t, 0.05);
          } else if (key === 'decay') {
            for (const dg of decayGains) dg.gain.setTargetAtTime(v, t, 0.02);
          } else if (key === 'damping') {
            for (const damp of dampers) damp.setFreq(v, t, 0.02);
          } else if (key === 'mix') {
            dry.gain.setTargetAtTime(1 - v, t, 0.01);
            wet.gain.setTargetAtTime(v, t, 0.01);
          }
        },
        dispose() {
          input.disconnect(); output.disconnect(); dry.disconnect(); wet.disconnect(); outSum.disconnect();
          diff1.dispose(); diff2.dispose(); diff3.dispose();
          for (const d of delays) d.disconnect();
          for (const damp of dampers) damp.dispose();
          for (const dg of decayGains) dg.disconnect();
          for (const row of matrixGains) for (const g of row) g.disconnect();
          for (const g of inGains) g.disconnect();
        },
      };
    },
  },
  resonator: {
    name: 'Resonator',
    // Bewusst KEIN Delay-Feedback-Design wie Filter Delay/Reverb (beide
    // haben uns schon eine Instabilität eingebrockt) -- stattdessen eine
    // Bank paralleler resonanter Bandpass-Filter (BiquadFilterNode), auf
    // Intervalle einer Grundtonhöhe gestimmt. Ein Bandpass hat laut
    // Web-Audio-Spezifikation IMMER konstanten 0dB-Spitzenpegel, egal wie
    // hoch Q gesetzt wird (kein Überschwingen wie bei Lowpass/Highpass,
    // s. Kommentare bei Filter Delay) -- UND jeder Filter ist ein
    // eigenständiger, für sich genommen stets stabiler 2-poliger IIR
    // (kein externes Feedback über mehrere Nodes/Iterationen wie beim
    // FDN-Reverb). Klingt wie ein angeschlagenes Glas/eine Saite, die auf
    // die eingehende Frequenz mitschwingt -- klassischer "Resonator"-
    // Pedal-Sound.
    defaults: { pitch: 220, resonance: 0.6, damping: 8000, mix: 0.35, interval: 'harmonic' },
    build(ctx, p) {
      const input = ctx.createGain();
      const output = ctx.createGain();
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      dry.gain.value = 1 - p.mix;
      wet.gain.value = p.mix;

      const N = 5;
      let ratios = RESONATOR_INTERVAL_RATIOS[p.interval] ?? RESONATOR_INTERVAL_RATIOS.harmonic;
      let pitch = p.pitch;
      const q = resonanceToQ(p.resonance);

      const bands = [];
      for (let i = 0; i < N; i++) {
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = pitch * ratios[i] * RESONATOR_DETUNE[i];
        bp.Q.value = q;
        input.connect(bp);
        bands.push(bp);
      }

      // Pegel-Kompensation: zwei Effekte gegenläufig ausgleichen. (1) N
      // parallele Bandpässe wären sonst lauter als der Dry-Pfad (1/N).
      // (2) Ein schmalbandigerer (höher-Q) Filter fängt bei einer kurzen/
      // breitbandigen Anregung (Drum-Transiente) nur einen ENTSPRECHEND
      // kleineren Ausschnitt der Eingangsenergie ein -- gemessen fällt der
      // Spitzenpegel etwa mit 1/Q (Resonance ganz auf: über 400x leiser
      // als Resonance ganz zu). Ohne Ausgleich würde "mehr Resonance"
      // sich anfühlen wie "leiser" statt "länger/dramatischer nachklingend"
      // -- makeupFor(q) gleicht das mit sqrt(Q) grob aus (voller 1/Q-
      // Ausgleich würde die tiefen Resonance-Werte dagegen unnötig laut
      // machen).
      const sum = ctx.createGain();
      sum.gain.value = makeupFor(q) / N;
      for (const bp of bands) bp.connect(sum);

      // limiter: makeupFor() ist auf eine KURZE/breitbandige Anregung
      // kalibriert (Drum-Transiente) -- bei einer GEHALTENEN Note exakt auf
      // der Resonanzfrequenz (z. B. ein Bass/Pad-Synth durch den Resonator)
      // erreicht ein Bandpass dagegen unabhängig von Q seinen vollen,
      // eingeschwungenen 0dB-Spitzenpegel (Definition laut Web-Audio-Spec)
      // -- die transienten-kalibrierte Extra-Verstärkung von makeupFor()
      // würde DANN klar übersteuern (gemessen: bis über 3x Vollausschlag
      // bei hoher Resonance). Ein schneller Limiter fängt genau diesen Fall
      // ab, ohne die (ohnehin leisen) Transienten hörbar zu beschneiden.
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -3;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.15;
      sum.connect(limiter);

      const damp = makeOnePoleLowpass(ctx, p.damping);
      limiter.connect(damp.input);

      input.connect(dry).connect(output);
      damp.output.connect(wet).connect(output);

      return {
        input, output,
        setParam(key, v) {
          const t = engine.now;
          if (key === 'pitch') {
            pitch = v;
            for (let i = 0; i < N; i++) bands[i].frequency.setTargetAtTime(pitch * ratios[i] * RESONATOR_DETUNE[i], t, 0.02);
          } else if (key === 'resonance') {
            const newQ = resonanceToQ(v);
            for (const bp of bands) bp.Q.setTargetAtTime(newQ, t, 0.02);
            sum.gain.setTargetAtTime(makeupFor(newQ) / N, t, 0.02);
          } else if (key === 'damping') {
            damp.setFreq(v, t, 0.02);
          } else if (key === 'interval') {
            ratios = RESONATOR_INTERVAL_RATIOS[v] ?? RESONATOR_INTERVAL_RATIOS.harmonic;
            for (let i = 0; i < N; i++) bands[i].frequency.setTargetAtTime(pitch * ratios[i], t, 0.03);
          } else if (key === 'mix') {
            dry.gain.setTargetAtTime(1 - v, t, 0.01);
            wet.gain.setTargetAtTime(v, t, 0.01);
          }
        },
        dispose() {
          input.disconnect(); output.disconnect(); dry.disconnect(); wet.disconnect(); sum.disconnect();
          limiter.disconnect();
          damp.dispose();
          for (const bp of bands) bp.disconnect();
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
};

/** UI-Metadaten je Parameter (Label/Bereich/Kurve/Einheit) — getrennt von
 *  den DSP-Defaults, weil die UI mehr wissen muss als der Audiograph. */
export const UI_PARAMS = {
  comp: [
    { key: 'input', label: 'Input', min: -20, max: 20, unit: 'dB' },
    { key: 'attack', label: 'Attack', min: 0.0002, max: 0.5, curve: 'log', unit: 's' },
    { key: 'release', label: 'Release', min: 0.02, max: 1, curve: 'log', unit: 's' },
    { key: 'output', label: 'Output', min: -20, max: 20, unit: 'dB' },
  ],
  eq: [
    { key: 'freq', label: 'Freq', min: 20, max: 20000, curve: 'log', unit: 'Hz' },
    { key: 'gain', label: 'Gain', min: -24, max: 24, unit: 'dB' },
    { key: 'q', label: 'Q', min: 0.1, max: 10, curve: 'log', unit: '' },
  ],
  drive: [
    { key: 'drive', label: 'Drive', min: 0, max: 1, unit: '' },
    { key: 'tone', label: 'Tone', min: 0, max: 1, unit: '' },
    { key: 'level', label: 'Level', min: 0, max: 2, unit: '' },
  ],
  filterDelay: [
    { key: 'time', label: 'Time', min: 0.01, max: 1.5, curve: 'log', unit: 's' },
    // Feedback bewusst auf 0.8 gedeckelt (nicht 1.0 oder gar 0.9): die
    // Schleife delay->filter->feedback->delay summiert sich sonst
    // unbegrenzt auf. Der naheliegende Gedanke "der Tiefpass/Hochpass
    // dämpft ja pro Durchlauf zusätzlich, das reicht als Sicherheit" ist
    // TRÜGERISCH -- Chromes BiquadFilterNode zeigt bei lowpass/highpass
    // nahe der Cutoff-Frequenz eine Überhöhung von >1.0 (gemessen ~1.15-
    // 1.22x, praktisch unabhängig von Q, auch bei sehr kleinem Q nicht
    // wegzubekommen). Bei Feedback=0.9 wächst die Schleife dadurch über
    // Sekunden tatsächlich exponentiell auf (gemessen, kein Bandpass
    // betroffen -- der hat wegen konstantem 0dB-Spitzenpegel keine
    // Überhöhung). 0.8 hat auch am Rand des Filter-Bereichs (200Hz/
    // 8000Hz) über 20s Rendertest nachweislich Sicherheitsabstand.
    { key: 'feedback', label: 'Feedback', min: 0, max: 0.8, unit: '' },
    { key: 'filterFreq', label: 'Filter', min: 200, max: 8000, curve: 'log', unit: 'Hz' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, unit: '' },
  ],
  reverb: [
    { key: 'size', label: 'Size', min: 0.3, max: 3, curve: 'log', unit: '' },
    // Wie beim Filter-Delay-Feedback bewusst unter 1.0 gedeckelt -- die
    // Hadamard-Rückkopplungsmatrix ist zwar energieerhaltend (verstärkt
    // selbst nichts), aber erst decay < 1 garantiert, dass die Schleife
    // insgesamt abklingt statt endlos auf demselben Pegel zu bleiben.
    // Mit dem einpoligen Damping-Filter (s. makeOnePoleLowpass) UND ohne
    // Delay-Zeit-Modulation (beides s. Kommentare im reverb-DEFS-Eintrag)
    // gilt decay*|Filter| <= decay < 1 rechnerisch für JEDE Damping/Size-
    // Kombination -- 0.9 ist zusätzlich per Sweep über den gesamten
    // Damping/Size/Tempo-Bereich unter dichter, rhythmischer Retriggerung
    // (nicht nur Einzelimpuls!) nachweislich sauber, bis hin zu extrem
    // schneller Retriggerung (20ms) über 40s Rendertest. Ab ca. 0.93
    // zeigten sich bei bestimmten Damping/Size-Extremen wieder Aufschaukel-
    // /Overflow-Effekte (vermutlich Gleitkomma-Akkumulation bei sehr nah an
    // 1 liegender Schleifenverstärkung über tausende Iterationen) -- 0.9
    // hat davon ausreichend Abstand.
    { key: 'decay', label: 'Decay', min: 0, max: 0.9, unit: '' },
    { key: 'damping', label: 'Damping', min: 500, max: 15000, curve: 'log', unit: 'Hz' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, unit: '' },
  ],
  resonator: [
    { key: 'pitch', label: 'Pitch', min: 55, max: 880, curve: 'log', unit: 'Hz' },
    { key: 'resonance', label: 'Resonance', min: 0, max: 1, unit: '' },
    { key: 'damping', label: 'Damping', min: 500, max: 15000, curve: 'log', unit: 'Hz' },
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
