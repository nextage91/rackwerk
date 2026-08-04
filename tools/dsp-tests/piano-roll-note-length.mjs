/**
 * piano-roll-note-length.mjs — Regressionstest für Noten mit Länge im
 * Piano-Roll (Nutzer-Anfrage: "dazu fände ich es extrem cool, wenn das
 * pianoroll nicht nur auf 16tel begrenzt wäre, sondern man auch längere
 * noten zeichnen könnte (wie im midi piano roll)").
 *
 * Deckt ab:
 * 1) UI: Antippen einer leeren Roll-Zelle legt eine 1-Step-Note an (Kopf
 *    UND Ende zugleich, s. ui/step-seq.js#renderRollRow). Ziehen von der
 *    rechten Kante (TAIL) einer bestehenden Note nach rechts verlängert
 *    sie, mit sichtbaren head/body/tail-Klassen. Antippen (ohne Ziehen)
 *    irgendwo im Körper einer Note löscht sie komplett -- inklusive der
 *    vom längeren #len überdeckten Steps (die selbst nie eigenes on:true
 *    tragen, s. #rollCoverage).
 * 2) DSP: onStep() berechnet die tatsächliche Hüllkurven-Dauer aus st.len
 *    (länger als der alte feste 0.8*stepDuration-Wert für 1 Step) UND
 *    ruft playNote nur für den START-Step auf, nicht für die vom #len
 *    überdeckten Folge-Steps (kein Doppel-Trigger).
 * 3) UI: PercSynth/KickSynth bekommen GAR KEINEN Roll-Modus (Nutzer-
 *    Entscheidung: deren Hüllkurve hängt rein am eigenen Decay-Regler,
 *    dur aus der Notenlänge wird ignoriert -- ein Resize-Anfasser, der
 *    hörbar nichts bewirkt, wäre irreführender als gar keiner). PolySynth
 *    (Kontrollgruppe) behält ihn wie gehabt.
 *
 * Voraussetzung: ein lokaler Server auf dem Repo-Root, z. B.
 *   python3 -m http.server 8901
 * Dann:  node tools/dsp-tests/piano-roll-note-length.mjs  [baseUrl]
 */
import { launchBrowser, makeReporter, openApp, baseUrlFromArgv } from './_helpers.mjs';

const { check, finish } = makeReporter();
const browser = await launchBrowser({ args: ['--touch-events=enabled'] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await openApp(page, baseUrlFromArgv());

// SubSynth startet mit einer seedDemo()-Line (s. subsynth.js) -- die belegt
// u. a. Step 3 mit midi=48, GENAU der Step/Tonhöhe, die dieser Test für
// Row 6 (Tonhöhe 48, s. unten) durchziehen würde. Erst leeren, damit die
// Drag-Prüfung nicht fälschlich mit vorbestehenden Demo-Noten kollidiert.
await page.evaluate(() => {
  const sub = song.rack.machines.find((m) => m.constructor.name === 'SubSynth');
  for (const s of sub.pattern) { s.on = false; s.len = 1; s.vel = 1; }
  sub.seq?.setPattern(sub.pattern); // erzwingt einen Redraw des (noch verborgenen) Grids
});

await page.locator('.rack-row', { hasText: 'SubSynth' }).click();
await page.waitForSelector('.machine-focus:not([hidden])');
await page.waitForTimeout(300);

// In den Roll-Modus wechseln.
await page.locator('.machine-focus:not([hidden]) [data-mode="roll"]').click();
await page.waitForTimeout(200);

const cdp = await context.newCDPSession(page);
async function tap(x, y) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
  await page.waitForTimeout(60);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(100);
}
async function dragAcross(fromBox, toBox) {
  const y = fromBox.y + fromBox.height / 2;
  const startX = fromBox.x + fromBox.width / 2;
  const endX = toBox.x + toBox.width / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: startX, y, id: 1 }] });
  await page.waitForTimeout(40);
  // Mehrere Zwischenschritte statt eines einzigen Sprungs -- #wireRollPointer
  // ermittelt die Zielspalte über document.elementFromPoint() bei JEDEM
  // pointermove, ein einzelner Endpunkt-Sprung würde trotzdem funktionieren,
  // aber Zwischenschritte spiegeln eine echte Zieh-Geste realistischer.
  const steps = 4;
  for (let i = 1; i <= steps; i++) {
    const x = startX + ((endX - startX) * i) / steps;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, id: 1 }] });
    await page.waitForTimeout(30);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(100);
}

const row = 6; // beliebige Zeile, Tonhöhe irrelevant für diesen Test
const cellAt = (c) => page.locator(`.machine-focus:not([hidden]) .roll-cell[data-row="${row}"][data-col="${c}"]`);
await cellAt(0).scrollIntoViewIfNeeded();

// ---------- 1a) Tippen auf eine leere Zelle legt eine 1-Step-Note an ----------
check('Zelle (row 6, col 2) ist anfangs leer', !(await cellAt(2).getAttribute('class')).includes('is-on'));
const box2 = await cellAt(2).boundingBox();
await tap(box2.x + box2.width / 2, box2.y + box2.height / 2);
let cls2 = await cellAt(2).getAttribute('class');
check('Antippen legt eine Note an (is-on)', cls2.includes('is-on'));
check('Eine frische 1-Step-Note ist Kopf UND Ende zugleich', cls2.includes('roll-cell--head') && cls2.includes('roll-cell--tail'));

// ---------- 1b) Ziehen von der TAIL-Kante verlängert die Note ----------
const box4 = await cellAt(4).boundingBox();
await dragAcross(box2, box4);
const clsHead = await cellAt(2).getAttribute('class');
const clsBody = await cellAt(3).getAttribute('class');
const clsTail = await cellAt(4).getAttribute('class');
console.log(`Nach Ziehen: col2=${clsHead}, col3=${clsBody}, col4=${clsTail}`);
check('Kopf-Zelle bleibt an (is-on) nach dem Verlängern', clsHead.includes('is-on') && clsHead.includes('roll-cell--head'));
check('Mittlere Zelle wird als Körper markiert (is-on, kein Kopf/Ende)',
  clsBody.includes('is-on') && clsBody.includes('roll-cell--body') && !clsBody.includes('roll-cell--head') && !clsBody.includes('roll-cell--tail'));
check('Neue Ende-Zelle ist markiert (is-on, roll-cell--tail, kein Kopf)',
  clsTail.includes('is-on') && clsTail.includes('roll-cell--tail') && !clsTail.includes('roll-cell--head'));

const lenAfterDrag = await page.evaluate((r) => {
  const sub = song.rack.machines.find((m) => m.constructor.name === 'SubSynth');
  // Spalte 2 auf Roll-Seite 0 = Pattern-Index 2 (ROLL_STEPS_PER_PAGE=8, Seite 0).
  return sub.pattern[2].len;
}, row);
console.log(`Gespeicherte Notenlänge nach Ziehen auf Spalte 4: ${lenAfterDrag}`);
check('Die gespeicherte Notenlänge ist jetzt 3 Steps (col2..col4)', lenAfterDrag === 3);

const coveredStepsOff = await page.evaluate(() => {
  const sub = song.rack.machines.find((m) => m.constructor.name === 'SubSynth');
  return !sub.pattern[3].on && !sub.pattern[4].on;
});
check('Die von der Länge überdeckten Steps tragen selbst KEIN on:true (kein Doppel-Trigger)', coveredStepsOff);

// ---------- 1c) Antippen (ohne Ziehen) irgendwo im Körper löscht die ganze Note ----------
await tap(box4.x + box4.width / 2, box4.y + box4.height / 2); // Tap auf die Ende-Zelle
const clsHeadAfterDelete = await cellAt(2).getAttribute('class');
const clsTailAfterDelete = await cellAt(4).getAttribute('class');
check('Antippen der Note (auch nur eine ihrer Zellen) löscht sie komplett -- Kopf aus',
  !clsHeadAfterDelete.includes('is-on'));
check('… und auch das ehemalige Ende ist wieder aus', !clsTailAfterDelete.includes('is-on'));

// ---------- 2) DSP: onStep() nutzt st.len für die Hüllkurven-Dauer ----------
const dsp = await page.evaluate(() => {
  const sub = song.rack.machines.find((m) => m.constructor.name === 'SubSynth');
  const calls = [];
  const origPlayNote = sub.playNote.bind(sub);
  sub.playNote = (midi, time, dur, vel) => { calls.push({ midi, dur, vel }); };

  // Step 5: 1-Step-Note (Referenzwert).
  sub.pattern[5] = { on: true, midi: 60, vel: 1, len: 1 };
  sub.onStep(5, 0);
  // Step 6: 4-Step-Note (deutlich länger).
  sub.pattern[6] = { on: true, midi: 60, vel: 1, len: 4 };
  sub.pattern[7] = { on: false, midi: 60, vel: 1, len: 1 };
  sub.pattern[8] = { on: false, midi: 60, vel: 1, len: 1 };
  sub.pattern[9] = { on: false, midi: 60, vel: 1, len: 1 };
  sub.onStep(6, 0);
  // Step 7: von Step 6 überdeckt (on:false) -- darf NICHT triggern.
  sub.onStep(7, 0);

  sub.playNote = origPlayNote;
  return { calls, stepDuration: transport.stepDuration };
});

console.log(`onStep-Aufrufe: ${JSON.stringify(dsp.calls)}, stepDuration=${dsp.stepDuration}`);
check('onStep() ruft playNote für den 1-Step- UND den 4-Step-Note-Start auf (genau 2 Aufrufe)', dsp.calls.length === 2);
check('Ein 4-Step-Note-dur ist deutlich länger als ein 1-Step-Note-dur',
  dsp.calls.length === 2 && dsp.calls[1].dur > dsp.calls[0].dur * 3);
const expectedLen4Dur = dsp.stepDuration * (4 - 0.2);
check('Die 4-Step-Note-Dauer entspricht ungefähr stepDuration*(4-0.2)',
  dsp.calls.length === 2 && Math.abs(dsp.calls[1].dur - expectedLen4Dur) < 0.001);

// ---------- 3) UI: PercSynth/KickSynth haben keinen Roll-Modus ----------
async function checkRollButton(name, expectPresent) {
  await openApp(page, baseUrlFromArgv());
  await page.click('.rack__add');
  await page.waitForSelector('.sheet__item');
  await page.locator('.sheet__item', { hasText: name }).first().click();
  await page.waitForTimeout(300);
  await page.waitForSelector('.machine-focus:not([hidden])');
  await page.waitForTimeout(200);
  const count = await page.locator('.machine-focus:not([hidden]) [data-mode="roll"]').count();
  check(`${name} ${expectPresent ? 'zeigt' : 'zeigt KEINEN'} Roll-Modus-Knopf`,
    expectPresent ? count === 1 : count === 0);
}
await checkRollButton('PercSynth', false);
await checkRollButton('KickSynth', false);
await checkRollButton('PolySynth', true); // Kontrollgruppe -- unverändert

check('Keine Seitenfehler', errors.length === 0);
if (errors.length) console.log(errors);

await browser.close();
process.exit(finish());
