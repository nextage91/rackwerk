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
    this.el.className = 'stepseq';
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
      this.grid.appendChild(cell);
      this.cells.push(cell);
    }

    this.el.querySelector('[data-clear]').addEventListener('click', () => {
      for (const st of this.pattern) st.on = false;
      this.#renderAll();
      this.onChange?.();
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
    cell.textContent = st?.on && this.pitchMode ? noteLabel(st.midi) : '';
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

  /* ---------- Gesten: Tippen vs. Pitch-Drag ---------- */
  #wirePointer() {
    let active = null; // { idx, startY, startMidi, moved }

    this.grid.addEventListener('pointerdown', (e) => {
      const cell = e.target.closest('.cell');
      if (!cell) return;
      e.preventDefault();
      this.grid.setPointerCapture?.(e.pointerId);
      const idx = this.#patIdx(parseInt(cell.dataset.cell, 10));
      active = { idx, startY: e.clientY, startMidi: this.pattern[idx].midi, moved: false };
    });

    this.grid.addEventListener('pointermove', (e) => {
      if (!active || !this.pitchMode) return;
      const dy = active.startY - e.clientY;
      if (!active.moved && Math.abs(dy) < TAP_THRESHOLD) return;

      const st = this.pattern[active.idx];
      if (!active.moved) {
        active.moved = true;
        st.on = true;
      }
      st.midi = Math.min(MIDI_MAX, Math.max(MIDI_MIN,
        active.startMidi + Math.round(dy / SEMITONE_PX)));
      this.#renderCell(active.idx % BAR_STEPS);
    });

    const finish = (e) => {
      if (!active) return;
      if (!active.moved) {
        const st = this.pattern[active.idx];
        st.on = !st.on;
        this.#renderCell(active.idx % BAR_STEPS);
      }
      this.grid.releasePointerCapture?.(e.pointerId);
      active = null;
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
