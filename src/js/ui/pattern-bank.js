/**
 * pattern-bank — A/B/C/D-Umschalter über dem Step-Sequenzer.
 *
 * Tippen  = Pattern wählen.
 * Halten  = Kontext-Chip öffnen (wie beim Löschen von Automationen):
 *           „⧉ Kopieren" legt das Pattern in die Zwischenablage; hältst du
 *           danach ein anderes Pattern, erscheint zusätzlich „⇩ Einfügen"
 *           und überschreibt es. So baust du Varianten (auch zwischen
 *           gleichartigen Maschinen — Noten-Patterns bzw. Drum-Patterns).
 *
 * Die Bank ist reine UI; Datenhaltung/Umschalten macht die Maschine über
 * die Callbacks (onSwitch, getSlot, putSlot). `shape` trennt inkompatible
 * Ablagen (Noten vs. Drums).
 */
const LETTERS = ['A', 'B', 'C', 'D'];
const HOLD_MS = 500;

/** Geteilte Pattern-Zwischenablage (maschinenübergreifend, shape-getrennt). */
const clipboard = { shape: null, data: null };

export function createPatternBank({ index = 0, onSwitch, getSlot, putSlot, shape } = {}) {
  const el = document.createElement('div');
  el.className = 'patbank';
  el.innerHTML = '<span class="patbank__label">Pattern</span>';

  let chip = null;
  const dismiss = () => {
    chip?.remove();
    chip = null;
    document.removeEventListener('pointerdown', onOutside, true);
  };
  const onOutside = (e) => { if (chip && !chip.contains(e.target)) dismiss(); };

  const openMenu = (i, btn) => {
    dismiss();
    chip = document.createElement('div');
    chip.className = 'pat-chip';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'pat-chip__btn';
    copyBtn.textContent = '⧉ Kopieren';
    copyBtn.addEventListener('click', () => {
      clipboard.shape = shape;
      clipboard.data = getSlot(i);
      flash(btns[i]);
      dismiss();
    });
    chip.appendChild(copyBtn);

    if (clipboard.data && clipboard.shape === shape) {
      const pasteBtn = document.createElement('button');
      pasteBtn.className = 'pat-chip__btn';
      pasteBtn.textContent = '⇩ Einfügen';
      pasteBtn.addEventListener('click', () => {
        putSlot(i, clipboard.data);
        setActive(i);
        flash(btns[i]);
        dismiss();
      });
      chip.appendChild(pasteBtn);
    }

    document.body.appendChild(chip);
    // über dem Button platzieren, am Bildschirmrand einklemmen
    const r = btn.getBoundingClientRect();
    const left = Math.max(8, Math.min(
      window.innerWidth - chip.offsetWidth - 8,
      r.left + r.width / 2 - chip.offsetWidth / 2,
    ));
    chip.style.left = `${left}px`;
    chip.style.top = `${Math.max(8, r.top - chip.offsetHeight - 8)}px`;
    setTimeout(() => document.addEventListener('pointerdown', onOutside, true), 0);
    clearTimeout(chip.dismissTimer);
    chip.dismissTimer = setTimeout(dismiss, 4000);
  };

  const btns = LETTERS.map((letter, i) => {
    const b = document.createElement('button');
    b.className = 'patbank__btn' + (i === index ? ' is-active' : '');
    b.textContent = letter;
    b.setAttribute('aria-label', `Pattern ${letter} (halten: kopieren/einfügen)`);

    let holdTimer = null;
    let held = false;
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      held = false;
      holdTimer = setTimeout(() => { held = true; openMenu(i, b); }, HOLD_MS);
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
