/**
 * pattern-bank — A/B/C/D-Umschalter über dem Step-Sequenzer.
 *
 * Tippen  = Pattern wählen.
 * Halten  = aktuelles Pattern in diesen Slot kopieren (und dorthin wechseln)
 *           — der schnelle Weg, aus einem Groove Variationen zu bauen.
 *
 * Die Bank ist reine UI; die Datenhaltung (4 Pattern-Slots) und das
 * eigentliche Umschalten/Kopieren macht die Maschine über die Callbacks.
 */
const LETTERS = ['A', 'B', 'C', 'D'];
const HOLD_MS = 500;

export function createPatternBank({ index = 0, onSwitch, onCopy } = {}) {
  const el = document.createElement('div');
  el.className = 'patbank';
  el.innerHTML = '<span class="patbank__label">Pattern</span>';

  const btns = LETTERS.map((letter, i) => {
    const b = document.createElement('button');
    b.className = 'patbank__btn' + (i === index ? ' is-active' : '');
    b.textContent = letter;
    b.setAttribute('aria-label', `Pattern ${letter} (halten: aktuelles hierher kopieren)`);

    let holdTimer = null;
    let held = false;
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      held = false;
      holdTimer = setTimeout(() => {
        held = true;
        onCopy?.(i);
        flash(b);
      }, HOLD_MS);
    });
    const cancel = () => clearTimeout(holdTimer);
    b.addEventListener('pointerup', () => {
      clearTimeout(holdTimer);
      if (!held) { setActive(i); onSwitch?.(i); }
    });
    b.addEventListener('pointerleave', cancel);
    b.addEventListener('pointercancel', cancel);
    return b;
  });
  for (const b of btns) el.appendChild(b);

  function setActive(i) {
    btns.forEach((b, j) => b.classList.toggle('is-active', j === i));
  }
  function flash(b) {
    b.classList.add('is-copied');
    setTimeout(() => b.classList.remove('is-copied'), 320);
  }

  return { el, setActive };
}
