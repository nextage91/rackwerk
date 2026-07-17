/**
 * hints — kontextuelle Einmal-Hinweise für versteckte Gesten (Long-Press,
 * REC-Doppelbedeutung, …). Jeder Hinweis feuert genau einmal pro Gerät
 * (Flag in store, überlebt Reloads) und danach nie wieder — kein Tutorial,
 * das man wegklicken muss, sondern eine kurze Erklärung im Moment, in dem
 * die Geste zum ersten Mal relevant wird.
 */
import { store } from './store.js';

export const hintSeen = (key) => store.get(`hint-seen:${key}`) === '1';
export const markHintSeen = (key) => store.set(`hint-seen:${key}`, '1');

/** Zeigt `show()` nur beim ersten Aufruf für diesen `key` (jemals). */
export function hintOnce(key, show) {
  if (hintSeen(key)) return;
  markHintSeen(key);
  show();
}

let toastEl = null;
let hideTimer = null;

/** Kurzer Hinweis-Toast unten im Bild (eigener Stil, länger lesbar als
 *  die kurzen Bestätigungs-Toasts von Automation/Undo). */
export function showHintToast(text, ms = 5000) {
  toastEl?.remove();
  clearTimeout(hideTimer);
  const el = document.createElement('div');
  el.className = 'hint-toast';
  el.textContent = text;
  document.body.appendChild(el);
  toastEl = el;
  hideTimer = setTimeout(() => {
    el.remove();
    if (toastEl === el) toastEl = null;
  }, ms);
}
