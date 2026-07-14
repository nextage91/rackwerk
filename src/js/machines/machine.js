/**
 * Machine — Basisklasse für alle Rack-Maschinen.
 *
 * Vertrag für Unterklassen:
 *   static meta = { type, name, desc, color }   → für Registry & Faceplate
 *   buildAudio()   → eigenen Audiographen bauen und an this.output hängen
 *   buildControls(container) → Bedienelemente in den Body rendern
 *   onStep(step, time)       → optional, vom Transport aufgerufen
 *   disposeAudio() → optional, eigene Nodes aufräumen
 *
 * Die Basisklasse übernimmt: Output-Gain + Mute, Faceplate-DOM
 * (Kopfzeile mit Farbstreifen, Mute, Entfernen) und Lifecycle.
 */
import { engine } from '../core/audio-engine.js';
import { transport } from '../core/transport.js';
import { automation } from '../core/automation.js';

let nextId = 1;

/** Alle lebenden Maschinen — für die Solo-Koordination über das ganze Rack. */
const machines = new Set();

/**
 * Öffnet/schließt die Gates aller Maschinen: Ist irgendeine Maschine solo,
 * sind alle nicht-solo Maschinen stumm. Mute gewinnt immer.
 */
function refreshGates() {
  const soloActive = [...machines].some((m) => m.soloed);
  const t = engine.now;
  for (const m of machines) {
    const open = !m.muted && (!soloActive || m.soloed);
    m.gate.gain.cancelScheduledValues(t);
    m.gate.gain.setTargetAtTime(open ? 1 : 0, t, 0.015);
  }
}

export class Machine {
  static meta = { type: 'machine', name: 'Machine', desc: '', color: '#888' };

  constructor() {
    this.id = nextId++;
    this.muted = false;
    this.soloed = false;

    /** @type {GainNode} Alles, was die Maschine erzeugt, läuft hier durch
     *  (Volume-Regler schreiben hierauf). */
    this.output = engine.ctx.createGain();
    /** @type {GainNode} Mute/Solo-Gate — getrennt vom Volume, damit
     *  Entmuten nicht die Reglerstellung überschreibt. */
    this.gate = engine.ctx.createGain();
    this.output.connect(this.gate);
    this.gate.connect(engine.masterBus);
    machines.add(this);

    /** @type {HTMLElement|null} */
    this.el = null;

    this.buildAudio();
    transport.addListener(this);
  }

  /* ---------- Von Unterklassen zu implementieren ---------- */
  buildAudio() {}
  buildControls(_container) {}
  disposeAudio() {}
  serialize() { return {}; }
  deserialize(_state) {}
  /** Wert für einen Knob (data-p) — Basis: aus this.params. */
  getParamForKnob(key) { return this.params?.[key]; }

  /* ---------- Faceplate ---------- */
  render() {
    const { name, type, color } = this.constructor.meta;

    const el = document.createElement('section');
    el.className = 'machine';
    // Farbvarianten hier berechnen statt per CSS color-mix() —
    // funktioniert damit auch in älteren WebViews zuverlässig
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
    el.style.setProperty('--m-color', color);
    el.style.setProperty('--m-color-dim', `rgba(${r},${g},${b},.22)`);
    el.style.setProperty('--m-color-glow', `rgba(${r},${g},${b},.45)`);
    el.innerHTML = `
      <header class="machine__head">
        <span class="machine__stripe"></span>
        <div>
          <div class="machine__name">${name}</div>
          <div class="machine__type">${type} · #${this.id}</div>
        </div>
        <div class="machine__head-actions">
          <button class="m-btn m-btn--solo" data-solo>SOLO</button>
          <button class="m-btn m-btn--mute" data-mute>MUTE</button>
          <button class="m-btn m-btn--remove" data-remove aria-label="Maschine entfernen">✕</button>
        </div>
      </header>
      <div class="machine__body"></div>
    `;

    el.querySelector('[data-mute]').addEventListener('click', (e) => {
      this.setMuted(!this.muted);
      e.currentTarget.classList.toggle('is-active', this.muted);
    });

    el.querySelector('[data-solo]').addEventListener('click', (e) => {
      this.setSoloed(!this.soloed);
      e.currentTarget.classList.toggle('is-active', this.soloed);
    });

    el.querySelector('[data-remove]').addEventListener('click', () => {
      this.dispose();
      el.dispatchEvent(new CustomEvent('machine:removed', {
        detail: { machine: this },
        bubbles: true,
      }));
    });

    this.buildControls(el.querySelector('.machine__body'));

    // Knob-Stellungen mit dem (ggf. geladenen) Zustand synchronisieren —
    // die value-Attribute im Markup sind nur die Werks-Defaults
    for (const knob of el.querySelectorAll('x-knob[data-p]')) {
      const v = this.getParamForKnob(knob.dataset.p);
      if (v !== undefined) knob.value = v;
    }

    // Alle Knobs mit data-auto bei der Automation anmelden. apply() nutzt
    // dieselbe input-Leitung wie eine Handbewegung — Maschinen brauchen
    // für Automation keinen Extra-Code.
    for (const knob of el.querySelectorAll('x-knob[data-auto]')) {
      const key = `${this.id}:${knob.dataset.p}`;
      automation.register(key, knob, (v) => {
        knob.value = v;
        knob.dispatchEvent(new CustomEvent('input', {
          detail: { value: v },
          bubbles: true,
        }));
      });
    }

    this.el = el;
    return el;
  }

  setMuted(muted) {
    this.muted = muted;
    refreshGates();
  }

  setSoloed(soloed) {
    this.soloed = soloed;
    refreshGates();
  }

  /* ---------- Aufräumen ---------- */
  dispose() {
    transport.removeListener(this);
    automation.unregisterMachine(this.id);
    machines.delete(this);
    refreshGates(); // falls die einzige Solo-Maschine entfernt wurde
    this.disposeAudio();
    // Fade-out, dann trennen — vermeidet Klicks beim Entfernen
    const t = engine.now;
    this.gate.gain.setTargetAtTime(0, t, 0.02);
    setTimeout(() => { this.output.disconnect(); this.gate.disconnect(); }, 120);
    this.el?.remove();
  }
}
