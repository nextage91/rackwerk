/**
 * eq8-select.mjs — Band-Auswahl im 8-Band-EQ-Touch-Graphen: Tippen auf ein
 * Band wählt es aus/ab, ein Zwei-Finger-Pinch abseits beider Bänder wirkt
 * auf das AUSGEWÄHLTE Band (nicht auf das, worüber die Finger gerade
 * liegen), und bewegt keines der beiden Bänder (s. ui/insert-chain.js#
 * setupEq8Graph).
 *
 * Voraussetzung: ein lokaler Server auf dem Repo-Root, z. B.
 *   python3 -m http.server 8901
 * Dann:  node tools/dsp-tests/eq8-select.mjs  [baseUrl]
 */
import { launchBrowser, makeReporter, openApp, baseUrlFromArgv } from './_helpers.mjs';

const { check, finish } = makeReporter();
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await openApp(page, baseUrlFromArgv());

await page.click('.rack__add');
await page.waitForSelector('.sheet__item');
await page.click('.sheet__item');
await page.waitForSelector('.machine-focus:not([hidden])');
await page.click('.machine-focus:not([hidden]) [data-add-insert]');
await page.waitForSelector('.sheet--insert-picker:not([hidden])');
await page.click('.sheet--insert-picker [data-type="eq8"]');
await page.waitForSelector('.eq8__graph');

const box = await page.locator('.eq8__graph').boundingBox();
// Reales Pointer-Capture (in setupEq8Graph) hält move/up am Graphen fest,
// auch wenn ein Finger über dessen Rand hinauswandert -- das synthetische
// elementFromPoint()-Dispatch bildet das nur nach, wenn move/up konsequent
// auf dem GRAPHEN selbst ausgelöst werden (nicht neu antasten, was gerade
// drunterliegt), genau wie es echte Capture auf einem Touchgerät
// automatisch tun würde.
const dispatchPointer = async (type, id, x, y) => {
  await page.evaluate(({ type, id, x, y }) => {
    const el = type === 'pointerdown' ? document.elementFromPoint(x, y) : document.querySelector('[data-eq8-graph]');
    const ev = new PointerEvent(type, { pointerId: id, clientX: x, clientY: y, bubbles: true, cancelable: true, pointerType: 'touch', isPrimary: true, button: 0 });
    (el || document.body).dispatchEvent(ev);
  }, { type, id, x, y });
};
const tap = async (id, fx, fy) => {
  await dispatchPointer('pointerdown', id, box.x + box.width * fx, box.y + box.height * fy);
  await dispatchPointer('pointerup', id, box.x + box.width * fx, box.y + box.height * fy);
  await page.waitForTimeout(150);
};

// Add two bands, far apart in frequency, so the "wrong band" risk is
// obvious if selection targeting is broken.
await tap(1, 0.2, 0.3); // low band, boost
await tap(2, 0.8, 0.7); // high band, cut
check('two bands are active after two taps', (await page.locator('.eq8__node.is-active').count()) === 2);

const nodeAt = async (idx) => {
  const el = page.locator('.eq8__node.is-active').nth(idx);
  return { cx: parseFloat(await el.getAttribute('cx')), cy: parseFloat(await el.getAttribute('cy')) };
};
const low = await nodeAt(0);
const high = await nodeAt(1);

// A freshly tapped-into-existence band auto-selects (so you can pinch its
// Q right away without a second tap) -- so exactly the band just added
// (the high one) starts selected, not zero.
check('the band just created is auto-selected', (await page.locator('.eq8__node.is-selected').count()) === 1);

// Tap the LOW band to select it (no movement -> select, not drag)
const lowClientX = box.x + (low.cx / 300) * box.width;
const lowClientY = box.y + (low.cy / 150) * box.height;
await dispatchPointer('pointerdown', 3, lowClientX, lowClientY);
await dispatchPointer('pointerup', 3, lowClientX, lowClientY);
await page.waitForTimeout(100);
check('tapping the low band selects it', (await page.locator('.eq8__node.is-selected').count()) === 1);

// Two-finger pinch AWAY from both nodes (top-middle empty area, clear of
// the low band at 0.2/0.3 and the high band at 0.8/0.7) -- should still
// adjust the SELECTED (low) band's Q, not the high band, and should NOT
// move either node's position. Kept safely within the graph's own bounds
// throughout (a real two-finger touch starts on the element it targets;
// drifting off the edge mid-gesture is what pointer capture, added in
// setupEq8Graph, is for -- not something this synthetic dispatch, which
// manually re-targets each event, can simulate).
const curveBefore = await page.locator('[data-eq8-curve]').getAttribute('d');
const farX = box.x + box.width * 0.5, farY = box.y + box.height * 0.12;
await dispatchPointer('pointerdown', 4, farX - 15, farY);
await dispatchPointer('pointerdown', 5, farX + 15, farY);
for (let i = 1; i <= 6; i++) {
  await dispatchPointer('pointermove', 4, farX - 15 - i * 4, farY);
  await dispatchPointer('pointermove', 5, farX + 15 + i * 4, farY);
  await page.waitForTimeout(16);
}
await dispatchPointer('pointerup', 4, farX - 39, farY);
await dispatchPointer('pointerup', 5, farX + 39, farY);
await page.waitForTimeout(100);

const lowAfter = await nodeAt(0);
const highAfter = await nodeAt(1);
check('low (selected) band position unchanged by a far-away pinch', lowAfter.cx === low.cx && lowAfter.cy === low.cy);
check('high (unselected) band position unchanged by a far-away pinch', highAfter.cx === high.cx && highAfter.cy === high.cy);
const curveAfter = await page.locator('[data-eq8-curve]').getAttribute('d');
check('the pinch still changed the response curve (adjusted the selected band\'s Q remotely)', curveBefore !== curveAfter);

// Tap the low band again -> should DESELECT
await dispatchPointer('pointerdown', 6, lowClientX, lowClientY);
await dispatchPointer('pointerup', 6, lowClientX, lowClientY);
await page.waitForTimeout(100);
check('tapping the selected band again deselects it', (await page.locator('.eq8__node.is-selected').count()) === 0);

check('No page errors', errors.length === 0);
if (errors.length) console.log(errors);

await browser.close();
process.exit(finish());
