/**
 * clampPopupLeft — klemmt die horizontale Position eines an document.body
 * gehängten Popups (Menü, Umbenennen-Popover, X/Y-Kontextmenü, ...) an den
 * Rand der gerade sichtbaren App-Oberfläche statt an den rohen Browser-
 * Viewport.
 *
 * Grund: Auf Desktop-Breiten (s. app.css, Sektion "Desktop (>=900px)")
 * werden der Maschinen-Vollbild-Editor (.machine-focus__panel) und die
 * Mixer/Song/Jam-Konsole (.sheet__panel--console) zentriert mit Rand
 * dargestellt statt kantenlos -- ein Popup, das weiterhin gegen
 * window.innerWidth klemmt, könnte dadurch in den abgedunkelten Rand NEBEN
 * dem Panel rutschen und dort freischwebend über dem Scrim landen, sichtbar
 * losgelöst von der eigentlich geöffneten Oberfläche.
 *
 * Fällt auf window.innerWidth zurück, wenn gerade kein solches Panel offen
 * ist (z. B. ein Popup direkt in der Rack-Liste) oder auf Mobile, wo die
 * Panels ohnehin randlos sind (dort liefert getBoundingClientRect() de
 * facto dieselben Grenzen wie der Viewport, also keine Verhaltensänderung).
 */
export function clampPopupLeft(preferredLeft, popupWidth) {
  const panel =
    document.querySelector('.machine-focus:not([hidden]) .machine-focus__panel') ??
    document.querySelector('.sheet--console:not([hidden]) .sheet__panel--console');
  const rect = panel?.getBoundingClientRect();
  const min = (rect ? rect.left : 0) + 8;
  const max = (rect ? rect.right : window.innerWidth) - popupWidth - 8;
  return Math.max(min, Math.min(max, preferredLeft));
}
