/**
 * opto-memory-release.mjs — Regressionstest für den neuen "T4-Memory"-
 * Mechanismus des Opto-Kompressors (s. core/opto-worklet.js), der die
 * bisherige DynamicsCompressorNode-Fassung mit fest verdrahteter, einziger
 * Release-Zeit ersetzt.
 *
 * Kernbehauptung: die Release-Zeit ist PROGRAMMABHÄNGIG -- ein kurzer
 * lauter Ausreisser klingt schnell wieder ab, aber nach einer LÄNGEREN
 * Phase gleich starker Kompression braucht die Erholung spürbar länger
 * (die "Memory"-Zelle ist eingedunkelt). Getestet, indem zwei Szenarien mit
 * IDENTISCHEM Spitzenpegel, aber unterschiedlicher Dauer der lauten Phase,
 * durch denselben Kompressor geschickt werden und die Gain-Reduction-Kurve
 * NACH dem Ende des lauten Abschnitts verglichen wird.
 *
 * Voraussetzung: ein lokaler Server auf dem Repo-Root, z. B.
 *   python3 -m http.server 8901
 * Dann:  node tools/dsp-tests/opto-memory-release.mjs  [baseUrl]
 */
import { launchBrowser, makeReporter, unlockAudio, baseUrlFromArgv } from './_helpers.mjs';

const { check, finish } = makeReporter();
const browser = await launchBrowser();
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

await unlockAudio(page, baseUrlFromArgv());

async function runScenario(page, loudDurS) {
  return page.evaluate(async (loudDurS) => {
    const ctx = engine.ctx;
    if (ctx.state === 'suspended') await ctx.resume();
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    const insert = createInsert('opto', { params: { reduction: 1, gain: 0, mode: 'limit', mix: 1 } });
    await wait(150); // Worklet-Kaltstart abwarten (nur beim allerersten Insert in der Seite relevant)

    const sr = ctx.sampleRate;
    const silenceTail = 2.2;
    const n = Math.round(sr * (loudDurS + silenceTail));
    const buf = ctx.createBuffer(1, n, sr);
    const d = buf.getChannelData(0);
    const loudSamples = Math.round(sr * loudDurS);
    for (let i = 0; i < loudSamples; i++) d[i] = 0.8 * Math.sin((2 * Math.PI * 300 * i) / sr);
    // danach bleibt d[] bei 0 (Float32Array-Default) -- echte Stille.

    const src = ctx.createBufferSource();
    src.buffer = buf;
    const mute = ctx.createGain();
    mute.gain.value = 0;
    src.connect(insert.input);
    insert.output.connect(mute).connect(ctx.destination);

    src.start();
    const t0 = performance.now();
    const samples = [];
    const totalMs = (loudDurS + silenceTail) * 1000;
    while (performance.now() - t0 < totalMs) {
      samples.push({ tMs: performance.now() - t0, reductionDb: insert.getReductionDb() });
      await wait(15);
    }
    src.stop();
    await wait(30);
    src.disconnect();
    insert.output.disconnect(mute);
    mute.disconnect();
    insert.dispose();

    return { samples, loudDurS };
  }, loudDurS);
}

function reductionAt(samples, loudDurS, afterMs) {
  const targetT = (loudDurS * 1000) + afterMs;
  let best = samples[0];
  for (const s of samples) {
    if (Math.abs(s.tMs - targetT) < Math.abs(best.tMs - targetT)) best = s;
  }
  return best.reductionDb;
}

const brief = await runScenario(page, 0.08); // kurzer Ausreisser: 80ms laut
const sustained = await runScenario(page, 2.0); // anhaltende Kompression: 2s laut

// GENAU am Ende des lauten Abschnitts (t=0 relativ) sollten beide Szenarien
// ÄHNLICH stark reduziert sein (derselbe Spitzenpegel während der lauten
// Phase, Attack ist in beiden Fällen längst eingeschwungen, s. u.) -- DAS
// ist der faire Vergleichspunkt, nicht ein Zeitpunkt NACH Signalende: schon
// wenige Millisekunden nach Signalende weicht die Reduktion zwischen den
// beiden Szenarien bewusst voneinander ab (unterschiedliche Release-Rate ab
// dem allerersten Moment der Stille) -- genau DAS ist der zu belegende
// Effekt, kein Test-Fehler.
const briefAt0 = reductionAt(brief.samples, brief.loudDurS, 0);
const sustainedAt0 = reductionAt(sustained.samples, sustained.loudDurS, 0);
console.log('Reduktion am Ende der lauten Phase -- kurz:', briefAt0.toFixed(2), 'dB | anhaltend:', sustainedAt0.toFixed(2), 'dB');
check('Am Ende des lauten Abschnitts ist die Reduktion in beiden Szenarien ähnlich stark (fairer Vergleichspunkt, Attack längst eingeschwungen)',
  Math.abs(briefAt0 - sustainedAt0) < 3);

// 400ms später sollte der KURZE Ausreisser deutlich weiter erholt sein
// (näher an 0dB) als die anhaltende Kompression -- das ist der eigentliche
// Programmabhängigkeits-Nachweis.
const briefAt400 = reductionAt(brief.samples, brief.loudDurS, 400);
const sustainedAt400 = reductionAt(sustained.samples, sustained.loudDurS, 400);
console.log('Reduktion 400ms nach Ende der lauten Phase -- kurz:', briefAt400.toFixed(2), 'dB | anhaltend:', sustainedAt400.toFixed(2), 'dB');
check('Nach kurzem Ausreisser hat sich die Reduktion 400ms später deutlich weiter erholt als nach anhaltender Kompression (programmabhängiger Release)',
  briefAt400 > sustainedAt400 + 2);

// Nach ausreichend langer Stille (die volle Nachlaufzeit) sollten BEIDE
// Szenarien schliesslich vollständig erholt sein -- das Memory hält die
// Reduktion nur länger, nicht für immer.
const briefFinal = brief.samples[brief.samples.length - 1].reductionDb;
const sustainedFinal = sustained.samples[sustained.samples.length - 1].reductionDb;
console.log('Reduktion am Ende der Stillephase -- kurz:', briefFinal.toFixed(2), 'dB | anhaltend:', sustainedFinal.toFixed(2), 'dB');
check('Kurzer Ausreisser ist am Ende der Stille praktisch vollständig erholt', briefFinal > -1);
check('Anhaltende Kompression ist am Ende der Stille ebenfalls (fast) vollständig erholt', sustainedFinal > -1.5);

// Grundfunktion: während der lauten Phase wird tatsächlich reduziert.
const midLoud = reductionAt(sustained.samples, 0, sustained.loudDurS * 500);
console.log('Reduktion in der Mitte der lauten Phase (anhaltend):', midLoud.toFixed(2), 'dB');
check('Während des lauten Abschnitts wird spürbar komprimiert', midLoud < -3);

const anyBad = [...brief.samples, ...sustained.samples].some((s) => !Number.isFinite(s.reductionDb));
check('Keine NaN/Infinity in der Reduktions-Messreihe', !anyBad);

check('Keine Seitenfehler', pageErrors.length === 0);
if (pageErrors.length) console.log(pageErrors);

await browser.close();
process.exit(finish());
