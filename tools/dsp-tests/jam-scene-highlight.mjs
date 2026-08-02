/**
 * jam-scene-highlight.mjs — Regressionstest für die Scene-Fortschritts-
 * anzeige in der Jam-Ansicht (s. rack/jam-view.js#matchesScene/
 * refreshActiveScene/ensureSceneProgressLoop).
 *
 * Nutzer-Wunsch: der Button der gerade spielenden Scene soll leuchten/
 * markiert sein, und man soll sehen, wo im Takt sie gerade steht.
 *
 * Prüft:
 *  - eine gespeicherte Scene ist sofort als aktiv markiert (sie entspricht
 *    ja exakt dem gerade herrschenden Live-Zustand -- s. saveScene()),
 *  - weicht man EINE Spur manuell vom gespeicherten Zustand ab (Stop),
 *    verschwindet die Markierung (Ableton-Verhalten: "diese Scene,
 *    unverändert" vs. "war mal diese Scene"),
 *  - erneutes Launchen der Scene stellt die Markierung wieder her,
 *  - der Taktfortschritt-Wisch (.jam-scene-chip__progress) bewegt sich
 *    bei laufendem Transport tatsächlich (scaleX ändert sich über Zeit),
 *  - bei einem MEHRTAKTIGEN Clip (hier 2 Takte/32 Steps) dauert ein voller
 *    Zyklus tatsächlich 2 Takte, NICHT pauschal einen einzelnen Takt (s.
 *    activeSceneCycle()/getClipStepLength() -- Regressionstest für den vom
 *    Nutzer gefundenen Bug: "die scene visualisierung/ taktfortschritt
 *    stimmt nicht mit der bar länge der szene (der längste clip der
 *    szene) überein").
 *
 * Filtert den Jam-Channel bewusst über die Maschinen-ID (s.
 * `.channel__name:has-text(#id)`) statt blind `.channel.first()` zu
 * nehmen -- das Default-/Seed-Projekt hat bereits eine BeatBox+SubSynth
 * VOR jeder frisch hinzugefügten Test-Maschine im Rack, `.first()` würde
 * also die falsche (unveränderte) Maschine treffen.
 *
 * Voraussetzung: ein lokaler Server auf dem Repo-Root, z. B.
 *   python3 -m http.server 8901
 * Dann:  node tools/dsp-tests/jam-scene-highlight.mjs  [baseUrl]
 */
import { launchBrowser, makeReporter, openApp, baseUrlFromArgv } from './_helpers.mjs';

const { check, finish } = makeReporter();
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await openApp(page, baseUrlFromArgv());

await page.click('.rack__add');
await page.waitForSelector('.sheet__item');
await page.click('.sheet__item');
await page.waitForSelector('.machine-focus:not([hidden])');
await page.waitForTimeout(300);

const typeText = await page.locator('.machine-focus:not([hidden]) .machine__type').innerText();
const id = typeText.match(/#(\d+)/)[1];

await page.click('.machine-focus:not([hidden]) .cell[data-cell="0"]');
await page.waitForTimeout(100);
// Pattern auf 2 Takte vergrößern (VOR dem Clip-Anlegen, ein Proto-Clip
// übernimmt beim Erzeugen eine Momentaufnahme der Pattern-Länge, s.
// addClipFromPattern() in step-sequenced-synth.js).
await page.click('.machine-focus:not([hidden]) [data-len]');
await page.waitForTimeout(150);
const lenLabel = await page.locator('.machine-focus:not([hidden]) [data-len]').innerText();
check('Pattern wurde auf 2 Takte vergrößert', lenLabel.trim() === '2B');

await page.click('.machine-focus:not([hidden]) .machine-focus__back');
await page.waitForTimeout(200);

await page.click('.bb-mode[data-mode="jam"]');
await page.waitForSelector('#jam-sheet:not([hidden])');
await page.waitForTimeout(300);

const channel = page.locator('.channel').filter({ has: page.locator('.channel__name', { hasText: `#${id}` }) });
check('Jam-Channel der neuen Maschine gefunden', (await channel.count()) === 1);
await channel.locator('.proto-clip[data-slot="0"]').click();
await page.waitForTimeout(150);

await page.click('.jam-scene-chip--add');
await page.waitForTimeout(150);
const sceneChip = page.locator('.jam-scene-chip[data-scene-id]').first();
check('eine Scene wurde gespeichert', (await sceneChip.count()) === 1);
check('frisch gespeicherte Scene ist sofort als aktiv markiert', await sceneChip.evaluate((el) => el.classList.contains('is-active')));

await channel.locator('.clip-stop').click();
await page.waitForTimeout(150);
check('Markierung verschwindet, sobald eine Spur manuell vom Scene-Zustand abweicht', !(await sceneChip.evaluate((el) => el.classList.contains('is-active'))));

await sceneChip.click();
await page.waitForTimeout(150);
check('erneutes Launchen der Scene stellt die Markierung wieder her', await sceneChip.evaluate((el) => el.classList.contains('is-active')));

await page.click('#btn-play');
await page.waitForTimeout(400);
const t1 = await sceneChip.locator('.jam-scene-chip__progress').evaluate((el) => el.style.transform);
await page.waitForTimeout(400);
const t2 = await sceneChip.locator('.jam-scene-chip__progress').evaluate((el) => el.style.transform);
console.log('Taktfortschritt:', t1, '->', t2);
check('Taktfortschritt-Wisch bewegt sich bei laufendem Transport', t1 !== t2);

// Vollen Zyklus messen: die Scene enthält einen 2-Takte-Clip, bei 120bpm
// muss ein voller Wisch-Zyklus (scaleX läuft von ~1 zurück auf ~0) daher
// ~4s dauern -- NICHT ~2s (ein einzelner Takt), was der ursprüngliche Bug
// (fixe STEPS_PER_BAR-Zykluslänge statt getClipStepLength()) gezeigt hätte.
const cycleStart = Date.now();
let wrapMs = null;
let prevScale = null;
for (let i = 0; i < 100; i++) {
  await page.waitForTimeout(80);
  const transform = await sceneChip.locator('.jam-scene-chip__progress').evaluate((el) => el.style.transform);
  const m = transform.match(/scaleX\(([\d.]+)\)/);
  const scale = m ? parseFloat(m[1]) : 0;
  if (prevScale !== null && prevScale > 0.8 && scale < 0.2) { wrapMs = Date.now() - cycleStart; break; }
  prevScale = scale;
}
console.log('Zeit für einen vollen Taktfortschritt-Zyklus:', wrapMs, 'ms (erwartet ~4000ms für 2 Takte bei 120bpm)');
check('Zyklus dauert ~2 Takte (>3000ms), entspricht dem längsten Clip der Scene', wrapMs !== null && wrapMs > 3000 && wrapMs < 5000);

await page.click('#btn-play'); // Transport wieder anhalten

check('Keine Seitenfehler', errors.length === 0);
if (errors.length) console.log(errors);

await browser.close();
process.exit(finish());
