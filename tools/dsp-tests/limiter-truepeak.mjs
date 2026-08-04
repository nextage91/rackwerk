/**
 * limiter-truepeak.mjs — Regressionstest für den neuen True-Peak-Lookahead-
 * Limiter (s. core/truepeak-limiter-worklet.js, core/inserts.js#DEFS.limiter),
 * Ersatz für die alte reine DynamicsCompressorNode-Fassung.
 *
 * Kernrisiko der alten Fassung: DynamicsCompressorNode prüft NUR die
 * diskreten Sample-Werte gegen die Schwelle. Hart geclipptes/hochfrequenz-
 * reiches Programmmaterial kann einen rekonstruierten (Inter-Sample-)Peak
 * haben, der klar ÜBER dem höchsten einzelnen Sample-Wert liegt (per
 * Catmull-Rom-Schätzung offline nachgemessen, s. Kommentar im Worklet:
 * ein bei 0.9 hart geclippter 8kHz-Ton hat einen diskreten Sample-Peak von
 * 0.9, aber einen geschätzten wahren Peak von ~1.0125 -- über 0dBFS). Eine
 * Ceiling zwischen diesen beiden Werten lässt einen reinen Sample-Peak-
 * Limiter das Signal komplett unangetastet durch; der neue True-Peak-
 * Limiter MUSS es trotzdem dämpfen.
 *
 * Voraussetzung: ein lokaler Server auf dem Repo-Root, z. B.
 *   python3 -m http.server 8901
 * Dann:  node tools/dsp-tests/limiter-truepeak.mjs  [baseUrl]
 */
import { launchBrowser, makeReporter, unlockAudio, baseUrlFromArgv } from './_helpers.mjs';

const { check, finish } = makeReporter();
const browser = await launchBrowser();
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

await unlockAudio(page, baseUrlFromArgv());

async function measurePeak(page, { ceilingDb, release, buildSignal, durationS }) {
  return page.evaluate(async ({ ceilingDb, release, code, durationS }) => {
    const ctx = engine.ctx;
    if (ctx.state === 'suspended') await ctx.resume();
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    // Ceiling/Release direkt als PARAMS beim Anlegen (nicht per setParam() DANACH):
    // ein frisch angelegter Insert, dessen einzige Quelle noch nicht gestartet ist,
    // hat noch kein aktiv durchlaufendes Signal -- eine per setTargetAtTime()
    // geplante Rampe braucht ein paar tatsächlich verarbeitete Blöcke, um zu
    // konvergieren, und die bleiben in diesem Leerlaufzustand aus (dasselbe würde
    // der alten DynamicsCompressorNode-Fassung mit ihrer eigenen
    // threshold.setTargetAtTime() ebenso passieren -- kein durch den neuen
    // Limiter verursachtes Verhalten). Der reale Master-Bus dagegen läuft
    // durchgehend (deshalb funktioniert dasselbe setParam()-Muster in
    // master-filter.mjs). Direkt als Default zu setzen entspricht ausserdem dem
    // realistischeren Fall "Regler steht schon dort, wenn der Insert entsteht".
    const insert = createInsert('limiter', { params: { inputGain: 0, ceiling: ceilingDb, release, mix: 1 } });
    // Weiterhin kurz abwarten -- deckt den (unabhängig davon bestehenden) Kaltstart-
    // Passthrough beim allerersten Laden des Worklet-Moduls ab, s. makeSweepFilter.
    await wait(150);

    const buildSignal = new Function('sr', 'n', `return (${code})(sr, n);`);
    const n = Math.round(ctx.sampleRate * durationS);
    const data = buildSignal(ctx.sampleRate, n);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    buf.getChannelData(0).set(data);
    const src = ctx.createBufferSource();
    src.buffer = buf;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    const mute = ctx.createGain();
    mute.gain.value = 0;
    src.connect(insert.input);
    insert.output.connect(analyser).connect(mute).connect(ctx.destination);

    src.start();
    let maxPeak = 0;
    let anyNaN = false;
    const pollUntil = performance.now() + durationS * 1000 + 150;
    const td = new Float32Array(analyser.fftSize);
    while (performance.now() < pollUntil) {
      analyser.getFloatTimeDomainData(td);
      for (const v of td) {
        if (!Number.isFinite(v)) anyNaN = true;
        else if (Math.abs(v) > maxPeak) maxPeak = Math.abs(v);
      }
      await wait(5);
    }
    src.stop();
    await wait(30);

    src.disconnect();
    insert.output.disconnect(analyser);
    analyser.disconnect();
    mute.disconnect();
    insert.dispose();

    return { maxPeak, anyNaN };
  }, { ceilingDb, release, code: buildSignal.toString(), durationS });
}

const dbToLin = (db) => Math.pow(10, db / 20);

// Signal, offline vorab nachgemessen (Node-Prototyp): diskreter Sample-Peak
// exakt 0.9 (hartes Clipping), Catmull-Rom-geschätzter wahrer Peak ~1.0125.
const clippedHighFreqSine = (sr, n) => {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const raw = 3.0 * Math.sin(2 * Math.PI * 8000 * i / sr);
    out[i] = Math.max(-0.9, Math.min(0.9, raw));
  }
  return out;
};

// ---------- 1) Inter-Sample-Peak wird gefangen, obwohl der diskrete Sample-Peak (0.9) unter der Ceiling liegt ----------
{
  const ceilingDb = -0.5; // ceilingLin ~0.944, > 0.9 (naiver Peak), aber < ~1.0125 (wahrer Peak)
  const ceilingLin = dbToLin(ceilingDb);
  const { maxPeak, anyNaN } = await measurePeak(page, {
    ceilingDb, release: 0.05, buildSignal: clippedHighFreqSine, durationS: 0.15,
  });
  console.log('Inter-Sample-Peak-Test: Ceiling =', ceilingLin.toFixed(4), '(', ceilingDb, 'dB ), gemessener Output-Peak =', maxPeak.toFixed(4));
  check('Naiver diskreter Sample-Peak (0.9) läge unter der Ceiling (Test wäre sonst wirkungslos)', 0.9 <= ceilingLin);
  check('True-Peak-Limiter dämpft trotzdem -- Output-Peak bleibt bei/unter der Ceiling', maxPeak <= ceilingLin * 1.05);
  check('Kein NaN/Inf im Output', !anyNaN);
}

// ---------- 2) Steady loud signal settles near the ceiling ----------
{
  const ceilingDb = -3;
  const ceilingLin = dbToLin(ceilingDb);
  const loudSine = (sr, n) => {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = 1.8 * Math.sin(2 * Math.PI * 440 * i / sr);
    return out;
  };
  const { maxPeak, anyNaN } = await measurePeak(page, {
    ceilingDb, release: 0.05, buildSignal: loudSine, durationS: 0.2,
  });
  console.log('Steady-loud-Test: Ceiling =', ceilingLin.toFixed(4), 'gemessener Output-Peak =', maxPeak.toFixed(4));
  check('Ein durchgehend lautes Signal wird zuverlässig auf/unter die Ceiling gebracht', maxPeak <= ceilingLin * 1.05);
  check('Kein NaN/Inf im Output', !anyNaN);
}

// ---------- 3) Quiet signal passes through basically unchanged ----------
{
  const ceilingDb = -0.5;
  const quietSine = (sr, n) => {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = 0.1 * Math.sin(2 * Math.PI * 220 * i / sr);
    return out;
  };
  const { maxPeak, anyNaN } = await measurePeak(page, {
    ceilingDb, release: 0.05, buildSignal: quietSine, durationS: 0.15,
  });
  console.log('Leises Signal: gemessener Output-Peak =', maxPeak.toFixed(4), '(Eingang: 0.1)');
  check('Ein leises Signal bleibt praktisch unverändert (keine Dämpfung nötig)', Math.abs(maxPeak - 0.1) < 0.02);
  check('Kein NaN/Inf im Output', !anyNaN);
}

check('Keine Seitenfehler', pageErrors.length === 0);
if (pageErrors.length) console.log(pageErrors);

await browser.close();
process.exit(finish());
