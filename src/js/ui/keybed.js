/**
 * createKeybed — Touch-Tastatur (eine Oktave) mit Glissando + Oktave-Umschaltung.
 *
 * Ein Finger kann über die Tasten wischen; die Taste unter dem Finger
 * wird per elementFromPoint ermittelt (funktioniert für Maus, Stift und
 * Touch gleich). Für One-Shot-Instrumente einfach onNoteOff weglassen.
 *
 * Die beiden Oktave-Buttons verschieben `baseMidi` um ±12 Halbtöne;
 * bereits gehaltene Noten spielen an ihrer ursprünglichen Tonhöhe zu Ende
 * (nur künftige Anschläge nutzen die neue Oktave) — kein Sprung unter dem
 * Finger.
 */
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B', 'C'];
const OCT_MIN = 12;   // C-1
const OCT_MAX = 108;  // C8

const noteName = (midi) => `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;

export function createKeybed({ baseMidi = 60, onNoteOn, onNoteOff = () => {} }) {
  let base = baseMidi;

  const wrap = document.createElement('div');
  wrap.className = 'keybed-wrap';

  const octRow = document.createElement('div');
  octRow.className = 'keybed__oct';
  octRow.innerHTML = `
    <button class="keybed__oct-btn" data-oct="-1" aria-label="Octave down">−</button>
    <span class="keybed__oct-label"></span>
    <button class="keybed__oct-btn" data-oct="1" aria-label="Octave up">+</button>
  `;
  const octLabel = octRow.querySelector('.keybed__oct-label');
  const octDownBtn = octRow.querySelector('[data-oct="-1"]');
  const octUpBtn = octRow.querySelector('[data-oct="1"]');
  wrap.appendChild(octRow);

  const bed = document.createElement('div');
  bed.className = 'keybed';
  wrap.appendChild(bed);

  const keyEls = [];
  for (let i = 0; i <= 12; i++) {
    const key = document.createElement('div');
    const isBlack = NOTE_NAMES[i].includes('#');
    key.className = 'key' + (isBlack ? ' key--black' : '');
    bed.appendChild(key);
    keyEls.push(key);
  }

  const syncKeys = () => {
    keyEls.forEach((key, i) => { key.dataset.midi = base + i; });
    octLabel.textContent = noteName(base);
    octDownBtn.disabled = base - 12 < OCT_MIN;
    octUpBtn.disabled = base + 12 > OCT_MAX;
  };
  syncKeys();

  octRow.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-oct]');
    if (!btn || btn.disabled) return;
    base += parseInt(btn.dataset.oct, 10) * 12;
    syncKeys();
  });

  /** pointerId → { midi, el } der aktuell gedrückten Taste. Das Element
   *  wird mitgespeichert statt bei jedem Loslassen per data-midi neu
   *  gesucht — sonst würde eine während des Haltens verschobene Oktave
   *  (data-midi der Tasten ändert sich) den optischen is-down-Zustand
   *  nicht mehr finden. */
  const held = new Map();

  const press = (pointerId, keyEl) => {
    const midi = keyEl ? parseInt(keyEl.dataset.midi, 10) : null;
    const prev = held.get(pointerId);
    if (prev?.midi === midi) return;

    if (prev != null) {
      onNoteOff(prev.midi);
      prev.el.classList.remove('is-down');
    }
    if (midi != null) {
      onNoteOn(midi);
      keyEl.classList.add('is-down');
      held.set(pointerId, { midi, el: keyEl });
    } else {
      held.delete(pointerId);
    }
  };

  bed.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    bed.setPointerCapture?.(e.pointerId);
    press(e.pointerId, e.target.closest('.key'));
  });

  bed.addEventListener('pointermove', (e) => {
    if (!held.has(e.pointerId)) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    press(e.pointerId, el?.closest('.key') ?? null);
  });

  const release = (e) => {
    const prev = held.get(e.pointerId);
    if (prev != null) {
      onNoteOff(prev.midi);
      prev.el.classList.remove('is-down');
      held.delete(e.pointerId);
    }
  };
  bed.addEventListener('pointerup', release);
  bed.addEventListener('pointercancel', release);

  return wrap;
}
