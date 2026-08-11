/**
 * subsynth-transpose.mjs — Regressionstest für den neuen Transpose-Regler
 * am SubSynth (Nutzer-Anfrage: "ich hätte gerne einen transpose regler
 * damit ich die ganzen gezeichneten noten hoch und runter shiften kann").
 *
 * Gleiches Prinzip wie polysynth.js' bereits bestehender Transpose-Knob
 * (s. dortiger Dateikopf-Kommentar): verschiebt in Halbtönen, wirkt sowohl
 * auf künftig ausgelöste Noten (Sequenzer-Steps UND frisch gedrückte
 * Keybed-Tasten) als auch LIVE per Glide auf bereits gehaltene Stimmen.
 *
 * Gemessen wird die tatsächliche Tonhöhe über einen Nulldurchgangs-
 * Schätzer auf einem Abgriff von engine.masterBus (VOR Filterketten/
 * Limiter -- reiner Summen-Abgriff, s. master-filter.mjs für dasselbe
 * Abgriff-Muster) statt nur den Regler-Wert zu prüfen: ein Regler, der
 * sich bewegt, aber keine echte Tonhöhenänderung bewirkt, wäre trotzdem
 * ein kaputtes Feature.
 *
 * Voraussetzung: ein lokaler Server auf dem Repo-Root, z. B.
 *   python3 -m http.server 8901
 * Dann:  node tools/dsp-tests/subsynth-transpose.mjs  [baseUrl]
 */
import { launchBrowser, makeReporter, openApp, baseUrlFromArgv } from './_helpers.mjs';

const { check, finish } = makeReporter();
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await openApp(page, baseUrlFromArgv());

// newProject() seedet immer genau einen SubSynth (s. project.js) -- kein
// eigenes Hinzufügen nötig.
// Das volle Maschinen-Panel (Knobs + Keybed) existiert nur EINMAL, in
// einem anfangs verborgenen .machine-focus-Overlay (s. rack.js#openFocus)
// -- #rack selbst zeigt nur die kompakte .rack-row-Zusammenfassung. Erst
// ein Klick auf die Zeile öffnet das Overlay mit dem echten Panel.
await page.locator('.rack-row', { hasText: 'SubSynth' }).locator('.rack-row__name').click();
await page.waitForSelector('.machine-focus:not([hidden])');
await page.waitForTimeout(300);
const subsynth = page.locator('.machine-focus:not([hidden]) .machine');
await subsynth.locator('.key[data-midi="60"]').scrollIntoViewIfNeeded();

/** FFT-Peak-Schätzer statt Nulldurchgang -- die resonante Filterhüllkurve
 *  (Q bis 20, Default 4) lässt die Sägezahn-Stimme nach jeder Flanke kurz
 *  nachschwingen (klassisches Resonanz-"Ringing"), was einen einfachen
 *  Nulldurchgangs-Zähler unzuverlässig macht (nachgemessen: teils grob
 *  falsche Werte durch übersprungene/verschobene Durchgänge). Der stärkste
 *  Frequenz-Bin im musikalisch relevanten Bereich ist robust dagegen, weil
 *  er über die gesamte Fensterlänge mittelt statt von einzelnen Flanken
 *  abzuhängen. Tap sitzt auf engine.masterBus (VOR jeder Filter-/Limiter-
 *  Kette), damit reines Oszillator-Signal gemessen wird. */
async function measureHeldNoteHz(page) {
  return page.evaluate(async () => {
    const ctx = engine.ctx;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 16384;
    analyser.smoothingTimeConstant = 0;
    const mute = ctx.createGain();
    mute.gain.value = 0;
    engine.masterBus.connect(analyser).connect(mute).connect(ctx.destination);
    await new Promise((r) => setTimeout(r, 120));
    const spec = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(spec);
    engine.masterBus.disconnect(analyser);
    analyser.disconnect();
    mute.disconnect();

    const binHz = ctx.sampleRate / 2 / spec.length;
    const loBin = Math.ceil(50 / binHz);
    const hiBin = Math.min(spec.length, Math.floor(2000 / binHz));
    let peakBin = loBin, peakDb = -Infinity;
    for (let i = loBin; i < hiBin; i++) {
      if (spec[i] > peakDb) { peakDb = spec[i]; peakBin = i; }
    }
    return peakBin * binHz;
  });
}

const key = subsynth.locator('.key[data-midi="60"]'); // MIDI 60 = C4 ≈ 261.6 Hz
const keyBox = await key.boundingBox();

// ---- 1) Frisch gedrückte Note übernimmt den VOR dem Antippen gesetzten
// Transpose-Wert (deckt sowohl den Sequenzer-Anwendungsfall -- Steps
// spielen mit dem jeweils aktuellen Transpose -- als auch neu gespielte
// Keybed-Noten ab). ----
await page.waitForTimeout(200);
await page.mouse.move(keyBox.x + keyBox.width / 2, keyBox.y + keyBox.height / 2);
await page.mouse.down();
await page.waitForTimeout(250); // Attack (5ms) + Einschwingen der Messung
const hzBefore = await measureHeldNoteHz(page);
await page.mouse.up();
await page.waitForTimeout(300); // Release ausklingen lassen

const transposeKnob = subsynth.locator('x-knob[data-p="transpose"]');
await transposeKnob.evaluate((el) => {
  el.value = 12;
  el.dispatchEvent(new CustomEvent('input', { detail: { value: 12 }, bubbles: true }));
});
await page.waitForTimeout(100);

await page.mouse.down();
await page.waitForTimeout(250);
const hzAfterOctaveUp = await measureHeldNoteHz(page);
await page.mouse.up();
await page.waitForTimeout(300);

console.log(`Transpose 0:  ${hzBefore.toFixed(1)} Hz (erwartet ~261.6 Hz)`);
console.log(`Transpose +12 (frisch gedrückt): ${hzAfterOctaveUp.toFixed(1)} Hz (erwartet ~523.3 Hz)`);
check('Transpose 0 spielt ungefähr die erwartete MIDI-60-Frequenz', Math.abs(hzBefore - 261.6) < 15);
check('Transpose +12 verdoppelt die Frequenz einer frisch gedrückten Note (+1 Oktave)',
  Math.abs(hzAfterOctaveUp - hzBefore * 2) < 25);

// ---- 2) Bereits GEHALTENE Note gleitet live mit, wenn Transpose während
// des Haltens weitergedreht wird (kein Neuanschlag nötig). ----
await transposeKnob.evaluate((el) => {
  el.value = 0;
  el.dispatchEvent(new CustomEvent('input', { detail: { value: 0 }, bubbles: true }));
});
await page.waitForTimeout(100);

await page.mouse.down();
await page.waitForTimeout(250);
const heldBefore = await measureHeldNoteHz(page);
await transposeKnob.evaluate((el) => {
  el.value = 12;
  el.dispatchEvent(new CustomEvent('input', { detail: { value: 12 }, bubbles: true }));
});
await page.waitForTimeout(150); // Glide (setTargetAtTime 0.01s) einschwingen lassen
const heldAfter = await measureHeldNoteHz(page);
await page.mouse.up();
await page.waitForTimeout(300);

console.log(`Gehaltene Note vor Transpose-Dreh: ${heldBefore.toFixed(1)} Hz`);
console.log(`Gehaltene Note nach Transpose +12 (live, ohne Neuanschlag): ${heldAfter.toFixed(1)} Hz`);
check('Eine bereits gehaltene Note gleitet live auf +1 Oktave, wenn Transpose gedreht wird',
  Math.abs(heldAfter - heldBefore * 2) < 25);

check('Keine Seitenfehler', errors.length === 0);
if (errors.length) console.log(errors);

await browser.close();
process.exit(finish());
