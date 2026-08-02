/**
 * eq8-pinch-invert.mjs — Regressionstest für die invertierte Q-Pinch-Geste
 * im 8-Band-EQ (s. Chat-Feedback: "Finger auseinander soll den Bump breiter
 * machen, Finger zusammen schmaler" -- das übliche Pinch-Gefühl bezogen auf
 * die SICHTBARE Bandbreite, nicht auf den rohen Q-Zahlenwert, der ja
 * physikalisch umgekehrt zur Breite steht: höherer Q = schmalerer Bump).
 * s. `qStartQ * (qStartDist / dist)` in setupEq8Graph (vorher `* (dist /
 * qStartDist)`).
 *
 * Es gibt keine sichtbare Q-Zahlenanzeige im UI -- der Test misst die
 * tatsächliche Kurvenbreite stattdessen indirekt über die reale
 * Summenkurve (`[data-eq8-curve]`, echte Werte aus getEq8Response(), s.
 * eq8CurvePath()): ein fester Frequenz-Offset neben dem Bandzentrum zeigt
 * bei einem BREITEREN Bump einen GRÖSSEREN Pegel-Ausschlag (mehr "Leck" in
 * den Nachbarbereich) als bei einem schmaleren Bump gleicher Peak-Höhe.
 *
 * Voraussetzung: ein lokaler Server auf dem Repo-Root, z. B.
 *   python3 -m http.server 8901
 * Dann:  node tools/dsp-tests/eq8-pinch-invert.mjs  [baseUrl]
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
await page.click('.machine-focus:not([hidden]) [data-add-insert]');
await page.waitForSelector('.sheet--insert-picker:not([hidden])');
await page.click('.sheet--insert-picker [data-type="eq8"]');
await page.waitForSelector('.eq8__graph');

const box = await page.locator('.eq8__graph').boundingBox();
const dispatchPointer = async (type, id, x, y) => {
  await page.evaluate(({ type, id, x, y }) => {
    const el = type === 'pointerdown' ? document.elementFromPoint(x, y) : document.querySelector('[data-eq8-graph]');
    const ev = new PointerEvent(type, { pointerId: id, clientX: x, clientY: y, bubbles: true, cancelable: true, pointerType: 'touch', isPrimary: true, button: 0 });
    (el || document.body).dispatchEvent(ev);
  }, { type, id, x, y });
};

// Zwei Taps am selben Punkt legen ein neues Band an (s. EMPTY_TAP_TOLERANCE
// in setupEq8Graph) und selektieren es direkt.
let nextId = 1;
const createBand = async (fx, fy) => {
  const x = box.x + box.width * fx, y = box.y + box.height * fy;
  const id = nextId++;
  await dispatchPointer('pointerdown', id, x, y);
  await dispatchPointer('pointerup', id, x, y);
  await page.waitForTimeout(50);
  const id2 = nextId++;
  await dispatchPointer('pointerdown', id2, x, y);
  await dispatchPointer('pointerup', id2, x, y);
  await page.waitForTimeout(150);
};

const selectBand = async (nodeLocator) => {
  const cx = parseFloat(await nodeLocator.getAttribute('cx'));
  const cy = parseFloat(await nodeLocator.getAttribute('cy'));
  const x = box.x + (cx / 300) * box.width, y = box.y + (cy / 150) * box.height;
  const id = nextId++;
  await dispatchPointer('pointerdown', id, x, y);
  await dispatchPointer('pointerup', id, x, y);
  await page.waitForTimeout(100);
};

// Zwei-Finger-Pinch, weit weg von jedem Knoten (wirkt auf das AUSGEWÄHLTE
// Band, s. eq8-select.mjs) -- von startDist zu endDist über mehrere Schritte.
const pinch = async (startDist, endDist) => {
  const cx = box.x + box.width * 0.5, cy = box.y + box.height * 0.08;
  const id1 = nextId++, id2 = nextId++;
  await dispatchPointer('pointerdown', id1, cx - startDist / 2, cy);
  await dispatchPointer('pointerdown', id2, cx + startDist / 2, cy);
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    const d = startDist + ((endDist - startDist) * i) / steps;
    await dispatchPointer('pointermove', id1, cx - d / 2, cy);
    await dispatchPointer('pointermove', id2, cx + d / 2, cy);
    await page.waitForTimeout(16);
  }
  await dispatchPointer('pointerup', id1, cx - endDist / 2, cy);
  await dispatchPointer('pointerup', id2, cx + endDist / 2, cy);
  await page.waitForTimeout(100);
};

// Liest die 120 Stützpunkte der echten Summenkurve (s. eq8CurvePath: "M
// x,y L x,y L x,y ..." mit FESTEM Raster über EQ8_W=300).
const getCurveYs = async () => {
  const d = await page.locator('[data-eq8-curve]').getAttribute('d');
  return [...d.matchAll(/(-?\d+\.?\d*),(-?\d+\.?\d*)/g)].map((m) => ({ x: parseFloat(m[1]), y: parseFloat(m[2]) }));
};
const yNearX = (points, targetX) => points.reduce((best, p) => (Math.abs(p.x - targetX) < Math.abs(best.x - targetX) ? p : best)).y;

// Band A (niedrige Frequenz, deutlicher Boost) -> wird per Zusammen-Pinch
// schmaler. Band B (hohe Frequenz, deutlicher Boost) -> wird per
// Auseinander-Pinch breiter. Weit genug auseinander (0.25 vs 0.75), damit
// sich ihre Kurven-"Buckel" nicht gegenseitig überlappen.
await createBand(0.25, 0.15); // Band A, stark geboostet
const nodeA = page.locator('.eq8__node.is-active').first();
const cxA = parseFloat(await nodeA.getAttribute('cx'));

await createBand(0.75, 0.15); // Band B, stark geboostet -- automatisch selektiert
const nodeB = page.locator('.eq8__node.is-active').nth(1);
const cxB = parseFloat(await nodeB.getAttribute('cx'));

check('zwei Bänder angelegt', (await page.locator('.eq8__node.is-active').count()) === 2);

// Offset-Punkt jeweils AUF DER SEITE WEG vom anderen Band messen (A: nach
// links, B: nach rechts), damit deren Kurven sich nicht überlagern.
const OFFSET = 35;
const before = await getCurveYs();
const yBeforeA = yNearX(before, cxA - OFFSET);
const yBeforeB = yNearX(before, cxB + OFFSET);

// Band B ist gerade selektiert (frisch erzeugt) -- Auseinander-Pinch sollte
// seinen Bump BREITER machen (mehr Pegel am Offset-Punkt).
await pinch(10, 50);
const afterB = await getCurveYs();
const yAfterB = yNearX(afterB, cxB + OFFSET);
console.log('Band B (Auseinander-Pinch): Offset-Y vorher', yBeforeB.toFixed(2), '-> nachher', yAfterB.toFixed(2), '(kleinerer Y-Wert = näher am Peak, EQ8_MIDY=75)');
check('Auseinander-Pinch macht den Bump breiter (mehr Pegel am Offset-Punkt, d.h. Y bewegt sich RICHTUNG Peak)', Math.abs(yAfterB - 75) > Math.abs(yBeforeB - 75));

// Jetzt Band A selektieren und per Zusammen-Pinch schmaler machen -- sollte
// WENIGER Pegel am Offset-Punkt ergeben.
await selectBand(nodeA);
await pinch(50, 10);
const afterA = await getCurveYs();
const yAfterA = yNearX(afterA, cxA - OFFSET);
console.log('Band A (Zusammen-Pinch): Offset-Y vorher', yBeforeA.toFixed(2), '-> nachher', yAfterA.toFixed(2));
check('Zusammen-Pinch macht den Bump schmaler (weniger Pegel am Offset-Punkt, d.h. Y bewegt sich WEG vom Peak, näher an EQ8_MIDY)', Math.abs(yAfterA - 75) < Math.abs(yBeforeA - 75));

check('Keine Seitenfehler', errors.length === 0);
if (errors.length) console.log(errors);

await browser.close();
process.exit(finish());
