/**
 * insert-chain.mjs — breiter UI-Regressionstest für den gemeinsamen
 * Insert-Chain-Code (ui/insert-chain.js), der von JEDER Maschine genutzt
 * wird. Deckt pro Insert-Typ die eine Interaktion ab, die am ehesten bei
 * einem gemeinsamen Refactor kaputtgehen würde (Compressor-Meter, EQ-
 * Kurve, Drive-LED, Filter-Delay-Sync-Umschaltung, Resonator-Presets,
 * eq8-Touch-Graph), plus Move/Bypass auf der Kette selbst.
 *
 * Voraussetzung: ein lokaler Server auf dem Repo-Root, z. B.
 *   python3 -m http.server 8901
 * Dann:  node tools/dsp-tests/insert-chain.mjs  [baseUrl]
 */
import { launchBrowser, makeReporter, openApp, baseUrlFromArgv } from './_helpers.mjs';

const { check, finish } = makeReporter();
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await openApp(page, baseUrlFromArgv());
await page.waitForSelector('.rack-row');

// Default project seeds BeatBox + SubSynth — open the first rack row to
// reveal the full editor with the insert chain.
await page.click('.rack-row');
await page.waitForTimeout(300);
const machine = await page.evaluateHandle(() => {
  const all = [...document.querySelectorAll('.machine')].filter((m) => m.offsetParent !== null && !m.classList.contains('machine--master') && m.querySelector('[data-add-insert]'));
  return all[0] || null;
});
check('a machine panel with insert-chain UI exists', await machine.evaluate((el) => !!el));

const addEffect = async (type) => {
  await machine.evaluate((el) => el.querySelector('[data-add-insert]').click());
  await page.waitForTimeout(150);
  await page.click(`.sheet--insert-picker [data-type="${type}"]`);
  await page.waitForTimeout(150);
};

// ---- Compressor ----
await addEffect('comp');
let compRow = await machine.evaluateHandle((el) => el.querySelector('.inserts .insert-module'));
check('comp: GR meter segments rendered', await compRow.evaluate((r) => r.querySelectorAll('.comp-meter__vu .vu__seg').length === 12));
check('comp: ratio mode buttons rendered', await compRow.evaluate((r) => r.querySelectorAll('[data-ratio-mode]').length > 0));
await compRow.evaluate((r) => r.querySelectorAll('[data-ratio-mode]')[1].click());
await page.waitForTimeout(50);
compRow = await machine.evaluateHandle((el) => el.querySelector('.inserts .insert-module'));
check('comp: ratio mode click re-renders with new active state', await compRow.evaluate((r) => r.querySelectorAll('[data-ratio-mode]')[1].classList.contains('is-active')));
await compRow.evaluate((r) => r.querySelector('[data-remove]').click());
await page.waitForTimeout(100);

// ---- Parametric EQ ----
await addEffect('eq');
let eqRow = await machine.evaluateHandle((el) => el.querySelector('.inserts .insert-module'));
check('eq: curve svg path present', await eqRow.evaluate((r) => !!r.querySelector('.eq-curve__path')));
const beforePath = await eqRow.evaluate((r) => r.querySelector('.eq-curve__path').getAttribute('d'));
await eqRow.evaluate((r) => {
  const knob = r.querySelector('x-knob[data-insert-param="freq"]');
  knob.value = 5000;
  knob.dispatchEvent(new CustomEvent('input', { detail: { value: 5000 }, bubbles: true }));
});
await page.waitForTimeout(50);
const afterPath = await eqRow.evaluate((r) => r.querySelector('.eq-curve__path').getAttribute('d'));
check('eq: curve path updates live on knob input (no full re-render)', beforePath !== afterPath);
await eqRow.evaluate((r) => r.querySelector('[data-eq-type="highshelf"]')?.click());
await page.waitForTimeout(50);
eqRow = await machine.evaluateHandle((el) => el.querySelector('.inserts .insert-module'));
check('eq: type toggle button works', await eqRow.evaluate((r) => r.querySelector('[data-eq-type="highshelf"]').classList.contains('is-active')));
await eqRow.evaluate((r) => r.querySelector('[data-remove]').click());
await page.waitForTimeout(100);

// ---- Drive ----
await addEffect('drive');
let driveRow = await machine.evaluateHandle((el) => el.querySelector('.inserts .insert-module'));
check('drive: heat LED present', await driveRow.evaluate((r) => !!r.querySelector('[data-drive-heat]')));
const beforeOpacity = await driveRow.evaluate((r) => r.querySelector('[data-drive-heat]').style.opacity);
await driveRow.evaluate((r) => {
  const knob = r.querySelector('x-knob[data-insert-param="drive"]');
  knob.value = 1;
  knob.dispatchEvent(new CustomEvent('input', { detail: { value: 1 }, bubbles: true }));
});
await page.waitForTimeout(50);
const afterOpacity = await driveRow.evaluate((r) => r.querySelector('[data-drive-heat]').style.opacity);
check('drive: heat LED opacity reacts to knob', beforeOpacity !== afterOpacity);
await driveRow.evaluate((r) => r.querySelector('[data-remove]').click());
await page.waitForTimeout(100);

// ---- Filter Delay ----
await addEffect('filterDelay');
let fdRow = await machine.evaluateHandle((el) => el.querySelector('.inserts .insert-module'));
check('filterDelay: sync buttons rendered', await fdRow.evaluate((r) => r.querySelectorAll('[data-filterdelay-sync]').length > 0));
check('filterDelay: time knob visible when free', await fdRow.evaluate((r) => !!r.querySelector('x-knob[data-insert-param="time"]')));
await fdRow.evaluate((r) => r.querySelector('[data-filterdelay-sync]:not([data-filterdelay-sync="free"])')?.click()
  ?? r.querySelectorAll('[data-filterdelay-sync]')[1].click());
await page.waitForTimeout(100);
fdRow = await machine.evaluateHandle((el) => el.querySelector('.inserts .insert-module'));
check('filterDelay: time knob hidden when synced', await fdRow.evaluate((r) => !r.querySelector('x-knob[data-insert-param="time"]')));
await fdRow.evaluate((r) => r.querySelector('[data-filterdelay-pingpong]').click());
await page.waitForTimeout(50);
check('filterDelay: ping-pong button toggles active class', await fdRow.evaluate((r) => r.querySelector('[data-filterdelay-pingpong]').classList.contains('is-active')));
await fdRow.evaluate((r) => r.querySelector('[data-remove]').click());
await page.waitForTimeout(100);

// ---- Resonator ---- (jetzt eine Faust-Modal-Synthese statt der früheren
// 5-Band-Delayline-Bank, s. inserts.js#DEFS.resonator -- die Interval-
// Presets/5 Tune-Regler entfielen dabei bewusst (24 automatisch verteilte
// Partialtöne statt 5 einzeln stimmbarer Bänder), jetzt nur noch die
// generischen UI_PARAMS-Regler wie bei den meisten anderen Inserts.
await addEffect('resonator');
let resRow = await machine.evaluateHandle((el) => el.querySelector('.inserts .insert-module'));
check('resonator: standard param knobs rendered (pitch/resonance/damping/width/mix)', await resRow.evaluate((r) => r.querySelectorAll('[data-insert-param]').length === 5));
await resRow.evaluate((r) => r.querySelector('[data-remove]').click());
await page.waitForTimeout(100);

// ---- Chorus / Phaser ---- (neue Modulationseffekte, s. inserts.js#DEFS.
// chorus/DEFS.phaser -- beide nutzen wie der neue Resonator nur die
// generischen UI_PARAMS-Regler, keine Sonder-UI.
await addEffect('chorus');
let chorusRow = await machine.evaluateHandle((el) => el.querySelector('.inserts .insert-module'));
check('chorus: standard param knobs rendered (rate/depth/width/mix)', await chorusRow.evaluate((r) => r.querySelectorAll('[data-insert-param]').length === 4));
await chorusRow.evaluate((r) => r.querySelector('[data-remove]').click());
await page.waitForTimeout(100);

await addEffect('phaser');
let phaserRow = await machine.evaluateHandle((el) => el.querySelector('.inserts .insert-module'));
check('phaser: standard param knobs rendered (rate/depth/feedback/mix)', await phaserRow.evaluate((r) => r.querySelectorAll('[data-insert-param]').length === 4));
await phaserRow.evaluate((r) => r.querySelector('[data-remove]').click());
await page.waitForTimeout(100);

// ---- Gate / Frequency Shifter / Vocoder ---- (generische UI_PARAMS-Regler,
// keine Sonder-UI, s. inserts.js#DEFS.gate/freqShift/vocoder).
await addEffect('gate');
let gateRow = await machine.evaluateHandle((el) => el.querySelector('.inserts .insert-module'));
check('gate: standard param knobs rendered (threshold/attack/release/range/mix)', await gateRow.evaluate((r) => r.querySelectorAll('[data-insert-param]').length === 5));
await gateRow.evaluate((r) => r.querySelector('[data-remove]').click());
await page.waitForTimeout(100);

await addEffect('freqShift');
let freqShiftRow = await machine.evaluateHandle((el) => el.querySelector('.inserts .insert-module'));
check('freqShift: standard param knobs rendered (shift/mix)', await freqShiftRow.evaluate((r) => r.querySelectorAll('[data-insert-param]').length === 2));
await freqShiftRow.evaluate((r) => r.querySelector('[data-remove]').click());
await page.waitForTimeout(100);

await addEffect('vocoder');
let vocoderRow = await machine.evaluateHandle((el) => el.querySelector('.inserts .insert-module'));
check('vocoder: standard param knobs rendered (carrierPitch/response/mix)', await vocoderRow.evaluate((r) => r.querySelectorAll('[data-insert-param]').length === 3));
await vocoderRow.evaluate((r) => r.querySelector('[data-remove]').click());
await page.waitForTimeout(100);

// ---- Beat Repeat ---- (division-Button-Reihe wie Filter Delays Sync-
// Buttons, s. inserts.js#DEFS.beatRepeat -- immer tempo-synchron, kein
// 'free'-Modus).
await addEffect('beatRepeat');
let beatRepeatRow = await machine.evaluateHandle((el) => el.querySelector('.inserts .insert-module'));
check('beatRepeat: division buttons rendered', await beatRepeatRow.evaluate((r) => r.querySelectorAll('[data-beatrepeat-division]').length > 0));
check('beatRepeat: standard param knobs rendered (chance/decay/mix)', await beatRepeatRow.evaluate((r) => r.querySelectorAll('[data-insert-param]').length === 3));
await beatRepeatRow.evaluate((r) => r.querySelectorAll('[data-beatrepeat-division]')[2].click());
await page.waitForTimeout(50);
beatRepeatRow = await machine.evaluateHandle((el) => el.querySelector('.inserts .insert-module'));
check('beatRepeat: division click re-renders with new active state', await beatRepeatRow.evaluate((r) => r.querySelectorAll('[data-beatrepeat-division]')[2].classList.contains('is-active')));
await beatRepeatRow.evaluate((r) => r.querySelector('[data-remove]').click());
await page.waitForTimeout(100);

// ---- EQ8 ---- (synthetic PointerEvents, matching the proven eq8 test idiom —
// real mouse actions don't reliably drive this graph's pointer-capture gestures)
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

await addEffect('eq8');
let eq8Row = await machine.evaluateHandle((el) => el.querySelector('.inserts .insert-module'));
check('eq8: graph svg rendered', await eq8Row.evaluate((r) => !!r.querySelector('[data-eq8-graph] .eq8__svg')));
await eq8Row.evaluate((r) => r.querySelector('[data-eq8-graph]').scrollIntoView({ block: 'center' }));
await page.waitForTimeout(100);
// Tap on empty graph area to add a band.
const graphBox = await eq8Row.evaluate((r) => {
  const g = r.querySelector('[data-eq8-graph]');
  const rect = g.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height * 0.4 };
});
// Zwei Taps am selben Punkt nötig, um ein Band zu erzeugen (s.
// EMPTY_TAP_TOLERANCE in setupEq8Graph).
await dispatchPointer('pointerdown', 1, graphBox.x, graphBox.y);
await dispatchPointer('pointerup', 1, graphBox.x, graphBox.y);
await page.waitForTimeout(50);
await dispatchPointer('pointerdown', 1, graphBox.x, graphBox.y);
await dispatchPointer('pointerup', 1, graphBox.x, graphBox.y);
await page.waitForTimeout(150);
eq8Row = await machine.evaluateHandle((el) => el.querySelector('.inserts .insert-module'));
check('eq8: tap on empty graph adds a node', await eq8Row.evaluate((r) => r.querySelectorAll('[data-eq8-node]').length === 1));
// Drag the node.
const nodePos = await eq8Row.evaluate((r) => {
  const n = r.querySelector('[data-eq8-node]');
  const svg = r.querySelector('.eq8__svg');
  const rect = svg.getBoundingClientRect();
  const cx = parseFloat(n.getAttribute('cx'));
  const cy = parseFloat(n.getAttribute('cy'));
  return { x: rect.left + (cx / 300) * rect.width, y: rect.top + (cy / 150) * rect.height };
});
await dispatchPointer('pointerdown', 2, nodePos.x, nodePos.y);
await dispatchPointer('pointermove', 2, nodePos.x + 30, nodePos.y - 20);
await dispatchPointer('pointerup', 2, nodePos.x + 30, nodePos.y - 20);
await page.waitForTimeout(150);
eq8Row = await machine.evaluateHandle((el) => el.querySelector('.inserts .insert-module'));
const nodeCxAfterDrag = await eq8Row.evaluate((r) => parseFloat(r.querySelector('[data-eq8-node]').getAttribute('cx')));
check('eq8: dragging a node moves it', Math.abs(nodeCxAfterDrag - (300 / 2)) > 1);
await eq8Row.evaluate((r) => r.querySelector('[data-remove]').click());
await page.waitForTimeout(100);

// ---- Move / Bypass on a fresh insert ----
await addEffect('drive');
await addEffect('eq');
const firstNameBefore = await machine.evaluate((el) => el.querySelector('.inserts .insert-module .machine__name').textContent);
await machine.evaluate((el) => el.querySelector('.inserts .insert-module [data-move="1"]').click());
await page.waitForTimeout(100);
const firstNameAfter = await machine.evaluate((el) => el.querySelector('.inserts .insert-module .machine__name').textContent);
check('move: moving first insert down changes order', firstNameBefore !== firstNameAfter);
await machine.evaluate((el) => el.querySelector('.inserts .insert-module [data-bypass]').click());
await page.waitForTimeout(50);
check('bypass: bypass button marks module is-bypassed', await machine.evaluate((el) => el.querySelector('.inserts .insert-module').classList.contains('is-bypassed')));

check('No page errors', errors.length === 0);
if (errors.length) console.log(errors);

await browser.close();
process.exit(finish());
