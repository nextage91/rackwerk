/**
 * jam-scene-transition.mjs — Regressionstest für den Übergang zwischen zwei
 * Jam-Scenes (s. rack/jam-view.js#matchesActiveScene/matchesQueuedScene/
 * refreshActiveScene).
 *
 * Nutzer-Wunsch: tippt man während Scene B läuft auf Scene A, soll Scene B
 * KONSTANT aktiv (leuchtend) bleiben, solange der Wechsel noch nicht
 * wirklich passiert ist (Clips sind quantisiert, s. queueStopChange/
 * promoteQueuedClip -- der Wechsel landet erst am nächsten Taktanfang).
 * Scene A soll währenddessen BLINKEND als "wird geladen" markiert sein.
 * Sobald der Taktanfang tatsächlich kommt, tauscht die Markierung: Scene A
 * wird konstant aktiv, Scene B geht aus, das Blinken hört auf.
 *
 * Voraussetzung: ein lokaler Server auf dem Repo-Root, z. B.
 *   python3 -m http.server 8901
 * Dann:  node tools/dsp-tests/jam-scene-transition.mjs  [baseUrl]
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
await page.click('.machine-focus:not([hidden]) .cell[data-cell="4"]');
await page.waitForTimeout(100);
await page.click('.machine-focus:not([hidden]) .machine-focus__back');
await page.waitForTimeout(200);

await page.click('.bb-mode[data-mode="jam"]');
await page.waitForSelector('#jam-sheet:not([hidden])');
await page.waitForTimeout(300);

// .channel--master (s. jam-view.js#buildMasterColumn) sitzt jetzt fest am
// Ende der Liste, hat aber keine Clips -- ausschliessen, sonst zielt
// .last() auf den Master- statt den letzten Maschinen-Kanal.
const channel = page.locator('.channel:not(.channel--master)').last();

// Scene A: Pattern A als Clip.
await channel.locator('.proto-clip[data-slot="0"]').click();
await page.waitForTimeout(150);
await page.click('.jam-scene-chip--add');
await page.waitForTimeout(150);
const sceneA = page.locator('.jam-scene-chip[data-scene-id]').nth(0);

// Scene B: Clip stoppen, Pattern B als neuer Clip.
await channel.locator('.clip[data-clip-id]').first().click();
await page.waitForTimeout(150);
await channel.locator('.proto-clip[data-slot="1"]').click();
await page.waitForTimeout(150);
await page.click('.jam-scene-chip--add');
await page.waitForTimeout(150);
const sceneB = page.locator('.jam-scene-chip[data-scene-id]').nth(1);

check('zwei Scenes angelegt', (await page.locator('.jam-scene-chip[data-scene-id]').count()) === 2);
check('Scene B ist aktuell aktiv (frisch gespeichert)', await sceneB.evaluate((el) => el.classList.contains('is-active')));

await page.click('#btn-play');
await page.waitForTimeout(200);
await sceneA.click();
await page.waitForTimeout(120); // deutlich innerhalb eines Takts (2s bei 120bpm)

const bSolid = await sceneB.evaluate((el) => el.classList.contains('is-active'));
const aQueued = await sceneA.evaluate((el) => el.classList.contains('is-queued'));
const aActiveTooEarly = await sceneA.evaluate((el) => el.classList.contains('is-active'));
check('Scene B bleibt konstant aktiv, solange der Wechsel noch nicht passiert ist', bSolid);
check('Scene A blinkt (is-queued), ist aber noch NICHT aktiv', aQueued && !aActiveTooEarly);

await page.waitForTimeout(2200); // über den nächsten Taktanfang hinaus warten
const aActive = await sceneA.evaluate((el) => el.classList.contains('is-active'));
const bStillActive = await sceneB.evaluate((el) => el.classList.contains('is-active'));
const aStillQueued = await sceneA.evaluate((el) => el.classList.contains('is-queued'));
check('nach dem Taktanfang: Scene A ist jetzt konstant aktiv', aActive);
check('nach dem Taktanfang: Scene B ist aus', !bStillActive);
check('nach dem Taktanfang: Scene A blinkt nicht mehr', !aStillQueued);

await page.click('#btn-play'); // Transport wieder anhalten

check('Keine Seitenfehler', errors.length === 0);
if (errors.length) console.log(errors);

await browser.close();
process.exit(finish());
