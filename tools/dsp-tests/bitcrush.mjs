/**
 * bitcrush.mjs — Korrektheits-/Stabilitätstest für den Bitcrusher (s.
 * core/inserts.js#DEFS.bitcrush, core/bitcrush-worklet.js).
 *
 * Prüft nicht nur "kein NaN/kein Aufschaukeln" (das brauchte hier ohnehin
 * keinen aufwendigen Stresstest -- reine Sample&Hold + Quantisierung ohne
 * jede Rückkopplung kann per Konstruktion nicht aufschaukeln), sondern
 * auch, dass die beiden Kernmechanismen TATSÄCHLICH wirken:
 *  - bits: niedrige Bit-Tiefe reduziert die Anzahl UNTERSCHIEDLICHER
 *    Amplitudenwerte im Ausgangssignal messbar (Quantisierungsstufen).
 *  - rate: niedrige Sample-Rate hält jeden Wert über mehrere echte Samples
 *    -- messbar als deutlich weniger Wert-zu-Wert-ÄNDERUNGEN pro Zeit-
 *    einheit als im unveränderten Signal.
 *
 * Voraussetzung: ein lokaler Server auf dem Repo-Root, z. B.
 *   python3 -m http.server 8901
 * Dann:  node tools/dsp-tests/bitcrush.mjs  [baseUrl]
 */
import { launchBrowser, makeReporter, unlockAudio, baseUrlFromArgv } from './_helpers.mjs';

const { check, finish } = makeReporter();
const browser = await launchBrowser();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await unlockAudio(page, baseUrlFromArgv());

const out = await page.evaluate(async () => {
  const ctx = engine.ctx;
  if (ctx.state === 'suspended') await ctx.resume();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function captureWithParams(bits, rate) {
    const insert = createInsert('bitcrush');
    insert.setParam('mix', 1);
    insert.setParam('bits', bits);
    insert.setParam('rate', rate);
    insert.setParam('jitter', 0);
    await wait(300);

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    const mute = ctx.createGain();
    mute.gain.value = 0;
    insert.output.connect(analyser).connect(mute).connect(ctx.destination);

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 660;
    const g = ctx.createGain();
    g.gain.value = 0.8;
    osc.connect(g).connect(insert.input);
    osc.start();
    await wait(300);

    const data = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(data);
    let anyNaN = false, peak = 0;
    const distinctValues = new Set();
    let changes = 0;
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      if (!Number.isFinite(v)) anyNaN = true;
      else peak = Math.max(peak, Math.abs(v));
      distinctValues.add(Math.round(v * 100000));
      if (i > 0 && data[i] !== data[i - 1]) changes++;
    }
    osc.stop();
    insert.dispose();
    analyser.disconnect();
    mute.disconnect();
    return { anyNaN, peak, distinctCount: distinctValues.size, changes };
  }

  const results = {};
  results.hiFi = await captureWithParams(16, 48000);
  results.lowBits = await captureWithParams(2, 48000);
  results.lowRate = await captureWithParams(16, 500);
  return results;
});

console.log(JSON.stringify(out, null, 2));

check('kein NaN/Infinity (16-Bit/48kHz)', !out.hiFi.anyNaN);
check('kein NaN/Infinity (2-Bit)', !out.lowBits.anyNaN);
check('kein NaN/Infinity (500Hz)', !out.lowRate.anyNaN);
check('kein Aufschaukeln (Peak <= 1.1 -- reine Quantisierung kann Pegel nicht erhöhen)',
  out.hiFi.peak <= 1.1 && out.lowBits.peak <= 1.1 && out.lowRate.peak <= 1.1);

check('bits: 2-Bit hat deutlich weniger unterschiedliche Amplitudenwerte als 16-Bit',
  out.lowBits.distinctCount < out.hiFi.distinctCount / 4);

check('rate: 500Hz Sample&Hold hat deutlich weniger Wert-Änderungen pro Fenster als 48kHz',
  out.lowRate.changes < out.hiFi.changes / 4);

check('Keine Seitenfehler', errors.length === 0);
if (errors.length) console.log(errors);

await browser.close();
process.exit(finish());
