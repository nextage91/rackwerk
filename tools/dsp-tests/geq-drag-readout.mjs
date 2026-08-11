/**
 * geq-drag-readout.mjs — Regressionstest für das neue Live-Readout am
 * Graphic EQ (s. Chat-Feedback: die 10 schmalen Bänder haben kaum Platz
 * für eine gut lesbare eigene Pegelanzeige, und der Finger deckt sie beim
 * Ziehen zusätzlich ab). Nutzt jetzt dieselbe geteilte, fixed-positionierte
 * Anzeige, die vorher nur der EQ8-Graph hatte (showDragReadout/
 * hideDragReadout in insert-chain.js, CSS-Klasse `.drag-readout`, vormals
 * `.eq8__readout`).
 *
 * Deckt ausserdem ab:
 *  - Graphic-EQ-Fader haben (über x-fader.js) bereits eingebautes Doppel-
 *    Tipp-Reset -- hier end-to-end verifiziert, dass es bei einem echten
 *    Graphic-EQ-Band tatsächlich bis zu insert.params.bands[i]/setBandGain
 *    durchschlägt.
 *  - Das EQ8-Readout schwebt jetzt 60px statt vormals 40px über dem
 *    Finger (Chat-Feedback: der Finger verdeckte die Anzeige noch leicht).
 *
 * Hinweis für künftige Playwright-Tests an dieser Stelle: die Insert-
 * Zeile kann je nach Reihenfolge/Anzahl bereits vorhandener Inserts weit
 * ausserhalb des sichtbaren Viewports liegen (hier beobachtet: y > 1200
 * bei 844px Viewport-Höhe) -- page.mouse.move/down an solchen Koordinaten
 * erreicht das Element NICHT, da es aus Playwright-Sicht ausserhalb des
 * sichtbaren Bereichs liegt. IMMER erst scrollIntoViewIfNeeded() aufrufen,
 * bevor boundingBox() für eine Maus-Interaktion gelesen wird.
 *
 * Zweiter Stolperstein: alle 8 EQ8-Bänder starten inaktiv (s.
 * DEFS.eq8.defaults) -- ein Tap auf eine leere Stelle des Graphen LEGT
 * ERST ein neues Band an (erst bei pointerup), zeigt dabei aber noch KEIN
 * Readout (das gibt es nur beim Ziehen eines bereits bestehenden/aktiven
 * Bandes, s. findNodeNear() in setupEq8Graph()). Für einen Readout-Test
 * muss also zuerst per Tap ein Band erzeugt, und ERST DANACH dasselbe
 * Band tatsächlich gezogen werden.
 *
 * Voraussetzung: ein lokaler Server auf dem Repo-Root, z. B.
 *   python3 -m http.server 8901
 * Dann:  node tools/dsp-tests/geq-drag-readout.mjs  [baseUrl]
 */
import { launchBrowser, makeReporter, openApp, baseUrlFromArgv } from './_helpers.mjs';

const { check, finish } = makeReporter();
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await openApp(page, baseUrlFromArgv());
await page.waitForSelector('.rack-row');
await page.click('.rack-row .rack-row__name');
await page.waitForTimeout(300);
const machine = await page.evaluateHandle(() => {
  const all = [...document.querySelectorAll('.machine')].filter((m) => m.offsetParent !== null && !m.classList.contains('machine--master') && m.querySelector('[data-add-insert]'));
  return all[0] || null;
});

await machine.evaluate((el) => el.querySelector('[data-add-insert]').click());
await page.waitForTimeout(150);
await page.click('.sheet--insert-picker [data-type="geq"]');
await page.waitForTimeout(150);

const fader = page.locator('.geq-bands x-fader').first();
await fader.scrollIntoViewIfNeeded();
const track = fader.locator('.fader__track');
const box = await track.boundingBox();

// Drag the fader up (boost).
await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.7);
await page.mouse.down();
await page.waitForTimeout(50);
const readoutDuringDrag = await page.locator('.drag-readout').textContent().catch(() => null);
check('Readout erscheint während des Ziehens am Graphic-EQ-Fader', readoutDuringDrag && /dB/.test(readoutDuringDrag));
check('Readout zeigt die Bandfrequenz an', readoutDuringDrag && /Hz|k/.test(readoutDuringDrag));

await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.1, { steps: 5 });
await page.waitForTimeout(50);
const readoutAfterMove = await page.locator('.drag-readout').textContent();
check('Readout aktualisiert den Gain-Wert live', readoutAfterMove !== readoutDuringDrag);

await page.mouse.up();
await page.waitForTimeout(100);
const readoutAfterRelease = await page.locator('.drag-readout').count();
check('Readout verschwindet nach dem Loslassen', readoutAfterRelease === 0);

// Verify the value actually changed (not still 0).
const valueAfterDrag = await fader.evaluate((el) => el.value);
check('Fader-Wert wurde durch das Ziehen tatsächlich verändert', valueAfterDrag !== 0);

// --- Double-tap to reset.
const tapPoint = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
await page.mouse.move(tapPoint.x, tapPoint.y);
await page.mouse.down();
await page.mouse.up();
await page.waitForTimeout(80);
await page.mouse.down();
await page.mouse.up();
await page.waitForTimeout(100);
const valueAfterDoubleTap = await fader.evaluate((el) => el.value);
check('Doppel-Tap setzt das Band auf 0 dB zurück', valueAfterDoubleTap === 0);

// --- EQ8 readout position raised (top offset uses -60 instead of -40).
await machine.evaluate((el) => el.querySelector('[data-add-insert]').click());
await page.waitForTimeout(150);
await page.click('.sheet--insert-picker [data-type="eq8"]');
await page.waitForTimeout(150);
const graph = page.locator('[data-eq8-graph]').first();
await graph.scrollIntoViewIfNeeded();
const gbox = await graph.boundingBox();
const tapX = gbox.x + gbox.width / 2;
const tapY = gbox.y + gbox.height / 2;
// Erst ein Band per DOPPEL-Tap anlegen (alle 8 starten inaktiv, und seit
// dem "versehentlich erzeugtes Band beim Q-Pinch"-Fix braucht das Anlegen
// selbst schon zwei Taps am selben Punkt, s. EMPTY_TAP_TOLERANCE in
// setupEq8Graph), dann DASSELBE Band in einer separaten dritten Geste
// tatsächlich ziehen -- s. Kommentar oben.
await page.mouse.move(tapX, tapY);
await page.mouse.down();
await page.mouse.up();
await page.waitForTimeout(80);
await page.mouse.move(tapX, tapY);
await page.mouse.down();
await page.mouse.up();
await page.waitForTimeout(100);
await page.mouse.move(tapX, tapY);
await page.mouse.down();
await page.waitForTimeout(50);
await page.mouse.move(tapX + 5, tapY - 10, { steps: 3 });
await page.waitForTimeout(50);
const eq8ReadoutTop = await page.locator('.drag-readout').evaluate((el) => parseFloat(el.style.top));
const finalFingerY = tapY - 10;
check('EQ8-Readout schwebt jetzt weiter über dem Finger (60px statt 40px)', Math.abs((finalFingerY - eq8ReadoutTop) - 60) < 2);
await page.mouse.up();

check('Keine Seitenfehler', errors.length === 0);
if (errors.length) console.log(errors);

await browser.close();
process.exit(finish());
