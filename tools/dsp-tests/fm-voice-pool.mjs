/**
 * fm-voice-pool.mjs — Regressionstest für den fm-voice-Wiederverwendungs-
 * Pool in FMSynth/PsySynth (s. dortiges `this.fmPool`, `#acquireFmVoice`/
 * `#releaseFmVoice`).
 *
 * Hintergrund: der überabgetastete fm-voice-Worklet (s. core/dsp.js#
 * makeFmVoice) ist pro Note teurer zu KONSTRUIEREN als die früheren zwei
 * nativen OscillatorNodes -- beim Tastenspiel (Anschläge naturgemäss
 * einzeln, von Hand getaktet) unauffällig, aber der Sequenzer-Lookahead-
 * Planer (s. transport.js, SCHEDULE_AHEAD=0.1s) kann bei Timer-
 * Nachzüglern mehrere Steps in EINEM synchronen JS-Tick nachholen --
 * mehrere frische Worklet-Konstruktionen in einem Tick reissen leicht das
 * ~2.7ms-Zeitbudget eines Audio-Blocks, hörbar als Knacksen speziell bei
 * Sequenzer-, nicht bei Tastentriggerung (Nutzer-Bugreport). Die Lösung:
 * abgespielte Stimmen NICHT entsorgen, sondern in einen Pool zurücklegen
 * und bei der nächsten Note wiederverwenden (nur `.connect()`/
 * `.disconnect()`, keine neue Konstruktion).
 *
 * Deckt zwei Dinge ab:
 *  1) Korrektheit: eine wiederverwendete Stimme darf KEINE Parameter/
 *     Automation der vorherigen Note "durchbluten" lassen (die neue Note
 *     muss klingen wie geplant, nicht wie ein Mix aus alt+neu).
 *  2) Performance: EIN Burst mehrerer gleichzeitiger playNote()-Aufrufe
 *     (das Sequenzer-Nachhol-Szenario) muss im warmen Zustand (genug
 *     Pool-Einträge vorhanden) deutlich billiger sein als im kalten
 *     Zustand (Pool leer, jede Stimme braucht eine frische Konstruktion).
 *
 * Voraussetzung: ein lokaler Server auf dem Repo-Root, z. B.
 *   python3 -m http.server 8901
 * Dann:  node tools/dsp-tests/fm-voice-pool.mjs  [baseUrl]
 */
import { launchBrowser, makeReporter, openApp, baseUrlFromArgv } from './_helpers.mjs';

const { check, finish } = makeReporter();
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await openApp(page, baseUrlFromArgv());

// ---------- FMSynth ----------
await page.click('.rack__add');
await page.waitForSelector('.sheet__item');
await page.locator('.sheet__item', { hasText: 'FM Synth' }).first().click();
await page.waitForTimeout(500);

const fmOut = await page.evaluate(async () => {
  const ctx = engine.ctx;
  if (ctx.state === 'suspended') await ctx.resume();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const fm = song.rack.machines.find((m) => m.constructor.name === 'FMSynth');
  fm.params.release = 0.05;
  fm.params.ratio = 2;
  fm.params.fmAmount = 0.3;
  fm.params.fmEnv = 0;

  // Korrektheit: Note A (tief), voll ausklingen lassen (Pool bekommt die
  // Stimme zurück), dann Note B (hoch, andere Ratio-Basis) auf DERSELBEN
  // wiederverwendeten fm-voice -- Ausgangsspektrum muss zu B passen, nicht
  // Reste von A tragen.
  fm.noteOn(48); // tiefe Note
  await wait(150);
  fm.noteOff(48);
  await wait(400); // release=0.05s + Sicherheitsmarge, Stimme sollte im Pool sein
  const poolSizeAfterA = fm.fmPool.length;

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 4096;
  const mute = ctx.createGain();
  mute.gain.value = 0;
  fm.output.connect(analyser).connect(mute).connect(ctx.destination);

  fm.noteOn(72); // zwei Oktaven höher -- deutlich andere Grundfrequenz
  await wait(150);
  const freqData = new Float32Array(analyser.frequencyBinCount);
  analyser.getFloatFrequencyData(freqData);
  fm.noteOff(72);
  await wait(400);
  fm.output.disconnect(analyser);

  const binHz = ctx.sampleRate / analyser.fftSize;
  const peakBin = freqData.indexOf(Math.max(...freqData));
  const peakHz = peakBin * binHz;
  const expectedHz = 523.25; // C5, midi 72

  // Performance: kalter vs. warmer Burst.
  fm.allNotesOff();
  await wait(200);
  fm.fmPool.length = 0; // Pool leeren -- garantiert kalten Start für den ersten Burst

  const tCold0 = performance.now();
  for (let i = 0; i < 8; i++) fm.playNote(60 + i, ctx.currentTime + 0.01, 0.05, 1);
  const coldMs = performance.now() - tCold0;
  await wait(600);

  const tWarm0 = performance.now();
  for (let i = 0; i < 8; i++) fm.playNote(60 + i, ctx.currentTime + 0.01, 0.05, 1);
  const warmMs = performance.now() - tWarm0;
  await wait(600);

  return { poolSizeAfterA, peakHz, expectedHz, coldMs, warmMs };
});

console.log('FMSynth: Pool-Grösse nach erster Note (release abgewartet):', fmOut.poolSizeAfterA);
check('FMSynth: Stimme kehrt nach dem Ausklingen tatsächlich in den Pool zurück', fmOut.poolSizeAfterA >= 1);

console.log('FMSynth: wiederverwendete Stimme -- gemessener Spektral-Peak:', fmOut.peakHz.toFixed(1), 'Hz (erwartet ~', fmOut.expectedHz.toFixed(1), 'Hz)');
check('FMSynth: eine wiederverwendete fm-voice klingt korrekt nach der NEUEN Note (kein Parameter-Durchbluten)',
  Math.abs(fmOut.peakHz - fmOut.expectedHz) < fmOut.expectedHz * 0.05);

console.log('FMSynth: Burst 8x playNote() kalt (Pool leer):', fmOut.coldMs.toFixed(2), 'ms');
console.log('FMSynth: Burst 8x playNote() warm (Pool voll):', fmOut.warmMs.toFixed(2), 'ms');
check('FMSynth: warmer (gepoolter) Burst ist deutlich billiger als kalter Burst', fmOut.warmMs < fmOut.coldMs * 0.7);

// ---------- PsySynth ----------
await page.locator('.machine-focus:not([hidden]) .machine-focus__back').click();
await page.waitForTimeout(150);
await page.click('.rack__add');
await page.waitForSelector('.sheet__item');
await page.locator('.sheet__item', { hasText: 'PsySynth' }).first().click();
await page.waitForTimeout(500);

const psyOut = await page.evaluate(async () => {
  const ctx = engine.ctx;
  if (ctx.state === 'suspended') await ctx.resume();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const psy = song.rack.machines.find((m) => m.constructor.name === 'PsySynth');
  psy.params.release = 0.05;
  psy.params.unisonVoices = 5;

  psy.allNotesOff();
  await wait(200);
  psy.fmPool.length = 0;

  const tCold0 = performance.now();
  for (let i = 0; i < 4; i++) psy.playNote(60 + i, ctx.currentTime + 0.01, 0.05, 1);
  const coldMs = performance.now() - tCold0;
  await wait(700);
  const poolAfterCold = psy.fmPool.length;

  const tWarm0 = performance.now();
  for (let i = 0; i < 4; i++) psy.playNote(60 + i, ctx.currentTime + 0.01, 0.05, 1);
  const warmMs = performance.now() - tWarm0;
  await wait(700);

  return { coldMs, warmMs, poolAfterCold };
});

console.log('\nPsySynth: Pool-Grösse nach kaltem Burst (4 Noten x 5 Unisono):', psyOut.poolAfterCold);
check('PsySynth: alle Unisono-Kopien kehren nach dem Ausklingen in den Pool zurück', psyOut.poolAfterCold >= 15);

console.log('PsySynth: Burst 4x playNote() (5 Unisono je Note) kalt:', psyOut.coldMs.toFixed(2), 'ms');
console.log('PsySynth: Burst 4x playNote() (5 Unisono je Note) warm:', psyOut.warmMs.toFixed(2), 'ms');
check('PsySynth: warmer (gepoolter) Burst ist deutlich billiger als kalter Burst', psyOut.warmMs < psyOut.coldMs * 0.7);

check('Keine Seitenfehler', errors.length === 0);
if (errors.length) console.log(errors);

await browser.close();
process.exit(finish());
