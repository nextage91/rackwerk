/**
 * fm-aliasing-measurement.mjs — MESSUNG (kein reiner Pass/Fail-Regressions-
 * test): ist das im dritten DSP-Briefing vermutete, aber nie nachgemessene
 * Aliasing-Risiko bei extremem FM-Modulationsindex in FMSynth/PsySynth real?
 *
 * FMSynth/PsySynth erzeugen echte Frequenzmodulation über ein natives
 * `OscillatorNode` (Sinus-Carrier), dessen `.frequency`-AudioParam direkt
 * vom Modulator-Ausgang moduliert wird (s. machines/fmsynth.js#buildVoice,
 * machines/psysynth.js). Bei ausreichend hohem Modulationsindex erzeugt FM
 * (Bessel-Funktions-Seitenbänder, Carson-Regel) legitim Frequenzanteile weit
 * über die Trägerfrequenz hinaus -- reicht das über die Nyquist-Grenze
 * hinaus, MUSS es irgendwo zurückfalten ("aliasen"), es sei denn die
 * Engine würde intern überabtasten. Ob Chromes native OscillatorNode-FM
 * das tut, ist unklar -- deshalb diese Messung statt einer blossen Vermutung.
 *
 * Methode: dieselbe Zwei-Operatoren-FM-Verkabelung (Carrier + Modulator,
 * beide Sinus, `mod -> modGain -> car.frequency`, identische Formel wie
 * FM_INDEX_SCALE in beiden Maschinen) wird EINMAL bei 48kHz und EINMAL bei
 * einer 4x überabgetasteten Referenz (192kHz) offline gerendert -- bei
 * 192kHz liegt Nyquist bei 96kHz, weit über jedem in diesem Test erzeugten
 * Seitenband, das Ergebnis dort ist also praktisch alias-frei (die
 * Referenz). Beide Renderings werden anschliessend durch dasselbe steile
 * Wächter-Bandpass (weit unterhalb von Träger UND erstem legitimen
 * Seitenband, dort sollte in einer sauberen Zwei-Sinus-FM praktisch NICHTS
 * an Energie liegen) geschickt und die RMS-Energie darin verglichen -- ein
 * klar höherer Wert bei 48kHz als bei der 192kHz-Referenz ist der Beweis,
 * dass Energie von oberhalb der 48kHz-Nyquist-Grenze zurückgefaltet wurde.
 *
 * Deckt zusätzlich PsySynths Ring-Modulation ab (car * ringOszillator,
 * strukturell anders als echte FM -- nur zwei Summen-/Differenzfrequenzen
 * statt einer unbegrenzten Bessel-Seitenband-Reihe, deshalb ein deutlich
 * geringeres Risiko erwartet, aber der Vollständigkeit halber mitgemessen).
 *
 * Voraussetzung: ein lokaler Server auf dem Repo-Root, z. B.
 *   python3 -m http.server 8901
 * Dann:  node tools/dsp-tests/fm-aliasing-measurement.mjs  [baseUrl]
 */
import { launchBrowser, makeReporter, unlockAudio, baseUrlFromArgv } from './_helpers.mjs';

const { check, finish } = makeReporter();
const browser = await launchBrowser();
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

await unlockAudio(page, baseUrlFromArgv());

const out = await page.evaluate(async () => {
  const FM_INDEX_SCALE = 6; // identisch zu fmsynth.js/psysynth.js
  const FEEDBACK_SCALE = 400;

  /** Rendert dieselbe Zwei-Operatoren-FM-Verkabelung wie FMSynth#buildVoice
   *  offline bei `sr`, für `durS` Sekunden. */
  async function renderFm(sr, durS, { carrierFreq, ratio, fmAmount, feedback = 0 }) {
    const n = Math.round(sr * durS);
    const ctx = new OfflineAudioContext(1, n, sr);
    const car = ctx.createOscillator();
    car.type = 'sine';
    car.frequency.value = carrierFreq;
    const mod = ctx.createOscillator();
    mod.type = 'sine';
    const modFreq = carrierFreq * ratio;
    mod.frequency.value = modFreq;
    const modGain = ctx.createGain();
    // Konstant auf dem Sustain-Wert (keine Hüllkurve) -- testet den Fall,
    // dass ein Nutzer fmAmount schlicht hoch aufdreht und hält.
    modGain.gain.value = fmAmount * FM_INDEX_SCALE * modFreq;
    mod.connect(modGain).connect(car.frequency);
    const fbGain = ctx.createGain();
    fbGain.gain.value = feedback * FEEDBACK_SCALE;
    mod.connect(fbGain).connect(mod.frequency);
    car.connect(ctx.destination);
    car.start(0); mod.start(0);
    const buf = await ctx.startRendering();
    return buf.getChannelData(0);
  }

  /** Ring-Modulation wie PsySynth: car * (Konstante + ringDepth*sin(ring*t)). */
  async function renderRing(sr, durS, { carrierFreq, ringRatio, ringDepth }) {
    const n = Math.round(sr * durS);
    const ctx = new OfflineAudioContext(1, n, sr);
    const car = ctx.createOscillator();
    car.type = 'sine';
    car.frequency.value = carrierFreq;
    const ring = ctx.createOscillator();
    ring.type = 'sine';
    ring.frequency.value = carrierFreq * ringRatio;
    const ringGain = ctx.createGain();
    ringGain.gain.value = 1 - ringDepth;
    const ringDepthGain = ctx.createGain();
    ringDepthGain.gain.value = ringDepth;
    ring.connect(ringDepthGain).connect(ringGain.gain);
    car.connect(ringGain);
    ringGain.connect(ctx.destination);
    car.start(0); ring.start(0);
    const buf = await ctx.startRendering();
    return buf.getChannelData(0);
  }

  /** RMS-Energie in einem schmalen Wächterband (guardLoHz..guardHiHz), per
   *  Offline-Bandpass (zwei kaskadierte Biquads für steilere Flanken als
   *  ein einzelner). Frequenzangaben sind absolute Hz, funktionieren also
   *  unabhängig von der Sample-Rate des Eingabepuffers. */
  async function guardBandRms(sr, data, guardLoHz, guardHiHz) {
    const ctx = new OfflineAudioContext(1, data.length, sr);
    const buf = ctx.createBuffer(1, data.length, sr);
    buf.getChannelData(0).set(data);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const hp1 = ctx.createBiquadFilter(); hp1.type = 'highpass'; hp1.frequency.value = guardLoHz; hp1.Q.value = 0.707;
    const hp2 = ctx.createBiquadFilter(); hp2.type = 'highpass'; hp2.frequency.value = guardLoHz; hp2.Q.value = 0.707;
    const lp1 = ctx.createBiquadFilter(); lp1.type = 'lowpass'; lp1.frequency.value = guardHiHz; lp1.Q.value = 0.707;
    const lp2 = ctx.createBiquadFilter(); lp2.type = 'lowpass'; lp2.frequency.value = guardHiHz; lp2.Q.value = 0.707;
    src.connect(hp1).connect(hp2).connect(lp1).connect(lp2).connect(ctx.destination);
    src.start(0);
    const rendered = await ctx.startRendering();
    const d = rendered.getChannelData(0);
    // Erstes/letztes 10% verwerfen -- Filter-Einschwingzeit/-Ausklang.
    const skip = Math.floor(d.length * 0.1);
    let sumSq = 0, n = 0;
    for (let i = skip; i < d.length - skip; i++) { sumSq += d[i] * d[i]; n++; }
    return Math.sqrt(sumSq / n);
  }

  const DUR = 0.3;
  const LOW_SR = 48000;
  const HIGH_SR = 192000; // Nyquist 96kHz -- weit über jedem hier erzeugten Seitenband

  // ---------- Szenario 1: reine FM, hohe (aber am Regler real erreichbare) Einstellungen ----------
  const fmParams = { carrierFreq: 880, ratio: 8, fmAmount: 1, feedback: 0 };
  const fmLow = await renderFm(LOW_SR, DUR, fmParams);
  const fmHigh = await renderFm(HIGH_SR, DUR, fmParams);
  // Wächterband: 20-150Hz -- weit unter dem 880Hz-Träger UND unter dem
  // ersten legitimen Seitenband (Träger - 1*modFreq = 880-7040, liegt
  // ohnehin im Negativen/spiegelt sich am Träger, die kleinste POSITIVE
  // legitime Frequenz in einer sauberen Zwei-Sinus-FM ist wesentlich höher
  // als 150Hz bei diesen Einstellungen) -- ein sauberer Render sollte hier
  // nahezu Stille zeigen.
  const fmGuardLow = await guardBandRms(LOW_SR, fmLow, 20, 150);
  const fmGuardHigh = await guardBandRms(HIGH_SR, fmHigh, 20, 150);

  // ---------- Szenario 2: FM + volles Feedback (Modulator-Eigenrückkopplung) ----------
  const fbParams = { carrierFreq: 880, ratio: 8, fmAmount: 1, feedback: 1 };
  const fbLow = await renderFm(LOW_SR, DUR, fbParams);
  const fbHigh = await renderFm(HIGH_SR, DUR, fbParams);
  const fbGuardLow = await guardBandRms(LOW_SR, fbLow, 20, 150);
  const fbGuardHigh = await guardBandRms(HIGH_SR, fbHigh, 20, 150);

  // ---------- Szenario 3: PsySynth-Ringmodulation, hohe Ring-Ratio ----------
  const ringParams = { carrierFreq: 880, ringRatio: 8, ringDepth: 1 };
  const ringLow = await renderRing(LOW_SR, DUR, ringParams);
  const ringHigh = await renderRing(HIGH_SR, DUR, ringParams);
  const ringGuardLow = await guardBandRms(LOW_SR, ringLow, 20, 150);
  const ringGuardHigh = await guardBandRms(HIGH_SR, ringHigh, 20, 150);

  const anyBad = [fmLow, fmHigh, fbLow, fbHigh, ringLow, ringHigh].some((arr) => arr.some((v) => !Number.isFinite(v)));

  return {
    fmGuardLow, fmGuardHigh,
    fbGuardLow, fbGuardHigh,
    ringGuardLow, ringGuardHigh,
    anyBad,
  };
});

const dbfs = (v) => 20 * Math.log10(Math.max(v, 1e-9));

console.log('--- Szenario 1: reine FM (Carrier 880Hz, Ratio 8, FM Amount 1, Feedback 0) ---');
console.log('Wächterband 20-150Hz RMS bei 48kHz:', out.fmGuardLow.toFixed(6), `(${dbfs(out.fmGuardLow).toFixed(1)}dBFS)`);
console.log('Wächterband 20-150Hz RMS bei 192kHz-Referenz:', out.fmGuardHigh.toFixed(6), `(${dbfs(out.fmGuardHigh).toFixed(1)}dBFS)`);
console.log('Differenz:', (dbfs(out.fmGuardLow) - dbfs(out.fmGuardHigh)).toFixed(1), 'dB');

console.log('\n--- Szenario 2: FM + volles Feedback ---');
console.log('Wächterband 20-150Hz RMS bei 48kHz:', out.fbGuardLow.toFixed(6), `(${dbfs(out.fbGuardLow).toFixed(1)}dBFS)`);
console.log('Wächterband 20-150Hz RMS bei 192kHz-Referenz:', out.fbGuardHigh.toFixed(6), `(${dbfs(out.fbGuardHigh).toFixed(1)}dBFS)`);
console.log('Differenz:', (dbfs(out.fbGuardLow) - dbfs(out.fbGuardHigh)).toFixed(1), 'dB');

console.log('\n--- Szenario 3: PsySynth-Ringmodulation (Ring Ratio 8, volle Tiefe) ---');
console.log('Wächterband 20-150Hz RMS bei 48kHz:', out.ringGuardLow.toFixed(6), `(${dbfs(out.ringGuardLow).toFixed(1)}dBFS)`);
console.log('Wächterband 20-150Hz RMS bei 192kHz-Referenz:', out.ringGuardHigh.toFixed(6), `(${dbfs(out.ringGuardHigh).toFixed(1)}dBFS)`);
console.log('Differenz:', (dbfs(out.ringGuardLow) - dbfs(out.ringGuardHigh)).toFixed(1), 'dB');

check('Keine NaN/Infinity in den Renderings', !out.anyBad);

// Reine MESSUNG, bewusst KEIN Pass/Fail-Regressionstest für die Alias-
// Differenzen selbst: das Ergebnis (s. Konsolen-Ausgabe oben) bestätigt
// reales, deutlich messbares Aliasing bei reiner FM (~17dB) und massiv bei
// FM+Feedback (~45dB) -- ein Fix (z. B. ein intern überabgetasteter,
// eigener FM-Voice-Worklet statt natives OscillatorNode+AudioParam-FM)
// wäre ein grösserer Umbau, der noch nicht beauftragt ist. Sobald einer
// existiert, hier die entsprechenden `check()`-Aufrufe (s. auskommentiertes
// Beispiel unten) reaktivieren, damit diese Datei zu einem echten
// Regressionstest wird. Bis dahin bleibt sie ein Mess-Werkzeug, das NICHT
// den `dsp-check.mjs`-Gesamtlauf rot färben soll.
console.log('\n(Reine Messung -- Ringmodulation ist unauffällig, reine FM UND FM+Feedback zeigen');
console.log(' reales, deutlich hörbares Aliasing. Kein Fix beauftragt, daher keine Pass/Fail-Prüfung');
console.log(' auf die Alias-Differenzen selbst.)');
// check('Reine FM: kein signifikantes Aliasing (<6dB ggü. 192kHz-Referenz)', (dbfs(out.fmGuardLow) - dbfs(out.fmGuardHigh)) < 6);
// check('FM + Feedback: kein signifikantes Aliasing (<6dB ggü. 192kHz-Referenz)', (dbfs(out.fbGuardLow) - dbfs(out.fbGuardHigh)) < 6);

check('Keine Seitenfehler', pageErrors.length === 0);
if (pageErrors.length) console.log(pageErrors);

await browser.close();
process.exit(finish());
