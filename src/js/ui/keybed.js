/**
 * createKeybed — Touch-Tastatur (eine Oktave) mit Glissando.
 *
 * Ein Finger kann über die Tasten wischen; die Taste unter dem Finger
 * wird per elementFromPoint ermittelt (funktioniert für Maus, Stift und
 * Touch gleich). Für One-Shot-Instrumente einfach onNoteOff weglassen.
 */
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B', 'C'];

export function createKeybed({ baseMidi = 60, onNoteOn, onNoteOff = () => {} }) {
  const bed = document.createElement('div');
  bed.className = 'keybed';

  for (let i = 0; i <= 12; i++) {
    const key = document.createElement('div');
    const isBlack = NOTE_NAMES[i].includes('#');
    key.className = 'key' + (isBlack ? ' key--black' : '');
    key.dataset.midi = baseMidi + i;
    bed.appendChild(key);
  }

  /** pointerId → aktuell gedrückte MIDI-Note */
  const held = new Map();

  const press = (pointerId, keyEl) => {
    const midi = keyEl ? parseInt(keyEl.dataset.midi, 10) : null;
    const prev = held.get(pointerId);
    if (prev === midi) return;

    if (prev != null) {
      onNoteOff(prev);
      bed.querySelector(`[data-midi="${prev}"]`)?.classList.remove('is-down');
    }
    if (midi != null) {
      onNoteOn(midi);
      keyEl.classList.add('is-down');
      held.set(pointerId, midi);
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
    const midi = held.get(e.pointerId);
    if (midi != null) {
      onNoteOff(midi);
      bed.querySelector(`[data-midi="${midi}"]`)?.classList.remove('is-down');
      held.delete(e.pointerId);
    }
  };
  bed.addEventListener('pointerup', release);
  bed.addEventListener('pointercancel', release);

  return bed;
}
