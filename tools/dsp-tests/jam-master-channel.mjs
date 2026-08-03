/**
 * jam-master-channel.mjs — Regressionstest für den Master-Kanal in der
 * Jam-Ansicht (Nutzer-Anfrage: "Master-Effekte während des Jams live
 * performen können, wie bei den anderen Kanälen" -- inzwischen weiter-
 * entwickelt zu "Sweep als eigene Touch-Fläche statt Encoder, wie das
 * X/Y-Pad, nur eine Achse", s. jam-view.js#buildSweepPanel).
 *
 * Kernrisiko: buildXYPad() wurde ursprünglich NUR für echte Machine-
 * Instanzen geschrieben (machine.el/.xyMap/.xySpring) -- masterFX ist
 * keine Machine-Unterklasse. Dieser Test prüft, dass die Wiederverwendung
 * für masterFX TATSÄCHLICH funktioniert: X/Y-Pad-Drag und Sweep-Pad-Drag
 * müssen echte, hörbare Master-Parameter verändern (revLevel/filterSweep),
 * nicht nur eine Attrappe ohne Wirkung zeigen.
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
check('Master column has an X/Y pad', await page.evaluate(() => !!document.querySelector('.channel--master .xy-wrap .xypad')));
check('Master column has a dedicated Sweep pad (single-axis touch strip)',
  await page.evaluate(() => !!document.querySelector('.channel--master .sweep-pad')));
check('Master column has a Reso knob, always visible',
  await page.evaluate(() => document.querySelectorAll('.channel--master .sweep-head x-knob').length === 1));
check('Master column has an auto-return toggle for the Sweep pad',
  await page.evaluate(() => !!document.querySelector('.channel--master [data-sweep-spring]')));
check('Master column has no fader/clips/solo-mute', await page.evaluate(() => {
  const col = document.querySelector('.channel--master');
  return !col.querySelector('.fader-row') && !col.querySelector('.clips') && !col.querySelector('.strip__row');
}));

// ---- Sweep-Pad tatsächlich mit dem echten Master-Regler verbunden? ----
// Echtes Touch-Event via CDP -- pad.setPointerCapture() braucht einen
// ECHTEN, vom Browser erzeugten Pointer (s. xypad-multitouch.mjs für
// dasselbe Muster/dieselbe Begründung).
const beforeSweep = await page.evaluate(() =>
  parseFloat(document.querySelector('#master-fx x-knob[data-p="filterSweep"]').value));
const sweepPadBox = await page.locator('.channel--master .sweep-pad').boundingBox();
const sweepCdp = await context.newCDPSession(page);
const sweepX = sweepPadBox.x + sweepPadBox.width / 2;
const sweepY = sweepPadBox.y + sweepPadBox.height * 0.05; // nahe oben -> Richtung Lowcut (-1)
await sweepCdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: sweepX, y: sweepY, id: 1 }] });
await page.waitForTimeout(80);
await sweepCdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await page.waitForTimeout(80);
const afterSweep = await page.evaluate(() =>
  parseFloat(document.querySelector('#master-fx x-knob[data-p="filterSweep"]').value));
check('Dragging near the top of the Sweep pad moves the REAL filterSweep knob toward -1 (lowcut)',
  afterSweep < beforeSweep && afterSweep < -0.5);

// ---- X/Y-Pad tatsächlich mit den echten Master-Reglern verbunden? ----
// Echtes Touch-Event via CDP statt eines synthetischen PointerEvents --
// pad.setPointerCapture() in buildXYPad() braucht einen ECHTEN, vom
// Browser selbst erzeugten Pointer, s. xypad-multitouch.mjs für dasselbe
// Muster/dieselbe Begründung.
const beforeRevLevel = await page.evaluate(() =>
  parseFloat(document.querySelector('#master-fx x-knob[data-p="revLevel"]').value));
const padBox = await page.locator('.channel--master .xy-wrap .xypad').boundingBox();
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
