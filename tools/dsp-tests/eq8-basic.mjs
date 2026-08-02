/**
 * eq8-basic.mjs — Grundinteraktion des 8-Band-EQ-Touch-Graphen: Tap fügt
 * ein Band hinzu, Ein-Finger-Drag ändert Freq/Gain, Zwei-Finger-Pinch
 * ändert Q ohne die Node zu bewegen, Halten öffnet das Typ-Menü, Remove
 * entfernt das Band wieder (s. ui/insert-chain.js#setupEq8Graph).
 *
 * Voraussetzung: ein lokaler Server auf dem Repo-Root, z. B.
 *   python3 -m http.server 8901
 * Dann:  node tools/dsp-tests/eq8-basic.mjs  [baseUrl]
 */
import { launchBrowser, makeReporter, openApp, baseUrlFromArgv } from './_helpers.mjs';

const { check, finish } = makeReporter();
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await openApp(page, baseUrlFromArgv());

// Add a machine (SubSynth is first in REGISTRY) -> opens focus automatically
await page.click('.rack__add');
await page.waitForSelector('.sheet__item');
await page.click('.sheet__item');
await page.waitForSelector('.machine-focus:not([hidden])');

// Add an EQ8 insert
await page.click('.machine-focus:not([hidden]) [data-add-insert]');
await page.waitForSelector('.sheet--insert-picker:not([hidden])');
await page.click('.sheet--insert-picker [data-type="eq8"]');

await page.waitForSelector('.eq8__graph');
// Nur AKTIVE Bänder bekommen einen sichtbaren Punkt im Graphen (s. Fix
// "always-visible unremovable EQ8 dot") -- ein frisches eq8 hat also
// weder .eq8__node- noch .is-active-Elemente, bis der Nutzer tippt.
check('no band nodes rendered before any tap', (await page.locator('.eq8__node').count()) === 0);

const graph = page.locator('.eq8__graph');
const box = await graph.boundingBox();

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

// --- Tap empty area -> needs a SECOND tap at (roughly) the same spot to
// actually add a band (s. EMPTY_TAP_TOLERANCE/lastEmptyTapPos in
// setupEq8Graph) -- a single tap used to create one immediately, which
// too easily fired by accident while trying to pinch-adjust an existing
// band's Q (s. Chat-Feedback).
const tapX = box.x + box.width * 0.5;
const tapY = box.y + box.height * 0.4;
await dispatchPointer('pointerdown', 1, tapX, tapY);
await dispatchPointer('pointerup', 1, tapX, tapY);
await page.waitForTimeout(50);
check('a single tap on empty graph does NOT yet create a band', (await page.locator('.eq8__node.is-active').count()) === 0);

await dispatchPointer('pointerdown', 1, tapX, tapY);
await dispatchPointer('pointerup', 1, tapX, tapY);
await page.waitForTimeout(50);
check('a second tap at the same spot activates exactly one band', (await page.locator('.eq8__node.is-active').count()) === 1);

const activeNode = page.locator('.eq8__node.is-active').first();
const cx0 = parseFloat(await activeNode.getAttribute('cx'));
const cy0 = parseFloat(await activeNode.getAttribute('cy'));

// Node position in client coords for further gestures
const nodeClientX = box.x + (cx0 / 300) * box.width;
const nodeClientY = box.y + (cy0 / 150) * box.height;

// --- Single-finger drag -> change freq/gain ---
await dispatchPointer('pointerdown', 2, nodeClientX, nodeClientY);
for (let i = 1; i <= 5; i++) {
  await dispatchPointer('pointermove', 2, nodeClientX + i * 8, nodeClientY - i * 4);
  await page.waitForTimeout(16);
}
await dispatchPointer('pointerup', 2, nodeClientX + 40, nodeClientY - 20);
await page.waitForTimeout(50);
const cx1 = parseFloat(await activeNode.getAttribute('cx'));
const cy1 = parseFloat(await activeNode.getAttribute('cy'));
check('single-finger drag moves the node (freq/gain changed)', cx1 !== cx0 || cy1 !== cy0);

const curveBefore = await page.locator('[data-eq8-curve]').getAttribute('d');

// --- Two-finger pinch on the node -> change Q, node should NOT move ---
const ncx = box.x + (cx1 / 300) * box.width;
const ncy = box.y + (cy1 / 150) * box.height;
await dispatchPointer('pointerdown', 3, ncx - 2, ncy);
await dispatchPointer('pointerdown', 4, ncx + 15, ncy, { isPrimary: false });
for (let i = 1; i <= 6; i++) {
  await dispatchPointer('pointermove', 3, ncx - 2 - i * 6, ncy);
  await dispatchPointer('pointermove', 4, ncx + 15 + i * 6, ncy, { isPrimary: false });
  await page.waitForTimeout(16);
}
await dispatchPointer('pointerup', 3, ncx - 40, ncy);
await dispatchPointer('pointerup', 4, ncx + 55, ncy, { isPrimary: false });
await page.waitForTimeout(50);
const cx2 = parseFloat(await activeNode.getAttribute('cx'));
const cy2 = parseFloat(await activeNode.getAttribute('cy'));
const curveAfterPinch = await page.locator('[data-eq8-curve]').getAttribute('d');
check('two-finger pinch leaves the node position unchanged', cx2 === cx1 && cy2 === cy1);
check('two-finger pinch changes the response curve (Q)', curveBefore !== curveAfterPinch);

// --- Hold on node -> menu opens ---
const hx = box.x + (cx2 / 300) * box.width;
const hy = box.y + (cy2 / 150) * box.height;
await dispatchPointer('pointerdown', 5, hx, hy);
await page.waitForTimeout(600);
check('hold on a node opens the type/slope menu', (await page.locator('.pat-chip').count()) >= 1);
const typeButtons = await page.locator('.pat-chip .pat-chip__btn').allTextContents();
check('menu offers all 5 EQ types', ['Low Shelf', 'Peak', 'High Shelf', 'High Pass', 'Low Pass'].every((t) => typeButtons.includes(t)));

// Click "High Shelf"
const hsBtn = page.locator('.pat-chip .pat-chip__btn', { hasText: 'High Shelf' });
await hsBtn.click();
await dispatchPointer('pointerup', 5, hx, hy);
await page.waitForTimeout(50);

// Re-open hold menu and remove
await dispatchPointer('pointerdown', 6, hx, hy);
await page.waitForTimeout(600);
const removeBtn = page.locator('.pat-chip .pat-chip__btn', { hasText: 'Remove' });
await removeBtn.click();
await dispatchPointer('pointerup', 6, hx, hy);
await page.waitForTimeout(50);
check('Remove deactivates the band again', (await page.locator('.eq8__node.is-active').count()) === 0);

check('No page errors', errors.length === 0);
if (errors.length) console.log(errors);

await browser.close();
process.exit(finish());
