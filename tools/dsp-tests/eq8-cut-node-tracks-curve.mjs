/**
 * eq8-cut-node-tracks-curve.mjs — Regressionstest für den vom Nutzer
 * gemeldeten Bug: "der Punkt ist ja unten und es gibt immer noch diese
 * Erhöhung von ca. 2dB welche sich kaum verschiebt mit dem Punkt" (s. PR).
 *
 * Ursache: die erste Fassung von insert-chain.js#eq8QToDb/eq8DbToQ nahm
 * `20·log10(Q)` an -- eine Näherung, die für ein IDEALISIERTES
 * zeitkontinuierliches 2-poliges Filter gilt (Resonanzüberhöhung existiert
 * dort nur ab Q>1/√2, darunter exakt 0dB). Per echter
 * BiquadFilterNode.getFrequencyResponse()-Messung bestätigt (s. PR): Web
 * Audios native, RBJ-Cookbook-parametrierte Highpass/Lowpass-Biquads haben
 * dieses Verhalten NICHT -- selbst beim minimal einstellbaren Q (0.1) bleibt
 * eine kleine, unvermeidbare Überhöhung von ca. +1.3dB an der Flanke. Die
 * naive Formel liess den gezeichneten Punkt deshalb beliebig tief sinken
 * (z. B. -20dB bei Q=0.1), während die tatsächliche Kurve dort weiterhin
 * bei ca. +1.3dB lag -- Punkt und Kurve liefen auseinander.
 *
 * Der Fix (eq8-adjustments-Folgefix): eine einmalig (lazy) über eine echte
 * BiquadFilterNode GEMESSENE Q->Peak-dB-Tabelle ersetzt die naive Formel --
 * der Punkt sitzt jetzt für JEDEN Q-Wert exakt auf dem echten, gemessenen
 * Kurven-Peak. Dieser Test zieht den Punkt einmal in den mittleren Bereich
 * und einmal ganz ans untere Ende und vergleicht die aus der Punktposition
 * zurückgerechnete dB-Position direkt mit dem echten, per getEq8Response()
 * gemessenen Kurven-Peak.
 *
 * Voraussetzung: ein lokaler Server auf dem Repo-Root, z. B.
 *   python3 -m http.server 8901
 * Dann:  node tools/dsp-tests/eq8-cut-node-tracks-curve.mjs  [baseUrl]
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

const dispatchPointer = async (type, id, x, y) => {
  await page.evaluate(({ type, id, x, y }) => {
    const el = document.elementFromPoint(x, y);
    const ev = new PointerEvent(type, { pointerId: id, clientX: x, clientY: y, bubbles: true, cancelable: true, pointerType: 'touch', isPrimary: true, button: 0 });
    (el || document.body).dispatchEvent(ev);
  }, { type, id, x, y });
};

const graph = page.locator('.eq8__graph');
const box = await graph.boundingBox();
const tapX = box.x + box.width * 0.5;
const tapY = box.y + box.height * 0.5;
await dispatchPointer('pointerdown', 1, tapX, tapY);
await dispatchPointer('pointerup', 1, tapX, tapY);
await page.waitForTimeout(50);
await dispatchPointer('pointerdown', 1, tapX, tapY);
await dispatchPointer('pointerup', 1, tapX, tapY);
await page.waitForTimeout(50);

const node = page.locator('.eq8__node.is-active').first();
await node.waitFor();

const cx0 = parseFloat(await node.getAttribute('cx'));
const cy0 = parseFloat(await node.getAttribute('cy'));
const hx = box.x + (cx0 / 300) * box.width;
const hy = box.y + (cy0 / 150) * box.height;
await dispatchPointer('pointerdown', 2, hx, hy);
await page.waitForTimeout(600);
await page.locator('.pat-chip .pat-chip__btn', { hasText: 'Low Cut' }).click();
await page.waitForTimeout(50);
await dispatchPointer('pointerup', 2, hx, hy);
await page.waitForTimeout(150);

async function realPeak() {
  return page.evaluate(async () => {
    const m = song.rack.machines[song.rack.machines.length - 1];
    const insert = m.inserts.find((i) => i.type === 'eq8');
    const N = 200, FREQ_MIN = 20, FREQ_MAX = 20000;
    const freqs = new Float32Array(N);
    for (let i = 0; i < N; i++) freqs[i] = FREQ_MIN * (FREQ_MAX / FREQ_MIN) ** (i / (N - 1));
    return Math.max(...insert.getEq8Response(freqs));
  });
}
async function nodeDb(range = 18) {
  const cy = parseFloat(await node.getAttribute('cy'));
  const EQ8_MIDY = 75;
  return ((EQ8_MIDY - cy) / (EQ8_MIDY - 8)) * range;
}
async function dragTo(clientYOffset) {
  const cx = parseFloat(await node.getAttribute('cx'));
  const cy = parseFloat(await node.getAttribute('cy'));
  const clientX = box.x + (cx / 300) * box.width;
  const clientY = box.y + (cy / 150) * box.height;
  await dispatchPointer('pointerdown', 3, clientX, clientY);
  await dispatchPointer('pointermove', 3, clientX, clientY + clientYOffset);
  await page.waitForTimeout(30);
  await dispatchPointer('pointerup', 3, clientX, clientY + clientYOffset);
  await page.waitForTimeout(150);
}

// Drag to a moderate position -- node must sit exactly on the real curve peak.
await dragTo(20);
const db1 = await nodeDb();
const peak1 = await realPeak();
console.log(`Moderater Drag: Punkt=${db1.toFixed(2)}dB, echter Kurven-Peak=${peak1.toFixed(2)}dB`);
check('Punktposition stimmt nach moderatem Drag mit dem echten Kurven-Peak überein', Math.abs(db1 - peak1) < 0.3);

// Drag all the way to the very bottom -- the point must stop at the REAL
// achievable floor (~+1.3dB for a standard RBJ biquad, s. Dateikopf-
// Kommentar), NOT at some deeply negative value the old 20*log10(Q) formula
// would have implied.
await dragTo(box.height); // weiter als die volle Grafikhöhe, garantiert am Boden
const db2 = await nodeDb();
const peak2 = await realPeak();
console.log(`Ganz unten gezogen: Punkt=${db2.toFixed(2)}dB, echter Kurven-Peak=${peak2.toFixed(2)}dB`);
check('Punktposition stimmt auch ganz unten mit dem echten Kurven-Peak überein (kein Auseinanderlaufen mehr)', Math.abs(db2 - peak2) < 0.3);
check('Der erreichbare Boden liegt bei den erwarteten ca. +1.3dB (physikalischer Mindestwert), nicht bei einem beliebig tiefen Wert', peak2 > 0.5 && peak2 < 3);

check('Keine Seitenfehler', errors.length === 0);
if (errors.length) console.log(errors);

await browser.close();
process.exit(finish());
