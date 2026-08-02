/**
 * eq8-zoom-ui.mjs — UI-Regressionstest für die einstellbare Pegel-
 * Zoomstufe (±3/±6/±12/±18dB) und das Highpass/Lowpass-Flankensteilheit-
 * Menü im 8-Band-EQ (s. ui/insert-chain.js#setupEq8Graph/openEq8Menu).
 *
 * Voraussetzung: ein lokaler Server auf dem Repo-Root, z. B.
 *   python3 -m http.server 8901
 * Dann:  node tools/dsp-tests/eq8-zoom-ui.mjs  [baseUrl]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchBrowser, makeReporter, openApp, baseUrlFromArgv } from './_helpers.mjs';

const { check, finish } = makeReporter();
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await openApp(page, baseUrlFromArgv());

await page.click('.rack__add');
await page.waitForSelector('.sheet__item');
await page.click('.sheet__item');
await page.waitForSelector('.machine-focus:not([hidden])');

await page.click('.machine-focus:not([hidden]) [data-add-insert]');
await page.waitForSelector('.sheet--insert-picker:not([hidden])');
await page.click('.sheet--insert-picker [data-type="eq8"]');
await page.waitForSelector('.eq8__graph');

const dispatchPointer = async (type, id, x, y, opts = {}) => {
  await page.evaluate(({ type, id, x, y, opts }) => {
    const el = document.elementFromPoint(x, y);
    const ev = new PointerEvent(type, {
      pointerId: id, clientX: x, clientY: y, bubbles: true, cancelable: true,
      pointerType: 'touch', isPrimary: opts.isPrimary ?? true, button: 0,
    });
    (el || document.body).dispatchEvent(ev);
  }, { type, id, x, y, opts });
};

// ---------------- Zoom button row exists with all 4 ranges, default ±18 active ----------------
const zoomBtns = page.locator('.eq8__zoom [data-eq8-zoom-value]');
check('4 zoom buttons rendered', (await zoomBtns.count()) === 4);
const zoomLabels = await zoomBtns.allTextContents();
check('zoom labels are ±3/±6/±12/±18dB', JSON.stringify(zoomLabels) === JSON.stringify(['±3dB', '±6dB', '±12dB', '±18dB']));
const activeZoom = await page.locator('.eq8__zoom [data-eq8-zoom-value].is-active').getAttribute('data-eq8-zoom-value');
check('default active zoom is ±18dB', activeZoom === '18');

// Add a band at a known gain via tap, then read its Y position at ±18.
const graph = page.locator('.eq8__graph');
const box = await graph.boundingBox();
const tapX = box.x + box.width * 0.5;
const tapY = box.y + box.height * 0.5; // dead-center -> gain 0
await dispatchPointer('pointerdown', 1, tapX, tapY);
await dispatchPointer('pointerup', 1, tapX, tapY);
await page.waitForTimeout(50);
const node = page.locator('.eq8__node.is-active').first();
const cyAt18 = parseFloat(await node.getAttribute('cy'));

// Drag it up by a fixed pixel amount at ±18 zoom, record resulting cy.
const nodeClientX18 = box.x + (parseFloat(await node.getAttribute('cx')) / 300) * box.width;
const nodeClientY18 = box.y + (cyAt18 / 150) * box.height;
await dispatchPointer('pointerdown', 2, nodeClientX18, nodeClientY18);
await dispatchPointer('pointermove', 2, nodeClientX18, nodeClientY18 - 20);
await page.waitForTimeout(20);
await dispatchPointer('pointerup', 2, nodeClientX18, nodeClientY18 - 20);
await page.waitForTimeout(50);
const cyAfterDrag18 = parseFloat(await node.getAttribute('cy'));

// Switch to ±3dB zoom -> tick labels/grid must change, node re-scales.
await page.click('.eq8__zoom [data-eq8-zoom-value="3"]');
await page.waitForTimeout(50);
const activeZoomAfter = await page.locator('.eq8__zoom [data-eq8-zoom-value].is-active').getAttribute('data-eq8-zoom-value');
check('clicking ±3dB button makes it active', activeZoomAfter === '3');
const yLabels = await page.locator('.eq8__label--y').allTextContents();
check('Y-axis labels at ±3dB zoom show +3/+1/0/-1/-3-ish range (no 18 or 12)', !yLabels.some((t) => t.includes('18') || t.includes('12')));

const cyAfterZoomChange = parseFloat(await node.getAttribute('cy'));
check('node Y position visibly changes when zoom range changes (re-scaled, same gain)', Math.abs(cyAfterZoomChange - cyAfterDrag18) > 5);

// Drag by a small pixel distance at ±3dB zoom; node must stay on-graph.
const nodeClientX3 = box.x + (parseFloat(await node.getAttribute('cx')) / 300) * box.width;
const nodeClientY3 = box.y + (cyAfterZoomChange / 150) * box.height;
await dispatchPointer('pointerdown', 3, nodeClientX3, nodeClientY3);
await dispatchPointer('pointermove', 3, nodeClientX3, nodeClientY3 - 5);
await page.waitForTimeout(20);
await dispatchPointer('pointerup', 3, nodeClientX3, nodeClientY3 - 5);
await page.waitForTimeout(50);
const cyAfterSmallDrag3 = parseFloat(await node.getAttribute('cy'));
check('after a 5px drag at ±3dB zoom the node stays on the graph (no NaN/out-of-range)', Number.isFinite(cyAfterSmallDrag3) && cyAfterSmallDrag3 >= 0 && cyAfterSmallDrag3 <= 150);

// ---------------- Highpass/Lowpass + slope menu ----------------
const hx = box.x + (parseFloat(await node.getAttribute('cx')) / 300) * box.width;
const hy = box.y + (cyAfterSmallDrag3 / 150) * box.height;
await dispatchPointer('pointerdown', 4, hx, hy);
await page.waitForTimeout(600);
const menuButtonsBefore = await page.locator('.pat-chip .pat-chip__btn').allTextContents();
check('hold menu has no slope row before picking Highpass/Lowpass', !menuButtonsBefore.some((t) => t.includes('dB/Okt') || t === 'Brickwall'));

const hpBtn = page.locator('.pat-chip .pat-chip__btn', { hasText: 'High Pass' });
await hpBtn.click();
await page.waitForTimeout(50);
const menuButtonsAfterHp = await page.locator('.pat-chip .pat-chip__btn').allTextContents();
check('slope row appears after picking High Pass (in same popup)', menuButtonsAfterHp.some((t) => t.includes('dB/Okt')));
check('Brickwall option present for High Pass', menuButtonsAfterHp.includes('Brickwall'));

// Switch to Low Pass -> Brickwall must disappear (user requirement: "nur highpass")
const lpBtn = page.locator('.pat-chip .pat-chip__btn', { hasText: 'Low Pass' });
await lpBtn.click();
await page.waitForTimeout(50);
const menuButtonsAfterLp = await page.locator('.pat-chip .pat-chip__btn').allTextContents();
check('slope row still appears for Low Pass', menuButtonsAfterLp.some((t) => t.includes('dB/Okt')));
check('Brickwall option is NOT present for Low Pass', !menuButtonsAfterLp.includes('Brickwall'));

// Pick -18 dB/Okt slope, then re-open the menu and confirm it's marked active.
const slope18Btn = page.locator('.pat-chip .pat-chip__btn', { hasText: '-18 dB/Okt' });
await slope18Btn.click();
await dispatchPointer('pointerup', 4, hx, hy);
await page.waitForTimeout(80);

await dispatchPointer('pointerdown', 5, hx, hy);
await page.waitForTimeout(600);
const slope18Active = await page.locator('.pat-chip .pat-chip__btn.is-active', { hasText: '-18 dB/Okt' }).count();
check('-18 dB/Okt marked active after re-opening menu', slope18Active === 1);
const removeBtn = page.locator('.pat-chip .pat-chip__btn', { hasText: 'Remove' });
await removeBtn.click();
await dispatchPointer('pointerup', 5, hx, hy);
await page.waitForTimeout(50);

// ---------------- Zoom persistence across export/import ----------------
// Zoom is currently ±3dB (set earlier in this test). Export the project via
// the real UI flow and confirm gainRange:3 survives into the serialized
// JSON.
await page.click('.machine-focus:not([hidden]) .machine-focus__back');
await page.waitForTimeout(150);
await page.click('#btn-projects');
await page.waitForSelector('#project-sheet:not([hidden])');
const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.click('#btn-export'),
]);
const filePath = path.join(os.tmpdir(), `rackwerk-eq8-zoom-test-${process.pid}.json`);
await download.saveAs(filePath);
const json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
fs.rmSync(filePath, { force: true });
let eq8Insert;
for (const m of json.machines ?? []) {
  eq8Insert = m.inserts?.find((i) => i.type === 'eq8');
  if (eq8Insert) break;
}
check('exported eq8 insert has gainRange:3 (persisted zoom level)', eq8Insert?.params?.gainRange === 3);

check('No page errors', errors.length === 0);
if (errors.length) console.log(errors);

await browser.close();
process.exit(finish());
