/**
 * chorus-phaser.mjs — Stabilitäts-/Regressionstest für die beiden neuen
 * Modulationseffekte (s. core/inserts.js#DEFS.chorus/DEFS.phaser), die im
 * Vergleich mit Abletons Stock-Effekten als fehlende Effektfamilie
 * identifiziert wurden ("Chorus/Ensemble", "Phaser/Flanger" -- RackWerk
 * hatte bis dahin GAR KEINE Modulationseffekte, nur Dynamik/EQ/Sättigung/
 * Delay/Reverb/Resonator).
 *
 * Chorus ist nicht-rekursiv (zwei vorwärts gespeiste modulierte Delays,
 * s. Kommentar bei DEFS.chorus) -- geringes Instabilitätsrisiko, aber
 * trotzdem stresstestet (Parameter-Extreme, Automation) statt nur
 * angenommen.
 *
 * Phaser hat dagegen eine ECHTE Rückkopplungsschleife (feedback-Regler) --
 * genau die Konstellation, die beim Reverb-Umbau (s. DEFS.reverb-Kommentar)
 * für modulierte DELAY-Zeiten als riskant identifiziert wurde. Die
 * modulierte Grösse ist hier aber eine Allpass-FREQUENZ, kein Delay --
 * ein Allpass hat |H(f)|=1 für jede Koeffizientenwahl, die Schleifen-
 * verstärkung ist also unabhängig vom LFO-Stand exakt durch den feedback-
 * Wert selbst begrenzt. Dieser Test verifiziert das empirisch (Extremwert
 * feedback=0.9, dichte Retriggerung, Live-Automation von feedback/rate/
 * depth während aktiv geklungen wird) statt sich nur auf die Theorie zu
 * verlassen.
 *
 * Voraussetzung: ein lokaler Server auf dem Repo-Root, z. B.
 *   python3 -m http.server 8901
 * Dann:  node tools/dsp-tests/chorus-phaser.mjs  [baseUrl]
 */
import { launchBrowser, makeReporter, unlockAudio, baseUrlFromArgv } from './_helpers.mjs';

const { check, finish } = makeReporter();
const browser = await launchBrowser();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await unlockAudio(page, baseUrlFromArgv());

const out = await page.evaluate(async (type) => {
  const ctx = engine.ctx;
  if (ctx.state === 'suspended') await ctx.resume();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const insert = createInsert(type);
  insert.setParam('mix', 1);

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  const mute = ctx.createGain();
  mute.gain.value = 0;
  insert.output.connect(analyser).connect(mute).connect(ctx.destination);

  let maxPeak = 0, anyNaN = false;
  const sample = () => {
    const data = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(data);
    for (const v of data) {
      if (!Number.isFinite(v)) anyNaN = true;
      else maxPeak = Math.max(maxPeak, Math.abs(v));
    }
  };
  const fireHit = (gain = 0.8) => {
    const len = Math.floor(ctx.sampleRate * 0.02);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.005)) * gain;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(insert.input);
    src.start();
  };

  const extremeParams = type === 'chorus'
    ? { rate: 8, depth: 1, width: 1 }
    : { rate: 8, depth: 1, feedback: 0.9 };
  for (const [k, v] of Object.entries(extremeParams)) insert.setParam(k, v);

  // 1. Dauerton bei Extremwerten.
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.value = 220;
  const g = ctx.createGain();
  g.gain.value = 0.4;
  osc.connect(g).connect(insert.input);
  osc.start();
  for (let i = 0; i < 15; i++) { await wait(200); sample(); }
  osc.stop();
  await wait(200);

  // 2. Dichte Retriggerung bei Extremwerten.
  for (let i = 0; i < 20; i++) {
    fireHit(0.8);
    await wait(50);
    sample();
  }
  await wait(300);
  sample();

  // 3. Parameter-Stichprobe.
  const sweepKeys = type === 'chorus' ? ['rate', 'depth', 'width'] : ['rate', 'depth', 'feedback'];
  const sweepVals = type === 'chorus' ? [0, 0.5, 1] : [0, 0.45, 0.9];
  for (const a of sweepVals) {
    for (const b of sweepVals) {
      insert.setParam(sweepKeys[0], a === 0 && sweepKeys[0] === 'rate' ? 0.05 : a * 8);
      insert.setParam(sweepKeys[1], b);
      fireHit(0.8);
      await wait(60);
      sample();
    }
  }

  // 4. Live-Automation aller Parameter WÄHREND aktiv geklungen und
  // retriggert wird -- genau der Fall, der beim Resonator/Reverb-Umbau
  // echte Bugs aufgedeckt hat (Zwischenzustände während Rampen).
  for (let i = 0; i < 30; i++) {
    insert.setParam('rate', 0.05 + Math.random() * 8);
    insert.setParam('depth', Math.random());
    if (type === 'chorus') insert.setParam('width', Math.random());
    else insert.setParam('feedback', Math.random() * 0.9);
    if (i % 4 === 0) fireHit(0.8);
    await wait(30);
    sample();
  }

  insert.dispose();
  analyser.disconnect();
  mute.disconnect();

  return { maxPeak, anyNaN };
}, 'chorus');

console.log('Chorus -- maximaler Pegel über den gesamten Stresstest:', out.maxPeak.toFixed(3));
check('Chorus: kein NaN/Infinity', !out.anyNaN);
check('Chorus: kein unbegrenztes/exzessives Aufschaukeln (Peak <= 3.0)', out.maxPeak <= 3);

const out2 = await page.evaluate(async (type) => {
  const ctx = engine.ctx;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const insert = createInsert(type);
  insert.setParam('mix', 1);

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  const mute = ctx.createGain();
  mute.gain.value = 0;
  insert.output.connect(analyser).connect(mute).connect(ctx.destination);

  let maxPeak = 0, anyNaN = false;
  const sample = () => {
    const data = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(data);
    for (const v of data) {
      if (!Number.isFinite(v)) anyNaN = true;
      else maxPeak = Math.max(maxPeak, Math.abs(v));
    }
  };
  const fireHit = (gain = 0.8) => {
    const len = Math.floor(ctx.sampleRate * 0.02);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.005)) * gain;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(insert.input);
    src.start();
  };

  insert.setParam('rate', 8);
  insert.setParam('depth', 1);
  insert.setParam('feedback', 0.9);

  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.value = 220;
  const g = ctx.createGain();
  g.gain.value = 0.4;
  osc.connect(g).connect(insert.input);
  osc.start();
  for (let i = 0; i < 15; i++) { await wait(200); sample(); }
  osc.stop();
  await wait(200);

  for (let i = 0; i < 20; i++) {
    fireHit(0.8);
    await wait(50);
    sample();
  }
  await wait(300);
  sample();

  for (const rate of [0.02, 4, 8]) {
    for (const feedback of [0, 0.45, 0.9]) {
      insert.setParam('rate', rate);
      insert.setParam('feedback', feedback);
      fireHit(0.8);
      await wait(60);
      sample();
    }
  }

  for (let i = 0; i < 30; i++) {
    insert.setParam('rate', 0.02 + Math.random() * 8);
    insert.setParam('depth', Math.random());
    insert.setParam('feedback', Math.random() * 0.9);
    if (i % 4 === 0) fireHit(0.8);
    await wait(30);
    sample();
  }

  insert.dispose();
  analyser.disconnect();
  mute.disconnect();

  return { maxPeak, anyNaN };
}, 'phaser');

console.log('Phaser -- maximaler Pegel über den gesamten Stresstest:', out2.maxPeak.toFixed(3));
check('Phaser: kein NaN/Infinity', !out2.anyNaN);
check('Phaser: kein unbegrenztes/exzessives Aufschaukeln (Peak <= 3.0)', out2.maxPeak <= 3);

check('Keine Seitenfehler', errors.length === 0);
if (errors.length) console.log(errors);

await browser.close();
process.exit(finish());
