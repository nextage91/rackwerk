/**
 * subsynth-ladder-filter.mjs — Regressionstest für den neuen "Ladder"-
 * Filtertyp in SubSynth (s. core/dsp.js#makeLadderFilter, generalisiert aus
 * AcidBass' TB-303-Filterkern, s. machines/acidbass-worklet.js).
 *
 * Deckt ab:
 *  1) Strukturell: bei filterType='ladder' ist der Stimmen-Filter tatsächlich
 *     der neue Worklet-Wrapper (erkennbar an `.dispose()`, das ein natives
 *     BiquadFilterNode nicht kennt), nicht länger ein BiquadFilterNode.
 *  2) DSP-Kernmerkmal eines Ladder-/Moog-artigen Filters: bei genug
 *     Resonanz kann er SELBST SCHWINGEN -- eine gehaltene Note mit
 *     Cutoff weit UNTER der Oszillator-Grundfrequenz sollte bei hoher
 *     Resonanz trotzdem deutlich mehr Ausgangsenergie am Filterausgang
 *     zeigen als bei niedriger Resonanz (der Filter erzeugt dann selbst
 *     einen Ton nahe der Grenzfrequenz, unabhängig vom hereinkommenden
 *     Oszillatorsignal) -- das unterscheidet ihn von einer harmlosen
 *     Biquad-Resonanzspitze.
 *  3) Stabilität: auch bei Resonanz am Anschlag keine NaN/Infinity-Samples
 *     (dieselben tanh-Sättigungs-/State-Clamp-Mechanismen wie in AcidBass).
 *
 * Voraussetzung: ein lokaler Server auf dem Repo-Root, z. B.
 *   python3 -m http.server 8901
 * Dann:  node tools/dsp-tests/subsynth-ladder-filter.mjs  [baseUrl]
 */
import { launchBrowser, makeReporter, openApp, baseUrlFromArgv } from './_helpers.mjs';

const { check, finish } = makeReporter();
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

// newProject() seedet immer genau einen SubSynth (s. project.js) -- kein
// manuelles Anlegen nötig.
await openApp(page, baseUrlFromArgv());

const out = await page.evaluate(async () => {
  const ctx = engine.ctx;
  if (ctx.state === 'suspended') await ctx.resume();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const sub = song.rack.machines.find((m) => m.constructor.name === 'SubSynth');
  sub.allNotesOff();
  sub.params.filterType = 'ladder';

  // ---------- 1) Struktur: Wrapper statt BiquadFilterNode ----------
  sub.noteOn(60);
  await wait(20);
  const voice = sub.voices.get(60);
  const isWrapper = typeof voice.filter.dispose === 'function';
  sub.noteOff(60);
  await wait(50);

  // ---------- 2) Selbstschwingung bei hoher vs. niedriger Resonanz ----------
  async function measureFilterEnergy(resonance) {
    sub.allNotesOff();
    await wait(30);
    sub.params.cutoff = 100; // weit unter der Oszillator-Grundfrequenz
    sub.params.resonance = resonance;
    sub.params.envAmt = 0; // keine Hüllkurven-Verschiebung -- reiner Reso-Effekt
    sub.noteOn(60); // ~261Hz Sägezahn-Grundton, weit über dem 100Hz-Cutoff

    const voice = sub.voices.get(60);
    const filterOut = voice.filter.output ?? voice.filter;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    const mute = ctx.createGain();
    mute.gain.value = 0;
    filterOut.connect(analyser).connect(mute).connect(ctx.destination);

    await wait(250); // Filter/Selbstschwingung einschwingen lassen

    let sumSq = 0, n = 0, anyBad = false;
    const td = new Float32Array(analyser.fftSize);
    for (let iter = 0; iter < 5; iter++) {
      analyser.getFloatTimeDomainData(td);
      for (const v of td) {
        if (!Number.isFinite(v)) anyBad = true;
        else { sumSq += v * v; n++; }
      }
      await wait(15);
    }
    const rms = n ? Math.sqrt(sumSq / n) : 0;

    filterOut.disconnect(analyser);
    analyser.disconnect();
    mute.disconnect();
    sub.noteOff(60);
    await wait(50);
    return { rms, anyBad };
  }

  const low = await measureFilterEnergy(0.5);
  const high = await measureFilterEnergy(20);

  sub.allNotesOff();
  return { isWrapper, low, high };
});

check('SubSynth: filterType="ladder" nutzt tatsächlich den neuen Worklet-Wrapper (nicht BiquadFilterNode)', out.isWrapper);
console.log('Ladder-Filter-Ausgangsenergie (RMS) bei Reso=0.5:', out.low.rms.toFixed(4), '| bei Reso=20:', out.high.rms.toFixed(4));
check('Niedrige Resonanz: keine NaN/Infinity-Samples', !out.low.anyBad);
check('Hohe Resonanz: keine NaN/Infinity-Samples', !out.high.anyBad);
check('Hohe Resonanz erzeugt deutlich mehr Energie am Filterausgang als niedrige (Selbstschwingungs-Charakteristik)', out.high.rms > out.low.rms * 2);

check('Keine Seitenfehler', errors.length === 0);
if (errors.length) console.log(errors);

await browser.close();
process.exit(finish());
