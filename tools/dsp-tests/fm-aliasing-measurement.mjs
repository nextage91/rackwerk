/**
 * fm-aliasing-measurement.mjs — Regressionstest für den überabgetasteten
 * FM-Stimmen-Worklet (s. core/fm-voice-worklet.js, core/dsp.js#makeFmVoice),
 * der das per früherer Messung bestätigte Aliasing bei hohem
 * Modulationsindex in FMSynth/PsySynth beheben soll (die alte, reine
 * Zwei-OscillatorNode-FM lief ohne jede interne Überabtastung).
 *
 * Testet den ECHTEN, ausgelieferten `rackwerk-fm-voice`-Worklet-Prozessor
 * direkt (nicht nur eine Nachbildung in Test-Code) -- das Modul wird schon
 * geladen, sobald einmal eine FMSynth/PsySynth-Maschine angelegt wurde,
 * deshalb der UI-Vorlauf über openApp() + Maschine anlegen.
 *
 * Methode: derselbe Vergleich wie in der ursprünglichen Messung (jetzt
 * commit-historisch als reine Diagnose, s. PR) -- der neue Worklet bei
 * 48kHz (mit interner 4x-Überabtastung + Dezimationsfilter) gegen eine
 * NAIVE (unüberabgetastete) Referenz bei 192kHz, in einem Wächterband, das
 * in sauberer Zwei-Sinus-FM praktisch still sein sollte. Diesmal MIT
 * scharfer Schwelle -- der Fix ist jetzt Teil des Codes, ein Rückfall soll
 * auffallen.
 *
 * Voraussetzung: ein lokaler Server auf dem Repo-Root, z. B.
 *   python3 -m http.server 8901
 * Dann:  node tools/dsp-tests/fm-aliasing-measurement.mjs  [baseUrl]
 */
import { launchBrowser, makeReporter, openApp, baseUrlFromArgv } from './_helpers.mjs';

const { check, finish } = makeReporter();
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

await openApp(page, baseUrlFromArgv());

// FM Synth anlegen -> registriert 'rackwerk-fm-voice' im (Echtzeit-)
// AudioContext. Reicht NICHT für die separaten OfflineAudioContext-
// Renderings unten (Worklet-Module sind pro-Context registriert) -- die
// laden das Modul jeweils selbst über den global zugänglichen
// FM_VOICE_WORKLET_SRC-String nach, s. u.
await page.click('.rack__add');
await page.waitForSelector('.sheet__item');
await page.locator('.sheet__item', { hasText: 'FM Synth' }).first().click();
await page.waitForTimeout(500);

const out = await page.evaluate(async () => {
  const FM_INDEX_SCALE = 6;
  const FEEDBACK_SCALE = 400;

  /** Rendert den ECHTEN fm-voice-Worklet offline bei `sr`. */
  async function renderFmWorklet(sr, durS, { carrierFreq, modFreq, fmIndex, feedback = 0 }) {
    const n = Math.round(sr * durS);
    const ctx = new OfflineAudioContext(1, n, sr);
    const blob = new Blob([FM_VOICE_WORKLET_SRC], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const node = new AudioWorkletNode(ctx, 'rackwerk-fm-voice', { numberOfInputs: 0, numberOfOutputs: 1 });
    node.parameters.get('carrierFreq').value = carrierFreq;
    node.parameters.get('modFreq').value = modFreq;
    node.parameters.get('fmIndex').value = fmIndex;
    node.parameters.get('feedback').value = feedback;
    node.connect(ctx.destination);
    const buf = await ctx.startRendering();
    return buf.getChannelData(0);
  }

  /** Naive (unüberabgetastete) Zwei-Oscillator-FM als Referenz -- exakt die
   *  ALTE Architektur, hier nur als Mess-Referenz bei sehr hoher Sample-
   *  Rate weiterverwendet (dort praktisch alias-frei). */
  async function renderFmNaive(sr, durS, { carrierFreq, modFreq, fmIndex, feedback = 0 }) {
    const n = Math.round(sr * durS);
    const ctx = new OfflineAudioContext(1, n, sr);
    const car = ctx.createOscillator();
    car.type = 'sine';
    car.frequency.value = carrierFreq;
    const mod = ctx.createOscillator();
    mod.type = 'sine';
    mod.frequency.value = modFreq;
    const modGain = ctx.createGain();
    modGain.gain.value = fmIndex;
    mod.connect(modGain).connect(car.frequency);
    const fbGain = ctx.createGain();
    fbGain.gain.value = feedback;
    mod.connect(fbGain).connect(mod.frequency);
    car.connect(ctx.destination);
    car.start(0); mod.start(0);
    const buf = await ctx.startRendering();
    return buf.getChannelData(0);
  }

  async function renderRing(sr, durS, { carrierFreq, ringRatio, ringDepth }) {
    const n = Math.round(sr * durS);
    const ctx = new OfflineAudioContext(1, n, sr);
    const car = ctx.createOscillator();
    car.type = 'sine';
    car.frequency.value = carrierFreq;
    const ring = ctx.createOscillator();
    ring.type = 'sine';
    ring.frequency.value = carrierFreq * ringRatio;
    const ringGain = ctx.createGain();
    ringGain.gain.value = 1 - ringDepth;
    const ringDepthGain = ctx.createGain();
    ringDepthGain.gain.value = ringDepth;
    ring.connect(ringDepthGain).connect(ringGain.gain);
    car.connect(ringGain);
    ringGain.connect(ctx.destination);
    car.start(0); ring.start(0);
    const buf = await ctx.startRendering();
    return buf.getChannelData(0);
  }

  async function guardBandRms(sr, data, guardLoHz, guardHiHz) {
    const ctx = new OfflineAudioContext(1, data.length, sr);
    const buf = ctx.createBuffer(1, data.length, sr);
    buf.getChannelData(0).set(data);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const hp1 = ctx.createBiquadFilter(); hp1.type = 'highpass'; hp1.frequency.value = guardLoHz;
    const hp2 = ctx.createBiquadFilter(); hp2.type = 'highpass'; hp2.frequency.value = guardLoHz;
    const lp1 = ctx.createBiquadFilter(); lp1.type = 'lowpass'; lp1.frequency.value = guardHiHz;
    const lp2 = ctx.createBiquadFilter(); lp2.type = 'lowpass'; lp2.frequency.value = guardHiHz;
    src.connect(hp1).connect(hp2).connect(lp1).connect(lp2).connect(ctx.destination);
    src.start(0);
    const rendered = await ctx.startRendering();
    const d = rendered.getChannelData(0);
    const skip = Math.floor(d.length * 0.1);
    let sumSq = 0, n = 0;
    for (let i = skip; i < d.length - skip; i++) { sumSq += d[i] * d[i]; n++; }
    return Math.sqrt(sumSq / n);
  }

  const DUR = 0.3;
  const LOW_SR = 48000;
  const HIGH_SR = 192000; // Nyquist 96kHz -- weit über jedem hier erzeugten Seitenband

  const carrierFreq = 880, ratio = 8, modFreq = carrierFreq * ratio;
  const fmAmount = 1;
  const fmIndex = fmAmount * FM_INDEX_SCALE * modFreq;

  // ---------- Szenario 1: reine FM, hoher Modulationsindex ----------
  const fmParams = { carrierFreq, modFreq, fmIndex, feedback: 0 };
  const fmFixedLow = await renderFmWorklet(LOW_SR, DUR, fmParams);
  const fmRefHigh = await renderFmNaive(HIGH_SR, DUR, fmParams);
  const fmNaiveLow = await renderFmNaive(LOW_SR, DUR, fmParams);
  const fmGuardFixed = await guardBandRms(LOW_SR, fmFixedLow, 20, 150);
  const fmGuardRef = await guardBandRms(HIGH_SR, fmRefHigh, 20, 150);
  const fmGuardNaive = await guardBandRms(LOW_SR, fmNaiveLow, 20, 150);

  // ---------- Szenario 2: FM + volles Feedback ----------
  const fbParams = { carrierFreq, modFreq, fmIndex, feedback: 1 * FEEDBACK_SCALE };
  const fbFixedLow = await renderFmWorklet(LOW_SR, DUR, fbParams);
  const fbRefHigh = await renderFmNaive(HIGH_SR, DUR, fbParams);
  const fbNaiveLow = await renderFmNaive(LOW_SR, DUR, fbParams);
  const fbGuardFixed = await guardBandRms(LOW_SR, fbFixedLow, 20, 150);
  const fbGuardRef = await guardBandRms(HIGH_SR, fbRefHigh, 20, 150);
  const fbGuardNaive = await guardBandRms(LOW_SR, fbNaiveLow, 20, 150);

  // ---------- Szenario 3: PsySynth-Ringmodulation (unverändert nativ) ----------
  const ringParams = { carrierFreq, ringRatio: 8, ringDepth: 1 };
  const ringLow = await renderRing(LOW_SR, DUR, ringParams);
  const ringHigh = await renderRing(HIGH_SR, DUR, ringParams);
  const ringGuardLow = await guardBandRms(LOW_SR, ringLow, 20, 150);
  const ringGuardHigh = await guardBandRms(HIGH_SR, ringHigh, 20, 150);

  const anyBad = [fmFixedLow, fbFixedLow, ringLow].some((arr) => arr.some((v) => !Number.isFinite(v)));

  return {
    fmGuardFixed, fmGuardRef, fmGuardNaive,
    fbGuardFixed, fbGuardRef, fbGuardNaive,
    ringGuardLow, ringGuardHigh,
    anyBad,
  };
});

const dbfs = (v) => 20 * Math.log10(Math.max(v, 1e-9));

console.log('--- Szenario 1: reine FM (Carrier 880Hz, Ratio 8, FM Amount 1, Feedback 0) ---');
console.log('Alte, unüberabgetastete Fassung @48kHz:', dbfs(out.fmGuardNaive).toFixed(1), 'dBFS');
console.log('Neuer Worklet (4x überabgetastet) @48kHz:', dbfs(out.fmGuardFixed).toFixed(1), 'dBFS');
console.log('Alias-freie Referenz @192kHz:', dbfs(out.fmGuardRef).toFixed(1), 'dBFS');
console.log('Verbesserung ggü. alter Fassung:', (dbfs(out.fmGuardNaive) - dbfs(out.fmGuardFixed)).toFixed(1), 'dB');

console.log('\n--- Szenario 2: FM + volles Feedback ---');
console.log('Alte, unüberabgetastete Fassung @48kHz:', dbfs(out.fbGuardNaive).toFixed(1), 'dBFS');
console.log('Neuer Worklet (4x überabgetastet) @48kHz:', dbfs(out.fbGuardFixed).toFixed(1), 'dBFS');
console.log('Alias-freie Referenz @192kHz:', dbfs(out.fbGuardRef).toFixed(1), 'dBFS');
console.log('Verbesserung ggü. alter Fassung:', (dbfs(out.fbGuardNaive) - dbfs(out.fbGuardFixed)).toFixed(1), 'dB');

console.log('\n--- Szenario 3: PsySynth-Ringmodulation (unverändert, zur Kontrolle) ---');
console.log('@48kHz:', dbfs(out.ringGuardLow).toFixed(1), 'dBFS | @192kHz-Referenz:', dbfs(out.ringGuardHigh).toFixed(1), 'dBFS');

check('Keine NaN/Infinity in den Renderings', !out.anyBad);

check('Reine FM: neuer Worklet liegt nah an der alias-freien Referenz (<6dB Differenz)',
  (dbfs(out.fmGuardFixed) - dbfs(out.fmGuardRef)) < 6);
check('Reine FM: neuer Worklet ist deutlich besser als die alte Fassung (>=10dB Verbesserung)',
  (dbfs(out.fmGuardNaive) - dbfs(out.fmGuardFixed)) >= 10);
// FM+Feedback ist ein selbstrückgekoppeltes, chaotisches System (der
// Modulator moduliert seine EIGENE Frequenz) -- strukturell breitbandiger/
// rauschartiger als reine FM, deshalb bleibt selbst nach dem Fix eine
// grössere Reststreuung ggü. der 192kHz-Referenz übrig als bei Szenario 1.
// Der eigentliche Beweis ist die klare Verbesserung ggü. der alten,
// unüberabgetasteten Fassung, nicht ein exaktes Erreichen der Referenz.
check('FM + volles Feedback: neuer Worklet ist deutlich besser als die alte Fassung (>=8dB Verbesserung)',
  (dbfs(out.fbGuardNaive) - dbfs(out.fbGuardFixed)) >= 8);
check('FM + volles Feedback: neuer Worklet bleibt in derselben Grössenordnung wie die Referenz (<25dB Differenz)',
  (dbfs(out.fbGuardFixed) - dbfs(out.fbGuardRef)) < 25);
// Ringmodulation: beide Werte liegen im Rauschboden (< -65dBFS, praktisch
// Stille) -- bei so niedrigen Pegeln schwankt die dB-Differenz stark, ohne
// dass das etwas mit echtem Aliasing zu tun hätte. Die eigentlich relevante
// Prüfung ist, dass BEIDE Werte klar im Rauschboden bleiben (kein reales
// Signal dort), nicht ihre relative Differenz zueinander.
check('Ringmodulation bleibt unauffällig (beide Messungen klar im Rauschboden, <-60dBFS)',
  dbfs(out.ringGuardLow) < -60 && dbfs(out.ringGuardHigh) < -60);

check('Keine Seitenfehler', pageErrors.length === 0);
if (pageErrors.length) console.log(pageErrors);

await browser.close();
process.exit(finish());
