/**
 * fm-voice-stability.mjs — Regressionstest für die neue überabgetastete
 * FM-Stimme (s. core/fm-voice-worklet.js, core/dsp.js#makeFmVoice) in
 * FMSynth UND PsySynth: klingt/verhält sich der komplette Umbau (Worklet
 * statt zwei nativer OscillatorNodes, geteiltes Carrier+Modulator-Detune,
 * eigener Stimmen-Lebenszyklus via ConstantSourceNode-"Uhr" statt
 * `osc.onended`) bei EXTREMEN Reglerstellungen weiterhin stabil?
 *
 * Deckt ab:
 *  - Kein NaN/Infinity bei maximalem Feedback+FM Amount+Ratio (FMSynth)
 *    bzw. zusätzlich vollem Unisono+Ringmod (PsySynth).
 *  - Live-Parameteränderung (Feedback) auf eine bereits klingende Stimme
 *    wirkt weiterhin (prüft `fm.feedback` als echtes, sofort verfügbares
 *    AudioParam, s. makeFmVoice-Kommentar zur ConstantSourceNode-Technik).
 *  - PsySynth: zwei Noten kurz hintereinander (Anschlag -> Loslassen ->
 *    sofort neue Note) laufen sauber durch -- prüft, dass #teardownNote/
 *    #disconnectSwirl nach dem Umbau (fm.dispose() statt car.disconnect())
 *    weiterhin korrekt aufräumt, ohne die dauerhaft laufenden Swirl-LFO-
 *    Depth-Gains in einen kaputten Zustand zu bringen.
 *
 * Voraussetzung: ein lokaler Server auf dem Repo-Root, z. B.
 *   python3 -m http.server 8901
 * Dann:  node tools/dsp-tests/fm-voice-stability.mjs  [baseUrl]
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
  fm.params.feedback = 1;
  fm.params.fmAmount = 1;
  fm.params.fmEnv = 1;
  fm.params.ratio = 8;

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  const mute = ctx.createGain();
  mute.gain.value = 0;
  fm.output.connect(analyser).connect(mute).connect(ctx.destination);

  fm.noteOn(69);
  await wait(150);
  // Live-Feedback-Änderung auf die bereits klingende Stimme.
  fm.params.feedback = 0.3;
  const t = ctx.currentTime;
  for (const v of fm.voices.values()) v.fm.feedback.setTargetAtTime(0.3 * 400, t, 0.01);
  await wait(150);

  const td = new Float32Array(analyser.fftSize);
  let peak = 0, anyBad = false;
  for (let iter = 0; iter < 6; iter++) {
    analyser.getFloatTimeDomainData(td);
    for (const v of td) {
      if (!Number.isFinite(v)) anyBad = true;
      else if (Math.abs(v) > peak) peak = Math.abs(v);
    }
    await wait(20);
  }
  fm.noteOff(69);
  await wait(700);
  fm.output.disconnect(analyser);
  return { peak, anyBad };
});

console.log('FMSynth (Feedback=1->0.3 live, FM Amount=1, Ratio=8): Peak =', fmOut.peak.toFixed(4), 'anyBad =', fmOut.anyBad);
check('FMSynth: hörbarer Pegel bei Extremeinstellungen', fmOut.peak > 0.01);
check('FMSynth: kein NaN/Infinity bei Extremeinstellungen + Live-Feedback-Änderung', !fmOut.anyBad);

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
  psy.params.feedback = 1;
  psy.params.fmAmount = 1;
  psy.params.fmEnv = 1;
  psy.params.ratio = 8;
  psy.params.ringAmount = 1;
  psy.params.ringRatio = 8;
  psy.params.unisonVoices = 5;
  psy.params.unisonDetune = 50;

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  const mute = ctx.createGain();
  mute.gain.value = 0;
  psy.output.connect(analyser).connect(mute).connect(ctx.destination);

  psy.noteOn(69);
  await wait(400); // Swirl-LFOs aktiv mitmodulieren lassen
  const td = new Float32Array(analyser.fftSize);
  let peak = 0, anyBad = false;
  for (let iter = 0; iter < 8; iter++) {
    analyser.getFloatTimeDomainData(td);
    for (const v of td) {
      if (!Number.isFinite(v)) anyBad = true;
      else if (Math.abs(v) > peak) peak = Math.abs(v);
    }
    await wait(20);
  }
  psy.noteOff(69);
  await wait(700);

  // Zweite Note DIREKT nach dem ersten Release -- prüft #teardownNote/
  // #disconnectSwirl nach dem Umbau (fm.dispose() statt car.disconnect()).
  psy.noteOn(72);
  await wait(150);
  let secondNoteOk = psy.voices.has(72);
  psy.noteOff(72);
  await wait(700);

  psy.output.disconnect(analyser);
  return { peak, anyBad, secondNoteOk };
});

console.log('PsySynth (Feedback=1, FM Amount=1, Ratio=8, Ring voll, 5x Unisono): Peak =', psyOut.peak.toFixed(4), 'anyBad =', psyOut.anyBad);
check('PsySynth: hörbarer Pegel bei Extremeinstellungen + vollem Unisono', psyOut.peak > 0.01);
check('PsySynth: kein NaN/Infinity bei Extremeinstellungen', !psyOut.anyBad);
check('PsySynth: zweite Note direkt nach Teardown der ersten spielt sauber an (Swirl-Disconnect intakt)', psyOut.secondNoteOk);

check('Keine Seitenfehler', errors.length === 0);
if (errors.length) console.log(errors);

await browser.close();
process.exit(finish());
