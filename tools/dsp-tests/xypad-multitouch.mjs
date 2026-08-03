/**
 * xypad-multitouch.mjs — Regressionstest dafür, dass Jam-Bedienelemente
 * (Stop-Button, Clip-Kacheln, Solo/Mute, Scene-Chips) auch als ZWEITER,
 * gleichzeitig gehaltener Finger reagieren, während das X/Y-Pad mit der
 * anderen Hand gezogen wird (jam-view.js#bindTap).
 *
 * Nutzer-Anfrage: "während ich das X/Y-Pad bediene, kann ich keine andere
 * Touch-Aktion ausführen". Ursache (per echtem Multitouch über CDP
 * bestätigt): Browser erzeugen ein synthetisches 'click' NUR für den
 * PRIMÄREN aktiven Touch-Punkt -- ein zweiter, gleichzeitig gehaltener
 * Finger bekommt pointerdown/pointerup ganz normal, aber NIE ein 'click'.
 * Alle betroffenen Bedienelemente hören jetzt direkt auf pointerdown/
 * pointerup statt auf 'click' (s. bindTap()/makeReorderable()/
 * wireSceneChip() in jam-view.js).
 *
 * Nutzt Chrome DevTools Protocol (Input.dispatchTouchEvent) für ECHTES
 * simultanes Multitouch -- Playwrights eigene page.touchscreen-API kann
 * das nicht (nur Einzel-Tap). Der Zustand wird bewusst erst NACH dem
 * vollständigen Loslassen BEIDER Finger gelesen: solange Finger 1 (Pad)
 * noch aktiv gehalten wird, kann Playwrights evaluate() den bereits
 * angewendeten DOM-Zustand verzögert liefern (reine Beobachtungs-
 * Verzögerung des Test-Runners, kein Verhalten der App selbst) --
 * das eigentliche Ergebnis (hat der zweite Finger etwas ausgelöst?)
 * ist nach dem Loslassen zuverlässig sichtbar.
 *
 * Voraussetzung: ein lokaler Server auf dem Repo-Root, z. B.
 *   python3 -m http.server 8901
 * Dann:  node tools/dsp-tests/xypad-multitouch.mjs  [baseUrl]
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

await page.click('.rack__add');
await page.waitForSelector('.sheet__item');
await page.click('.sheet__item');
await page.waitForSelector('.machine-focus:not([hidden])');
await page.waitForTimeout(300);
await page.click('.machine-focus:not([hidden]) .cell[data-cell="0"]');
await page.waitForTimeout(100);
await page.click('.machine-focus:not([hidden]) .machine-focus__back');
await page.waitForTimeout(200);
await page.click('.bb-mode[data-mode="jam"]');
await page.waitForSelector('#jam-sheet:not([hidden])');
await page.waitForTimeout(300);

// .channel--master (s. jam-view.js#buildMasterColumn) sitzt jetzt fest am
// Ende der Liste, hat aber keine Clips/kein "letzter Maschinen-Kanal" --
// ausschliessen, sonst zielt .last() seit dessen Einführung auf den
// Master- statt den letzten Maschinen-Kanal.
const channel = page.locator('.channel:not(.channel--master)').last();
await channel.locator('.proto-clip[data-slot="0"]').click();
await page.waitForTimeout(150);

const pad = channel.locator('.xypad');
const stopBtn = channel.locator('.clip-stop');
const padBox = await pad.boundingBox();
const stopBox = await stopBtn.boundingBox();
const cdp = await context.newCDPSession(page);
const padX = padBox.x + padBox.width * 0.3;
const padY = padBox.y + padBox.height * 0.3;
const stopX = stopBox.x + stopBox.width / 2;
const stopY = stopBox.y + stopBox.height / 2;

// Finger 1: drückt und hält das X/Y-Pad (simuliert laufendes Ziehen).
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: padX, y: padY, id: 1 }] });
await page.waitForTimeout(100);

// Finger 2: tippt WÄHREND Finger 1 noch aktiv ist auf den Stop-Button.
await cdp.send('Input.dispatchTouchEvent', {
  type: 'touchStart',
  touchPoints: [{ x: padX, y: padY, id: 1 }, { x: stopX, y: stopY, id: 2 }],
});
await page.waitForTimeout(80);
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ x: padX, y: padY, id: 1 }] }); // Finger 2 lässt los, Finger 1 bleibt
await page.waitForTimeout(80);
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); // Finger 1 lässt auch los
await page.waitForTimeout(150);

const stopClass = await stopBtn.evaluate((el) => el.className);
const dotLeft = await channel.locator('.xypad__dot').evaluate((el) => el.style.left);
console.log('Stop-Klasse nach der Geste:', stopClass);
console.log('Dot-Position (bestätigt, dass Finger 1 parallel wirklich gezogen hat):', dotLeft);

check('X/Y-Pad reagierte auf Finger 1 (Dot bewegte sich)', dotLeft === '30%');
check('Stop-Button reagierte auf Finger 2, WÄHREND Finger 1 noch auf dem Pad war', stopClass.includes('is-active'));

check('Keine Seitenfehler', errors.length === 0);
if (errors.length) console.log(errors);

await browser.close();
process.exit(finish());
