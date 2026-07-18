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
    const x = (i * 2) / n - 1;
    const driven = Math.tanh(K * x) / norm;
    curve[i] = (1 - amount) * x + amount * driven;
  }
  return curve;
}

const DEFS = {
  comp: {
    name: 'Compressor',
    defaults: { threshold: -24, ratio: 4, attack: 0.01, release: 0.25, makeup: 1 },
    build(ctx, p) {
      const node = ctx.createDynamicsCompressor();
      node.threshold.value = p.threshold;
      node.ratio.value = p.ratio;
      node.attack.value = p.attack;
      node.release.value = p.release;
      node.knee.value = 24;
      const makeup = ctx.createGain();
      makeup.gain.value = p.makeup;
      node.connect(makeup);
      return {
        input: node,
        output: makeup,
        setParam(key, v) {
          const t = engine.now;
          if (key === 'threshold') node.threshold.setTargetAtTime(v, t, 0.01);
          else if (key === 'ratio') node.ratio.setTargetAtTime(v, t, 0.01);
          else if (key === 'attack') node.attack.setTargetAtTime(v, t, 0.01);
          else if (key === 'release') node.release.setTargetAtTime(v, t, 0.01);
          else if (key === 'makeup') makeup.gain.setTargetAtTime(v, t, 0.01);
        },
        dispose() { node.disconnect(); makeup.disconnect(); },
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
      return {
        input: shaper,
        output: level,
        setParam(key, v) {
          if (key === 'drive') shaper.curve = makeDriveCurve(v);
          else if (key === 'tone') tone.frequency.setTargetAtTime(400 * Math.pow(12000 / 400, v), engine.now, 0.01);
          else if (key === 'level') level.gain.setTargetAtTime(v, engine.now, 0.01);
        },
        dispose() { shaper.disconnect(); tone.disconnect(); level.disconnect(); },
      };
    },
  },
};

export const INSERT_TYPES = Object.keys(DEFS);
export function insertMeta(type) {
  return { name: DEFS[type].name, defaults: { ...DEFS[type].defaults } };
}

/** UI-Metadaten je Parameter (Label/Bereich/Kurve/Einheit) — getrennt von
 *  den DSP-Defaults, weil die UI mehr wissen muss als der Audiograph. */
export const UI_PARAMS = {
  comp: [
    { key: 'threshold', label: 'Thresh', min: -60, max: 0, unit: 'dB' },
    { key: 'ratio', label: 'Ratio', min: 1, max: 20, unit: ':1' },
    { key: 'attack', label: 'Attack', min: 0.001, max: 0.5, curve: 'log', unit: 's' },
    { key: 'release', label: 'Release', min: 0.02, max: 1, curve: 'log', unit: 's' },
    { key: 'makeup', label: 'Makeup', min: 0, max: 4, unit: 'x' },
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
};

/** EQ-Filtertyp ist ein Enum, kein Knob — eigene, kleine Liste fürs UI. */
export const EQ_TYPES = [
  { value: 'lowshelf', label: 'Low Shelf' },
  { value: 'peaking', label: 'Peak' },
  { value: 'highshelf', label: 'High Shelf' },
];

let nextInsertId = 1;

/**
 * Baut einen Insert. `saved` (optional) = { params, bypassed } aus einem
 * vorher gespeicherten Projekt — fehlende Parameter fallen auf die
 * Effekt-Defaults zurück (z. B. wenn ein neuer Parameter dazukommt).
 */
export function createInsert(type, saved = null) {
  const def = DEFS[type];
  if (!def) throw new Error(`Unbekannter Insert-Typ: ${type}`);
  const ctx = engine.ctx;
  const params = { ...def.defaults, ...saved?.params };
  const bypassed = saved?.bypassed ?? false;

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
    id: nextInsertId++,
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
    setBypass(b) {
      insert.bypassed = b;
      const t = engine.now;
      dryGain.gain.setTargetAtTime(b ? 1 : 0, t, 0.01);
      wetGain.gain.setTargetAtTime(b ? 0 : 1, t, 0.01);
    },
    serialize() {
      return { type, params: { ...params }, bypassed: insert.bypassed };
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
