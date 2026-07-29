/**
 * modular.js — freie Patch-Umgebung (wie Caustics "Modular"): einzelne
 * Klangbausteine (Oszillator, Filter, Hüllkurve, …), die der Nutzer per
 * virtuellem Kabel beliebig miteinander verbindet, statt eine feste
 * Signalkette wie bei jeder anderen Maschine zu bekommen.
 *
 * Zwei Ebenen, wie inserts.js:
 *   - MODULE_DEFS: ein `build(ctx, params)` pro Modultyp, baut den echten
 *     Web-Audio-Teilgraphen und liefert { inputs, outputs, trigger?,
 *     setParam, dispose }. `inputs`/`outputs` sind benannte Ports --
 *     `inputs` kann AudioParams (CV-Ziel, z. B. Filter-Cutoff) ODER
 *     AudioNodes (Signal-Eingang, z. B. Filter-Audioeingang) enthalten,
 *     `outputs` sind immer AudioNodes.
 *   - ModularPatch: verwaltet Modul-Instanzen + Kabel-Liste, verbindet sie
 *     wirklich per connect()/disconnect().
 *
 * Sicherheit: JEDER Modul-Ausgang läuft durch denselben Weichbegrenzer
 * (tanh, wie beim Filter-Delay/Resonator/Master-Delay) -- eine frei
 * patchbare Umgebung kann der Nutzer in eine Rückkopplungsschleife
 * verkabeln, die wir nicht vorhersehen können (s. Chat: Rückkopplung
 * bleibt bewusst ERLAUBT, das ist eine der beliebtesten Modular-Techniken
 * überhaupt -- nur pauschal amplitudenbegrenzt statt topologisch verboten).
 *
 * CV-Eingänge (AudioParams) folgen der üblichen Konvention frei patchbarer
 * Software-Modularsysteme: Web Audio ADDIERT jede angeschlossene Quelle auf
 * den eingestellten Regler-Wert des Parameters -- für die meisten CV-Fälle
 * (z. B. Hüllkurve auf VCA-Gain) will man aber, dass das PATCH-KABEL allein
 * den Wert bestimmt, nicht Regler+Kabel zusammen. Deshalb: sobald ein Kabel
 * an einem CV-Eingang hängt, wird dessen Regler-Basiswert auf 0 gesetzt
 * (der Regler bleibt in der UI sichtbar, wirkt aber erst wieder, sobald das
 * letzte Kabel dort entfernt wird) -- s. ModularPatch#connect/disconnect.
 */
import { engine } from './audio-engine.js';
import { noise, midiToHz } from './dsp.js';
import { makeFeedbackClipCurve } from './inserts.js';

let sharedClipCurve = null;
function clipCurve() {
  if (!sharedClipCurve) sharedClipCurve = makeFeedbackClipCurve();
  return sharedClipCurve;
}

/** Ein einziges Sample Verzögerung (1/sampleRate) -- unhörbar, aber
 *  entscheidend: die Web-Audio-Spezifikation MUTET jeden Zyklus, der KEINEN
 *  DelayNode enthält, automatisch komplett (Chromium tatsächlich beobachtet:
 *  ein Modul, das direkt oder über andere Module in seinen eigenen Eingang
 *  zurückgeführt wird, blieb sonst komplett stumm -- nicht etwa laut/instabil,
 *  sondern gar kein Signal). Da JEDER Modul-Ausgang durch safeOutput() läuft,
 *  reicht ein einzelner Mini-Delay HIER, um wirklich JEDEN möglichen Zyklus
 *  patchbar zu machen, egal welche Module ihn bilden. */
function microDelay(ctx) {
  const d = ctx.createDelay(1);
  d.delayTime.value = 1 / ctx.sampleRate;
  return d;
}

/** Hängt Mini-Delay + tanh-Weichbegrenzer HINTER einen rohen Ausgangsknoten
 *  und gibt den letzten Knoten der Kette zurück -- das ist es, was Kabel
 *  tatsächlich abgreifen (s. Dateikopf-Kommentar). Bei kleinen (CV-
 *  typischen) Pegeln ist der Begrenzer praktisch identisch zur Identität
 *  (tanh(x)≈x nahe 0), also auch für Steuerspannungs-Ausgänge unauffällig --
 *  deshalb pauschal auf ALLE Ausgänge angewendet statt nur auf Audio-Ports. */
function safeOutput(ctx, rawNode) {
  const delay = microDelay(ctx);
  const shaper = ctx.createWaveShaper();
  shaper.curve = clipCurve();
  rawNode.connect(delay);
  delay.connect(shaper);
  shaper.__preDelay = delay; // s. disposeOutput()
  return shaper;
}

/** Gegenstück zu safeOutput() -- trennt Weichbegrenzer UND den vorgeschalteten
 *  Mini-Delay wieder ab. Jedes Modul ruft das statt eines blossen
 *  `output.disconnect()` in seinem eigenen dispose() auf. */
function disposeOutput(output) {
  output.__preDelay?.disconnect();
  output.disconnect();
}

const MODULE_DEFS = {
  oscillator: {
    name: 'Oscillator',
    defaults: { wave: 'sawtooth', coarse: 0 },
    build(ctx, p) {
      const osc = ctx.createOscillator();
      osc.type = p.wave;
      osc.frequency.value = midiToHz(60);
      osc.start();
      const output = safeOutput(ctx, osc);
      return {
        inputs: { pitch: osc.frequency, fine: osc.detune },
        outputs: { audio: output },
        // Vom Sequenzer aufgerufen (s. machines/modular.js#playNote) -- setzt
        // die Grundtonhöhe. Ein evtl. an `pitch`/`fine` gepatchtes CV-Signal
        // (LFO fürs Vibrato, Hüllkurve fürs Pitch-Envelope, …) ADDIERT sich
        // laut Web-Audio-Spezifikation automatisch darüber, braucht hier
        // keinen Sonderfall.
        trigger(t, _dur, midi) {
          osc.frequency.setValueAtTime(midiToHz(midi + p.coarse), t);
        },
        setParam(key, v) {
          if (key === 'wave') osc.type = v;
          else if (key === 'coarse') p.coarse = v;
        },
        dispose() { osc.stop(); osc.disconnect(); disposeOutput(output); },
      };
    },
  },

  noise: {
    name: 'Noise',
    defaults: {},
    build(ctx) {
      const src = ctx.createBufferSource();
      src.buffer = noise(ctx);
      src.loop = true;
      src.start();
      const output = safeOutput(ctx, src);
      return {
        inputs: {},
        outputs: { audio: output },
        setParam() {},
        dispose() { src.stop(); src.disconnect(); disposeOutput(output); },
      };
    },
  },

  filter: {
    name: 'Filter',
    defaults: { type: 'lowpass', cutoff: 2000, resonance: 0.707 },
    build(ctx, p) {
      const input = ctx.createGain();
      const filter = ctx.createBiquadFilter();
      filter.type = p.type;
      filter.frequency.value = p.cutoff;
      filter.Q.value = p.resonance;
      input.connect(filter);
      const output = safeOutput(ctx, filter);
      return {
        inputs: { audio: input, cutoff: filter.frequency },
        outputs: { audio: output },
        setParam(key, v) {
          if (key === 'type') filter.type = v;
          else if (key === 'cutoff') { p.cutoff = v; filter.frequency.value = v; }
          else if (key === 'resonance') filter.Q.value = v;
        },
        dispose() { input.disconnect(); filter.disconnect(); disposeOutput(output); },
      };
    },
  },

  /**
   * Hüllkurve als PERSISTENTE Steuerspannungsquelle (ConstantSourceNode),
   * nicht wie dsp.js#env() ein pro Anschlag frisch erzeugter/wegwerfbarer
   * Gain-Node -- ein Patch-Kabel verbindet feste Modul-Instanzen, keine
   * Einwegknoten. trigger() rampt exakt dieselbe Kurvenform (Attack linear
   * 0→1, Decay exponentiell →0.001, Release linear →0) auf `src.offset`,
   * jedes Mal neu für den nächsten Anschlag.
   */
  envelope: {
    name: 'Envelope',
    defaults: { attack: 0, release: 0.05 },
    build(ctx, p) {
      const src = ctx.createConstantSource();
      src.offset.value = 0;
      src.start();
      const output = safeOutput(ctx, src);
      return {
        inputs: {},
        outputs: { cv: output },
        trigger(t, dur) {
          const attack = Math.max(0, p.attack);
          const release = Math.max(0.005, p.release);
          src.offset.cancelScheduledValues(t);
          src.offset.setValueAtTime(0.0001, t);
          if (attack > 0) src.offset.linearRampToValueAtTime(1, t + attack);
          else src.offset.setValueAtTime(1, t);
          src.offset.exponentialRampToValueAtTime(0.001, t + attack + dur);
          src.offset.linearRampToValueAtTime(0, t + attack + dur + release);
        },
        setParam(key, v) { p[key] = v; },
        dispose() { src.stop(); src.disconnect(); disposeOutput(output); },
      };
    },
  },

  lfo: {
    name: 'LFO',
    defaults: { wave: 'sine', rateHz: 4, depth: 1 },
    build(ctx, p) {
      const osc = ctx.createOscillator();
      osc.type = p.wave;
      osc.frequency.value = p.rateHz;
      const depth = ctx.createGain();
      depth.gain.value = p.depth;
      osc.connect(depth);
      osc.start();
      const output = safeOutput(ctx, depth);
      return {
        inputs: {},
        outputs: { cv: output },
        setParam(key, v) {
          if (key === 'wave') osc.type = v;
          else if (key === 'rateHz') osc.frequency.value = v;
          else if (key === 'depth') depth.gain.value = v;
        },
        dispose() { osc.stop(); osc.disconnect(); depth.disconnect(); disposeOutput(output); },
      };
    },
  },

  /** VCA -- steuerbarer Verstärker, das Standard-"Ausgang dosieren"-Modul
   *  jedes Modularsystems. `level` ist der Regler-Basiswert; sobald ein
   *  Kabel an `gain` hängt, übernimmt ModularPatch#connect diesen Basiswert
   *  auf 0 (s. Dateikopf-Kommentar) -- eine gepatchte Hüllkurve bestimmt den
   *  Pegel dann vollständig selbst. */
  vca: {
    name: 'VCA',
    defaults: { level: 1 },
    build(ctx, p) {
      const input = ctx.createGain();
      const gain = ctx.createGain();
      gain.gain.value = p.level;
      input.connect(gain);
      const output = safeOutput(ctx, gain);
      return {
        inputs: { audio: input, gain: gain.gain },
        outputs: { audio: output },
        setParam(key, v) {
          if (key === 'level') { p.level = v; gain.gain.value = v; }
        },
        dispose() { input.disconnect(); gain.disconnect(); disposeOutput(output); },
      };
    },
  },

  /** Fester Endpunkt jedes Patches -- die Modular-Maschine verbindet dessen
   *  Ausgang einmalig, dauerhaft an ihren eigenen this.output (s.
   *  machines/modular.js). Reine Durchleitung, kein eigener Regler. */
  output: {
    name: 'Output',
    defaults: {},
    build(ctx) {
      const gain = ctx.createGain();
      return {
        inputs: { audio: gain },
        outputs: { audio: gain },
        setParam() {},
        dispose() { gain.disconnect(); },
      };
    },
  },
};

export const MODULE_TYPES = Object.keys(MODULE_DEFS);
export function moduleMeta(type) {
  return { name: MODULE_DEFS[type].name, defaults: { ...MODULE_DEFS[type].defaults } };
}

/** Port-Beschriftungen je Modultyp fürs Kabel-UI (ui/modular-view.js) --
 *  müssen manuell mit den `inputs`/`outputs`-Schlüsseln der jeweiligen
 *  build()-Funktion oben übereinstimmen (dasselbe Muster wie DEFS/UI_PARAMS
 *  in inserts.js: von Hand synchron gehalten statt automatisch abgeleitet). */
export const MODULE_PORTS = {
  oscillator: { inputs: [{ key: 'pitch', label: 'Pitch' }, { key: 'fine', label: 'Fine' }], outputs: [{ key: 'audio', label: 'Out' }] },
  noise: { inputs: [], outputs: [{ key: 'audio', label: 'Out' }] },
  filter: { inputs: [{ key: 'audio', label: 'In' }, { key: 'cutoff', label: 'Cutoff' }], outputs: [{ key: 'audio', label: 'Out' }] },
  envelope: { inputs: [], outputs: [{ key: 'cv', label: 'CV' }] },
  lfo: { inputs: [], outputs: [{ key: 'cv', label: 'CV' }] },
  vca: { inputs: [{ key: 'audio', label: 'In' }, { key: 'gain', label: 'Gain' }], outputs: [{ key: 'audio', label: 'Out' }] },
  output: { inputs: [{ key: 'audio', label: 'In' }], outputs: [] },
};

/** Regler-Metadaten (Label/Bereich/Kurve/Einheit) je Modultyp -- getrennt
 *  von den DSP-Defaults, wie UI_PARAMS in inserts.js. Enum-Parameter (Wave-
 *  Form, Filtertyp) laufen über eigene Segment-Buttons, s.
 *  OSCILLATOR_WAVES/LFO_WAVES/FILTER_TYPES statt hier. */
export const MODULE_UI_PARAMS = {
  oscillator: [{ key: 'coarse', label: 'Coarse', min: -24, max: 24, step: 1, unit: 'st' }],
  noise: [],
  filter: [
    { key: 'cutoff', label: 'Cutoff', min: 40, max: 12000, curve: 'log', unit: 'Hz' },
    { key: 'resonance', label: 'Reso', min: 0.1, max: 15, curve: 'log', unit: '' },
  ],
  envelope: [
    { key: 'attack', label: 'Attack', min: 0, max: 1, curve: 'log', unit: 's' },
    { key: 'release', label: 'Release', min: 0.01, max: 1.5, curve: 'log', unit: 's' },
  ],
  lfo: [
    { key: 'rateHz', label: 'Rate', min: 0.05, max: 20, curve: 'log', unit: 'Hz' },
    { key: 'depth', label: 'Depth', min: 0, max: 1, unit: '' },
  ],
  vca: [{ key: 'level', label: 'Level', min: 0, max: 1, unit: '' }],
  output: [],
};

export const OSCILLATOR_WAVES = [
  { value: 'sine', label: 'Sine' },
  { value: 'triangle', label: 'Tri' },
  { value: 'sawtooth', label: 'Saw' },
  { value: 'square', label: 'Sqr' },
];
export const FILTER_TYPES = [
  { value: 'lowpass', label: 'LP' },
  { value: 'highpass', label: 'HP' },
  { value: 'bandpass', label: 'BP' },
];

let nextModuleId = 1;
let nextCableId = 1;

export class ModularPatch {
  constructor() {
    /** @type {Map<number, {type:string, params:object, instance:object, x:number, y:number}>} */
    this.modules = new Map();
    /** @type {Array<{id:number, fromId:number, fromPort:string, toId:number, toPort:string}>} */
    this.cables = [];
  }

  /** @param {{id?:number, params?:object, x?:number, y?:number}} [saved] */
  addModule(type, saved = null) {
    const def = MODULE_DEFS[type];
    if (!def) throw new Error(`Unbekannter Modul-Typ: ${type}`);
    const params = { ...def.defaults, ...saved?.params };
    const id = saved?.id ?? nextModuleId++;
    if (saved?.id != null) nextModuleId = Math.max(nextModuleId, saved.id + 1);
    const instance = def.build(engine.ctx, params);
    this.modules.set(id, { type, params, instance, x: saved?.x ?? 20, y: saved?.y ?? 20 });
    return id;
  }

  removeModule(id) {
    // Alle Kabel entfernen, die dieses Modul berühren -- sonst blieben
    // Verweise auf eine bereits entsorgte Instanz stehen (s. connect()/
    // disconnect() unten, die live auf instance.outputs/inputs zugreifen).
    for (const cable of [...this.cables]) {
      if (cable.fromId === id || cable.toId === id) this.disconnect(cable.id);
    }
    this.modules.get(id)?.instance.dispose();
    this.modules.delete(id);
  }

  #portCountOnTarget(toId, toPort) {
    return this.cables.filter((c) => c.toId === toId && c.toPort === toPort).length;
  }

  connect(fromId, fromPort, toId, toPort) {
    const from = this.modules.get(fromId)?.instance.outputs[fromPort];
    const toModule = this.modules.get(toId);
    const to = toModule?.instance.inputs[toPort];
    if (!from || !to) return null;
    from.connect(to);
    // Erstes Kabel an einem CV-Ziel (AudioParam, s. Dateikopf-Kommentar) --
    // Regler-Basiswert merken und auf 0 setzen, damit das Kabel allein
    // bestimmt, was ankommt, statt sich zum Reglerwert zu addieren.
    if (to instanceof AudioParam && this.#portCountOnTarget(toId, toPort) === 0) {
      to.__patchBaseValue = to.value;
      to.setValueAtTime(0, engine.now);
    }
    const id = nextCableId++;
    this.cables.push({ id, fromId, fromPort, toId, toPort });
    return id;
  }

  disconnect(cableId) {
    const cable = this.cables.find((c) => c.id === cableId);
    if (!cable) return;
    const from = this.modules.get(cable.fromId)?.instance.outputs[cable.fromPort];
    const toModule = this.modules.get(cable.toId);
    const to = toModule?.instance.inputs[cable.toPort];
    this.cables = this.cables.filter((c) => c.id !== cableId);
    if (from && to) {
      try { from.disconnect(to); } catch { /* schon getrennt (z. B. Modul gerade entfernt) */ }
      // Letztes Kabel an diesem CV-Ziel entfernt -- Regler-Basiswert
      // wiederherstellen (s. connect() oben).
      if (to instanceof AudioParam && this.#portCountOnTarget(cable.toId, cable.toPort) === 0) {
        to.setValueAtTime(to.__patchBaseValue ?? 0, engine.now);
      }
    }
  }

  setModuleParam(id, key, v) {
    const m = this.modules.get(id);
    if (!m) return;
    m.params[key] = v;
    m.instance.setParam(key, v);
  }

  /** An JEDES Modul mit eigenem trigger() weiterreichen (Oszillator setzt
   *  seine Tonhöhe, Hüllkurve rampt ihre Kurve) -- vom Sequenzer aus
   *  aufgerufen (s. machines/modular.js#playNote), ein Anschlag betrifft
   *  immer den GANZEN Patch, nicht ein einzelnes Modul. */
  triggerAll(time, dur, midi) {
    for (const { instance } of this.modules.values()) instance.trigger?.(time, dur, midi);
  }

  dispose() {
    for (const id of [...this.modules.keys()]) this.removeModule(id);
  }

  serialize() {
    return {
      modules: [...this.modules.entries()].map(([id, m]) => ({ id, type: m.type, params: { ...m.params }, x: m.x, y: m.y })),
      cables: this.cables.map((c) => ({ fromId: c.fromId, fromPort: c.fromPort, toId: c.toId, toPort: c.toPort })),
    };
  }
}
