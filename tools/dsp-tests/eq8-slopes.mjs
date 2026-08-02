/**
 * eq8-slopes.mjs — DSP-Genauigkeit der eq8-Highpass-Flankensteilheiten
 * (6/12/18/48 dB/Okt, s. core/inserts.js#eq8BuildBandNodes).
 *
 * Misst über ECHTES Audio (AnalyserNode-RMS, keine reine Formelauswertung),
 * dass jede Flanke tatsächlich mit der behaupteten Steilheit dämpft --
 * genau diese Messung deckte ursprünglich auf, dass die erste 6/18dB/Okt-
 * Umsetzung (ein nativer Graph-Zyklus als 1-Pol-Filter) durch die
 * render-quantum-bedingte Latenz um Grössenordnungen daneben lag (s.
 * core/onepole-worklet.js-Dateikopf) -- eine rein analytische Kurven-
 * prüfung hätte das NICHT gefunden, weil sie nie echtes Audio anfasst.
 *
 * Voraussetzung: ein lokaler Server auf dem Repo-Root, z. B.
 *   python3 -m http.server 8901
 * Dann:  node tools/dsp-tests/eq8-slopes.mjs  [baseUrl]
 */
import { launchBrowser, makeReporter, unlockAudio, baseUrlFromArgv } from './_helpers.mjs';

const { check, finish } = makeReporter();
const browser = await launchBrowser();
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

await unlockAudio(page, baseUrlFromArgv());

// ---------------- Highpass slope steepness (real audio, real createInsert) ----------------
const slopeResult = await page.evaluate(async () => {
  const ctx = engine.ctx;
  if (ctx.state === 'suspended') await ctx.resume();

  async function measureAt(insert, freq, ms) {
    const osc = ctx.createOscillator();
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.value = 0.3;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    osc.connect(g).connect(insert.input);
    insert.output.connect(analyser);
    osc.start();
    await new Promise((r) => setTimeout(r, ms));
    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const s of buf) sum += s * s;
    const rms = Math.sqrt(sum / buf.length);
    osc.stop();
    osc.disconnect();
    g.disconnect();
    insert.output.disconnect(analyser);
    analyser.disconnect();
    return 20 * Math.log10(Math.max(1e-8, rms));
  }

  const CUTOFF = 4000;
  // Pro Flankensteilheit ein eigenes Frequenzpaar: bei 48dB/Okt (8-polig)
  // würde ein Testpunkt 4 Oktaven unter Cutoff (wie bei 6/12/18 genutzt)
  // ~190dB Dämpfung implizieren -- weit jenseits des float32-Rauschbodens
  // von Web Audio (~140dB), die Messung läse dann reines Zahlenrauschen
  // statt des eigentlichen Signals. Näher an Cutoff (1000/2000Hz) bleibt
  // die Messung rauschbodenfrei, zeigt aber durch die Resonanzüberhöhung
  // der 4 kaskadierten Q=1-Stufen im Übergangsbereich eine etwas höhere
  // Steilheit als die reine Asymptote -- daher eigene, grosszügigere
  // Toleranz für 48dB/Okt.
  const FREQ_PAIRS = { 6: [250, 500], 12: [250, 500], 18: [250, 500], 48: [1000, 2000] };

  const out = {};
  for (const slope of [6, 12, 18, 48]) {
    const insert = createInsert('eq8');
    const b = insert.params.bands[0];
    b.type = 'highpass';
    b.freq = CUTOFF;
    b.slope = slope;
    b.active = true;
    insert.setBand(0, 'type');
    insert.setBand(0, 'slope');
    insert.setBand(0, 'freq');
    insert.setBand(0, 'active');

    const [LOW, HIGH] = FREQ_PAIRS[slope];
    const dbLow = await measureAt(insert, LOW, 150);
    const dbHigh = await measureAt(insert, HIGH, 150);
    out[slope] = { dbLow, dbHigh, diff: dbHigh - dbLow };
    insert.dispose();
  }
  return out;
});
console.log('slope steepness (measured dB rise per octave, well below cutoff):', JSON.stringify(slopeResult, null, 1));

for (const slope of [6, 12, 18, 48]) {
  const measured = slopeResult[slope].diff;
  const tolerance = slope === 48 ? 8 : 3;
  // Grosszügige Toleranz -- misst reale Audio-Nodes, nicht die reine
  // Formel; will nur grob die richtige Grössenordnung/Reihenfolge
  // bestätigen, keine Labor-Präzisionsmessung.
  check(`${slope}dB/oct highpass: measured rise per octave is close to ${slope}dB (got ${measured.toFixed(1)}dB)`, Math.abs(measured - slope) < tolerance);
}
check('Steeper slopes attenuate more: 12dB/oct < 48dB/oct measured rise', slopeResult[48].diff > slopeResult[12].diff);
check('Steeper slopes attenuate more: 6dB/oct < 12dB/oct < 18dB/oct', slopeResult[6].diff < slopeResult[12].diff && slopeResult[12].diff < slopeResult[18].diff);

// ---------------- Inactive highpass/lowpass band is transparent ----------------
const transparencyResult = await page.evaluate(async () => {
  const ctx = engine.ctx;

  async function measureThrough(setup, freq) {
    const insert = createInsert('eq8');
    setup(insert);
    const osc = ctx.createOscillator();
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.value = 0.3;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    osc.connect(g).connect(insert.input);
    insert.output.connect(analyser);
    osc.start();
    await new Promise((r) => setTimeout(r, 150));
    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const s of buf) sum += s * s;
    const rms = Math.sqrt(sum / buf.length);
    osc.stop();
    osc.disconnect();
    g.disconnect();
    insert.dispose();
    return 20 * Math.log10(Math.max(1e-8, rms));
  }

  // Bypass reference: an eq8 with NO active bands at all (every band stays
  // at its default 'peaking'/gain 0, already known-transparent).
  const dbBypass = await measureThrough(() => {}, 100);

  const dbInactiveHp = await measureThrough((insert) => {
    const b = insert.params.bands[0];
    b.type = 'highpass';
    b.freq = 1000; // would heavily attenuate 100Hz if ACTUALLY active
    b.slope = 12;
    b.active = false; // stays inactive
    insert.setBand(0, 'type');
    insert.setBand(0, 'slope');
    insert.setBand(0, 'freq');
    insert.setBand(0, 'active');
  }, 100);

  const dbInactiveLp = await measureThrough((insert) => {
    const b = insert.params.bands[0];
    b.type = 'lowpass';
    b.freq = 200; // would heavily attenuate 4000Hz if ACTUALLY active
    b.slope = 12;
    b.active = false;
    insert.setBand(0, 'type');
    insert.setBand(0, 'slope');
    insert.setBand(0, 'freq');
    insert.setBand(0, 'active');
  }, 4000);

  const dbActiveHpSameFreq = await measureThrough((insert) => {
    const b = insert.params.bands[0];
    b.type = 'highpass';
    b.freq = 1000;
    b.slope = 12;
    b.active = true; // NOW actually active, at 100Hz should be heavily cut
    insert.setBand(0, 'type');
    insert.setBand(0, 'slope');
    insert.setBand(0, 'freq');
    insert.setBand(0, 'active');
  }, 100);

  return { dbBypass, dbInactiveHp, dbInactiveLp, dbActiveHpSameFreq };
});
console.log('transparency result:', JSON.stringify(transparencyResult, null, 1));
check('Inactive highpass band leaves a 100Hz tone essentially unattenuated', Math.abs(transparencyResult.dbInactiveHp - transparencyResult.dbBypass) < 1);
check('Inactive lowpass band leaves a 4000Hz tone essentially unattenuated', Math.abs(transparencyResult.dbInactiveLp - transparencyResult.dbBypass) < 1);
check('The SAME band, once actually active, does heavily attenuate that frequency (sanity check the test itself)', transparencyResult.dbBypass - transparencyResult.dbActiveHpSameFreq > 15);

// ---------------- getEq8Response() curve: brickwall steeper than 12dB/oct ----------------
const curveResult = await page.evaluate(async () => {
  function curveDropPerOctave(slope) {
    const insert = createInsert('eq8');
    const b = insert.params.bands[0];
    b.type = 'highpass';
    b.freq = 4000;
    b.slope = slope;
    b.active = true;
    insert.setBand(0, 'type');
    insert.setBand(0, 'slope');
    insert.setBand(0, 'freq');
    insert.setBand(0, 'active');
    const freqs = new Float32Array([250, 500]);
    const db = insert.getEq8Response(freqs);
    insert.dispose();
    return db[1] - db[0];
  }
  return { db12: curveDropPerOctave(12), db48: curveDropPerOctave(48) };
});
console.log('curve result:', JSON.stringify(curveResult, null, 1));
check('getEq8Response() curve: Brickwall (48dB/oct) rises noticeably more per octave than 12dB/oct', curveResult.db48 > curveResult.db12 + 20);

check('No page errors', pageErrors.length === 0);
if (pageErrors.length) console.log(pageErrors);

await browser.close();
process.exit(finish());
