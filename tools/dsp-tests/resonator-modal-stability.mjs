/**
 * resonator-modal-stability.mjs — Stabilitäts-/Regressionstest für den
 * neuen, Faust-basierten Modal-Synthese-Resonator (s. faust/resonator.dsp,
 * core/resonator-worklet.js, core/inserts.js#DEFS.resonator), der die
 * frühere 5-Band-Karplus-Strong-Delayline-Bank ersetzt (Nutzer-Feedback:
 * "klingt immer noch nicht so schön").
 *
 * Deckt denselben Stresstest-Umfang ab, den schon die alte Bank bestehen
 * musste (s. Git-Historie): Dauerton bei Max-Resonance/-Damping, dichte
 * Retriggerung, eine Parameter-Stichprobe (Pitch x Resonance x Damping)
 * sowie Live-Automation WÄHREND aktiv geklungen und retriggert wird --
 * durchgehend kein NaN, kein unbegrenztes Aufschaukeln.
 *
 * Deckt ausserdem den ECHTEN Bug ab, der beim Umbau auffiel: der alte
 * Anreger-Ducker (-50dB/20:1, für die schmalbandige 5-Band-Bank getunt,
 * die nur nahe ihren eigenen 5 Resonanzfrequenzen reagierte) presste den
 * Anschlag einer neuen Note fast bis zur Rechteckwelle zusammen -- die
 * neue, breitbandige 24-Moden-Synthese reagiert auf das GANZE Spektrum
 * der Anregung und wurde von den dabei entstehenden massiven Obertönen
 * kurzzeitig >30x übersteuert (gemessen VOR dem Sicherheits-Limiter).
 * Milder getunt (-24dB/4:1) behoben -- dieser Test hätte das Problem
 * direkt aufgedeckt (maxPeak-Schranke unten).
 *
 * Voraussetzung: ein lokaler Server auf dem Repo-Root, z. B.
 *   python3 -m http.server 8901
 * Dann:  node tools/dsp-tests/resonator-modal-stability.mjs  [baseUrl]
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

  const insert = createInsert('resonator');
  insert.setParam('mix', 1);
  // Worklet-Modul + WASM laden lassen, bevor gemessen wird -- sonst landet
  // die Messung auf dem transparenten Platzhalter (s. ensureResonatorWorklet).
  await wait(700);

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

  // 1. Dauerton bei Max-Resonance/-Damping (3s -- die Abklingzeit sättigt
  // bei Max-Resonance deutlich vor 3s, s. resonator.dsp#decayTime).
  insert.setParam('resonance', 1);
  insert.setParam('damping', 18000);
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

  // 2. Dichte Retriggerung (alle 50ms) bei Max-Resonance/-Damping.
  for (let i = 0; i < 20; i++) {
    fireHit(0.8);
    await wait(50);
    sample();
  }
  await wait(300);
  sample();

  // 3. Parameter-Stichprobe (Resonance x Damping).
  for (const resonance of [0, 0.3, 0.6, 1]) {
    for (const damping of [500, 4000, 18000]) {
      insert.setParam('resonance', resonance);
      insert.setParam('damping', damping);
      fireHit(0.8);
      await wait(60);
      sample();
    }
  }

  // 4. Live-Automation (Pitch/Resonance/Damping) WÄHREND aktiv geklungen
  // und retriggert wird.
  insert.setParam('resonance', 0.9);
  for (let i = 0; i < 30; i++) {
    insert.setParam('pitch', 100 + Math.random() * 1500);
    insert.setParam('resonance', Math.random());
    insert.setParam('damping', 300 + Math.random() * 15000);
    if (i % 4 === 0) fireHit(0.8);
    await wait(30);
    sample();
  }

  insert.dispose();
  analyser.disconnect();
  mute.disconnect();

  return { maxPeak, anyNaN };
});

console.log('Maximaler Pegel über den gesamten Stresstest:', out.maxPeak.toFixed(3));
check('Kein NaN/Infinity über den gesamten Stresstest', !out.anyNaN);
// >3 wäre klar aussergewöhnlich -- der Sicherheits-Limiter (Schwelle 0dB,
// 20:1) lässt normale Überschwinger nur wenig über 1.0 durch (gemessen
// ~1.0-1.3 im Normalfall). Ein Wert weit darüber deckt genau den Bug auf,
// der den alten, zu harten Anreger-Ducker enttarnt hat (s. Dateikopf).
check('Kein unbegrenztes/exzessives Aufschaukeln (Peak <= 3.0)', out.maxPeak <= 3);
check('Keine Seitenfehler', errors.length === 0);
if (errors.length) console.log(errors);

await browser.close();
process.exit(finish());
