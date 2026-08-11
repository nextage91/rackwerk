/**
 * pitch-picker-popup.mjs — Regressionstest für den neuen Pitch-Picker-
 * Popup im Sequenzer-Grid (Nutzer-Anfrage: "wenn man den pitch einer note
 * im sequencer ändern möchte, [soll] ein pop up fenster auf[gehen] wo man
 * dann die entsprechende note antippen kann" -- das alte vertikale Ziehen
 * war "fummelig").
 *
 * Ersetztes Verhalten: Halten (500ms) auf einem bereits AKTIVEN Step öffnet
 * jetzt den Picker statt (wie zuvor) auf ein vertikales Ziehen zu warten
 * (s. ui/step-seq.js#openPitchPopup). Kurzer Tipp bleibt unverändert
 * (An/Aus-Toggle) -- wichtig zu prüfen, dass diese Kern-Bedienung durch
 * den Umbau nicht kaputtgegangen ist.
 *
 * Voraussetzung: ein lokaler Server auf dem Repo-Root, z. B.
 *   python3 -m http.server 8901
 * Dann:  node tools/dsp-tests/pitch-picker-popup.mjs  [baseUrl]
 */
import { launchBrowser, makeReporter, openApp, baseUrlFromArgv } from './_helpers.mjs';

const { check, finish } = makeReporter();
const browser = await launchBrowser({ args: ['--touch-events=enabled'] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await openApp(page, baseUrlFromArgv());

// newProject() seedet immer einen SubSynth mit einer Demo-Line (s.
// subsynth.js#seedDemo) -- Step 0 ist an (MIDI 36 = C2), genau der
// Fall, den der Picker abdecken soll (Tonhöhe eines AKTIVEN Steps ändern).
await page.locator('.rack-row', { hasText: 'SubSynth' }).locator('.rack-row__name').click();
await page.waitForSelector('.machine-focus:not([hidden])');
await page.waitForTimeout(300);

const cell = page.locator('.machine-focus:not([hidden]) .cell[data-cell="0"]');
await cell.scrollIntoViewIfNeeded();
const cdp = await context.newCDPSession(page);

/** Echtes Touch-Event via CDP statt page.mouse -- setPointerCapture()
 *  braucht einen ECHTEN, vom Browser erzeugten Pointer (s. step-seq.js#
 *  wirePointer), UND ein zweiter, unabhängiger Tap auf einen Popup-Knopf
 *  (Playwrights eigenes .click()) funktioniert erst sauber, NACHDEM der
 *  ursprüngliche Finger wieder losgelassen wurde -- exakt die reale
 *  Geste (Halten mit einem Finger, dann diesen Finger heben, dann den
 *  gewünschten Knopf antippen), s. xypad-multitouch.mjs für dasselbe
 *  Muster/dieselbe Begründung bei echten Touch-Events. */
async function holdCell(locator, ms) {
  const box = await locator.boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
  await page.waitForTimeout(ms);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(100);
  return { x, y };
}
async function tapCell(locator, ms = 80) {
  const box = await locator.boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
  await page.waitForTimeout(ms);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(100);
}

// ---- Kurzer Tipp bleibt unverändert: schaltet einen aktiven Step aus. ----
check('Step 0 ist anfangs an (Demo-Line)', (await cell.getAttribute('class')).includes('is-on'));
await tapCell(cell);
check('Kurzer Tipp schaltet einen aktiven Step weiterhin aus', !(await cell.getAttribute('class')).includes('is-on'));
await tapCell(cell); // wieder an (Default-Tonhöhe) für den Rest des Tests
check('Kurzer Tipp schaltet einen ausgeschalteten Step weiterhin an', (await cell.getAttribute('class')).includes('is-on'));

// ---- Halten auf einem aktiven Step öffnet den Pitch-Picker. ----
await holdCell(cell, 600);
check('Halten (500ms+) auf einem aktiven Step öffnet den Pitch-Picker', (await page.locator('.pitch-picker').count()) === 1);
check('Der Picker zeigt eine Oktave-Zeile (Grundton-Umschaltung wie Roll-Modus/Keybed)',
  (await page.locator('.pitch-picker .keybed__oct-btn').count()) === 2);
check('Der Picker zeigt 13 antippbare Tonhöhen (eine Oktave + Grundton)',
  (await page.locator('.pitch-picker__note').count()) === 13);
check('Der Picker markiert die aktuelle Tonhöhe des Steps', (await page.locator('.pitch-picker__note.is-active').count()) === 1);

// Eine andere Tonhöhe antippen -> Step übernimmt sie, Popup schliesst.
const targetNote = page.locator('.pitch-picker__note', { hasText: 'A1' });
await targetNote.click();
await page.waitForTimeout(200);
check('Antippen einer Tonhöhe im Picker setzt sie auf dem Step', (await cell.locator('.cell__label').textContent()) === 'A1');
check('Der Picker schliesst sich nach der Auswahl', (await page.locator('.pitch-picker').count()) === 0);

// ---- Turn-off-Knopf im Picker schaltet den Step aus (Alternative zum
// erneuten kurzen Tipp), ohne dass eine falsche Tonhöhe gewählt wird. ----
await holdCell(cell, 600);
check('Popup erneut offen für den zweiten Testfall', (await page.locator('.pitch-picker').count()) === 1);
await page.locator('[data-stepoff]').click();
await page.waitForTimeout(200);
check('"Turn off" im Picker schaltet den Step aus', !(await cell.getAttribute('class')).includes('is-on'));
check('Der Picker schliesst sich nach "Turn off"', (await page.locator('.pitch-picker').count()) === 0);

// ---- Halten auf einem AUSGESCHALTETEN Step öffnet NICHTS (keine
// Tonhöhe zum Bearbeiten vorhanden) -- der normale kurze Tipp bleibt der
// einzige Weg, ihn wieder einzuschalten. ----
await holdCell(cell, 600);
check('Halten auf einem ausgeschalteten Step öffnet KEINEN Pitch-Picker', (await page.locator('.pitch-picker').count()) === 0);

check('Keine Seitenfehler', errors.length === 0);
if (errors.length) console.log(errors);

await browser.close();
process.exit(finish());
