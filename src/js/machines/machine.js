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
import { createInsert, INSERT_TYPES, insertMeta, UI_PARAMS, EQ_TYPES } from '../core/inserts.js';
import { masterFX } from '../core/fx.js';

let nextId = 1;

/** Alle lebenden Maschinen — für die Solo-Koordination über das ganze Rack. */
const machines = new Set();

/** Eine einzige, wiederverwendete Sheet-Instanz für "+ Insert Effect" —
 *  jede Maschine bräuchte sonst ihr eigenes Picker-Markup, dabei kann
 *  ohnehin nie mehr als eines gleichzeitig offen sein (modal). */
let insertPickerEl = null;
function openInsertPicker(onPick) {
  if (!insertPickerEl) {
    insertPickerEl = document.createElement('div');
    insertPickerEl.className = 'sheet sheet--insert-picker';
    insertPickerEl.hidden = true;
    insertPickerEl.innerHTML = `
      <div class="sheet__backdrop" data-close></div>
      <div class="sheet__panel" role="dialog" aria-label="Insert effect">
        <div class="sheet__grip"></div>
        <h2 class="sheet__title">Insert Effect</h2>
        <div class="sheet__list">
          ${INSERT_TYPES.map((type) => `
            <button type="button" class="sheet__item" data-type="${type}">
              <span class="sheet__name">${insertMeta(type).name}</span>
            </button>
          `).join('')}
        </div>
      </div>
    `;
    document.body.appendChild(insertPickerEl);
    insertPickerEl.querySelector('[data-close]').addEventListener('click', () => {
      insertPickerEl.hidden = true;
    });
    insertPickerEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-type]');
      if (!btn) return;
      insertPickerEl.hidden = true;
      insertPickerEl._onPick?.(btn.dataset.type);
    });
  }
  insertPickerEl._onPick = onPick;
  insertPickerEl.hidden = false;
}

/**
 * Öffnet/schließt die Gates aller Maschinen: Ist irgendeine Maschine solo,
 * sind alle nicht-solo Maschinen stumm. Mute gewinnt immer.
 *
 * Schließt zusätzlich die gemeinsame Master-FX-Rückführung (masterFX.
 * setReturnAudible), sobald KEINE Maschine mehr hörbar ist — sonst bliebe
 * ein bereits angeregter Delay-/Reverb-Schwanz weiterspielen, obwohl schon
 * alles gemutet (bzw. nichts soloed) ist ("solo in place").
 */
function refreshGates() {
  const soloActive = [...machines].some((m) => m.soloed);
  const t = engine.now;
  let anyAudible = false;
  for (const m of machines) {
    const open = !m.muted && (!soloActive || m.soloed);
    if (open) anyAudible = true;
    m.gate.gain.cancelScheduledValues(t);
    m.gate.gain.setTargetAtTime(open ? 1 : 0, t, 0.015);
  }
  masterFX.setReturnAudible(anyAudible);
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
    /** @type {StereoPannerNode} Panorama — sitzt direkt hinterm Fader, wie
     *  am echten Kanalzug. Die Sends (Delay/Reverb) hängen hinter dem Gate,
     *  tragen die Stereo-Position also mit. */
    this.pan = 0;
    this.panner = engine.ctx.createStereoPanner();
    /** @type {GainNode} Mute/Solo-Gate — getrennt vom Volume, damit
     *  Entmuten nicht die Reglerstellung überschreibt. */
    this.gate = engine.ctx.createGain();
    this.panner.connect(this.gate);
    this.gate.connect(engine.masterBus);

    /** @type {Array<ReturnType<typeof createInsert>>} Insert-FX-Kette
     *  zwischen Output und Panner — frei bestückbar (0..n Instanzen,
     *  beliebige Reihenfolge). Leer verbindet #rewireInsertChain()
     *  Output direkt an den Panner. */
    this.inserts = [];
    this.#rewireInsertChain();

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

  /* ---------- Mixer: Pegel & Panorama ---------- */

  /**
   * Pegel (0..1) — Basis liest/schreibt `this.params.volume`, passend für
   * SubSynth/PercSynth. BeatBox überschreibt (führt die Lautstärke separat
   * als `this.volume`). Sowohl der eigene Volume-Knob im Maschinen-Body als
   * auch der Mixer greifen auf DIESELBE Methode zu — eine Quelle der
   * Wahrheit, kein zweiter, widersprüchlicher Pegel-Regler.
   */
  get level() { return this.params?.volume ?? 1; }
  setLevel(v) {
    v = Math.min(1, Math.max(0, v));
    if (this.params) this.params.volume = v;
    this.output.gain.setTargetAtTime(v, engine.now, 0.01);
    const knob = this.el?.querySelector('x-knob[data-p="volume"]');
    if (knob) knob.value = v;
  }

  /** Panorama (-1..1). Neu, ohne Legacy-Regler — nur der Mixer zeigt ihn. */
  setPan(v) {
    this.pan = Math.min(1, Math.max(-1, v));
    this.panner.pan.setTargetAtTime(this.pan, engine.now, 0.01);
  }

  /** @type {AnalyserNode|null} */
  #meterAnalyser = null;
  /**
   * Analyser für das Kanalzug-VU-Meter im Mixer — hinter dem Mute/Solo-Gate
   * abgegriffen, zeigt also genau das, was hörbar ist (still bei Mute).
   * Lazy angelegt: kostet nichts, solange kein Mixer-Kanalzug ihn abfragt.
   */
  getMeterAnalyser() {
    if (!this.#meterAnalyser) {
      this.#meterAnalyser = engine.ctx.createAnalyser();
      this.#meterAnalyser.fftSize = 512;
      this.gate.connect(this.#meterAnalyser);
    }
    return this.#meterAnalyser;
  }

  /* ---------- Master-FX-Sends ---------- */
  setSend(which, value) {
    this.sends[which] = value;
    const node = which === 'delay' ? this.sendDelay : this.sendReverb;
    node.gain.setTargetAtTime(value, engine.now, 0.01);
    // Panel-Knob synchron halten — eine Quelle der Wahrheit, egal ob der
    // Mixer oder das eigene Maschinen-Panel gerade gezogen wird.
    const paramKey = which === 'delay' ? 'sendDelay' : 'sendReverb';
    const knob = this.el?.querySelector(`x-knob[data-p="${paramKey}"]`);
    if (knob) knob.value = value;
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

  /* ---------- Insert-FX ---------- */

  /** Verbindet Output -> insert[0] -> insert[1] -> ... -> Panner neu.
   *  output/insert-outputs haben immer nur EIN Ziel, disconnect() ohne
   *  Argument trennt also genau die eine bestehende Verbindung. */
  #rewireInsertChain() {
    this.output.disconnect();
    for (const insert of this.inserts) insert.output.disconnect();
    let prev = this.output;
    for (const insert of this.inserts) {
      prev.connect(insert.input);
      prev = insert.output;
    }
    prev.connect(this.panner);
  }

  addInsert(type) {
    const insert = createInsert(type);
    this.inserts.push(insert);
    this.#rewireInsertChain();
    this.#renderInserts();
    return insert;
  }

  removeInsert(id) {
    const idx = this.inserts.findIndex((i) => i.id === id);
    if (idx === -1) return;
    const [insert] = this.inserts.splice(idx, 1);
    this.#rewireInsertChain();
    insert.dispose();
    this.#renderInserts();
  }

  moveInsert(id, dir) {
    const idx = this.inserts.findIndex((i) => i.id === id);
    if (idx === -1) return;
    const j = idx + dir;
    if (j < 0 || j >= this.inserts.length) return;
    [this.inserts[idx], this.inserts[j]] = [this.inserts[j], this.inserts[idx]];
    this.#rewireInsertChain();
    this.#renderInserts();
  }

  setInsertBypass(id, bypassed) {
    this.inserts.find((i) => i.id === id)?.setBypass(bypassed);
  }

  setInsertParam(id, key, value) {
    this.inserts.find((i) => i.id === id)?.setParam(key, value);
  }

  /** Für project.js — analog zu `sends`, als Sibling-Feld serialisiert,
   *  nicht Teil der Unterklassen-eigenen serialize()/deserialize(). */
  serializeInserts() {
    return this.inserts.map((i) => i.serialize());
  }

  deserializeInserts(list) {
    for (const insert of this.inserts) insert.dispose();
    this.inserts = (list ?? []).map((saved) => createInsert(saved.type, saved));
    this.#rewireInsertChain();
    this.#renderInserts();
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
        <div class="machine__title" data-collapse-toggle>
          <span class="machine__chevron" aria-hidden="true">▾</span>
          <span>
            <div class="machine__name">${name}</div>
            <div class="machine__type">${model} · #${this.id}<span class="machine__led" data-led></span></div>
          </span>
        </div>
        <div class="machine__head-actions">
          <button class="m-btn m-btn--solo" data-solo>SOLO</button>
          <button class="m-btn m-btn--mute" data-mute>MUTE</button>
          <button class="m-btn m-btn--remove" data-remove aria-label="Hold to remove machine">✕</button>
        </div>
      </header>
      <div class="machine__body"></div>
    `;

    // Panel einklappen (nur Header sichtbar) — reduziert Scroll-Distanz bei
    // mehreren Maschinen im Rack. Rein visuell, kein Datenzustand, deshalb
    // bewusst nicht in serialize()/deserialize() (wie das Mixer-Pendant
    // .mixer-group__toggle, das ebenfalls nicht persistiert wird).
    el.querySelector('[data-collapse-toggle]').addEventListener('click', () => {
      el.classList.toggle('is-collapsed');
    });

    this.headMuteBtn = el.querySelector('[data-mute]');
    this.headSoloBtn = el.querySelector('[data-solo]');
    this.headMuteBtn.addEventListener('click', () => this.setMuted(!this.muted));
    this.headSoloBtn.addEventListener('click', () => this.setSoloed(!this.soloed));

    // Löschen erst nach kurzem Halten (nicht bei einzelnem Tap) — verse-
    // hentliches Löschen war der Auslöser für den Undo-Button; ein Hold
    // mit sichtbarem Füllfortschritt verhindert das schon an der Wurzel.
    const removeBtn = el.querySelector('[data-remove]');
    const REMOVE_HOLD_MS = 550;
    let removeTimer = null;
    const cancelRemoveHold = () => {
      clearTimeout(removeTimer);
      removeTimer = null;
      removeBtn.classList.remove('is-holding');
    };
    removeBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      removeBtn.classList.add('is-holding');
      removeTimer = setTimeout(() => {
        removeTimer = null;
        removeBtn.classList.remove('is-holding');
        const state = this.serialize(); // vor dispose() sichern — für Undo
        // Event VOR dispose() feuern: dispose() hängt el aus dem DOM aus,
        // ein bubbling Event auf einem bereits entfernten Knoten erreicht
        // keine Vorfahren mehr (also auch nicht Racks Listener).
        el.dispatchEvent(new CustomEvent('machine:removed', {
          detail: { machine: this, state },
          bubbles: true,
        }));
        this.dispose();
      }, REMOVE_HOLD_MS);
    });
    removeBtn.addEventListener('pointerup', cancelRemoveHold);
    removeBtn.addEventListener('pointerleave', cancelRemoveHold);
    removeBtn.addEventListener('pointercancel', cancelRemoveHold);

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

    // Insert-FX — frei bestückbare Effektkette zwischen Output und Panner,
    // gilt automatisch für jede Maschine (generisch in der Basisklasse).
    const insertsSection = document.createElement('div');
    insertsSection.className = 'machine__row machine__row--inserts';
    insertsSection.innerHTML = `
      <div class="inserts" data-inserts></div>
      <button type="button" class="m-btn inserts__add" data-add-insert>+ Insert Effect</button>
    `;
    insertsSection.querySelector('[data-add-insert]').addEventListener('click', () => {
      openInsertPicker((type) => {
        this.addInsert(type);
      });
    });
    el.querySelector('.machine__body').appendChild(insertsSection);
    this.insertsListEl = insertsSection.querySelector('[data-inserts]');
    this.#renderInserts();

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

  /** Baut die komplette Insert-Liste neu aus this.inserts — einfacher als
   *  gezieltes DOM-Patchen und unkritisch, weil nur bei add/remove/move/
   *  bypass aufgerufen wird (Knob-Ziehen selbst löst KEIN Re-Render aus,
   *  bleibt also während des Drags ungestört). */
  #renderInserts() {
    if (!this.insertsListEl) return;
    this.insertsListEl.innerHTML = this.inserts.map((insert, idx) => {
      const paramDefs = UI_PARAMS[insert.type] ?? [];
      const knobsHtml = paramDefs.map((def) => `
        <x-knob label="${def.label}" min="${def.min}" max="${def.max}"
          value="${insert.params[def.key]}"
          ${def.curve ? `curve="${def.curve}"` : ''}
          ${def.unit ? `unit="${def.unit}"` : ''}
          data-insert-id="${insert.id}" data-insert-param="${def.key}"></x-knob>
      `).join('');
      const eqTypeHtml = insert.type === 'eq' ? `
        <div class="seg">
          ${EQ_TYPES.map((t) => `
            <button type="button" class="seg__btn${insert.params.type === t.value ? ' is-active' : ''}" data-eq-type="${t.value}">${t.label}</button>
          `).join('')}
        </div>
      ` : '';
      return `
        <div class="insert-row${insert.bypassed ? ' is-bypassed' : ''}" data-insert-id="${insert.id}">
          <div class="insert-row__head">
            <span class="insert-row__name">${insert.name}</span>
            <div class="insert-row__actions">
              <button type="button" class="m-btn insert-row__move" data-move="-1" aria-label="Move up" ${idx === 0 ? 'disabled' : ''}>▲</button>
              <button type="button" class="m-btn insert-row__move" data-move="1" aria-label="Move down" ${idx === this.inserts.length - 1 ? 'disabled' : ''}>▼</button>
              <button type="button" class="m-btn insert-row__bypass${insert.bypassed ? ' is-active' : ''}" data-bypass>BYP</button>
              <button type="button" class="m-btn insert-row__remove" data-remove aria-label="Remove insert">✕</button>
            </div>
          </div>
          ${eqTypeHtml}
          <div class="insert-row__params">${knobsHtml}</div>
        </div>
      `;
    }).join('');

    for (const row of this.insertsListEl.querySelectorAll('.insert-row')) {
      const id = parseInt(row.dataset.insertId, 10);
      row.querySelector('[data-move="-1"]')?.addEventListener('click', () => this.moveInsert(id, -1));
      row.querySelector('[data-move="1"]')?.addEventListener('click', () => this.moveInsert(id, 1));
      row.querySelector('[data-bypass]').addEventListener('click', () => {
        const insert = this.inserts.find((i) => i.id === id);
        this.setInsertBypass(id, !insert.bypassed);
        this.#renderInserts();
      });
      row.querySelector('[data-remove]').addEventListener('click', () => this.removeInsert(id));
      for (const knob of row.querySelectorAll('x-knob[data-insert-param]')) {
        knob.addEventListener('input', (e) => {
          this.setInsertParam(id, knob.dataset.insertParam, e.detail.value);
        });
      }
      for (const btn of row.querySelectorAll('[data-eq-type]')) {
        btn.addEventListener('click', () => {
          this.setInsertParam(id, 'type', btn.dataset.eqType);
          this.#renderInserts();
        });
      }
    }
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
    this.headMuteBtn?.classList.toggle('is-active', muted);
    this.onMixerChange?.(); // Mixer-Sheet hält seine Buttons synchron, falls offen
    refreshGates();
  }

  setSoloed(soloed) {
    this.soloed = soloed;
    this.headSoloBtn?.classList.toggle('is-active', soloed);
    this.onMixerChange?.();
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
      this.panner.disconnect();
      this.gate.disconnect();
      this.sendDelay.disconnect();
      this.sendReverb.disconnect();
      this.#meterAnalyser?.disconnect();
      for (const insert of this.inserts) insert.dispose();
    }, 120);
    this.el?.remove();
  }
}
