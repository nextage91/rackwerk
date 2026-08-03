/**
 * master-filter-spring.mjs — Regressionstest für den Auto-Return-Taster am
 * Sweep-Regler des Master-Filters (s. fx.js#filterSweepSpring, Nutzer-
 * Anfrage: "ein Button wie beim X/Y-Pad, wo der Regler beim Loslassen auf
 * die Mitte [Dry-Signal] zurückspringt").
 *
 * Geprüft wird an BEIDEN physischen Vorkommen von Sweep -- dem echten
 * Knob im Rack-Panel-Master-FX-Abschnitt UND dem eigenständigen Sweep-Pad
 * in der Jam-Ansicht (s. jam-view.js#buildSweepPanel, Folge-Umbau: Sweep
 * ist dort inzwischen eine einachsige Touch-Fläche statt eines Knobs) --
 * weil beides unabhängige Bedienelemente mit je eigenem Pointer-Handling
 * sind. Ausserdem: Reso hat KEINEN Auto-Return-Taster (keine "neutrale"
 * Mitte) -- und bei ausgeschaltetem Taster bleibt der Sweep-Wert nach dem
 * Loslassen stehen wie jeder normale Regler.
 *
 * Voraussetzung: ein lokaler Server auf dem Repo-Root, z. B.
 *   python3 -m http.server 8901
 * Dann:  node tools/dsp-tests/master-filter-spring.mjs  [baseUrl]
 */
import { launchBrowser, makeReporter, openApp, baseUrlFromArgv } from './_helpers.mjs';

const { check, finish } = makeReporter();
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await openApp(page, baseUrlFromArgv());

/** Zieht den Dial eines Sweep-Knobs per echtem Pointer-Drag von der
 *  Mitte weg und lässt wieder los -- knob-release feuert <x-knob> nur bei
 *  einer ECHTEN Zieh-Geste (s. ui/knob.js-Kommentar), nicht bei einem
 *  synthetisch gesetzten .value. */
async function dragAndRelease(dialLocator, dyPx) {
  await dialLocator.scrollIntoViewIfNeeded();
  const box = await dialLocator.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + dyPx, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(80);
}

check('Reso hat keinen Auto-Return-Taster',
  await page.evaluate(() => document.querySelectorAll('#master-fx [data-sweep-spring]').length === 1));

// ---- Rack-Panel: Taster AUS -> Wert bleibt nach dem Loslassen stehen ----
const rackDial = page.locator('#master-fx x-knob[data-p="filterSweep"] .knob__dial');
await dragAndRelease(rackDial, -60); // hoch = mehr (s. knob.js)
const afterDragOff = await page.locator('#master-fx x-knob[data-p="filterSweep"]').evaluate((el) => parseFloat(el.value));
check('Rack-Panel, Auto-Return AUS: Sweep bleibt nach dem Loslassen auf dem gezogenen Wert', afterDragOff > 0.1);

// ---- Rack-Panel: Taster AN -> Wert springt beim Loslassen auf 0 ----
await page.click('#master-fx [data-sweep-spring]');
check('Auto-Return-Taster reagiert auf Klick (is-active)',
  await page.locator('#master-fx [data-sweep-spring]').evaluate((el) => el.classList.contains('is-active')));
await dragAndRelease(rackDial, -60);
const afterDragOn = await page.locator('#master-fx x-knob[data-p="filterSweep"]').evaluate((el) => parseFloat(el.value));
check('Rack-Panel, Auto-Return AN: Sweep springt beim Loslassen auf 0 zurück', afterDragOn === 0);

// ---- Jam-Ansicht: derselbe geteilte Zustand, aber ein eigenständiges
// Sweep-Pad statt eines Knobs ----
await page.click('.bb-mode[data-mode="jam"]');
await page.waitForSelector('#jam-sheet:not([hidden])');
await page.waitForTimeout(300);
check('Auto-Return-Taster im Jam-Master-Kanal zeigt den geteilten Zustand (bereits AN)',
  await page.locator('.channel--master [data-sweep-spring]').evaluate((el) => el.classList.contains('is-active')));

const sweepPad = page.locator('.channel--master .sweep-pad');
await sweepPad.scrollIntoViewIfNeeded();
const padBox = await sweepPad.boundingBox();
// Von der Mitte Richtung unten (Highcut/+1) ziehen und wieder loslassen --
// bei aktivem Auto-Return muss der ECHTE Rack-Regler danach exakt auf 0
// zurückspringen (dieselbe Prüfung wie zuvor beim Jam-Klon-Knob, nur mit
// dem neuen Pad als Bedienelement).
await page.mouse.move(padBox.x + padBox.width / 2, padBox.y + padBox.height * 0.5);
await page.mouse.down();
await page.mouse.move(padBox.x + padBox.width / 2, padBox.y + padBox.height * 0.9, { steps: 6 });
const duringDrag = await page.locator('#master-fx x-knob[data-p="filterSweep"]').evaluate((el) => parseFloat(el.value));
await page.mouse.up();
await page.waitForTimeout(80);
check('Sweep-Pad-Drag Richtung unten bewegt den echten Regler Richtung +1 (Highcut) vor dem Loslassen',
  duringDrag > 0.5);

const rackAfterJamDrag = await page.locator('#master-fx x-knob[data-p="filterSweep"]').evaluate((el) => parseFloat(el.value));
check('Sweep-Pad, Auto-Return AN (geteilter Zustand): der echte Rack-Regler springt beim Loslassen auf 0 zurück',
  rackAfterJamDrag === 0);

check('Keine Seitenfehler', errors.length === 0);
if (errors.length) console.log(errors);

await browser.close();
process.exit(finish());
