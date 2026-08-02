/**
 * eq8-roundtrip.mjs — Projekt-Export/Import-Regressionstest für eq8: ein
 * gesetztes Band muss nach Export -> frischem Reload -> Import exakt an
 * derselben Stelle wieder erscheinen. Deckt insbesondere ab, dass die
 * neueren Felder `slope`/`gainRange` (s. core/inserts.js#DEFS.eq8) korrekt
 * mitserialisiert werden.
 *
 * Voraussetzung: ein lokaler Server auf dem Repo-Root, z. B.
 *   python3 -m http.server 8901
 * Dann:  node tools/dsp-tests/eq8-roundtrip.mjs  [baseUrl]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchBrowser, makeReporter, openApp, baseUrlFromArgv } from './_helpers.mjs';

const { check, finish } = makeReporter();
const baseUrl = baseUrlFromArgv();
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await openApp(page, baseUrl);

await page.click('.rack__add');
await page.waitForSelector('.sheet__item');
await page.click('.sheet__item');
await page.waitForSelector('.machine-focus:not([hidden])');
await page.click('.machine-focus:not([hidden]) [data-add-insert]');
await page.waitForSelector('.sheet--insert-picker:not([hidden])');
await page.click('.sheet--insert-picker [data-type="eq8"]');
await page.waitForSelector('.eq8__graph');

const box = await page.locator('.eq8__graph').boundingBox();
const dispatchPointer = async (type, id, x, y) => {
  await page.evaluate(({ type, id, x, y }) => {
    const el = document.elementFromPoint(x, y);
    const ev = new PointerEvent(type, { pointerId: id, clientX: x, clientY: y, bubbles: true, cancelable: true, pointerType: 'touch', isPrimary: true, button: 0 });
    (el || document.body).dispatchEvent(ev);
  }, { type, id, x, y });
};
const tapX = box.x + box.width * 0.7, tapY = box.y + box.height * 0.15;
// Zwei Taps am selben Punkt nötig, um ein Band zu erzeugen (s.
// EMPTY_TAP_TOLERANCE in setupEq8Graph -- Schutz gegen versehentliches
// Anlegen beim Versuch, per Pinch die Q eines Bandes einzustellen).
await dispatchPointer('pointerdown', 1, tapX, tapY);
await dispatchPointer('pointerup', 1, tapX, tapY);
await page.waitForTimeout(50);
await dispatchPointer('pointerdown', 1, tapX, tapY);
await dispatchPointer('pointerup', 1, tapX, tapY);
await page.waitForTimeout(150);

const nodeBefore = page.locator('.eq8__node.is-active').first();
const cxBefore = await nodeBefore.getAttribute('cx');
const cyBefore = await nodeBefore.getAttribute('cy');

// Zurück zum Rack, bevor das Projekt-Sheet geöffnet wird (sonst liegt es
// hinter dem noch offenen Vollbild-Editor).
await page.click('.machine-focus:not([hidden]) .machine-focus__back');
await page.waitForTimeout(150);

// Export project
await page.click('#btn-projects');
await page.waitForSelector('#project-sheet:not([hidden])');
const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.click('#btn-export'),
]);
const filePath = path.join(os.tmpdir(), `rackwerk-eq8-roundtrip-test-${process.pid}.json`);
await download.saveAs(filePath);
const json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
let eq8Insert;
for (const m of json.machines ?? []) {
  eq8Insert = m.inserts?.find((i) => i.type === 'eq8');
  if (eq8Insert) break;
}
check('exported project contains the eq8 insert with 8 bands', Array.isArray(eq8Insert?.params?.bands) && eq8Insert.params.bands.length === 8);
check('exported band carries a slope field (new since the Highpass/Lowpass feature)', typeof eq8Insert.params.bands[0].slope === 'number');
check('exported insert carries a gainRange field (new since the zoom feature)', typeof eq8Insert.params.gainRange === 'number');

// Reload fresh, then import
await openApp(page, baseUrl);

await page.click('#btn-projects');
await page.waitForSelector('#project-sheet:not([hidden])');
await page.setInputFiles('#file-input', filePath);
await page.waitForTimeout(300);
fs.rmSync(filePath, { force: true });

await page.waitForSelector('.machine-focus:not([hidden])', { timeout: 5000 }).catch(() => {});
if (await page.locator('.machine-focus:not([hidden])').count()) {
  await page.click('.machine-focus:not([hidden]) .machine-focus__back');
}
// eq8__graph liegt in der Maschine, die unser Insert hat -- nacheinander
// jede Zeile öffnen, bis sie gefunden ist (Reihenfolge nach Import nicht
// garantiert identisch zur Anzeige-Reihenfolge beim Bauen).
const rowCount = await page.locator('.rack-row').count();
let found = false;
for (let i = 0; i < rowCount; i++) {
  await page.locator('.rack-row').nth(i).click();
  await page.waitForTimeout(100);
  if (await page.locator('.machine-focus:not([hidden]) .eq8__graph').count()) { found = true; break; }
  await page.click('.machine-focus:not([hidden]) .machine-focus__back');
}
check('an eq8-bearing machine is found again after import', found);

const nodeAfter = page.locator('.eq8__node.is-active').first();
const cxAfter = await nodeAfter.getAttribute('cx');
const cyAfter = await nodeAfter.getAttribute('cy');
check('band position round-trips exactly through export/import', cxBefore === cxAfter && cyBefore === cyAfter);

check('No page errors', errors.length === 0);
if (errors.length) console.log(errors);

await browser.close();
process.exit(finish());
