/**
 * modulators.js — die Modulations-Kette: LFO und Arpeggiator.
 *
 * Anders als die Insert-Kette (inserts.js, verändert das Audiosignal) sitzt
 * diese Kette VOR den maschinen-eigenen Reglern (s. machine.js#render()) und
 * steuert stattdessen PARAMETER (LFO) oder NOTEN (Arpeggiator) -- deshalb
 * ein eigenes, kleineres Geschwistermodul statt eine Erweiterung von
 * inserts.js. Ein Modulator braucht (anders als ein Insert) Zugriff auf
 * seine Maschine (`owner`), nicht nur auf den AudioContext:
 *   - LFO schreibt über automation.js auf einen der automatisierbaren
 *     Knobs der Maschine (owner.laneKeyPrefix + Zielname).
 *   - Arpeggiator ruft owner.noteOn(midi)/owner.noteOff(midi) direkt auf --
 *     dieselben Methoden, die sonst das Keybed aufruft (s. subsynth.js/
 *     polysynth.js/fmsynth.js, die bei aktivem Arp ihr Keybed stattdessen
 *     hierher umleiten).
 *
 * createModulator(type, saved, owner) baut EIN Objekt, das Daten (params,
 * bypassed, serialize) UND Verhalten (Ticker/Notenlogik) vereint -- gleiches
 * Muster wie inserts.js#createInsert, nur mit `owner` statt `ctx`.
 */
import { engine } from './audio-engine.js';
import { transport } from './transport.js';
import { automation } from './automation.js';
import { DELAY_SYNC_DIVISIONS } from './inserts.js';

const TICK_MS = 30;

/** Modulierte Waveforms (0..1, unipolar -- LFO-Tiefe skaliert davon
 *  ausgehend den tatsächlich bestrichenen Reglerbereich, s. paramValueAt). */
function waveValue(wave, phase, sh) {
  if (wave === 'triangle') return phase < 0.5 ? phase * 2 : (1 - phase) * 2;
  if (wave === 'square') return phase < 0.5 ? 0 : 1;
  if (wave === 'random') return sh.value;
  return (1 - Math.cos(phase * Math.PI * 2)) / 2; // sine
}

/** Reglerwert für einen 0..1-Fortschritt -- respektiert die log-Kurve
 *  mancher Knobs (Cutoff, Zeiten, …) genau wie automation.js' Trim-Modus
 *  (s. dort, gleiche Idee: curve="log" heisst multiplikativ statt additiv
 *  interpolieren, sonst verbringt eine LFO-Fahrt fast ihre ganze Zeit im
 *  oberen Bereich eines log-Reglers). */
function paramValueAt(knob, t01) {
  const lo = Number(knob.min), hi = Number(knob.max);
  if (knob.getAttribute('curve') === 'log' && lo > 0) return lo * (hi / lo) ** t01;
  return lo + t01 * (hi - lo);
}

export const LFO_WAVES = [
  { value: 'sine', label: 'Sine' },
  { value: 'triangle', label: 'Triangle' },
  { value: 'square', label: 'Square' },
  { value: 'random', label: 'Random' },
];

/** Tempo-Sync-Buttons für den LFO -- 'free' schaltet auf den Rate-Knob
 *  (Hz) um, alle anderen Werte sind Takt-Bruchteile/-Vielfache und werden
 *  direkt an transport.phaseOver() durchgereicht (0..1 Phase pro Zyklus,
 *  braucht anders als der Filter Delay keine Sekunden-Umrechnung). Reicht
 *  bewusst von schnell (Vibrato-Tempo) bis langsam (mehrtaktige Sweeps) --
 *  ein LFO wird typischerweise langsamer eingesetzt als ein Delay. */
export const LFO_SYNC_BUTTONS = [
  { value: 'free', label: 'Free' },
  { value: '0.0625', label: '1/16' },
  { value: '0.125', label: '1/8' },
  { value: '0.25', label: '1/4' },
  { value: '0.5', label: '1/2' },
  { value: '1', label: '1 Bar' },
  { value: '2', label: '2 Bars' },
  { value: '4', label: '4 Bars' },
  { value: '8', label: '8 Bars' },
];

export const ARP_MODES = [
  { value: 'up', label: 'Up' },
  { value: 'down', label: 'Down' },
  { value: 'updown', label: 'Up-Down' },
  { value: 'random', label: 'Random' },
];

/** Tempo-Sync-Buttons des Arpeggiators -- dieselben Notenwerte/Faktoren wie
 *  der Filter Delay (DELAY_SYNC_DIVISIONS, relativ zu einer Viertelnote),
 *  bewusst OHNE 'free': ein Arp ohne Songtempo-Bezug ergibt musikalisch
 *  keinen Sinn (anders als ein LFO, der auch als freie Hz-Modulation
 *  Sinn ergibt, z. B. Vibrato unabhängig vom Sequencer-Tempo). */
export const ARP_SYNC_BUTTONS = [
  { value: '1/16', label: '1/16' },
  { value: '1/8t', label: '1/8t' },
  { value: '1/8', label: '1/8' },
  { value: '1/8d', label: '1/8.' },
  { value: '1/4t', label: '1/4t' },
  { value: '1/4', label: '1/4' },
  { value: '1/4d', label: '1/4.' },
  { value: '1/2', label: '1/2' },
];

const MOD_DEFS = {
  lfo: {
    name: 'LFO',
    defaults: { target: '', wave: 'sine', division: '1', rateHz: 2, depth: 1 },
    build(owner, p) {
      let timer = null;
      let phaseAcc = 0;
      let lastT = engine.now;
      let lastPhase = 0;
      const sh = { value: Math.random() };
      let trackedTarget = p.target;
      let bypassedFlag = false;

      const muteKey = (target) => (target ? `${owner.laneKeyPrefix}:${target}` : null);
      const setMute = (target, active) => {
        const k = muteKey(target);
        if (k) automation.setLfoActive(k, active);
      };

      const tick = () => {
        const k = muteKey(p.target);
        if (!k) return;
        const target = automation.getTarget(k);
        if (!target) return;

        let phase;
        if (p.division === 'free') {
          const now = engine.now;
          phaseAcc = (phaseAcc + (now - lastT) * p.rateHz) % 1;
          lastT = now;
          phase = phaseAcc;
        } else {
          phase = transport.phaseOver(Number(p.division));
        }
        if (p.wave === 'random' && phase < lastPhase) sh.value = Math.random();
        lastPhase = phase;

        const t01 = waveValue(p.wave, phase, sh) * Math.min(1, Math.max(0, p.depth));
        target.apply(paramValueAt(target.knob, t01));
      };

      return {
        onParam(key) {
          if (key === 'target') {
            setMute(trackedTarget, false);
            trackedTarget = p.target;
            if (!bypassedFlag) setMute(trackedTarget, true);
          }
        },
        onBypass(v) {
          bypassedFlag = v;
          if (v) { clearInterval(timer); timer = null; setMute(trackedTarget, false); }
          else { setMute(trackedTarget, true); if (!timer) timer = setInterval(tick, TICK_MS); }
        },
        dispose() {
          clearInterval(timer);
          setMute(trackedTarget, false);
        },
      };
    },
  },

  arp: {
    name: 'Arpeggiator',
    defaults: { mode: 'up', octaves: 1, division: '1/16' },
    build(owner, p) {
      let held = [];
      let stepTimer = null;
      let stepIdx = 0;
      let sounding = null;
      let bypassedFlag = false;

      const sequence = () => {
        if (!held.length) return [];
        const base = [...held].sort((a, b) => a - b);
        const stack = [];
        for (let o = 0; o < p.octaves; o++) for (const n of base) stack.push(n + o * 12);
        if (p.mode === 'down') return stack.reverse();
        if (p.mode === 'updown' && stack.length > 2) return stack.concat(stack.slice(1, -1).reverse());
        return stack;
      };

      const stepMs = () => transport.stepDuration * 4 * (DELAY_SYNC_DIVISIONS[p.division] ?? 0.25) * 1000;

      const advance = () => {
        if (sounding != null) { owner.noteOff(sounding); sounding = null; }
        const seq = sequence();
        if (!seq.length) return;
        sounding = p.mode === 'random' ? seq[Math.floor(Math.random() * seq.length)] : seq[stepIdx++ % seq.length];
        owner.noteOn(sounding);
      };

      const restart = () => {
        clearInterval(stepTimer);
        stepTimer = setInterval(advance, stepMs());
      };
      const stop = () => {
        clearInterval(stepTimer);
        stepTimer = null;
        if (sounding != null) { owner.noteOff(sounding); sounding = null; }
        stepIdx = 0;
      };

      return {
        // Vom Keybed der 3 Maschinen mit gehaltenen Stimmen aufgerufen
        // (s. subsynth.js/polysynth.js/fmsynth.js), solange dieser Arp
        // aktiv (nicht bypassed) ist -- ersetzt für diese Noten direkt
        // owner.noteOn/noteOff.
        noteOn(midi) {
          if (!held.includes(midi)) held.push(midi);
          if (!bypassedFlag && !stepTimer) { restart(); advance(); }
        },
        noteOff(midi) {
          held = held.filter((m) => m !== midi);
          if (!held.length) stop();
        },
        onParam(key) {
          if (key === 'division' && stepTimer) restart();
        },
        onBypass(v) {
          bypassedFlag = v;
          if (v) stop();
          else if (held.length) { restart(); advance(); }
        },
        dispose() { stop(); },
      };
    },
  },
};

export const MODULATOR_TYPES = Object.keys(MOD_DEFS);

export const MOD_DISPLAY = {
  lfo: { name: 'LFO', badge: 'MOD-LFO' },
  arp: { name: 'Arpeggiator', badge: 'MOD-ARP' },
};

export const MOD_COLORS = {
  lfo: '#c98fe0',
  arp: '#e0a24a',
};

let nextModId = 1;

/**
 * Baut einen Modulator. `saved` (optional) = { id, params, bypassed } aus
 * einem gespeicherten Projekt. `owner` ist die Maschine, auf der er sitzt
 * (Automations-Präfix bzw. Noten-Ziel, s. Dateikopf-Kommentar).
 */
export function createModulator(type, saved, owner) {
  const def = MOD_DEFS[type];
  if (!def) throw new Error(`Unbekannter Modulator-Typ: ${type}`);
  const params = structuredClone({ ...def.defaults, ...saved?.params });
  const id = saved?.id ?? nextModId++;
  if (saved?.id != null) nextModId = Math.max(nextModId, saved.id + 1);

  const runtime = def.build(owner, params);
  const mod = {
    id,
    type,
    name: def.name,
    params,
    bypassed: saved?.bypassed ?? false,
    setParam(key, v) {
      params[key] = v;
      runtime.onParam?.(key, v);
    },
    setBypass(v) {
      mod.bypassed = v;
      runtime.onBypass?.(v);
    },
    serialize() {
      return { id, type, params: { ...params }, bypassed: mod.bypassed };
    },
    dispose() {
      runtime.dispose?.();
    },
    // Nur vom Arpeggiator belegt -- s. subsynth.js/polysynth.js/fmsynth.js
    noteOn: runtime.noteOn,
    noteOff: runtime.noteOff,
  };
  runtime.onBypass?.(mod.bypassed);
  return mod;
}
