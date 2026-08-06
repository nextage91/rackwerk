/**
 * eq8-cut-node-tracks-curve.mjs — Regressionstest für die dritte Fassung
 * des Low-Cut/High-Cut-Reglerverhaltens (Nutzer-Anfrage: "es hat diesen
 * fixen ca. +2db boost... es wäre toll wenn ich dort absenken könnte und
 * auch ins minus gehen könnte" -- die vorherigen beiden Fassungen liessen
 * entweder gar keine Wirkung zu (Gain war bei Highpass/Lowpass laut Web-
 * Audio-Spec wirkungslos) oder nur eine Q-gesteuerte Annäherung an 0dB von
 * OBEN (nie darunter, s. PR #219).
 *
 * Die dritte, jetzt aktuelle Fassung hängt an jedes Low-Cut/High-Cut-Band
 * IMMER eine zusätzliche Peaking-Biquad an der Grenzfrequenz an (s.
 * inserts.js#eq8BuildBandNodes/eq8ResonanceGain) -- b.gain ist seitdem für
 * ALLE Bandtypen (auch Cut-Typen) einheitlich "der gewünschte dB-Wert an
 * der Grenzfrequenz", genau wie bei einem Peaking-Band. Das vereinfacht
 * auch die UI (insert-chain.js) wieder: vertikales Ziehen setzt für JEDEN
 * Bandtyp einheitlich b.gain, keine Sonderbehandlung/Lookup-Tabelle für
 * Cut-Typen mehr nötig -- der Punkt sitzt deshalb (trivial, aber hier
 * geprüft) IMMER exakt auf dem echten Kurvenwert an seiner eigenen
 * Grenzfrequenz, in JEDE Richtung, auch ins Negative.
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

async function bandState() {
  return page.evaluate(async () => {
    const m = song.rack.machines[song.rack.machines.length - 1];
    const insert = m.inserts.find((i) => i.type === 'eq8');
    const b = insert.params.bands.find((bb) => bb.active);
    const atCutoff = insert.getEq8Response(new Float32Array([b.freq]))[0];
    return { gain: b.gain, atCutoff };
  });
}
function nodeDb(cy, range = 18) {
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

// Drag DOWN, well below the graph's vertical center -- this is exactly the
// reported scenario: the point sits below center, and the real curve at
// the cutoff must show a genuine NEGATIVE dB dip there, not just a small
// unavoidable positive floor (s. Dateikopf-Kommentar/PR #219).
await dragTo(50);
const down = await bandState();
const downCy = parseFloat(await node.getAttribute('cy'));
console.log(`Nach unten gezogen: b.gain=${down.gain.toFixed(2)}dB, echte Antwort an der Grenzfrequenz=${down.atCutoff.toFixed(2)}dB, Punktposition=${nodeDb(downCy).toFixed(2)}dB`);
check('Runterziehen erzeugt tatsächlich einen negativen b.gain', down.gain < -0.5);
check('Die echte Kurve an der Grenzfrequenz zeigt eine ECHTE Senke unter 0dB (die eigentliche Nutzer-Anfrage)', down.atCutoff < -0.5);
check('Der Punkt sitzt exakt auf dem echten Kurvenwert an der Grenzfrequenz', Math.abs(nodeDb(downCy) - down.atCutoff) < 0.3);

// Drag back up, well above center -- must produce a real resonance peak
// above 0dB, matching the point's position exactly.
await dragTo(-100);
const up = await bandState();
const upCy = parseFloat(await node.getAttribute('cy'));
console.log(`Nach oben gezogen: b.gain=${up.gain.toFixed(2)}dB, echte Antwort an der Grenzfrequenz=${up.atCutoff.toFixed(2)}dB, Punktposition=${nodeDb(upCy).toFixed(2)}dB`);
check('Hochziehen erzeugt tatsächlich einen positiven b.gain', up.gain > 0.5);
check('Der Punkt sitzt auch beim Hochziehen exakt auf dem echten Kurvenwert', Math.abs(nodeDb(upCy) - up.atCutoff) < 0.3);

check('Keine Seitenfehler', errors.length === 0);
if (errors.length) console.log(errors);

await browser.close();
process.exit(finish());
