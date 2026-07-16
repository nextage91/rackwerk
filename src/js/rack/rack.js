/**
 * Rack — verwaltet die Maschinen-Slots.
 *
 * - Registry: alle verfügbaren Maschinentypen (neue Maschinen hier eintragen)
 * - Rendert die Slot-Liste + den »Maschine hinzufügen«-Slot
 * - Bottom-Sheet als touch-freundlicher Picker
 */
import { SubSynth } from '../machines/subsynth.js';
import { BeatBox } from '../machines/beatbox.js';
import { PercSynth } from '../machines/percsynth.js';
import { PolySynth } from '../machines/polysynth.js';

/** Neue Maschinentypen einfach hier registrieren. */
export const REGISTRY = [SubSynth, BeatBox, PercSynth, PolySynth];

export class Rack {
  /**
   * @param {HTMLElement} rackEl   Container für die Slots
   * @param {HTMLElement} sheetEl  Bottom-Sheet-Element
   */
  constructor(rackEl, sheetEl) {
    this.rackEl = rackEl;
    this.sheetEl = sheetEl;
    /** @type {import('../machines/machine.js').Machine[]} */
    this.machines = [];

    this.#buildAddSlot();
    this.#buildSheet();

    // Maschinen melden ihr Entfernen selbst (Event aus machine.js)
    this.rackEl.addEventListener('machine:removed', (e) => {
      this.machines = this.machines.filter((m) => m !== e.detail.machine);
    });
  }

  /** Alle Maschinen entfernen (z. B. vor dem Laden eines Projekts). */
  clear() {
    for (const m of [...this.machines]) m.dispose();
    this.machines = [];
  }

  addMachine(MachineClass, state = null) {
    const machine = new MachineClass();
    if (state) machine.deserialize(state);
    this.machines.push(machine);
    this.rackEl.insertBefore(machine.render(), this.addSlotEl);
    // neue Maschine ins Bild scrollen
    machine.el.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
    return machine;
  }

  /* ---------- »+«-Slot ---------- */
  #buildAddSlot() {
    const btn = document.createElement('button');
    btn.className = 'rack__add';
    btn.textContent = '+  Add Machine';
    btn.addEventListener('click', () => this.#openSheet());
    this.rackEl.appendChild(btn);
    this.addSlotEl = btn;
  }

  /* ---------- Bottom Sheet ---------- */
  #buildSheet() {
    const list = this.sheetEl.querySelector('#machine-list');

    for (const MachineClass of REGISTRY) {
      const { name, desc, color } = MachineClass.meta;
      const item = document.createElement('button');
      item.className = 'sheet__item';
      item.innerHTML = `
        <span class="sheet__swatch" style="background:${color}"></span>
        <span>
          <div class="sheet__name">${name}</div>
          <div class="sheet__desc">${desc}</div>
        </span>
      `;
      item.addEventListener('click', () => {
        this.addMachine(MachineClass);
        this.#closeSheet();
      });
      list.appendChild(item);
    }

    this.sheetEl.querySelector('[data-close]')
      .addEventListener('click', () => this.#closeSheet());
  }

  #openSheet()  { this.sheetEl.hidden = false; }
  #closeSheet() { this.sheetEl.hidden = true; }
}
