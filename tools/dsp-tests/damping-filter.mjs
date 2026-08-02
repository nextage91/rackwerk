/**
 * damping-filter.mjs — Regressionstest für den Damping-Filter
 * (makeOnePoleLowpass, s. core/inserts.js), gemeinsam genutzt vom Reverb-
 * Tank und den Resonator-Delaylines.
 *
 * Gemessen wird die Höhenenergie im AUSKLANG (nach Abschalten der Quelle) --
 * nur dort besteht das Signal ausschliesslich aus rezirkuliertem, also
 * mehrfach durch den Damping-Filter gelaufenem Material. Im eingeschwungenen
 * Zustand dominiert das frische, ungedämpfte Eingangssignal und verwässert
 * die Messung (nachgemessen: Spreizung dort nur ~7dB statt ~94dB).
 *
 * Die eigentliche Korrektheit der 1-Pol-Stufe selbst (exakt 6dB/Okt) prüft
 * eq8-slopes.mjs -- eq8 und dieser Damping-Filter teilen sich seit deren
 * Zusammenführung dasselbe Worklet (core/onepole-worklet.js). Dieser Test
 * deckt die INTEGRATION in die beiden Feedback-Netze ab: wirkt der Regler
 * monoton über seinen ganzen Bereich, und bleibt das Netz dabei stabil.
 *
 * Der Reverb wird bewusst NICHT auf eine Mindestspreizung geprüft: die
 * Decay-Obergrenze von 0.4 (Stabilitätsgrenze der Dattorro-Figure-8, s.
 * UI_PARAMS-Kommentar in core/inserts.js) lässt das Signal nur rund zwei-
 * bis dreimal umlaufen, bevor der Ausklang im Rauschen verschwindet -- ein
 * Filter, der pro Umlauf wirkt, kann sich über so wenige Umläufe nicht
 * spürbar aufsummieren. Das ist ein bekannter, separater Schwachpunkt der
 * Tank-Topologie, nicht des Damping-Filters selbst; hier wird für den
 * Reverb nur auf Stabilität (kein NaN) geprüft.
 *
 * Voraussetzung: ein lokaler Server auf dem Repo-Root, z. B.
 *   python3 -m http.server 8901
 * Dann:  node tools/dsp-tests/damping-filter.mjs  [baseUrl]
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

  // Worklet-Modul einmal vorladen, damit keine Messung auf dem
  // transparenten Platzhalter landet (s. makeOnePoleLowpass).
  const warm = createInsert('reverb');
  await wait(500);
  warm.dispose();

  async function tailSpectrum(type, params) {
    const insert = createInsert(type);
    for (const [k, v] of Object.entries(params)) insert.setParam(k, v);

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
    src.connect(insert.input);
    insert.output.connect(analyser).connect(mute).connect(ctx.destination);

    src.start();
    await wait(500);
    src.stop();
    await wait(120);
    const spec = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(spec);

    src.disconnect();
    insert.output.disconnect(analyser);
    analyser.disconnect();
    mute.disconnect();
    insert.dispose();

    const binHz = ctx.sampleRate / 2 / spec.length;
    const avg = (loHz, hiHz) => {
      let sum = 0, n = 0;
      for (let i = Math.ceil(loHz / binHz); i < Math.min(spec.length, hiHz / binHz); i++) {
        if (Number.isFinite(spec[i])) { sum += spec[i]; n++; }
      }
      return n ? sum / n : -999;
    };
    return { high: avg(4000, 8000), bad: spec.some((v) => Number.isNaN(v)) };
  }

  const steps = [500, 2000, 8000, 15000];
  const res = [];
  for (const damping of steps) res.push(await tailSpectrum('resonator', { mix: 1, resonance: 0.8, damping }));
  const rev = [];
  for (const damping of steps) rev.push(await tailSpectrum('reverb', { mix: 1, decay: 0.38, damping }));

  return {
    steps,
    res: res.map((r) => +r.high.toFixed(1)),
    rev: rev.map((r) => +r.high.toFixed(1)),
    anyNaN: [...res, ...rev].some((r) => r.bad),
  };
});

console.log('Damping-Stufen (Hz):', out.steps.join(', '));
console.log('Resonator, Höhenenergie im Ausklang (dB):', out.res.join(', '));
console.log('Reverb,    Höhenenergie im Ausklang (dB):', out.rev.join(', '));

const resSpread = out.res[out.res.length - 1] - out.res[0];
const resMonotonic = out.res.every((v, i) => i === 0 || v >= out.res[i - 1] - 1.5);
const revSpread = out.rev[out.rev.length - 1] - out.rev[0];

check(`Resonator: Damping öffnet die Höhen über den ganzen Reglerbereich (Spreizung ${resSpread.toFixed(1)}dB)`, resSpread > 30);
check('Resonator: die Wirkung ist monoton (heller mit steigender Grenzfrequenz)', resMonotonic);
check('Kein NaN im Spektrum beider Effekte', !out.anyNaN);
check('Keine Seitenfehler', pageErrors.length === 0);
if (pageErrors.length) console.log(pageErrors);

console.log(`\nHinweis: Reverb-Spreizung ${revSpread.toFixed(1)}dB -- architekturbedingt gering `
  + '(Decay-Deckel 0.4 => nur ~2-3 Umlaeufe, s. Dateikopf), bewusst nicht geprüft.');

await browser.close();
process.exit(finish());
