/**
 * StepSeq — Step-Sequenzer-Grid (Touch-first, 303-Stil) mit 1–8 Takten.
 *
 * Das Grid zeigt immer einen Takt (16 Zellen, 2×8); längere Patterns
 * werden seitenweise durchgeblättert (◀ 1/4 ▶). Der »2T«-Button schaltet
 * die Länge 1 → 2 → 4 → 8 Takte durch; die Datenänderung macht die
 * Maschine selbst (opts.onLengthChange), weil z. B. die BeatBox dabei
 * alle 8 Spuren gleichzeitig anpassen muss.
 *
 * Bedienung:
 * - Tippen: Step an/aus · vertikal ziehen: Tonhöhe (nur pitchMode)
 * - Pattern-Daten gehören der Maschine (Array beliebiger 16er-Länge)
 */
import { undo } from '../core/undo.js';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteLabel = (midi) => NOTE_NAMES[midi % 12] + (Math.floor(midi / 12) - 1);

const SEMITONE_PX = 10;
const TAP_THRESHOLD = 8;
const MIDI_MIN = 24;
const MIDI_MAX = 84;
const BAR_STEPS = 16;
const BAR_CHOICES = [1, 2, 4, 8];

export class StepSeq {
  /**
   * @param {{on:boolean, midi?:number}[]} pattern  Daten der Maschine (Referenz)
   * @param {{onChange?:Function, pitch?:boolean, onLengthChange?:Function}} [opts]
   */
  constructor(pattern, opts = {}) {
    this.pattern = pattern;
    this.onChange = opts.onChange ?? null;
    this.pitchMode = opts.pitch ?? true;
    this.onLengthChange = opts.onLengthChange ?? null;
    this.page = 0;

    this.el = document.createElement('div');
    this.el.className = 'stepseq' + (this.pitchMode ? ' stepseq--pitch' : '');
    this.el.innerHTML = `
      <div class="stepseq__bar">
        <span class="stepseq__title">Pattern</span>
        <span class="stepseq__ctrl">
          <button class="m-btn" data-page="-1" aria-label="Previous bar">◀</button>
          <span class="stepseq__page" data-pagelabel>1/1</span>
          <button class="m-btn" data-page="1" aria-label="Next bar">▶</button>
          <button class="m-btn" data-len aria-label="Pattern length">1B</button>
          <button class="m-btn" data-clear>Clear</button>
        </span>
      </div>
      <div class="stepseq__grid"></div>
    `;

    this.grid = this.el.querySelector('.stepseq__grid');
    this.cells = [];
    for (let c = 0; c < BAR_STEPS; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell' + (c % 4 === 0 ? ' cell--beat' : '');
      cell.dataset.cell = c;
      // Der frühere "↕"-Hinweis (Step vertikal ziehen = Tonhöhe) war bei
      // 8px/30%-Opacity praktisch unlesbar (gemessen <1.5:1 Kontrast, s.
      // UI-Review) -- ersatzlos entfernt statt aufgehellt, das wären sonst
      // 16 dauerhaft sichtbare Mini-Icons pro Grid. Die Geste gehört ins
      // Onboarding (dortige Überarbeitung ist ein eigener, größerer Posten).
      const label = document.createElement('span');
      label.className = 'cell__label';
      cell.appendChild(label);
      this.grid.appendChild(cell);
      this.cells.push(cell);
    }

    this.el.querySelector('[data-clear]').addEventListener('click', () => {
      const snapshot = this.pattern.map((st) => ({ ...st }));
      if (snapshot.every((st) => !st.on)) return; // schon leer — kein Undo nötig
      for (const st of this.pattern) st.on = false;
      this.#renderAll();
      this.onChange?.();
      undo.offer('Pattern cleared', () => {
        snapshot.forEach((st, i) => { if (this.pattern[i]) Object.assign(this.pattern[i], st); });
        this.#renderAll();
        this.onChange?.();
      });
    });

    this.el.querySelectorAll('[data-page]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const dir = parseInt(btn.dataset.page, 10);
        this.page = Math.min(this.bars - 1, Math.max(0, this.page + dir));
        this.#renderAll();
      }));

    this.lenBtn = this.el.querySelector('[data-len]');
    this.lenBtn.addEventListener('click', () => {
      if (!this.onLengthChange) return;
      const next = BAR_CHOICES[(BAR_CHOICES.indexOf(this.bars) + 1) % BAR_CHOICES.length];
      this.onLengthChange(next); // Maschine passt Daten an und ruft setPattern()
    });

    this.#wirePointer();
    this.#renderAll();
  }

  get bars() { return Math.max(1, Math.round(this.pattern.length / BAR_STEPS)); }

  /** Zell-Index (0..15) → Index im Pattern-Array. */
  #patIdx(c) { return this.page * BAR_STEPS + c; }

  /* ---------- Rendering ---------- */
  #renderCell(c) {
    const st = this.pattern[this.#patIdx(c)];
    const cell = this.cells[c];
    cell.classList.toggle('is-on', !!st?.on);
    cell.querySelector('.cell__label').textContent = st?.on && this.pitchMode ? noteLabel(st.midi) : '';
  }

  #renderAll() {
    for (let c = 0; c < BAR_STEPS; c++) this.#renderCell(c);
    const multi = this.bars > 1;
    this.el.querySelector('[data-pagelabel]').textContent = `${this.page + 1}/${this.bars}`;
    this.el.querySelectorAll('[data-page]').forEach((b) => (b.style.display = multi ? '' : 'none'));
    this.el.querySelector('[data-pagelabel]').style.display = multi ? '' : 'none';
    this.lenBtn.textContent = `${this.bars}B`;
  }

  /** Pattern-Daten austauschen (Spurwechsel, Längenänderung, Laden). */
  setPattern(pattern) {
    this.pattern = pattern;
    this.page = Math.min(this.page, this.bars - 1);
    this.#renderAll();
  }

  /**
   * Einzelnen Step neu zeichnen, nachdem die Maschine ihn extern verändert
   * hat (Live-Aufnahme via REC — s. Machine.liveStepIndex). patternIdx ist
   * der Index im GESAMTEN Pattern; ohne Wirkung, wenn die Seite gerade
   * nicht sichtbar ist.
   */
  refreshStep(patternIdx) {
    if (Math.floor(patternIdx / BAR_STEPS) !== this.page) return;
    this.#renderCell(patternIdx % BAR_STEPS);
  }

  /* ---------- Playhead ---------- */
  /** patternIdx ist der Index im GESAMTEN Pattern; sichtbar nur auf seiner Seite. */
  flashStep(patternIdx, delayMs, durMs) {
    setTimeout(() => {
      if (Math.floor(patternIdx / BAR_STEPS) !== this.page) return;
      const cell = this.cells[patternIdx % BAR_STEPS];
      if (!cell) return;
      cell.classList.add('is-play');
      setTimeout(() => cell.classList.remove('is-play'), durMs);
    }, Math.max(0, delayMs));
  }

  clearPlayhead() {
    for (const c of this.cells) c.classList.remove('is-play');
  }

  /** Multi-Touch: pointerId → { idx, startY, startMidi, moved } je Geste
   *  (nicht ein einzelnes gemeinsames Objekt) -- sonst würde ein zweiter
   *  Finger, der eine ANDERE Zelle antippt, den ersten mitten in der
   *  Geste überschreiben (dessen pointerup fände dann keine Zelle mehr
   *  und würde stattdessen die falsche togglen). */
  #wirePointer() {
    const active = new Map();

    this.grid.addEventListener('pointerdown', (e) => {
      const cell = e.target.closest('.cell');
      if (!cell) return;
      e.preventDefault();
      this.grid.setPointerCapture?.(e.pointerId);
      const idx = this.#patIdx(parseInt(cell.dataset.cell, 10));
      active.set(e.pointerId, { idx, startY: e.clientY, startMidi: this.pattern[idx].midi, moved: false });
    });

    this.grid.addEventListener('pointermove', (e) => {
      const drag = active.get(e.pointerId);
      if (!drag) return;
      const dy = drag.startY - e.clientY;
      if (!drag.moved && Math.abs(dy) < TAP_THRESHOLD) return;

      // Bewegung über der Schwelle markiert die Geste als "kein Tap" --
      // WICHTIG auch im Nicht-Pitch-Modus (Drum-Grids): touch-action:none
      // aufs Grid blockiert dort ohnehin das Scrollen (nötig, damit ein
      // echter Pitch-Drag nicht mit Seiten-Scroll kollidiert). Ohne dieses
      // frühe drag.moved=true würde eine abgebrochene Wisch-/Scroll-Geste
      // beim Loslassen trotzdem als Tap gewertet und den Step stumm an/aus
      // schalten -- genau das gemeldete "Step kippt beim Scrollversuch"-
      // Problem. Im Pitch-Modus lief das schon immer so (drag.moved=true
      // setzt hier gleich den Step an UND beginnt den Pitch-Drag); im
      // Drum-Modus bleibt es jetzt bei "kein Toggle", ohne den Step
      // zusätzlich zu verändern -- schlimmstenfalls ein No-Op statt einer
      // stillen, unerwünschten Pattern-Änderung.
      if (!drag.moved) drag.moved = true;
      if (!this.pitchMode) return;

      const step = this.pattern[drag.idx];
      step.on = true;
      step.midi = Math.min(MIDI_MAX, Math.max(MIDI_MIN,
        drag.startMidi + Math.round(dy / SEMITONE_PX)));
      this.#renderCell(drag.idx % BAR_STEPS);
    });

    const finish = (e) => {
      const drag = active.get(e.pointerId);
      if (!drag) return;
      if (!drag.moved) {
        const step = this.pattern[drag.idx];
        step.on = !step.on;
        this.#renderCell(drag.idx % BAR_STEPS);
      }
      this.grid.releasePointerCapture?.(e.pointerId);
      active.delete(e.pointerId);
      this.onChange?.();
    };
    this.grid.addEventListener('pointerup', finish);
    this.grid.addEventListener('pointercancel', finish);
  }
}

/**
 * Pattern auf `bars` Takte bringen. Verlängern dupliziert den bestehenden
 * Loop (musikalisch: Inhalt wiederholen), Verkürzen schneidet ab.
 */
export function resizePattern(pattern, bars) {
  const target = bars * BAR_STEPS;
  if (target <= pattern.length) {
    pattern.length = target;
  } else {
    const src = pattern.length;
    for (let i = src; i < target; i++) pattern.push({ ...pattern[i % src] });
  }
  return pattern;
}
