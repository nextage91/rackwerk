/**
 * undo.js — »Letzte destruktive Aktion rückgängig machen«.
 *
 * Bewusst nur ein Slot statt ein Stack: der Undo-Toast zeigt ohnehin immer
 * nur die letzte Aktion an, ältere wären über die UI gar nicht erreichbar.
 * Jede Stelle im Code, die etwas ohne Rückfrage löscht (Maschine entfernen,
 * Pattern leeren, …), ruft nach der Aktion `undo.offer(label, fn)` auf;
 * `fn` macht die Aktion beim Antippen von »Undo« rückgängig.
 */
let last = null; // { label, run() }
const listeners = new Set();

function notify() {
  for (const fn of listeners) fn(last);
}

export const undo = {
  offer(label, run) {
    last = { label, run };
    notify();
  },
  trigger() {
    if (!last) return;
    const entry = last;
    last = null;
    notify();
    entry.run();
  },
  onChange(fn) { listeners.add(fn); },
};
