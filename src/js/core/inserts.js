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
      // Der WET-Abgriff sitzt VOR dem Filter (am Delay-Ausgang direkt) --
      // das erste Echo kommt dadurch noch unverändert/breitbandig, nur die
      // NACHFOLGENDEN Wiederholungen (die schon einmal durch die Schleife
      // liefen) werden zunehmend gefiltert. Genau dieser fortschreitend
      // dunkler/schmaler werdende Charakter macht den "Filter-Delay"-Sound
      // aus (klassischer Dub-Effekt) statt eines gleichförmig gefilterten
      // Signals von Anfang an.
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
      delay.connect(wet).connect(output);
      delay.connect(filter);
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
    // Netzwerk (FDN) -- vier modulierte Delay-Leitungen, über eine
    // Hadamard-Matrix rückgekoppelt. Klingt dadurch weniger "eingefroren",
    // mit einer leicht lebendigen, schwebenden Qualität -- die algorithmische
    // Bauart (statt Faltung), auf die "Valhalla-Style" hier zielt.
    defaults: { size: 1.0, decay: 0.75, damping: 6000, mix: 0.35 },
    build(ctx, p) {
      const input = ctx.createGain();
      const output = ctx.createGain();
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      dry.gain.value = 1 - p.mix;
      wet.gain.value = p.mix;

      // Eingangsdiffusion: zwei serielle Allpass-Diffusoren VOR dem
      // eigentlichen Netzwerk -- verwandeln den scharfen Eingangsimpuls in
      // ein dichtes Bündel aus Mikro-Echos, damit das FDN nicht mit einem
      // einzelnen "Klick" angeregt wird (der sonst als kurzes Klicken vor
      // dem eigentlichen Hall-Schwanz hörbar wäre).
      const diff1 = makeAllpass(ctx, 0.0047, 0.6);
      const diff2 = makeAllpass(ctx, 0.0033, 0.5);
      input.connect(diff1.input);
      diff1.output.connect(diff2.input);

      const N = 4;
      // Bewusst NICHT auf einfache Verhältnisse zueinander (vermeidet
      // periodische Deckungen zwischen den Leitungen -- die klingen als
      // "Flatterecho"/metallisches Klingeln statt als glatter Hall).
      const BASE_MS = [19.7, 27.1, 33.3, 41.9];
      // Je Leitung ein anderes, langsames LFO-Tempo -- die Modulation bleibt
      // dadurch unsynchron/organisch statt im Gleichtakt zu "pumpen", und
      // gibt dem Klang die leicht schwebende, nie exakt statische Qualität
      // guter algorithmischer Reverbs (der "Valhalla"-Charakter).
      const MOD_RATE_HZ = [0.13, 0.19, 0.24, 0.11];
      const MOD_DEPTH_S = 0.0015;

      const delays = [], dampers = [], decayGains = [], lfos = [], modGains = [], inGains = [];
      for (let i = 0; i < N; i++) {
        const d = ctx.createDelay(1.0);
        d.delayTime.value = (BASE_MS[i] / 1000) * p.size;
        const damp = ctx.createBiquadFilter();
        damp.type = 'lowpass';
        damp.frequency.value = p.damping;
        damp.Q.value = 0.5;
        const dg = ctx.createGain();
        dg.gain.value = p.decay;

        const lfo = ctx.createOscillator();
        lfo.frequency.value = MOD_RATE_HZ[i];
        const modGain = ctx.createGain();
        modGain.gain.value = MOD_DEPTH_S;
        lfo.connect(modGain).connect(d.delayTime);
        lfo.start();

        d.connect(damp).connect(dg);
        delays.push(d); dampers.push(damp); decayGains.push(dg); lfos.push(lfo); modGains.push(modGain);
      }

      // Eingang mit alternierendem Vorzeichen auf alle 4 Leitungen verteilen
      // -- mehr Dekorrelation zwischen den Leitungen als ein gleiches
      // Vorzeichen für alle.
      for (let i = 0; i < N; i++) {
        const g = ctx.createGain();
        g.gain.value = 0.5 * (i % 2 === 0 ? 1 : -1);
        diff2.output.connect(g).connect(delays[i]);
        inGains.push(g);
      }

      // Hadamard-Rückkopplungsmatrix (orthogonal/energieerhaltend, s.
      // HADAMARD_4 oben): decayGains[j] -> matrixGain[i][j] -> delays[i].
      // Die eigentliche Abkling-Kontrolle sitzt in decayGains, NICHT in der
      // Matrix selbst -- die darf dem Netzwerk keine Energie hinzufügen,
      // sonst wird die Schleife instabil.
      const matrixGains = [];
      for (let i = 0; i < N; i++) {
        matrixGains[i] = [];
        for (let j = 0; j < N; j++) {
          const g = ctx.createGain();
          g.gain.value = HADAMARD_4[i][j];
          decayGains[j].connect(g).connect(delays[i]);
          matrixGains[i][j] = g;
        }
      }

      // Ausgang: Summe aller 4 Leitungen (nach Damping/Decay, derselbe
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
            for (const damp of dampers) damp.frequency.setTargetAtTime(v, t, 0.02);
          } else if (key === 'mix') {
            dry.gain.setTargetAtTime(1 - v, t, 0.01);
            wet.gain.setTargetAtTime(v, t, 0.01);
          }
        },
        dispose() {
          input.disconnect(); output.disconnect(); dry.disconnect(); wet.disconnect(); outSum.disconnect();
          diff1.dispose(); diff2.dispose();
          for (const d of delays) d.disconnect();
          for (const damp of dampers) damp.disconnect();
          for (const dg of decayGains) dg.disconnect();
          for (const lfo of lfos) { try { lfo.stop(); } catch { /* schon gestoppt */ } lfo.disconnect(); }
          for (const mg of modGains) mg.disconnect();
          for (const row of matrixGains) for (const g of row) g.disconnect();
          for (const g of inGains) g.disconnect();
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
  drive: '#e8643f',  // Sättigung: warmes Glühen
  filterDelay: '#6f9ceb', // Delay: kühles Blau, wie ein Tape-/Digital-Delay-Rack
  reverb: '#a888e0', // Reverb: Violett, wie ein Hall-/Space-Rack
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
    // Feedback bewusst auf 0.9 gedeckelt (nicht 1.0): die Schleife
    // delay->filter->feedback->delay summiert sich sonst unbegrenzt auf --
    // 0.9 lässt viele hörbare Wiederholungen zu, bleibt aber mathematisch
    // stabil (jeder Durchlauf durchs Filter verliert zusätzlich Pegel).
    { key: 'feedback', label: 'Feedback', min: 0, max: 0.9, unit: '' },
    { key: 'filterFreq', label: 'Filter', min: 200, max: 8000, curve: 'log', unit: 'Hz' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, unit: '' },
  ],
  reverb: [
    { key: 'size', label: 'Size', min: 0.3, max: 3, curve: 'log', unit: '' },
    // Wie beim Filter-Delay-Feedback bewusst unter 1.0 gedeckelt -- die
    // Hadamard-Rückkopplungsmatrix ist zwar energieerhaltend (verstärkt
    // selbst nichts), aber erst decay < 1 garantiert, dass die Schleife
    // insgesamt abklingt statt endlos auf demselben Pegel zu bleiben.
    // Deckel bei 0.9 statt rechnerisch möglicher 0.99: die modulierten
    // Delay-Zeiten (Chorus-LFO je Leitung) machen das Netzwerk zeit-
    // variant, wodurch die übliche Stabilitätsgarantie (Loop-Gain < 1
    // bei fixer Delay-Zeit) nicht mehr exakt gilt -- gemessen wurde ein
    // Übergang zu langsam aufschaukelndem Verhalten ab ca. 0.92; 0.9 hat
    // über 20s Rendertest nachweislich Sicherheitsabstand.
    { key: 'decay', label: 'Decay', min: 0, max: 0.9, unit: '' },
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
  const params = { ...def.defaults, ...saved?.params };
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
