/**
 * gate-freqshift-vocoder-beatrepeat.mjs — Korrektheits-/Stabilitätstest für
 * die vier jüngsten Insert-Effekte (s. core/inserts.js#DEFS.gate/freqShift/
 * vocoder/beatRepeat), die im Vergleich mit Ableton als weitere fehlende
 * Effekte identifiziert wurden (nach Chorus/Phaser): Noise Gate,
 * Frequenzschieber, Vocoder, Beat Repeat.
 *
 * Drei davon brauchen eigene, handgeschriebene AudioWorkletProcessor
 * (Web Audio hat weder ein natives Gate/Expander- noch ein Frequenz-
 * schiebe- noch ein "Ringpuffer + Wiederholen"-Node) -- dieser Test prüft
 * nicht nur "kein NaN/kein Aufschaukeln" (wie die übrigen Stresstests),
 * sondern für jeden Effekt auch, dass er tatsächlich das Richtige TUT:
 *  - Gate: dämpft leise Abschnitte, lässt laute unverändert durch.
 *  - Frequency Shifter: verschiebt eine reine Testfrequenz tatsächlich um
 *    den eingestellten Hz-Betrag (Goertzel-Magnitudenvergleich statt einer
 *    vollen FFT -- reicht für einen einzelnen Frequenz-Peak-Vergleich).
 *  - Vocoder: die Ausgabe folgt der AMPLITUDEN-Hüllkurve des Eingangs
 *    (Modulator), statt eine konstante Trägerfrequenz-Drohne zu sein.
 *  - Beat Repeat: bei chance=1 sinkt die Lautstärke über aufeinander-
 *    folgende Zyklen tatsächlich gemäss `decay` (deterministisch, da
 *    chance=1 IMMER wiederholt -- kein Zufallseinfluss auf die Reihenfolge).
 *
 * Voraussetzung: ein lokaler Server auf dem Repo-Root, z. B.
 *   python3 -m http.server 8901
 * Dann:  node tools/dsp-tests/gate-freqshift-vocoder-beatrepeat.mjs [baseUrl]
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
  const results = {};

  function sampleRms(analyser) {
    const data = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(data);
    let sumSq = 0, peak = 0, anyNaN = false;
    for (const v of data) {
      if (!Number.isFinite(v)) anyNaN = true;
      else { sumSq += v * v; peak = Math.max(peak, Math.abs(v)); }
    }
    return { rms: Math.sqrt(sumSq / data.length), peak, anyNaN };
  }

  function goertzelMag(samples, freq, sr) {
    const N = samples.length;
    const k = Math.round((N * freq) / sr);
    const w = (2 * Math.PI * k) / N;
    const coeff = 2 * Math.cos(w);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < N; i++) {
      const s0 = samples[i] + coeff * s1 - s2;
      s2 = s1; s1 = s0;
    }
    const real = s1 - s2 * Math.cos(w);
    const imag = s2 * Math.sin(w);
    return Math.sqrt(real * real + imag * imag) / N;
  }

  // ---------- Gate ----------
  {
    const insert = createInsert('gate');
    insert.setParam('mix', 1);
    insert.setParam('threshold', -30);
    insert.setParam('range', -60);
    insert.setParam('attack', 0.005);
    insert.setParam('release', 0.05);
    await wait(50);

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    const mute = ctx.createGain();
    mute.gain.value = 0;
    insert.output.connect(analyser).connect(mute).connect(ctx.destination);

    // Konstantes leises Rauschen (unter der Schwelle) + periodische laute
    // Bursts (deutlich über der Schwelle).
    const quietNoise = ctx.createBufferSource();
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.003;
    quietNoise.buffer = buf;
    quietNoise.loop = true;
    quietNoise.connect(insert.input);
    quietNoise.start();

    let anyNaN = false;
    const quietSamples = [];
    const loudSamples = [];
    for (let i = 0; i < 6; i++) {
      await wait(300);
      const { rms, anyNaN: n } = sampleRms(analyser);
      if (n) anyNaN = true;
      quietSamples.push(rms);
    }
    const burstOsc = ctx.createOscillator();
    burstOsc.frequency.value = 440;
    const burstGain = ctx.createGain();
    burstGain.gain.value = 0.5;
    burstOsc.connect(burstGain).connect(insert.input);
    burstOsc.start();
    for (let i = 0; i < 6; i++) {
      await wait(300);
      const { rms, anyNaN: n } = sampleRms(analyser);
      if (n) anyNaN = true;
      loudSamples.push(rms);
    }
    burstOsc.stop();
    quietNoise.stop();
    insert.dispose();
    analyser.disconnect();
    mute.disconnect();

    const avgQuiet = quietSamples.slice(-3).reduce((a, b) => a + b, 0) / 3;
    const avgLoud = loudSamples.slice(-3).reduce((a, b) => a + b, 0) / 3;
    results.gate = { avgQuiet, avgLoud, anyNaN };
  }

  // ---------- Frequency Shifter ----------
  {
    const insert = createInsert('freqShift');
    insert.setParam('mix', 1);
    insert.setParam('shift', 200);
    await wait(300);

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 8192;
    const mute = ctx.createGain();
    mute.gain.value = 0;
    insert.output.connect(analyser).connect(mute).connect(ctx.destination);

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 1000;
    osc.connect(insert.input);
    osc.start();
    await wait(400);

    const data = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(data);
    let anyNaN = false;
    for (const v of data) if (!Number.isFinite(v)) anyNaN = true;
    const magAt1000 = goertzelMag(data, 1000, ctx.sampleRate);
    const magAt1200 = goertzelMag(data, 1200, ctx.sampleRate);

    osc.stop();
    insert.dispose();
    analyser.disconnect();
    mute.disconnect();
    results.freqShift = { magAt1000, magAt1200, anyNaN };
  }

  // ---------- Vocoder ----------
  {
    const insert = createInsert('vocoder');
    insert.setParam('mix', 1);
    await wait(50);

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    const mute = ctx.createGain();
    mute.gain.value = 0;
    insert.output.connect(analyser).connect(mute).connect(ctx.destination);

    const modOsc = ctx.createOscillator();
    modOsc.type = 'sawtooth';
    modOsc.frequency.value = 180;
    const modGate = ctx.createGain();
    modGate.gain.value = 0;
    modOsc.connect(modGate).connect(insert.input);
    modOsc.start();

    let anyNaN = false;
    const onSamples = [];
    const offSamples = [];
    for (let cycle = 0; cycle < 3; cycle++) {
      modGate.gain.setTargetAtTime(0.6, ctx.currentTime, 0.005);
      await wait(250);
      let r = sampleRms(analyser);
      if (r.anyNaN) anyNaN = true;
      onSamples.push(r.rms);
      modGate.gain.setTargetAtTime(0, ctx.currentTime, 0.005);
      await wait(250);
      r = sampleRms(analyser);
      if (r.anyNaN) anyNaN = true;
      offSamples.push(r.rms);
    }
    modOsc.stop();
    insert.dispose();
    analyser.disconnect();
    mute.disconnect();

    const avgOn = onSamples.reduce((a, b) => a + b, 0) / onSamples.length;
    const avgOff = offSamples.reduce((a, b) => a + b, 0) / offSamples.length;
    results.vocoder = { avgOn, avgOff, anyNaN };
  }

  // ---------- Beat Repeat ----------
  {
    const insert = createInsert('beatRepeat');
    insert.setParam('mix', 1);
    insert.setParam('chance', 1);
    insert.setParam('decay', 0.5);
    insert.setParam('division', '1/8');
    await wait(50);

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    const mute = ctx.createGain();
    mute.gain.value = 0;
    insert.output.connect(analyser).connect(mute).connect(ctx.destination);

    const noiseSrc = ctx.createBufferSource();
    const nbuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const nd = nbuf.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = (Math.random() * 2 - 1) * 0.8;
    noiseSrc.buffer = nbuf;
    noiseSrc.loop = true;
    noiseSrc.connect(insert.input);
    noiseSrc.start();

    // 1/8-Note bei Default-Tempo -- genug Zyklen in ~2.5s, um einen klaren
    // Decay-Trend über mehrere Wiederholungen zu sehen.
    let anyNaN = false, maxPeak = 0;
    const samples = [];
    for (let i = 0; i < 25; i++) {
      await wait(100);
      const r = sampleRms(analyser);
      if (r.anyNaN) anyNaN = true;
      maxPeak = Math.max(maxPeak, r.peak);
      samples.push(r.rms);
    }
    noiseSrc.stop();
    insert.dispose();
    analyser.disconnect();
    mute.disconnect();

    const firstThird = samples.slice(0, 8).reduce((a, b) => a + b, 0) / 8;
    const lastThird = samples.slice(-8).reduce((a, b) => a + b, 0) / 8;
    results.beatRepeat = { firstThird, lastThird, anyNaN, maxPeak };
  }

  // ---------- Stresstest: Parameter-Extreme + Live-Automation ----------
  // Dieselbe Grundidee wie resonator-modal-stability.mjs/chorus-phaser.mjs:
  // dichte Retriggerung + Live-Automation ALLER Regler während aktiv
  // gespielt wird, nur "kein NaN, Peak begrenzt" statt Korrektheit.
  async function stress(type, params, extra) {
    const insert = createInsert(type);
    insert.setParam('mix', 1);
    for (const [k, v] of Object.entries(params)) insert.setParam(k, v);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    const mute = ctx.createGain();
    mute.gain.value = 0;
    insert.output.connect(analyser).connect(mute).connect(ctx.destination);

    const noiseSrc = ctx.createBufferSource();
    const nbuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const nd = nbuf.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = (Math.random() * 2 - 1) * 0.8;
    noiseSrc.buffer = nbuf;
    noiseSrc.loop = true;
    noiseSrc.connect(insert.input);
    noiseSrc.start();

    let anyNaN = false, maxPeak = 0;
    for (let i = 0; i < 30; i++) {
      extra(insert, i);
      await wait(30);
      const r = sampleRms(analyser);
      if (r.anyNaN) anyNaN = true;
      maxPeak = Math.max(maxPeak, r.peak);
    }
    noiseSrc.stop();
    insert.dispose();
    analyser.disconnect();
    mute.disconnect();
    return { anyNaN, maxPeak };
  }

  results.gateStress = await stress('gate', { attack: 0.0002, release: 2 }, (i) => {
    i.setParam('threshold', -80 + Math.random() * 80);
    i.setParam('range', -80 + Math.random() * 80);
    i.setParam('attack', 0.0002 + Math.random() * 0.5);
    i.setParam('release', 0.005 + Math.random() * 2);
  });
  results.freqShiftStress = await stress('freqShift', {}, (i) => {
    i.setParam('shift', -1000 + Math.random() * 2000);
  });
  results.vocoderStress = await stress('vocoder', {}, (i) => {
    i.setParam('carrierPitch', 55 + Math.random() * 800);
    i.setParam('response', 5 + Math.random() * 55);
  });
  results.beatRepeatStress = await stress('beatRepeat', {}, (i, idx) => {
    const divs = ['1/16', '1/8t', '1/8', '1/4', '1/2'];
    i.setParam('division', divs[idx % divs.length]);
    i.setParam('chance', Math.random());
    i.setParam('decay', Math.random());
  });

  return results;
});

console.log(JSON.stringify(out, null, 2));

check('Gate: kein NaN/Infinity', !out.gate.anyNaN);
check('Gate: leise Passagen (unter Schwelle) werden deutlich gedämpft', out.gate.avgQuiet < 0.01);
check('Gate: laute Passagen (über Schwelle) bleiben nahezu unverändert durch', out.gate.avgLoud > 0.1);

check('Frequency Shifter: kein NaN/Infinity', !out.freqShift.anyNaN);
check('Frequency Shifter: Energie bei der Ziel-Frequenz (1200Hz) deutlich höher als beim Original (1000Hz)',
  out.freqShift.magAt1200 > out.freqShift.magAt1000 * 3);

check('Vocoder: kein NaN/Infinity', !out.vocoder.anyNaN);
check('Vocoder: Ausgabe folgt der Modulator-Hüllkurve (an-Phase deutlich lauter als aus-Phase)',
  out.vocoder.avgOn > out.vocoder.avgOff * 3);

check('Beat Repeat: kein NaN/Infinity', !out.beatRepeat.anyNaN);
check('Beat Repeat: kein unbegrenztes Aufschaukeln (Peak <= 3.0)', out.beatRepeat.maxPeak <= 3);
check('Beat Repeat: Lautstärke sinkt über die Zeit gemäss decay (chance=1, deterministisch)',
  out.beatRepeat.lastThird < out.beatRepeat.firstThird * 0.5);

check('Gate-Stresstest: kein NaN, kein Aufschaukeln (Peak <= 3.0)', !out.gateStress.anyNaN && out.gateStress.maxPeak <= 3);
check('Frequency-Shifter-Stresstest: kein NaN, kein Aufschaukeln (Peak <= 3.0)', !out.freqShiftStress.anyNaN && out.freqShiftStress.maxPeak <= 3);
check('Vocoder-Stresstest: kein NaN, kein Aufschaukeln (Peak <= 3.0)', !out.vocoderStress.anyNaN && out.vocoderStress.maxPeak <= 3);
check('Beat-Repeat-Stresstest: kein NaN, kein Aufschaukeln (Peak <= 3.0)', !out.beatRepeatStress.anyNaN && out.beatRepeatStress.maxPeak <= 3);

check('Keine Seitenfehler', errors.length === 0);
if (errors.length) console.log(errors);

await browser.close();
process.exit(finish());
