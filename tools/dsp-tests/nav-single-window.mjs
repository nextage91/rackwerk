/**
 * nav-single-window.mjs — Regressionstest für die "immer nur eine Ebene
 * gleichzeitig offen"-Regel (main.js#closeAllOverlays, rack.js#
 * closeOverlays/onBeforeOpenOverlay).
 *
 * Nutzer-Anfrage: die App-Overlays "lappten" beim Bottom-Bar-Tab-Wechsel
 * übereinander, weil wireBottomBar() bisher nur die drei Konsolen (Mixer/
 * Song/Jam) gegeneinander schloss -- ein offenes Maschinen-Fokus-Overlay
 * oder das Add-Machine-Sheet blieben unangetastet im Hintergrund (bzw.
 * blockierten im Fall des Add-Machine-Sheets sogar jeden weiteren Tap
 * komplett, per Reproduktion bestätigt).
 *
 * Prüft drei reale Navigationspfade, die vorher genau das auslösten:
 *  - Maschinen-Fokus offen lassen, per Bottom-Bar zu Jam wechseln,
 *  - "+Add Machine" -> neue Maschine (öffnet automatisch ihren Fokus) ->
 *    zu Mixer wechseln,
 *  - Maschinen-Fokus offen lassen, "Projects" über den eigenen Button
 *    öffnen (nicht über die Bottom-Bar).
 * In jedem Fall darf danach GENAU EINE Overlay-Ebene sichtbar sein.
 *
 * Voraussetzung: ein lokaler Server auf dem Repo-Root, z. B.
 *   python3 -m http.server 8901
 * Dann:  node tools/dsp-tests/nav-single-window.mjs  [baseUrl]
 */
import { launchBrowser, makeReporter, openApp, baseUrlFromArgv } from './_helpers.mjs';

const { check, finish } = makeReporter();
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await openApp(page, baseUrlFromArgv());

const openLayers = () => page.evaluate(() => ({
  machineFocus: document.querySelectorAll('.machine-focus:not([hidden])').length,
  machineSheet: document.querySelectorAll('#machine-sheet:not([hidden])').length,
  projectSheet: document.querySelectorAll('#project-sheet:not([hidden])').length,
  mixerSheet: document.querySelectorAll('#mixer-sheet:not([hidden])').length,
  songSheet: document.querySelectorAll('#song-sheet:not([hidden])').length,
  jamSheet: document.querySelectorAll('#jam-sheet:not([hidden])').length,
}));
const totalOpen = (layers) => Object.values(layers).reduce((a, b) => a + b, 0);

// --- Szenario 1: eine bestehende Maschine öffnen (Rack-Fokus), dann per
// Bottom-Bar zu Jam wechseln, OHNE vorher "Zurück" zu tippen.
await page.click('.rack-row .rack-row__name');
await page.waitForTimeout(200);
let layers = await openLayers();
check('Szenario 1: Maschinen-Fokus ist offen', layers.machineFocus === 1);

await page.click('.bb-mode[data-mode="jam"]');
await page.waitForTimeout(300);
layers = await openLayers();
console.log('Szenario 1 nach Tab-Wechsel:', layers);
check('Szenario 1: genau EINE Ebene offen (nur Jam)', totalOpen(layers) === 1 && layers.jamSheet === 1);

// --- Szenario 2: "+Add Machine" -> neue Maschine wählen (öffnet automatisch
// deren Fokus, s. addMachine(..., {focus:true})) -> zu Mixer wechseln.
await page.click('.bb-mode[data-mode="rack"]');
await page.waitForTimeout(200);
await page.click('.rack__add');
await page.waitForTimeout(200);
await page.locator('.sheet__item').first().click();
await page.waitForTimeout(300);
layers = await openLayers();
console.log('Szenario 2 nach Maschine hinzufügen:', layers);
check('Szenario 2: neue Maschine öffnet ihren Fokus, Add-Sheet ist zu', layers.machineFocus === 1 && layers.machineSheet === 0);

await page.click('.bb-mode[data-mode="mix"]');
await page.waitForTimeout(300);
layers = await openLayers();
console.log('Szenario 2 nach Tab-Wechsel zu Mixer:', layers);
check('Szenario 2: genau EINE Ebene offen (nur Mixer)', totalOpen(layers) === 1 && layers.mixerSheet === 1);

// --- Szenario 3: Maschinen-Fokus offen lassen, dann "Projects" öffnen
// (nicht über die Bottom-Bar, sondern den eigenen Button).
await page.click('.bb-mode[data-mode="rack"]');
await page.waitForTimeout(200);
await page.click('.rack-row .rack-row__name');
await page.waitForTimeout(200);
layers = await openLayers();
check('Szenario 3: Maschinen-Fokus wieder offen', layers.machineFocus === 1);

await page.click('#btn-projects');
await page.waitForTimeout(200);
layers = await openLayers();
console.log('Szenario 3 nach Projects-Öffnen:', layers);
check('Szenario 3: genau EINE Ebene offen (nur Projects)', totalOpen(layers) === 1 && layers.projectSheet === 1);

check('Keine Seitenfehler', errors.length === 0);
if (errors.length) console.log(errors);

await browser.close();
process.exit(finish());
