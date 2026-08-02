/**
 * insert-move-meter.mjs — Regressionstest für Machine#rewireInsertChain
 * (und den analogen MasterFX#rewireMasterInsertChain).
 *
 * Nutzer-Bugreport: "wenn ich einen Insert-Effekt verschiebe, funktioniert
 * danach das VU-Meter nicht mehr in der ganzen Kette (auch bei anderen
 * Effekten)."
 *
 * Ursache: #rewireInsertChain() rief bislang `insert.output.disconnect()`
 * OHNE Ziel auf, bevor es die Kette neu verkabelte -- ein zielloser
 * disconnect() kappt aber ALLE ausgehenden Verbindungen eines Knotens,
 * auch den parallelen Pegel-Meter-Tap (insert.getMeterAnalyser(), s.
 * core/inserts.js). Der Analyser selbst wird nur EINMAL lazy angelegt UND
 * verbunden -- ein späterer Aufruf von getMeterAnalyser() liefert danach
 * einfach den längst verwaisten, nie wieder verbundenen Analyser zurück.
 * Betraf JEDEN Insert der Kette, nicht nur den verschobenen, weil die
 * Disconnect-Schleife über ALLE Inserts läuft -- und trat schon beim
 * ZWEITEN addInsert() auf (die erste Meter-Verbindung stirbt, sobald ein
 * zweiter Insert die Kette neu verkabelt), nicht erst beim Verschieben.
 *
 * Dieser Test fügt zwei Inserts hinzu, prüft dass beide Meter über echtes
 * Audio (Pegel-LEDs, kein interner Zustand) leuchten, verschiebt einen
 * Insert und prüft, dass BEIDE Meter danach weiterhin leuchten.
 *
 * Gegenprobe (beim Schreiben durchgeführt, nicht Teil des automatisierten
 * Laufs): mit deaktiviertem Fix zeigte bereits der erste Insert VOR dem
 * Verschieben 0 gelit-Segmente (starb schon beim Hinzufügen des zweiten
 * Inserts), nach dem Verschieben beide 0.
 *
 * Voraussetzung: ein lokaler Server auf dem Repo-Root, z. B.
 *   python3 -m http.server 8901
 * Dann:  node tools/dsp-tests/insert-move-meter.mjs  [baseUrl]
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

// Alle 16 Schritte an -- durchgängiges, verlässlich hörbares Signal.
for (let c = 0; c < 16; c++) {
  const cell = page.locator('.machine-focus:not([hidden]) .cell').nth(c);
  if (!(await cell.evaluate((el) => el.classList.contains('is-on')))) await cell.click();
}
await page.waitForTimeout(100);

const machine = page.locator('.machine-focus:not([hidden])');
await machine.locator('[data-add-insert]').click();
await page.waitForSelector('.sheet--insert-picker:not([hidden])');
await page.click('.sheet--insert-picker [data-type="comp"]');
await page.waitForTimeout(150);
await machine.locator('[data-add-insert]').click();
await page.waitForSelector('.sheet--insert-picker:not([hidden])');
await page.click('.sheet--insert-picker [data-type="drive"]');
await page.waitForTimeout(150);

const rows = machine.locator('.inserts .insert-module');
check('zwei Insert-Zeilen vorhanden', (await rows.count()) === 2);

await page.click('#btn-play');
await page.waitForTimeout(700);

const litCounts = async () => {
  const out = [];
  for (let i = 0; i < await rows.count(); i++) {
    out.push(await rows.nth(i).locator('x-meter .x-meter__seg.is-lit').count());
  }
  return out;
};

const before = await litCounts();
console.log('lit segments vor dem Verschieben:', JSON.stringify(before));
check('beide Meter leuchten schon nach dem Hinzufügen zweier Inserts (Insert 1)', before[0] > 0);
check('beide Meter leuchten schon nach dem Hinzufügen zweier Inserts (Insert 2)', before[1] > 0);

await rows.nth(1).locator('[data-move="-1"]').click();
await page.waitForTimeout(700);

const after = await litCounts();
console.log('lit segments nach dem Verschieben:', JSON.stringify(after));
check('Meter des (jetzt an Position 1 stehenden) verschobenen Inserts leuchtet weiterhin', after[0] > 0);
check('Meter des zweiten Inserts leuchtet nach dem Verschieben weiterhin (nicht nur des verschobenen)', after[1] > 0);

check('Keine Seitenfehler', errors.length === 0);
if (errors.length) console.log(errors);

await page.click('#btn-play');

await browser.close();
process.exit(finish());
