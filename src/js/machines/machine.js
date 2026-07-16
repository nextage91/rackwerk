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

    /** Post-Fader-Sends zu den Master-Effekten — hinter dem Gate,
     *  damit Mute/Solo die Effekt-Fahnen mitnimmt. */
    this.sends = { delay: 0, reverb: 0 };
    this.sendDelay = engine.ctx.createGain();
    this.sendDelay.gain.value = 0;
    this.sendReverb = engine.ctx.createGain();
    this.sendReverb.gain.value = 0;
    this.gate.connect(this.sendDelay);
    this.sendDelay.connect(engine.delayBus);
    this.gate.connect(this.sendReverb);
    this.sendReverb.connect(engine.reverbBus);

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
  /** Wert für einen Knob (data-p) — Basis: Sends, sonst aus this.params. */
  getParamForKnob(key) {
    if (key === 'sendDelay') return this.sends.delay;
    if (key === 'sendReverb') return this.sends.reverb;
    return this.params?.[key];
  }

  /* ---------- Master-FX-Sends ---------- */
  setSend(which, value) {
    this.sends[which] = value;
    const node = which === 'delay' ? this.sendDelay : this.sendReverb;
    node.gain.setTargetAtTime(value, engine.now, 0.01);
  }

  /** Beim Projekt-Laden: Werte setzen UND Knob-Stellungen nachziehen
   *  (das Laden passiert nach render, der Sync-Lauf dort ist schon durch). */
  setSends({ delay = 0, reverb = 0 } = {}) {
    this.setSend('delay', delay);
    this.setSend('reverb', reverb);
    const dk = this.el?.querySelector('x-knob[data-p="sendDelay"]');
    const rk = this.el?.querySelector('x-knob[data-p="sendReverb"]');
    if (dk) dk.value = delay;
    if (rk) rk.value = reverb;
  }

  /* ---------- Faceplate ---------- */
  render() {
    const { name, type, color, model = 'RW-00' } = this.constructor.meta;

    const el = document.createElement('section');
    el.className = 'machine';
    // Farbvarianten hier berechnen statt per CSS color-mix() —
    // funktioniert damit auch in älteren WebViews zuverlässig
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
    el.style.setProperty('--m-color', color);
    el.style.setProperty('--m-color-dim', `rgba(${r},${g},${b},.22)`);
    el.style.setProperty('--m-color-glow', `rgba(${r},${g},${b},.45)`);
    el.style.setProperty('--m-color-tint', `rgba(${r},${g},${b},.08)`);
    el.innerHTML = `
      <header class="machine__head">
        <span class="machine__stripe"></span>
        <div>
          <div class="machine__name">${name}</div>
          <div class="machine__type">${model} · #${this.id}<span class="machine__led" data-led></span></div>
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

    // Send-Regler zu den Master-Effekten — einheitlich unter jeder Maschine
    const sendsRow = document.createElement('div');
    sendsRow.className = 'machine__row machine__row--sends';
    sendsRow.innerHTML = `
      <span class="sends__label">FX</span>
      <x-knob label="Delay" min="0" max="1" value="0" data-p="sendDelay" data-auto></x-knob>
      <x-knob label="Reverb" min="0" max="1" value="0" data-p="sendReverb" data-auto></x-knob>
    `;
    sendsRow.addEventListener('input', (e) => {
      const key = e.target.dataset?.p;
      if (key === 'sendDelay') this.setSend('delay', e.detail.value);
      else if (key === 'sendReverb') this.setSend('reverb', e.detail.value);
    });
    el.querySelector('.machine__body').appendChild(sendsRow);

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
    this.ledEl = el.querySelector('[data-led]');
    return el;
  }

  #ledTimer;

  /**
   * Aktivitäts-LED kurz aufblitzen lassen — Maschinen rufen das bei jedem
   * Trigger. `time` ist die geplante Audio-Zeit, damit die LED synchron
   * zum hörbaren Klang blinkt (nicht zum Planungs-Zeitpunkt).
   */
  pulse(time = 0) {
    if (!this.ledEl) return;
    const delay = Math.max(0, (time - engine.now) * 1000);
    setTimeout(() => {
      this.ledEl.classList.add('is-on');
      clearTimeout(this.#ledTimer);
      this.#ledTimer = setTimeout(() => this.ledEl.classList.remove('is-on'), 90);
    }, delay);
  }

  /**
   * Live-Aufnahme ins Step-Pattern: Sind REC scharf und der Transport am
   * Laufen, während live gespielt wird (Keybed-Note, Drum-Pad), schreiben
   * Unterklassen den Treffer direkt in den aktuell aktiven Pattern-Slot.
   * Dieselbe REC-Taste löst sonst die Regler-Automation aus — ein Knopf
   * für beides, wie bei klassischen Grooveboxen ("Step-Rec").
   *
   * `liveStepIndex(length)` liefert den Ziel-Step (auf den nächsten 16tel
   * gerundet, über den absoluten Transport-Step — bleibt so auch bei
   * polymetrischen Patterns unterschiedlicher Länge konsistent zum
   * Sequenzer-Playback, das genauso `step % length` rechnet).
   */
  get isLiveRecording() {
    return automation.armed && transport.isPlaying;
  }
  liveStepIndex(length) {
    return transport.currentStep % length;
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
    setTimeout(() => {
      this.output.disconnect();
      this.gate.disconnect();
      this.sendDelay.disconnect();
      this.sendReverb.disconnect();
    }, 120);
    this.el?.remove();
  }
}
