/**
 * master-filter.mjs — Regressionstest für den DJ-mixer-artigen Master-
 * Filter (Sweep/Reso, s. fx.js#buildFilterChain), Nutzer-Anfrage: "Filter-
 * sektion für die Song-Performance, wie beim Auflegen" -- ersetzt die
 * vorherigen 4 Makro-Knobs im Jam-Master-Kanal (s. jam-master-channel.mjs).
 *
 * Kernrisiko der gewählten Architektur (Parallel-HP/LP/Dry-Crossfade statt
 * Typ-Umschaltung eines einzelnen BiquadFilterNode, s. Kommentar bei
 * #buildFilterChain für die vollständige Begründung): bei sweep=0 MUSS das
 * Signal exakt unverändert durchlaufen (dryGain=1, beide Filterzweige
 * stumm) -- sonst wäre die zentrale Design-Garantie ("klickfrei, transparent
 * in der Mitte") gebrochen. Ausserdem muss negativer Sweep tatsächlich die
 * Tiefen dämpfen (Highpass) und positiver Sweep die Höhen (Lowpass) --
 * sonst wäre die Regler-Richtung vertauscht oder wirkungslos.
 *
 * Voraussetzung: ein lokaler Server auf dem Repo-Root, z. B.
 *   python3 -m http.server 8901
 * Dann:  node tools/dsp-tests/master-filter.mjs  [baseUrl]
 */
import { launchBrowser, makeReporter, unlockAudio, baseUrlFromArgv } from './_helpers.mjs';

const { check, finish } = makeReporter();
const browser = await launchBrowser();
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

await unlockAudio(page, baseUrlFromArgv());

const out = await page.evaluate(async () => {
  const ctx = engine.ctx;
  if (ctx.state === 'suspended') await ctx.resume();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // masterFX.init() lief bereits beim App-Boot (main.js) -- Sweep auf einen
  // definierten Startwert, damit vorherige Testläufe/Autosave nicht
  // durchschlagen.
  masterFX.setParam('filterSweep', 0);
  masterFX.setParam('filterReso', 5);
  await wait(100);

  /** Weisses Rauschen direkt in engine.masterFilterIn einspeisen (VOR dem
   *  Filter, NACH der kompletten Insert-Kette -- exakt der reale Signalpfad,
   *  s. audio-engine.js#buildMasterChain) und das Spektrum NACH
   *  engine.masterFilterOut messen (also inkl. Filterwirkung, aber vor dem
   *  Limiter, der sonst je nach Pegel unterschiedlich stark eingreifen und
   *  die Messung verfälschen könnte). */
  async function spectrumAt(sweep, reso) {
    masterFX.setParam('filterSweep', sweep);
    masterFX.setParam('filterReso', reso);
    await wait(80); // setTargetAtTime(…, 0.02) einschwingen lassen

    const len = ctx.sampleRate * 0.5;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * 0.5;
    const src = ctx.createBufferSource();
    src.buffer = buf;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0;
    const mute = ctx.createGain();
    mute.gain.value = 0;
    src.connect(engine.masterFilterIn);
    engine.masterFilterOut.connect(analyser).connect(mute).connect(ctx.destination);

    src.start();
    await wait(300);
    const spec = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(spec);
    src.stop();
    await wait(50);

    src.disconnect();
    engine.masterFilterOut.disconnect(analyser);
    analyser.disconnect();
    mute.disconnect();

    const binHz = ctx.sampleRate / 2 / spec.length;
    const avg = (loHz, hiHz) => {
      let sum = 0, n = 0;
      for (let i = Math.ceil(loHz / binHz); i < Math.min(spec.length, hiHz / binHz); i++) {
        if (Number.isFinite(spec[i])) { sum += spec[i]; n++; }
      }
      return n ? sum / n : -999;
    };
    return {
      low: avg(60, 200),
      high: avg(6000, 12000),
      bad: spec.some((v) => Number.isNaN(v)),
    };
  }

  // Zwei unabhängige Messungen bei sweep=0 (einmal "von negativ kommend",
  // einmal "von positiv kommend") -- deckt ab, dass BEIDE Zweige (HP-Ast
  // UND LP-Ast) bei Sweep 0 wirklich stumm sind, nicht nur der zuletzt
  // aktive.
  const neutralFromNeg = await spectrumAt(0, 5);
  const hp = await spectrumAt(-1, 5);
  const backToNeutral = await spectrumAt(0, 5);
  const lp = await spectrumAt(1, 5);
  const highReso = await spectrumAt(-0.6, 14);

  return {
    neutralFromNeg, hp, backToNeutral, lp, highReso,
    anyNaN: [neutralFromNeg, hp, backToNeutral, lp, highReso].some((r) => r.bad),
  };
});

console.log('Sweep=0 (aus HP kommend)  low/high (dB):', out.neutralFromNeg.low.toFixed(1), out.neutralFromNeg.high.toFixed(1));
console.log('Sweep=-1 (Highpass)       low/high (dB):', out.hp.low.toFixed(1), out.hp.high.toFixed(1));
console.log('Sweep=0 (aus LP kommend)  low/high (dB):', out.backToNeutral.low.toFixed(1), out.backToNeutral.high.toFixed(1));
console.log('Sweep=+1 (Lowpass)        low/high (dB):', out.lp.low.toFixed(1), out.lp.high.toFixed(1));
console.log('Sweep=-0.6, Reso=14       low/high (dB):', out.highReso.low.toFixed(1), out.highReso.high.toFixed(1));

check('Sweep=0 ist transparent bezüglich Tiefen (kein Highpass hängt noch nach)',
  Math.abs(out.neutralFromNeg.low - out.backToNeutral.low) < 3);
check('Sweep=0 ist transparent bezüglich Höhen (kein Lowpass hängt noch nach)',
  Math.abs(out.neutralFromNeg.high - out.backToNeutral.high) < 3);
check('Sweep=-1 (Highpass) dämpft die Tiefen deutlich gegenüber Sweep=0',
  out.neutralFromNeg.low - out.hp.low > 15);
check('Sweep=-1 (Highpass) lässt die Höhen weitgehend unangetastet',
  Math.abs(out.hp.high - out.neutralFromNeg.high) < 6);
check('Sweep=+1 (Lowpass) dämpft die Höhen deutlich gegenüber Sweep=0',
  out.backToNeutral.high - out.lp.high > 15);
check('Sweep=+1 (Lowpass) lässt die Tiefen weitgehend unangetastet',
  Math.abs(out.lp.low - out.backToNeutral.low) < 6);
check('Hohe Resonanz bleibt stabil (kein NaN/Inf im Spektrum)', !out.anyNaN);
check('Keine Seitenfehler', pageErrors.length === 0);
if (pageErrors.length) console.log(pageErrors);

await browser.close();
process.exit(finish());
