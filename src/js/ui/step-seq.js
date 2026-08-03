/**
 * StepSeq — Step-Sequenzer-Grid (Touch-first, 303-Stil) mit 1–8 Takten.
 *
 * Das Grid zeigt immer einen Takt (16 Zellen, 2×8); längere Patterns
 * werden seitenweise durchgeblättert (◀ 1/4 ▶). Der »2T«-Button schaltet
 * die Länge 1 → 2 → 4 → 8 Takte durch; die Datenänderung macht die
 * Maschine selbst (opts.onLengthChange), weil z. B. die BeatBox dabei
 * alle 8 Spuren gleichzeitig anpassen muss.
 *
 * Bedienung (Grid-Modus):
 * - Tippen: Step an/aus · Halten auf einem AKTIVEN Step (nur pitchMode):
 *   öffnet den Pitch-Picker (s. #openPitchPopup) -- ersetzt das frühere
 *   vertikale Ziehen, das Nutzer als "fummelig" gemeldet haben (schnelles
 *   Antippen der Zieltonhöhe statt Pixel-genauem Ziehen).
 * - Pattern-Daten gehören der Maschine (Array beliebiger 16er-Länge)
 *
 * Roll-Modus (nur pitchMode, s. #buildRoll()): echtes Tonhöhe×Zeit-Raster
 * als Alternative zum reinen Live-Aufnehmen -- Zeilen = Tonhöhen (eine
 * Oktave + Grundton, gleicher Ausschnitt wie das Keybed, mit denselben
 * Oktave-Tasten), Spalten = Steps (8 pro Seite, kleiner als die 16 im
 * Grid-Modus, damit die Zellen auf dem Handy noch treffsicher bleiben).
 * Antippen setzt/löscht die Note an genau dieser Tonhöhe+Zeit direkt --
 * ohne live zu spielen. Beide Modi bearbeiten dieselbe pattern-Referenz,
 * nichts geht beim Umschalten verloren; Live-Aufnahme (REC + Keybed/Arp)
 * bleibt in beiden Modi aktiv und aktualisiert sichtbar, welcher Modus
 * auch gerade offen ist (s. refreshStep()).
 */
import { undo } from '../core/undo.js';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteLabel = (midi) => NOTE_NAMES[midi % 12] + (Math.floor(midi / 12) - 1);

const TAP_THRESHOLD = 8;
const MIDI_MIN = 24;
const MIDI_MAX = 84;
const BAR_STEPS = 16;
const BAR_CHOICES = [1, 2, 4, 8];
const HOLD_MS = 500; // wie CLIP_HOLD_MS/insert-chain.js' Halten-Menüs

// Roll-Modus: 13 Tonhöhen sichtbar (eine Oktave + Grundton), gleicher
// Ausschnitt wie createKeybed() -- vertraute Bedienung, dieselben Oktave-
// Tasten wie beim Live-Spielen dieser Maschine. Nur 8 statt 16 Steps pro
// Seite (schmalere Spalten wären auf dem Handy neben 13 Zeilen zu klein
// zum treffsicheren Antippen).
const ROLL_ROWS = 13;
const ROLL_STEPS_PER_PAGE = 8;

/* ---------- Pitch-Picker-Popup (Halten auf einem aktiven Grid-Step) ----------
 * Ein einzelnes, modulweites Popup -- gleiches Muster wie eq8Menu in
 * insert-chain.js (nie mehr als eines gleichzeitig offen, egal welche
 * StepSeq-Instanz/welches Panel gerade offen ist). Ersetzt das frühere
 * vertikale Ziehen zum Tonhöhe-Ändern: Antippen der Zieltonhöhe statt
 * Pixel-genauem Ziehen (Nutzer-Anfrage, s. Dateikopf-Kommentar).
 */
let pitchPopup = null;
const dismissPitchPopup = () => {
  pitchPopup?.remove();
  pitchPopup = null;
  document.removeEventListener('pointerdown', onOutsidePitchPopup, true);
};
const onOutsidePitchPopup = (e) => { if (pitchPopup && !pitchPopup.contains(e.target)) dismissPitchPopup(); };

/**
 * @param {number} currentMidi  Aktuelle Tonhöhe des Steps (bestimmt das
 *   anfangs sichtbare Oktav-Fenster, ungefähr mittig wie beim Roll-Modus).
 * @param {number} clientX
 * @param {number} clientY
 * @param {(midi:number)=>void} onPick  Neue Tonhöhe gewählt.
 * @param {()=>void} onTurnOff  Step stattdessen ausschalten.
 */
function openPitchPopup(currentMidi, clientX, clientY, onPick, onTurnOff) {
  dismissPitchPopup();
  let base = Math.min(MIDI_MAX - (ROLL_ROWS - 1),
    Math.max(MIDI_MIN, currentMidi - Math.floor(ROLL_ROWS / 2)));

  pitchPopup = document.createElement('div');
  pitchPopup.className = 'pat-chip pitch-picker';
  document.body.appendChild(pitchPopup);

  const position = () => {
    const left = Math.max(8, Math.min(window.innerWidth - pitchPopup.offsetWidth - 8, clientX - pitchPopup.offsetWidth / 2));
    pitchPopup.style.left = `${left}px`;
    // Anders als eq8Menu (immer über dem Tap-Punkt) kann dieses Popup
    // deutlich höher werden (13 Notenknöpfe + Oktave-Zeile + Turn-off) --
    // ein Step ganz oben im Grid liesse es sonst über den oberen Rand
    // hinaus wachsen und in den Inhalt darüber hineinragen. Reicht der
    // Platz oberhalb nicht, klappt es stattdessen UNTER den Tap-Punkt.
    const spaceAbove = clientY - 30;
    const top = spaceAbove >= pitchPopup.offsetHeight
      ? clientY - pitchPopup.offsetHeight - 30
      : clientY + 30;
    pitchPopup.style.top = `${Math.max(8, Math.min(window.innerHeight - pitchPopup.offsetHeight - 8, top))}px`;
  };

  const rebuild = () => {
    pitchPopup.innerHTML = `
      <div class="pitch-picker__oct">
        <button class="keybed__oct-btn" data-poct="-1" aria-label="Octave down">−</button>
        <span class="keybed__oct-label" data-poctlabel></span>
        <button class="keybed__oct-btn" data-poct="1" aria-label="Octave up">+</button>
      </div>
      <div class="pitch-picker__notes">
        ${Array.from({ length: ROLL_ROWS }, (_, i) => {
          const pitch = base + (ROLL_ROWS - 1 - i);
          return `<button class="pat-chip__btn pitch-picker__note${pitch === currentMidi ? ' is-active' : ''}" data-pitch="${pitch}">${noteLabel(pitch)}</button>`;
        }).join('')}
      </div>
      <button class="pat-chip__btn pat-chip__btn--danger" data-stepoff>Turn off</button>
    `;
    pitchPopup.querySelectorAll('[data-pitch]').forEach((btn) => {
      btn.addEventListener('click', () => {
        onPick(parseInt(btn.dataset.pitch, 10));
        dismissPitchPopup();
      });
    });
    pitchPopup.querySelector('[data-poct="-1"]').addEventListener('click', () => {
      base = Math.max(MIDI_MIN, base - 12);
      rebuild(); position();
    });
    pitchPopup.querySelector('[data-poct="1"]').addEventListener('click', () => {
      base = Math.min(MIDI_MAX - (ROLL_ROWS - 1), base + 12);
      rebuild(); position();
    });
    pitchPopup.querySelector('[data-poct="-1"]').disabled = base - 12 < MIDI_MIN;
    pitchPopup.querySelector('[data-poct="1"]').disabled = base + 12 > MIDI_MAX - (ROLL_ROWS - 1);
    pitchPopup.querySelector('[data-poctlabel]').textContent = noteLabel(base);
    pitchPopup.querySelector('[data-stepoff]').addEventListener('click', () => {
      onTurnOff();
      dismissPitchPopup();
    });
  };
  rebuild();
  position();
  // capture:true wie onOutsideEq8Menu -- muss VOR dem eigentlichen Ziel-
  // Handler des nächsten Taps feuern, sonst würde ein Tap auf eine ANDERE
  // Zelle sowohl das Popup schliessen als auch sofort die neue Zelle
  // togglen (zwei Wirkungen aus einer Geste).
  document.addEventListener('pointerdown', onOutsidePitchPopup, true);
}

export class StepSeq {
  /**
   * @param {{on:boolean, midi?:number, accent?:boolean, slide?:boolean}[]} pattern  Daten der Maschine (Referenz)
   * @param {{onChange?:Function, pitch?:boolean, onLengthChange?:Function, accentSlide?:boolean, defaultMidi?:number}} [opts]
   */
  constructor(pattern, opts = {}) {
    this.pattern = pattern;
    this.onChange = opts.onChange ?? null;
    this.pitchMode = opts.pitch ?? true;
    this.onLengthChange = opts.onLengthChange ?? null;
    /** Zwei zusätzliche Tippzonen pro Zelle (oben/unten) für Accent/Slide --
     *  bislang nur vom AcidBass genutzt (s. acidbass.js), alle anderen
     *  Maschinen lassen das weg und bekommen unverändert nur die normale
     *  An/Aus-Zelle. */
    this.accentSlide = opts.accentSlide ?? false;
    this.page = 0;

    // Roll-Modus (s. Dateikopf) -- nur bei pitchMode UND ohne Accent/Slide
    // sinnvoll (der AcidBass bräuchte eigene Accent/Slide-Zonen PRO Zeile,
    // das ist bewusst nicht Teil dieser ersten Version). 'grid' bleibt der
    // Standard, damit sich am Verhalten aller bisherigen Aufrufer nichts
    // ändert, die den neuen Modus nicht kennen.
    this.rollEnabled = this.pitchMode && !this.accentSlide;
    this.mode = 'grid';
    this.rollPage = 0;
    // Unterste sichtbare Tonhöhe im Roll-Raster -- startet so, dass der
    // Standardton der Maschine ungefähr mittig im 13-Zeilen-Ausschnitt
    // liegt (gleicher Ausschnitt-Gedanke wie createKeybed()'s baseMidi).
    this.rollBase = Math.min(MIDI_MAX - (ROLL_ROWS - 1),
      Math.max(MIDI_MIN, (opts.defaultMidi ?? 60) - 6));

    this.el = document.createElement('div');
    this.el.className = 'stepseq' + (this.pitchMode ? ' stepseq--pitch' : '') + (this.accentSlide ? ' stepseq--accent-slide' : '');
    this.el.innerHTML = `
      <div class="stepseq__bar">
        <span class="stepseq__title">Pattern</span>
        <span class="stepseq__ctrl">
          ${this.rollEnabled ? `
            <button class="m-btn" data-mode="grid" aria-label="Grid view">Grid</button>
            <button class="m-btn" data-mode="roll" aria-label="Roll view">Roll</button>
          ` : ''}
          <button class="m-btn" data-page="-1" aria-label="Previous bar">◀</button>
          <span class="stepseq__page" data-pagelabel>1/1</span>
          <button class="m-btn" data-page="1" aria-label="Next bar">▶</button>
          <button class="m-btn" data-len aria-label="Pattern length">1B</button>
          <button class="m-btn" data-clear>Clear</button>
        </span>
      </div>
      ${this.rollEnabled ? `
        <div class="stepseq__rollbar" hidden>
          <button class="keybed__oct-btn" data-roll-oct="-1" aria-label="Octave down">−</button>
          <span class="keybed__oct-label" data-rolloctlabel></span>
          <button class="keybed__oct-btn" data-roll-oct="1" aria-label="Octave up">+</button>
        </div>
      ` : ''}
      <div class="stepseq__grid"></div>
      ${this.rollEnabled ? '<div class="stepseq__roll" hidden></div>' : ''}
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

      // Zwei zusätzliche Tippzonen (oben = Accent, unten = Slide) --
      // eigene <button>-Elemente statt nur CSS-Bereiche der Zelle, damit
      // sie als eigenständige Tippziele erkennbar sind (s. #wirePointer(),
      // das Klicks darauf explizit von der normalen An/Aus-Geste
      // ausnimmt). Nur angehängt, wenn accentSlide aktiv ist -- alle
      // anderen Maschinen bekommen weiterhin die schlichte Zelle von vorher.
      if (this.accentSlide) {
        const accentZone = document.createElement('button');
        accentZone.type = 'button';
        accentZone.className = 'cell__accent';
        accentZone.setAttribute('aria-label', 'Toggle accent');
        cell.appendChild(accentZone);

        const slideZone = document.createElement('button');
        slideZone.type = 'button';
        slideZone.className = 'cell__slide';
        slideZone.setAttribute('aria-label', 'Toggle slide');
        cell.appendChild(slideZone);
      }

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
        if (this.mode === 'roll') {
          this.rollPage = Math.min(this.rollPages - 1, Math.max(0, this.rollPage + dir));
        } else {
          this.page = Math.min(this.bars - 1, Math.max(0, this.page + dir));
        }
        this.#renderAll();
      }));

    this.lenBtn = this.el.querySelector('[data-len]');
    this.lenBtn.addEventListener('click', () => {
      if (!this.onLengthChange) return;
      const next = BAR_CHOICES[(BAR_CHOICES.indexOf(this.bars) + 1) % BAR_CHOICES.length];
      this.onLengthChange(next); // Maschine passt Daten an und ruft setPattern()
    });

    this.#wirePointer();
    if (this.accentSlide) this.#wireAccentSlide();
    if (this.rollEnabled) {
      this.rollBar = this.el.querySelector('.stepseq__rollbar');
      this.rollEl = this.el.querySelector('.stepseq__roll');
      this.#buildRoll();
      this.#wireRollPointer();

      this.el.querySelectorAll('[data-mode]').forEach((btn) =>
        btn.addEventListener('click', () => {
          this.mode = btn.dataset.mode;
          this.grid.hidden = this.mode !== 'grid';
          this.rollEl.hidden = this.mode !== 'roll';
          this.rollBar.hidden = this.mode !== 'roll';
          this.el.querySelectorAll('[data-mode]').forEach((b) =>
            b.classList.toggle('is-active', b.dataset.mode === this.mode));
          this.#renderAll();
        }));
      this.el.querySelector('[data-mode="grid"]').classList.add('is-active');

      const rollOctDown = this.el.querySelector('[data-roll-oct="-1"]');
      const rollOctUp = this.el.querySelector('[data-roll-oct="1"]');
      const shiftRollOctave = (dir) => {
        this.rollBase = Math.min(MIDI_MAX - (ROLL_ROWS - 1),
          Math.max(MIDI_MIN, this.rollBase + dir * 12));
        this.#renderRollAll();
      };
      rollOctDown.addEventListener('click', () => shiftRollOctave(-1));
      rollOctUp.addEventListener('click', () => shiftRollOctave(1));
    }
    this.#renderAll();
  }

  get bars() { return Math.max(1, Math.round(this.pattern.length / BAR_STEPS)); }
  get rollPages() { return Math.max(1, Math.ceil(this.pattern.length / ROLL_STEPS_PER_PAGE)); }

  /** Zell-Index (0..15) → Index im Pattern-Array. */
  #patIdx(c) { return this.page * BAR_STEPS + c; }

  /** Roll-Spalten-Index (0..7) → Index im Pattern-Array. */
  #rollPatIdx(c) { return this.rollPage * ROLL_STEPS_PER_PAGE + c; }

  /* ---------- Rendering ---------- */
  #renderCell(c) {
    const st = this.pattern[this.#patIdx(c)];
    const cell = this.cells[c];
    cell.classList.toggle('is-on', !!st?.on);
    cell.querySelector('.cell__label').textContent = st?.on && this.pitchMode ? noteLabel(st.midi) : '';
    if (this.accentSlide) {
      cell.querySelector('.cell__accent')?.classList.toggle('is-active', !!st?.accent);
      cell.querySelector('.cell__slide')?.classList.toggle('is-active', !!st?.slide);
    }
  }

  /** Ein Roll-Raster-Feld (Zeile row 0..12, Spalte c 0..7) neu zeichnen. */
  #renderRollCell(row, c) {
    const st = this.pattern[this.#rollPatIdx(c)];
    const pitch = this.rollBase + (ROLL_ROWS - 1 - row);
    const cell = this.rollCells[row][c];
    cell.classList.toggle('is-on', !!st?.on && st.midi === pitch);
  }

  #renderRollAll() {
    if (!this.rollEnabled) return;
    for (let row = 0; row < ROLL_ROWS; row++) {
      for (let c = 0; c < ROLL_STEPS_PER_PAGE; c++) this.#renderRollCell(row, c);
    }
    for (let row = 0; row < ROLL_ROWS; row++) {
      this.rollLabels[row].textContent = noteLabel(this.rollBase + (ROLL_ROWS - 1 - row));
    }
    const label = noteLabel(this.rollBase);
    this.el.querySelector('[data-rolloctlabel]').textContent = label;
    this.el.querySelector('[data-roll-oct="-1"]').disabled = this.rollBase - 12 < MIDI_MIN;
    this.el.querySelector('[data-roll-oct="1"]').disabled = this.rollBase + 12 > MIDI_MAX - (ROLL_ROWS - 1);
  }

  #renderAll() {
    for (let c = 0; c < BAR_STEPS; c++) this.#renderCell(c);
    if (this.rollEnabled) this.#renderRollAll();

    const multi = this.mode === 'roll' ? this.rollPages > 1 : this.bars > 1;
    const pageLabel = this.mode === 'roll' ? `${this.rollPage + 1}/${this.rollPages}` : `${this.page + 1}/${this.bars}`;
    this.el.querySelector('[data-pagelabel]').textContent = pageLabel;
    this.el.querySelectorAll('[data-page]').forEach((b) => (b.style.display = multi ? '' : 'none'));
    this.el.querySelector('[data-pagelabel]').style.display = multi ? '' : 'none';
    this.lenBtn.textContent = `${this.bars}B`;
  }

  /** Pattern-Daten austauschen (Spurwechsel, Längenänderung, Laden). */
  setPattern(pattern) {
    this.pattern = pattern;
    this.page = Math.min(this.page, this.bars - 1);
    if (this.rollEnabled) this.rollPage = Math.min(this.rollPage, this.rollPages - 1);
    this.#renderAll();
  }

  /**
   * Einzelnen Step neu zeichnen, nachdem die Maschine ihn extern verändert
   * hat (Live-Aufnahme via REC — s. Machine.liveStepIndex). patternIdx ist
   * der Index im GESAMTEN Pattern; ohne Wirkung, wenn die Seite gerade
   * nicht sichtbar ist. Zeichnet BEIDE Darstellungen nach, egal welche
   * gerade sichtbar ist -- damit ein Umschalten später sofort den
   * aktuellen Stand zeigt, ohne dass hier bekannt sein muss, welcher
   * Modus gleich als nächstes aktiv wird.
   */
  refreshStep(patternIdx) {
    if (Math.floor(patternIdx / BAR_STEPS) === this.page) this.#renderCell(patternIdx % BAR_STEPS);
    if (this.rollEnabled && Math.floor(patternIdx / ROLL_STEPS_PER_PAGE) === this.rollPage) {
      const c = patternIdx % ROLL_STEPS_PER_PAGE;
      for (let row = 0; row < ROLL_ROWS; row++) this.#renderRollCell(row, c);
    }
  }

  /* ---------- Playhead ---------- */
  /** patternIdx ist der Index im GESAMTEN Pattern; sichtbar nur auf seiner Seite. */
  flashStep(patternIdx, delayMs, durMs) {
    setTimeout(() => {
      if (Math.floor(patternIdx / BAR_STEPS) === this.page) {
        const cell = this.cells[patternIdx % BAR_STEPS];
        if (cell) {
          cell.classList.add('is-play');
          setTimeout(() => cell.classList.remove('is-play'), durMs);
        }
      }
      // Roll-Modus: die ganze Spalte kurz aufleuchten lassen (klassischer
      // Piano-Roll-Playhead, "wir sind jetzt bei diesem Zeitpunkt") statt
      // nur der einen Zelle mit aktiver Note wie im Grid.
      if (this.rollEnabled && Math.floor(patternIdx / ROLL_STEPS_PER_PAGE) === this.rollPage) {
        const c = patternIdx % ROLL_STEPS_PER_PAGE;
        for (let row = 0; row < ROLL_ROWS; row++) {
          const cell = this.rollCells[row][c];
          cell.classList.add('is-play');
          setTimeout(() => cell.classList.remove('is-play'), durMs);
        }
      }
    }, Math.max(0, delayMs));
  }

  clearPlayhead() {
    for (const c of this.cells) c.classList.remove('is-play');
    if (this.rollEnabled) {
      for (const row of this.rollCells) for (const c of row) c.classList.remove('is-play');
    }
  }

  /** Baut das 13×8-Roll-Raster einmalig auf (Zeilen = Tonhöhen, höchste
   *  oben, Spalten = Steps) -- eine Beschriftungs-Spalte links, damit
   *  erkennbar bleibt, welche Zeile welcher Ton ist. */
  #buildRoll() {
    this.rollEl.style.gridTemplateColumns = `34px repeat(${ROLL_STEPS_PER_PAGE}, 1fr)`;
    this.rollCells = [];
    this.rollLabels = [];
    for (let row = 0; row < ROLL_ROWS; row++) {
      const label = document.createElement('span');
      label.className = 'roll-label';
      this.rollEl.appendChild(label);
      this.rollLabels.push(label);

      const rowCells = [];
      for (let c = 0; c < ROLL_STEPS_PER_PAGE; c++) {
        const cell = document.createElement('div');
        cell.className = 'roll-cell' + (c % 4 === 0 ? ' cell--beat' : '');
        cell.dataset.row = row;
        cell.dataset.col = c;
        this.rollEl.appendChild(cell);
        rowCells.push(cell);
      }
      this.rollCells.push(rowCells);
    }
  }

  /** Antippen setzt/löscht die Note direkt an dieser Tonhöhe+Zeit -- kein
   *  Ziehen nötig (die Zeile IST schon die Tonhöhe), deshalb reicht ein
   *  einfacher Klick wie bei den Accent-/Slide-Zonen oben. */
  #wireRollPointer() {
    this.rollEl.addEventListener('click', (e) => {
      const cell = e.target.closest('.roll-cell');
      if (!cell) return;
      const row = parseInt(cell.dataset.row, 10);
      const c = parseInt(cell.dataset.col, 10);
      const idx = this.#rollPatIdx(c);
      const pitch = this.rollBase + (ROLL_ROWS - 1 - row);
      const st = this.pattern[idx];
      if (!st) return;
      if (st.on && st.midi === pitch) {
        st.on = false;
      } else {
        st.on = true;
        st.midi = pitch;
      }
      for (let r = 0; r < ROLL_ROWS; r++) this.#renderRollCell(r, c);
      this.onChange?.();
    });
  }

  /** Multi-Touch: pointerId → { idx, startY, startX, moved, holdFired,
   *  holdTimer } je Geste (nicht ein einzelnes gemeinsames Objekt) --
   *  sonst würde ein zweiter Finger, der eine ANDERE Zelle antippt, den
   *  ersten mitten in der Geste überschreiben (dessen pointerup fände
   *  dann keine Zelle mehr und würde stattdessen die falsche togglen). */
  #wirePointer() {
    const active = new Map();

    this.grid.addEventListener('pointerdown', (e) => {
      // Accent-/Slide-Zonen haben ihre eigene, einfache Klick-Behandlung
      // (s. #wireAccentSlide) -- hier aussteigen, sonst würde dieselbe
      // Berührung ZUSÄTZLICH den Step selbst an/aus schalten.
      if (e.target.closest('.cell__accent, .cell__slide')) return;
      const cell = e.target.closest('.cell');
      if (!cell) return;
      e.preventDefault();
      this.grid.setPointerCapture?.(e.pointerId);
      const idx = this.#patIdx(parseInt(cell.dataset.cell, 10));
      const drag = { idx, startY: e.clientY, startX: e.clientX, moved: false, holdFired: false, holdTimer: null };
      active.set(e.pointerId, drag);

      // Halten auf einem BEREITS AKTIVEN Step (nur pitchMode) öffnet den
      // Pitch-Picker (s. Dateikopf-Kommentar/openPitchPopup()) -- ersetzt
      // das frühere vertikale Ziehen. Ein ausgeschalteter Step hat keine
      // Tonhöhe zu bearbeiten, dafür bleibt der normale kurze Tipp
      // (schaltet ihn mit der zuletzt genutzten Tonhöhe ein).
      if (this.pitchMode && this.pattern[idx]?.on) {
        drag.holdTimer = setTimeout(() => {
          if (drag.moved) return;
          drag.holdFired = true;
          openPitchPopup(
            this.pattern[idx].midi, e.clientX, e.clientY,
            (pitch) => {
              this.pattern[idx].midi = pitch;
              this.#renderCell(idx % BAR_STEPS);
              this.onChange?.();
            },
            () => {
              this.pattern[idx].on = false;
              this.#renderCell(idx % BAR_STEPS);
              this.onChange?.();
            },
          );
        }, HOLD_MS);
      }
    });

    this.grid.addEventListener('pointermove', (e) => {
      const drag = active.get(e.pointerId);
      if (!drag || drag.moved) return;
      const dy = drag.startY - e.clientY;
      const dx = (e.clientX ?? drag.startX) - drag.startX;
      if (Math.hypot(dx, dy) < TAP_THRESHOLD) return;

      // Bewegung über der Schwelle markiert die Geste als "kein Tap" UND
      // bricht ein evtl. laufendes Halten ab -- wichtig auch im Nicht-
      // Pitch-Modus (Drum-Grids): touch-action:none aufs Grid blockiert
      // dort ohnehin das Scrollen, ohne dieses früh gesetzte moved=true
      // würde eine abgebrochene Wisch-/Scroll-Geste beim Loslassen
      // trotzdem als Tap gewertet und den Step stumm an/aus schalten --
      // genau das früher gemeldete "Step kippt beim Scrollversuch"-Problem.
      drag.moved = true;
      clearTimeout(drag.holdTimer);
    });

    const finish = (e) => {
      const drag = active.get(e.pointerId);
      if (!drag) return;
      clearTimeout(drag.holdTimer);
      if (!drag.moved && !drag.holdFired) {
        const step = this.pattern[drag.idx];
        step.on = !step.on;
        this.#renderCell(drag.idx % BAR_STEPS);
        this.onChange?.();
      }
      this.grid.releasePointerCapture?.(e.pointerId);
      active.delete(e.pointerId);
    };
    this.grid.addEventListener('pointerup', finish);
    this.grid.addEventListener('pointercancel', finish);
  }

  /** Accent-/Slide-Zonen: einfache Klicks statt der Zieh-fähigen Geste
   *  oben (kein Pitch-Drag, kein Multi-Touch-Sonderfall nötig -- ein
   *  einzelner Tipp schaltet die jeweilige Eigenschaft direkt um). */
  #wireAccentSlide() {
    this.grid.addEventListener('click', (e) => {
      const accentBtn = e.target.closest('.cell__accent');
      const slideBtn = e.target.closest('.cell__slide');
      if (!accentBtn && !slideBtn) return;
      const btn = accentBtn ?? slideBtn;
      const c = parseInt(btn.closest('.cell').dataset.cell, 10);
      const st = this.pattern[this.#patIdx(c)];
      if (!st) return;
      if (accentBtn) st.accent = !st.accent;
      else st.slide = !st.slide;
      this.#renderCell(c);
      this.onChange?.();
    });
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
