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

/* ---------- Halten-Popups (Pitch-Picker + Velocity) ----------
 * Ein einzelnes, modulweites Popup -- gleiches Muster wie eq8Menu in
 * insert-chain.js (nie mehr als eines gleichzeitig offen, egal welche
 * StepSeq-Instanz/welches Panel gerade offen ist). Der Pitch-Picker
 * ersetzt das frühere vertikale Ziehen zum Tonhöhe-Ändern: Antippen der
 * Zieltonhöhe statt Pixel-genauem Ziehen (Nutzer-Anfrage). Das Velocity-
 * Popup (Drum-Grids, s. openVelocityPopup unten) teilt sich dasselbe
 * Positionierungs-/Lebenszyklus-Gerüst -- nur der Inhalt unterscheidet sich.
 */
let activePopup = null;
const dismissActivePopup = () => {
  activePopup?.remove();
  activePopup = null;
  document.removeEventListener('pointerdown', onOutsideActivePopup, true);
};
const onOutsideActivePopup = (e) => { if (activePopup && !activePopup.contains(e.target)) dismissActivePopup(); };

/**
 * @param {string} className  Zusätzliche Klasse (neben .pat-chip) fürs Popup-Element.
 * @param {number} clientX
 * @param {number} clientY
 * @param {(el:HTMLElement, position:()=>void)=>void} render  Füllt den Inhalt;
 *   bekommt `position` mit, damit Inhaltswechsel (z. B. Oktave-Klick im
 *   Pitch-Picker) die Position neu berechnen können, ohne das Popup neu zu öffnen.
 */
function openChipPopup(className, clientX, clientY, render) {
  dismissActivePopup();
  const el = document.createElement('div');
  el.className = `pat-chip ${className}`;
  document.body.appendChild(el);
  activePopup = el;

  const position = () => {
    const left = Math.max(8, Math.min(window.innerWidth - el.offsetWidth - 8, clientX - el.offsetWidth / 2));
    el.style.left = `${left}px`;
    // Kann höher werden als die übrigen .pat-chip-Menüs (z. B. 13
    // Notenknöpfe + Oktave-Zeile + Turn-off) -- ein Step ganz oben im Grid
    // liesse es sonst über den oberen Rand hinaus wachsen und in den
    // Inhalt darüber hineinragen. Reicht der Platz oberhalb nicht, klappt
    // es stattdessen UNTER den Tap-Punkt.
    const spaceAbove = clientY - 30;
    const top = spaceAbove >= el.offsetHeight
      ? clientY - el.offsetHeight - 30
      : clientY + 30;
    el.style.top = `${Math.max(8, Math.min(window.innerHeight - el.offsetHeight - 8, top))}px`;
  };

  render(el, position);
  position();
  // capture:true wie onOutsideEq8Menu -- muss VOR dem eigentlichen Ziel-
  // Handler des nächsten Taps feuern, sonst würde ein Tap auf eine ANDERE
  // Zelle sowohl das Popup schliessen als auch sofort die neue Zelle
  // togglen (zwei Wirkungen aus einer Geste).
  document.addEventListener('pointerdown', onOutsideActivePopup, true);
}

/** Kompakter Ziehbalken (0..1) für die Velocity -- gemeinsam vom Pitch-
 *  Picker und vom Velocity-Popup genutzt. Kein <input type="range">
 *  (im restlichen Projekt bewusst keine nativen Formularelemente, s.
 *  x-knob/x-fader) -- stattdessen dieselbe Zieh-Technik wie das Sweep-Pad
 *  (jam-view.js): pointerdown/-move mit setPointerCapture, kontinuierliches
 *  onChange während des Ziehens, kein separates Loslassen-Commit nötig. */
function wireVelBar(el, currentVel, onVelChange) {
  const bar = el.querySelector('[data-velbar]');
  const fill = el.querySelector('[data-velfill]');
  const pct = el.querySelector('[data-velpct]');
  const setUI = (v) => {
    fill.style.width = `${Math.round(v * 100)}%`;
    pct.textContent = `${Math.round(v * 100)}%`;
  };
  setUI(currentVel);
  const valueFromEvent = (e) => {
    const r = bar.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };
  let dragging = false;
  bar.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    dragging = true;
    bar.setPointerCapture?.(e.pointerId);
    const v = valueFromEvent(e);
    setUI(v);
    onVelChange(v);
  });
  bar.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const v = valueFromEvent(e);
    setUI(v);
    onVelChange(v);
  });
  const release = () => { dragging = false; };
  bar.addEventListener('pointerup', release);
  bar.addEventListener('pointercancel', release);
}

const velBarHtml = () => `
  <div class="pitch-picker__vel">
    <span class="pitch-picker__vel-label">Vel</span>
    <div class="pitch-picker__vel-bar" data-velbar><div class="pitch-picker__vel-fill" data-velfill></div></div>
    <span class="pitch-picker__vel-pct" data-velpct></span>
  </div>
`;

/**
 * @param {number} currentMidi  Aktuelle Tonhöhe des Steps (bestimmt das
 *   anfangs sichtbare Oktav-Fenster, ungefähr mittig wie beim Roll-Modus).
 * @param {number} currentVel   Aktuelle Velocity (0..1) des Steps.
 * @param {number} clientX
 * @param {number} clientY
 * @param {(midi:number)=>void} onPick  Neue Tonhöhe gewählt.
 * @param {(vel:number)=>void} onVelChange  Velocity gezogen (live, kein Dismiss).
 * @param {()=>void} onTurnOff  Step stattdessen ausschalten.
 */
function openPitchPopup(currentMidi, currentVel, clientX, clientY, onPick, onVelChange, onTurnOff) {
  let base = Math.min(MIDI_MAX - (ROLL_ROWS - 1),
    Math.max(MIDI_MIN, currentMidi - Math.floor(ROLL_ROWS / 2)));

  openChipPopup('pitch-picker', clientX, clientY, (el, position) => {
    const rebuild = () => {
      el.innerHTML = `
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
        ${onVelChange ? velBarHtml() : ''}
        <button class="pat-chip__btn pat-chip__btn--danger" data-stepoff>Turn off</button>
      `;
      el.querySelectorAll('[data-pitch]').forEach((btn) => {
        btn.addEventListener('click', () => {
          onPick(parseInt(btn.dataset.pitch, 10));
          dismissActivePopup();
        });
      });
      el.querySelector('[data-poct="-1"]').addEventListener('click', () => {
        base = Math.max(MIDI_MIN, base - 12);
        rebuild(); position();
      });
      el.querySelector('[data-poct="1"]').addEventListener('click', () => {
        base = Math.min(MIDI_MAX - (ROLL_ROWS - 1), base + 12);
        rebuild(); position();
      });
      el.querySelector('[data-poct="-1"]').disabled = base - 12 < MIDI_MIN;
      el.querySelector('[data-poct="1"]').disabled = base + 12 > MIDI_MAX - (ROLL_ROWS - 1);
      el.querySelector('[data-poctlabel]').textContent = noteLabel(base);
      if (onVelChange) wireVelBar(el, currentVel, onVelChange);
      el.querySelector('[data-stepoff]').addEventListener('click', () => {
        onTurnOff();
        dismissActivePopup();
      });
    };
    rebuild();
  });
}

/** Schlankes Pendant zum Pitch-Picker für Drum-Grids (pitchMode:false) --
 *  die haben keine Tonhöhe zu bearbeiten, aber jetzt (wie die Pitch-
 *  Maschinen) eine Velocity pro Step. Nur Velocity-Balken + Turn off. */
function openVelocityPopup(currentVel, clientX, clientY, onVelChange, onTurnOff) {
  openChipPopup('pitch-picker', clientX, clientY, (el) => {
    el.innerHTML = `
      ${velBarHtml()}
      <button class="pat-chip__btn pat-chip__btn--danger" data-stepoff>Turn off</button>
    `;
    wireVelBar(el, currentVel, onVelChange);
    el.querySelector('[data-stepoff]').addEventListener('click', () => {
      onTurnOff();
      dismissActivePopup();
    });
  });
}

export class StepSeq {
  /**
   * @param {{on:boolean, midi?:number, accent?:boolean, slide?:boolean}[]} pattern  Daten der Maschine (Referenz)
   * @param {{onChange?:Function, pitch?:boolean, onLengthChange?:Function, accentSlide?:boolean, defaultMidi?:number, roll?:boolean}} [opts]
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
    // ändert, die den neuen Modus nicht kennen. opts.roll=false (PercSynth/
    // KickSynth, s. step-sequenced-synth.js#buildPatternControls) blendet
    // ihn zusätzlich aus: deren Hüllkurve hängt rein am eigenen Decay-
    // Regler, die per Roll gezeichnete Notenlänge hätte dort keine hörbare
    // Wirkung -- ein Anfasser, der sichtbar nichts bewirkt, ist irreführender
    // als die Möglichkeit gar nicht erst anzubieten.
    this.rollEnabled = this.pitchMode && !this.accentSlide && (opts.roll ?? true);
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
    // Velocity als Helligkeit ablesbar (leiser = dunkler) -- gilt für
    // Pitch- UND Drum-Grids gleichermassen, beide haben jetzt vel pro Step.
    cell.style.opacity = st?.on ? String(0.4 + 0.6 * (st.vel ?? 1)) : '';
    cell.querySelector('.cell__label').textContent = st?.on && this.pitchMode ? noteLabel(st.midi) : '';
    if (this.accentSlide) {
      cell.querySelector('.cell__accent')?.classList.toggle('is-active', !!st?.accent);
      cell.querySelector('.cell__slide')?.classList.toggle('is-active', !!st?.slide);
    }
  }

  /** Für Zeile `row` (0..12): welche Spalten (0..ROLL_STEPS_PER_PAGE-1)
   *  von einer Note dieser Tonhöhe belegt sind -- eine Note startet an
   *  ihrem eigenen Step (on:true) und belegt `len` Spalten (an der
   *  Roll-Seitengrenze geklemmt, s. Dateikopf-Kommentar zur v1-Grenze
   *  "kein Auto-Scroll über die Seite hinaus"). Steps INNERHALB einer
   *  Notenlänge tragen selbst kein on:true (s. #wireRollPointer/onLengthDrag) --
   *  die Belegung entsteht rein aus Start-Step + len, nicht aus eigenen Flags. */
  #rollCoverage(row) {
    const pitch = this.rollBase + (ROLL_ROWS - 1 - row);
    const coverage = new Array(ROLL_STEPS_PER_PAGE).fill(null);
    for (let c = 0; c < ROLL_STEPS_PER_PAGE; c++) {
      const st = this.pattern[this.#rollPatIdx(c)];
      if (!st?.on || st.midi !== pitch) continue;
      const len = Math.min(st.len ?? 1, ROLL_STEPS_PER_PAGE - c);
      for (let k = 0; k < len; k++) coverage[c + k] = { startCol: c, len, idx: this.#rollPatIdx(c), vel: st.vel ?? 1 };
    }
    return coverage;
  }

  /** Eine Roll-Zeile (alle Spalten, Tonhöhe = row) neu zeichnen -- ersetzt
   *  das frühere zellenweise Rendern: eine Notenlänge kann mehrere Spalten
   *  gleichzeitig betreffen, ein einzelner Zell-Redraw wüsste das nicht. */
  #renderRollRow(row) {
    const coverage = this.#rollCoverage(row);
    for (let c = 0; c < ROLL_STEPS_PER_PAGE; c++) {
      const cov = coverage[c];
      const cell = this.rollCells[row][c];
      cell.classList.toggle('is-on', !!cov);
      cell.classList.toggle('roll-cell--head', !!cov && cov.startCol === c);
      cell.classList.toggle('roll-cell--tail', !!cov && cov.startCol + cov.len - 1 === c);
      cell.classList.toggle('roll-cell--body', !!cov && cov.startCol !== c && cov.startCol + cov.len - 1 !== c);
      // Velocity als Helligkeit, s. #renderCell -- dieselbe Formel, damit
      // Grid- und Roll-Ansicht optisch konsistent bleiben.
      cell.style.opacity = cov ? String(0.4 + 0.6 * cov.vel) : '';
    }
  }

  #renderRollAll() {
    if (!this.rollEnabled) return;
    for (let row = 0; row < ROLL_ROWS; row++) this.#renderRollRow(row);
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
    // Voller Roll-Redraw statt nur der einen Spalte: eine Notenlänge kann
    // mehrere Spalten überdecken, ein externer Einzel-Step-Schreibzugriff
    // (Live-Aufnahme) kennt diese Überdeckung nicht -- bei nur 13×8 Zellen
    // ist der volle Redraw trotzdem billig.
    if (this.rollEnabled && Math.floor(patternIdx / ROLL_STEPS_PER_PAGE) === this.rollPage) this.#renderRollAll();
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

  /** Antippen setzt/löscht die Note direkt an dieser Tonhöhe+Zeit (Kopf
   *  ODER Körper einer bestehenden Note löscht sie komplett) -- kein
   *  Ziehen nötig für die Grundfunktion, die Zeile IST schon die Tonhöhe.
   *  NEU: Ziehen ausgehend von der rechten Kante (TAIL) einer bestehenden
   *  Note verlängert/verkürzt sie stattdessen (klassischer Piano-Roll-
   *  Anfasser) -- deshalb pointerdown/-move/-up statt eines einfachen
   *  'click', um Tap und Zieh-Geste sauber zu unterscheiden (gleiches
   *  Muster wie #wirePointer() fürs Grid). v1-Grenze (Nutzer akzeptiert,
   *  s. Proposal): Ziehen bleibt auf die aktuell sichtbare Roll-Seite
   *  geklemmt, kein Auto-Scroll über die Seitengrenze hinaus -- Ziehen auf
   *  eine andere ZEILE (Tonhöhe) wird schlicht ignoriert (Resize ist eine
   *  reine Zeit-Geste, kein Tonhöhe-Wechsel mitten im Ziehen). */
  #wireRollPointer() {
    const active = new Map();

    this.rollEl.addEventListener('pointerdown', (e) => {
      const cell = e.target.closest('.roll-cell');
      if (!cell) return;
      e.preventDefault();
      this.rollEl.setPointerCapture?.(e.pointerId);
      const row = parseInt(cell.dataset.row, 10);
      const c = parseInt(cell.dataset.col, 10);
      const cov = this.#rollCoverage(row)[c];
      const isTailGrab = !!cov && cov.startCol + cov.len - 1 === c;
      active.set(e.pointerId, { row, col: c, cov, isTailGrab, resizeLen: cov?.len, moved: false });
    });

    this.rollEl.addEventListener('pointermove', (e) => {
      const drag = active.get(e.pointerId);
      if (!drag?.isTailGrab) return;
      const overCell = document.elementFromPoint(e.clientX, e.clientY)?.closest('.roll-cell');
      if (!overCell || parseInt(overCell.dataset.row, 10) !== drag.row) return;
      const c = parseInt(overCell.dataset.col, 10);
      const newLen = Math.max(1, Math.min(ROLL_STEPS_PER_PAGE - drag.cov.startCol, c - drag.cov.startCol + 1));
      if (newLen === drag.resizeLen) return;
      drag.resizeLen = newLen;
      drag.moved = true;
      this.pattern[drag.cov.idx].len = newLen;
      this.#renderRollRow(drag.row);
    });

    const finish = (e) => {
      const drag = active.get(e.pointerId);
      if (!drag) return;
      this.rollEl.releasePointerCapture?.(e.pointerId);
      active.delete(e.pointerId);
      if (drag.moved) { this.onChange?.(); return; } // Resize abgeschlossen
      // Kein Ziehen -> normaler Tap: bestehende Note (Kopf oder Körper)
      // löschen, sonst eine neue 1-Step-Note an dieser Stelle anlegen.
      const pitch = this.rollBase + (ROLL_ROWS - 1 - drag.row);
      if (drag.cov) {
        const startSt = this.pattern[drag.cov.idx];
        startSt.on = false;
        startSt.len = 1;
      } else {
        const st = this.pattern[this.#rollPatIdx(drag.col)];
        if (!st) return;
        st.on = true;
        st.midi = pitch;
        st.len = 1;
      }
      this.#renderRollRow(drag.row);
      this.onChange?.();
    };
    this.rollEl.addEventListener('pointerup', finish);
    this.rollEl.addEventListener('pointercancel', finish);
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

      // Halten auf einem BEREITS AKTIVEN Step öffnet ein Popup -- ersetzt
      // im Pitch-Modus das frühere vertikale Ziehen (Tonhöhe + Velocity),
      // im Drum-Modus gibt es jetzt (analog) ein schlankeres Popup, das
      // nur Velocity anbietet (s. openVelocityPopup, kein Tonhöhe-Konzept
      // bei Drums). Ein ausgeschalteter Step hat nichts zu bearbeiten,
      // dafür bleibt der normale kurze Tipp (schaltet ihn ein).
      if (this.pattern[idx]?.on) {
        drag.holdTimer = setTimeout(() => {
          if (drag.moved) return;
          drag.holdFired = true;
          if (this.pitchMode) {
            openPitchPopup(
              this.pattern[idx].midi, this.pattern[idx].vel ?? 1, e.clientX, e.clientY,
              (pitch) => {
                this.pattern[idx].midi = pitch;
                this.#renderCell(idx % BAR_STEPS);
                this.onChange?.();
              },
              // Velocity-Balken bewusst NICHT beim AcidBass (accentSlide) --
              // der hat mit Accent/Slide bereits ein eigenes Dynamik-
              // Konzept, zwei parallele Dynamik-Regler pro Step wären
              // widersprüchlich (s. Chat/Proposal).
              this.accentSlide ? undefined : (vel) => {
                this.pattern[idx].vel = vel;
                this.#renderCell(idx % BAR_STEPS);
                this.onChange?.();
              },
              () => {
                this.pattern[idx].on = false;
                this.#renderCell(idx % BAR_STEPS);
                this.onChange?.();
              },
            );
          } else {
            openVelocityPopup(
              this.pattern[idx].vel ?? 1, e.clientX, e.clientY,
              (vel) => {
                this.pattern[idx].vel = vel;
                this.#renderCell(idx % BAR_STEPS);
                this.onChange?.();
              },
              () => {
                this.pattern[idx].on = false;
                this.#renderCell(idx % BAR_STEPS);
                this.onChange?.();
              },
            );
          }
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
