/**
 * Rack — verwaltet die Maschinen-Slots.
 *
 * EXPERIMENT (claude/rack-focused-editor-experiment): statt jede Maschine
 * mit voller Bedienoberfläche inline zu stapeln, zeigt das Rack nur noch
 * eine kompakte Zeile pro Maschine (Name, Mute/Solo, Chevron). Antippen
 * öffnet die volle Oberfläche (Header + Body, unverändert von machine.js
 * gebaut) als eigenen Vollbild-Screen — dieselbe Sheet-Mechanik wie beim
 * Mixer, nur pro Maschine statt einmalig. Ziel: weniger Scroll, grössere
 * Regler pro Maschine (nur eine muss aufs Mal passen statt aller gestapelt).
 *
 * - Registry: alle verfügbaren Maschinentypen (neue Maschinen hier eintragen)
 * - Rendert die Kompakt-Liste + den »Maschine hinzufügen«-Slot
 * - Bottom-Sheet als touch-freundlicher Picker
 */
import { SubSynth } from '../machines/subsynth.js';
import { BeatBox } from '../machines/beatbox.js';
import { PercSynth } from '../machines/percsynth.js';
import { PolySynth } from '../machines/polysynth.js';
import { AnalogKit } from '../machines/analogkit.js';
import { Sampler } from '../machines/sampler.js';
import { FMSynth } from '../machines/fmsynth.js';
import { AcidBass } from '../machines/acidbass.js';
import { KickSynth } from '../machines/kicksynth.js';
import { PsySynth } from '../machines/psysynth.js';
import { openRenamePopup } from '../machines/machine.js';
import { undo } from '../core/undo.js';
import { automation } from '../core/automation.js';

/** Neue Maschinentypen einfach hier registrieren. */
export const REGISTRY = [SubSynth, BeatBox, PercSynth, PolySynth, AnalogKit, Sampler, FMSynth, AcidBass, KickSynth, PsySynth];

export class Rack {
  /**
   * @param {HTMLElement} rackEl   Container für die Kompakt-Zeilen
   * @param {HTMLElement} sheetEl  Bottom-Sheet-Element (Maschine hinzufügen)
   */
  constructor(rackEl, sheetEl) {
    this.rackEl = rackEl;
    this.sheetEl = sheetEl;
    /** @type {import('../machines/machine.js').Machine[]} */
    this.machines = [];
    /** @type {Map<import('../machines/machine.js').Machine, {row:HTMLElement, overlay:HTMLElement, panel:HTMLElement, muteBtn:HTMLElement, soloBtn:HTMLElement, moveUpBtn:HTMLElement, moveDownBtn:HTMLElement}>} */
    this.views = new Map();

    this.#buildAddSlot();
    this.#buildSheet();

    // Maschinen melden ihr Entfernen selbst (Event aus machine.js). Die
    // .machine-Elemente hängen jetzt in eigenen .machine-focus-Overlays
    // unter document.body statt inline in rackEl — das Event bubbelt also
    // NICHT mehr durch rackEl. Auf document lauschen, das ist immer ein
    // Vorfahre, egal wo das Overlay hängt.
    document.addEventListener('machine:removed', (e) => {
      const { machine, state } = e.detail;
      const index = this.machines.indexOf(machine);
      this.machines = this.machines.filter((m) => m !== machine);
      if (index === -1) return;

      const view = this.views.get(machine);
      view?.row.remove();
      view?.overlay.remove();
      this.views.delete(machine);
      this.#refreshMoveButtons();

      const MachineClass = machine.constructor;
      undo.offer(`${machine.displayName} removed`, () => {
        const restored = new MachineClass();
        // Vollständiges Bundle wiederherstellen (state/sends/inserts/clips/
        // lanes) -- derselbe Pfad wie project.js#loadProject, damit "Undo"
        // wirklich den kompletten Zustand zurückbringt, nicht nur den
        // Unterklassen-eigenen state (s. machine.js, wo dieses Bundle beim
        // Entfernen geschnürt wird).
        if (state?.state) restored.deserialize(state.state);
        if (state?.sends) restored.setSends(state.sends);
        if (state?.inserts) restored.deserializeInserts(state.inserts);
        if (state?.modulators) restored.deserializeModulators(state.modulators);
        if (state?.clips) restored.deserializeClips(state.clips);
        if (state?.xySpring) restored.xySpring = true;
        if (state?.label) restored.label = state.label;
        this.machines.splice(index, 0, restored);
        this.#mount(restored, this.machines[index + 1] ?? null);
        if (state?.lanes) {
          automation.importLanes(restored.id, state.lanes);
          restored.onLanesImported?.();
        }
        this.#openFocus(restored);
      });
    });
  }

  /** Alle Maschinen entfernen (z. B. vor dem Laden eines Projekts). */
  clear() {
    for (const m of [...this.machines]) m.dispose();
    for (const view of this.views.values()) { view.row.remove(); view.overlay.remove(); }
    this.views.clear();
    this.machines = [];
  }

  /**
   * @param {{focus?: boolean}} [opts] focus: Vollbild-Editor direkt öffnen
   *   (nur beim expliziten Hinzufügen über die Maschinenauswahl sinnvoll —
   *   beim Massen-Wiederherstellen aus einem Projekt NICHT setzen, sonst
   *   flackert für jede geladene Maschine kurz ein Vollbild-Editor auf).
   */
  addMachine(MachineClass, state = null, { focus = false } = {}) {
    const machine = new MachineClass();
    if (state) {
      try {
        machine.deserialize(state);
      } catch (err) {
        // deserialize() ist bei manchen Maschinen erst auf halbem Weg
        // gescheitert (z. B. ungültige Track-Daten aus einer beschädigten
        // Projektdatei) -- der Konstruktor lief aber schon vollständig
        // (buildAudio() hat Nodes an masterBus/delayBus/reverbBus gehängt,
        // als Transport-Listener und in der modulweiten Solo-Koordination
        // von machine.js registriert). OHNE dispose() bliebe dieses Objekt
        // als unsichtbare, aber weiterlaufende Leiche im Audiographen und
        // in den Listener-Listen hängen -- rack.machines enthält es nie
        // (der Push unten wird ja gar nicht erreicht), rack.clear() findet
        // es also auch nie. dispose() räumt genau das auf, dann den
        // Fehler weiterreichen (project.js#loadProject/importMachines
        // fangen ihn pro Maschine ab und protokollieren ihn).
        machine.dispose();
        throw err;
      }
    }
    this.machines.push(machine);
    this.#mount(machine, null); // null = ans Ende der Liste
    if (focus) this.#openFocus(machine);
    return machine;
  }

  /**
   * Baut Kompakt-Zeile + Vollbild-Editor für eine Maschine und hängt beides
   * ein — VOR der Kompakt-Zeile/dem Overlay von `beforeMachine` (null = ans
   * Ende). Beide Elemente werden über DIESELBE Referenz-Maschine platziert,
   * damit Zeilen-Reihenfolge (sichtbar in der Liste) und Overlay-Reihenfolge
   * (nur für Dokument-/Tab-Reihenfolge relevant, da immer nur ein Overlay
   * gleichzeitig sichtbar ist) konsistent bleiben — sonst landet ein Overlay
   * z. B. nach einem Undo an der falschen Stelle in der Geschwister-Reihenfolge.
   */
  #mount(machine, beforeMachine) {
    const fullEl = machine.render(); // Header + Body wie gehabt, unverändert

    const overlay = document.createElement('div');
    overlay.className = 'machine-focus';
    overlay.hidden = true;
    const panel = document.createElement('div');
    panel.className = 'machine-focus__panel';
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'm-btn machine-focus__back';
    back.textContent = '‹ Back to Rack';
    back.addEventListener('click', () => this.#closeFocus(machine));
    panel.appendChild(back);
    panel.appendChild(fullEl);
    overlay.appendChild(panel);

    const { color } = machine.constructor.meta;
    const row = document.createElement('div');
    row.className = 'rack-row';
    row.style.setProperty('--m-color', color);
    row.innerHTML = `
      <span class="rack-row__stripe"></span>
      <span class="rack-row__name"><span data-name-text>${machine.displayName}</span><span class="rack-row__led" data-led></span></span>
      <span class="rack-row__pattern" data-pattern hidden></span>
      <span class="rack-row__actions">
        <button type="button" class="m-btn m-btn--solo" data-solo>S</button>
        <button type="button" class="m-btn m-btn--mute" data-mute>M</button>
        <span class="rack-row__move">
          <button type="button" class="m-btn rack-row__move-btn" data-move="-1" aria-label="Move up">▲</button>
          <button type="button" class="m-btn rack-row__move-btn" data-move="1" aria-label="Move down">▼</button>
        </span>
      </span>
      <span class="rack-row__chevron" aria-hidden="true">›</span>
    `;
    machine.rowNameEl = row.querySelector('[data-name-text]');
    // Aktivitäts-LED + aktiver Pattern-Buchstabe direkt in der Kompakt-
    // Zeile -- ohne das war das Rack bei laufendem Transport blind: man
    // sah nicht, welche Maschine gerade spielt oder welches Pattern aktiv
    // ist, ohne jede einzelne im Vollbild-Editor zu öffnen (s. UI-Review).
    // machine.pulse() (schon vorhanden, feuert pro Trigger fürs eigene
    // Faceplate-LED) blitzt jetzt zusätzlich dieses hier; onPatternChange
    // ist derselbe lose Hook wie onMixerChange fürs Mute/Solo-Sync.
    machine.rowLedEl = row.querySelector('[data-led]');
    const patternEl = row.querySelector('[data-pattern]');
    if (machine.patternIndex != null) {
      patternEl.hidden = false;
      patternEl.textContent = 'ABCD'[machine.patternIndex] ?? '';
      machine.onPatternChange = () => {
        patternEl.textContent = 'ABCD'[machine.patternIndex] ?? '';
      };
    }
    const muteBtn = row.querySelector('[data-mute]');
    const soloBtn = row.querySelector('[data-solo]');
    soloBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      machine.setSoloed(!machine.soloed);
      soloBtn.classList.toggle('is-active', machine.soloed);
    });
    muteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      machine.setMuted(!machine.muted);
      muteBtn.classList.toggle('is-active', machine.muted);
    });
    // Rack-Reihenfolge bestimmt auch die Spaltenreihenfolge in der Jam-
    // Ansicht (renderJamView() iteriert einfach this.machines, s. dort) --
    // "nach oben verschieben" heisst also gleichzeitig "weiter nach links
    // in der Jam-Ansicht" (s. Chat).
    row.querySelector('[data-move="-1"]').addEventListener('click', (e) => {
      e.stopPropagation();
      this.moveMachine(machine, -1);
    });
    row.querySelector('[data-move="1"]').addEventListener('click', (e) => {
      e.stopPropagation();
      this.moveMachine(machine, 1);
    });
    // Halten -> Umbenennen-Popup (wie die anderen Halten-Menüs im Repo),
    // kurzes Antippen -> Vollbild-Editor öffnen (unverändertes Verhalten).
    // Bricht bei nennenswerter Fingerbewegung ab (MOVE_TOLERANCE) -- die
    // Zeile sitzt in einer scrollbaren Liste, ein Scroll-Start darf nicht
    // nach 500ms plötzlich das Rename-Popup aufreissen.
    const RENAME_HOLD_MS = 500, MOVE_TOLERANCE = 8;
    let holdTimer = null, held = false, downX = 0, downY = 0;
    const cancelRowHold = () => { clearTimeout(holdTimer); holdTimer = null; };
    row.addEventListener('pointerdown', (e) => {
      held = false;
      downX = e.clientX; downY = e.clientY;
      holdTimer = setTimeout(() => {
        held = true;
        openRenamePopup(machine, row);
      }, RENAME_HOLD_MS);
    });
    row.addEventListener('pointermove', (e) => {
      if (holdTimer && Math.hypot(e.clientX - downX, e.clientY - downY) > MOVE_TOLERANCE) cancelRowHold();
    });
    row.addEventListener('pointerup', cancelRowHold);
    row.addEventListener('pointerleave', cancelRowHold);
    row.addEventListener('pointercancel', cancelRowHold);
    row.addEventListener('click', () => {
      if (held) { held = false; return; }
      this.#openFocus(machine);
    });

    const beforeView = beforeMachine ? this.views.get(beforeMachine) : null;
    document.body.insertBefore(overlay, beforeView?.overlay ?? null);
    this.rackEl.insertBefore(row, beforeView?.row ?? this.addSlotEl);

    const moveUpBtn = row.querySelector('[data-move="-1"]');
    const moveDownBtn = row.querySelector('[data-move="1"]');
    this.views.set(machine, { row, overlay, panel, muteBtn, soloBtn, moveUpBtn, moveDownBtn });
    this.#refreshMoveButtons();
  }

  /** ▲ der ersten und ▼ der letzten Zeile deaktivieren -- muss nach JEDER
   *  Änderung der Reihenfolge (Hinzufügen/Entfernen/Verschieben) neu
   *  laufen, weil sich "erste"/"letzte" dabei verschieben kann. */
  #refreshMoveButtons() {
    this.machines.forEach((m, i) => {
      const view = this.views.get(m);
      if (!view) return;
      view.moveUpBtn.disabled = i === 0;
      view.moveDownBtn.disabled = i === this.machines.length - 1;
    });
  }

  /** Positioniert Zeile+Overlay einer bereits gemounteten Maschine gemäss
   *  ihrem AKTUELLEN Index in this.machines neu (kein Neubau) -- von
   *  moveMachine() nach jedem Array-Swap aufgerufen, damit DOM-Reihenfolge
   *  und this.machines-Reihenfolge (die Jam-Ansicht direkt davon abliest,
   *  s. renderJamView() in jam-view.js) immer übereinstimmen. */
  #reorderDom(machine) {
    const view = this.views.get(machine);
    if (!view) return;
    const idx = this.machines.indexOf(machine);
    const nextMachine = this.machines[idx + 1] ?? null;
    const nextView = nextMachine ? this.views.get(nextMachine) : null;
    document.body.insertBefore(view.overlay, nextView?.overlay ?? null);
    this.rackEl.insertBefore(view.row, nextView?.row ?? this.addSlotEl);
  }

  /** Maschine um EINE Position nach oben (-1) oder unten (+1) verschieben.
   *  Bestimmt gleichzeitig die Spaltenreihenfolge in der Jam-Ansicht (s.
   *  Kommentar bei den Move-Buttons oben) -- oberste Rack-Zeile = linkeste
   *  Jam-Spalte, unterste = rechteste, ganz ohne jam-view.js anzufassen
   *  (die liest die Reihenfolge bei jedem Öffnen frisch aus this.machines). */
  moveMachine(machine, dir) {
    const idx = this.machines.indexOf(machine);
    if (idx === -1) return;
    const j = idx + dir;
    if (j < 0 || j >= this.machines.length) return;
    [this.machines[idx], this.machines[j]] = [this.machines[j], this.machines[idx]];
    this.#reorderDom(this.machines[idx]);
    this.#reorderDom(this.machines[j]);
    this.#refreshMoveButtons();
  }

  #openFocus(machine) {
    const view = this.views.get(machine);
    if (!view) return;
    view.overlay.hidden = false;
    view.panel.scrollTop = 0;
  }

  #closeFocus(machine) {
    const view = this.views.get(machine);
    if (!view) return;
    view.overlay.hidden = true;
    // Mute/Solo können sich im Vollbild-Editor geändert haben (eigene
    // Header-Buttons dort) — Kompakt-Zeile beim Schliessen nachziehen.
    view.muteBtn.classList.toggle('is-active', machine.muted);
    view.soloBtn.classList.toggle('is-active', machine.soloed);
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
        this.addMachine(MachineClass, null, { focus: true });
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
