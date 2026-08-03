/**
 * jam-master-channel.mjs — Regressionstest für den neuen Master-Kanal in
 * der Jam-Ansicht (Nutzer-Anfrage: "Master-Effekte während des Jams live
 * performen können, wie bei den anderen Kanälen -- mit X/Y-Pad und
 * einer Filter-Sektion für die Song-Performance, statt zugeklappter
 * Makros, da kein Fader den Platz braucht").
 *
 * Kernrisiko: buildXYPad()/buildMacros()-Äquivalente wurden ursprünglich
 * NUR für echte Machine-Instanzen geschrieben (machine.el/.xyMap/
 * .xySpring) -- masterFX ist keine Machine-Unterklasse. Dieser Test
 * prüft, dass die Wiederverwendung für masterFX TATSÄCHLICH funktioniert:
 * X/Y-Pad-Drag und Filter-Knob-Dreh müssen echte, hörbare Master-Parameter
 * verändern (revLevel/filterSweep), nicht nur eine Attrappe ohne Wirkung
 * zeigen.
 *
 * Voraussetzung: ein lokaler Server auf dem Repo-Root, z. B.
 *   python3 -m http.server 8901
 * Dann:  node tools/dsp-tests/jam-master-channel.mjs  [baseUrl]
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
await page.waitForSelector('.rack-row');
await page.click('.bb-mode[data-mode="jam"]');
await page.waitForTimeout(300);

check('Jam view shows a Master column', await page.evaluate(() => !!document.querySelector('.channel--master')));
check('Master column has an X/Y pad', await page.evaluate(() => !!document.querySelector('.channel--master .xypad')));
check('Master column has filter knobs (Sweep/Reso), always visible (no popup toggle)',
  await page.evaluate(() => document.querySelectorAll('.channel--master .macros x-knob').length === 2));
check('Master column has no fader/clips/solo-mute', await page.evaluate(() => {
  const col = document.querySelector('.channel--master');
  return !col.querySelector('.fader-row') && !col.querySelector('.clips') && !col.querySelector('.strip__row');
}));

// ---- Filter knob tatsächlich mit dem echten Master-Regler verbunden? ----
const beforeSweep = await page.evaluate(() =>
  parseFloat(document.querySelector('#master-fx x-knob[data-p="filterSweep"]').value));
await page.evaluate(() => {
  const filterKnob = document.querySelectorAll('.channel--master .macros x-knob')[0]; // Sweep (filterSweep)
  filterKnob.value = 0.7;
  filterKnob.dispatchEvent(new CustomEvent('input', { detail: { value: 0.7 }, bubbles: true }));
});
await page.waitForTimeout(50);
const afterSweep = await page.evaluate(() =>
  parseFloat(document.querySelector('#master-fx x-knob[data-p="filterSweep"]').value));
check('Dragging the Sweep filter knob updates the REAL filterSweep knob on the Rack-panel master-fx section',
  Math.abs(afterSweep - 0.7) < 0.01 && afterSweep !== beforeSweep);

// ---- X/Y-Pad tatsächlich mit den echten Master-Reglern verbunden? ----
// Echtes Touch-Event via CDP statt eines synthetischen PointerEvents --
// pad.setPointerCapture() in buildXYPad() braucht einen ECHTEN, vom
// Browser selbst erzeugten Pointer, s. xypad-multitouch.mjs für dasselbe
// Muster/dieselbe Begründung.
const beforeRevLevel = await page.evaluate(() =>
  parseFloat(document.querySelector('#master-fx x-knob[data-p="revLevel"]').value));
const padBox = await page.locator('.channel--master .xypad').boundingBox();
const cdp = await context.newCDPSession(page);
const padX = padBox.x + padBox.width * 0.9;
const padY = padBox.y + padBox.height * 0.1; // nahe oben = hoher Y-Wert
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: padX, y: padY, id: 1 }] });
await page.waitForTimeout(80);
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await page.waitForTimeout(80);
const afterRevLevel = await page.evaluate(() =>
  parseFloat(document.querySelector('#master-fx x-knob[data-p="revLevel"]').value));
check('Dragging the X/Y pad (near top -- high Y) changes the REAL revLevel knob',
  afterRevLevel !== beforeRevLevel);

check('Keine Seitenfehler', errors.length === 0);
if (errors.length) console.log(errors);

await browser.close();
process.exit(finish());
