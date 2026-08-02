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
 *    bei laufendem Transport tatsächlich (scaleX ändert sich über Zeit).
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
await page.click('.machine-focus:not([hidden]) .cell[data-cell="0"]');
await page.waitForTimeout(100);
await page.click('.machine-focus:not([hidden]) .machine-focus__back');
await page.waitForTimeout(200);

await page.click('.bb-mode[data-mode="jam"]');
await page.waitForSelector('#jam-sheet:not([hidden])');
await page.waitForTimeout(300);

const channel = page.locator('.channel').first();
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
await page.click('#btn-play'); // Transport wieder anhalten

check('Keine Seitenfehler', errors.length === 0);
if (errors.length) console.log(errors);

await browser.close();
process.exit(finish());
