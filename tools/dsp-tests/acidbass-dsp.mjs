/**
 * acidbass-dsp.mjs — DSP-Audit-Regressionstest für den AcidBass-Worklet-
 * Kern (machines/acidbass-worklet.js).
 *
 * Testet den Prozessor DIREKT (eigener AudioWorkletNode statt über die
 * Maschine), damit Parameter/Trigger exakt kontrollierbar sind. Der
 * Prozessor ist registriert, sobald einmal eine AcidBass-Maschine
 * angelegt wurde -- deshalb der UI-Vorlauf über openApp().
 *
 * Deckt drei Punkte aus dem DSP-Audit ab, die sich nur an echtem Audio
 * verifizieren lassen: Endlichkeit/Headroom bei Extremeinstellungen (die
 * tanh-Ketten + State-Clamp + NaN-Recovery müssen greifen) und Zipper-
 * Freiheit bei einem harten Parametersprung (die 5ms-Glättung von Cutoff/
 * Resonanz in #onParamsChanged()).
 *
 * Voraussetzung: ein lokaler Server auf dem Repo-Root, z. B.
 *   python3 -m http.server 8901
 * Dann:  node tools/dsp-tests/acidbass-dsp.mjs  [baseUrl]
 */
import { launchBrowser, makeReporter, openApp, baseUrlFromArgv } from './_helpers.mjs';

const { check, finish } = makeReporter();
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await openApp(page, baseUrlFromArgv());

// AcidBass anlegen -> registriert das Worklet-Modul im AudioContext.
await page.click('.rack__add');
await page.waitForSelector('.sheet__item');
const acid = page.locator('.sheet__item', { hasText: 'AcidBass' });
await acid.first().click();
await page.waitForTimeout(800); // Worklet-Modul laden lassen

const out = await page.evaluate(async () => {
  const ctx = engine.ctx;
  if (ctx.state === 'suspended') await ctx.resume();

  /** Baut eine frische, isolierte Stimme + Abgriff. */
  function makeVoice() {
    const node = new AudioWorkletNode(ctx, 'acidbass-voice', {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1],
    });
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    // Stummer Pfad zum Ziel -- ohne Verbindung Richtung destination wird
    // der Teilgraph nicht garantiert gerendert.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    node.connect(analyser).connect(mute).connect(ctx.destination);
    return { node, analyser, dispose() { node.port.postMessage({ type: 'dispose' }); node.disconnect(); analyser.disconnect(); mute.disconnect(); } };
  }

  const grab = (analyser) => {
    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    return buf;
  };
  const stats = (buf) => {
    let peak = 0, sumSq = 0, maxDelta = 0, bad = 0, prev = buf[0];
    for (const s of buf) {
      if (!Number.isFinite(s)) { bad++; continue; }
      const a = Math.abs(s);
      if (a > peak) peak = a;
      sumSq += s * s;
      const d = Math.abs(s - prev);
      if (d > maxDelta) maxDelta = d;
      prev = s;
    }
    return { peak, rms: Math.sqrt(sumSq / buf.length), maxDelta, bad };
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- 1: Grundfunktion, endliche Ausgabe, Pegel im Rahmen ----
  const v1 = makeVoice();
  v1.node.port.postMessage({ type: 'params', params: {
    waveform: 'saw', tune: 0, cutoff: 800, resonance: 0.7, envMod: 0.6,
    fDecay: 0.4, accentDecay: 0.15, accent: 0.6, overdrive: 0, filterFM: 0,
    slideTime: 0.06, hiRes: false, ampDecay: 1.2,
  } });
  v1.node.port.postMessage({ type: 'trigger', midi: 36, time: ctx.currentTime, accent: false, slide: false });
  await wait(180);
  const normal = stats(grab(v1.analyser));

  // ---- 2: Extremeinstellung (alles am Anschlag) -> darf nicht knallen ----
  v1.node.port.postMessage({ type: 'params', params: {
    cutoff: 18000, resonance: 1, envMod: 1, hiRes: true, overdrive: 1,
    filterFM: 1, accent: 1, fDecay: 3, accentDecay: 3, ampDecay: 3,
  } });
  for (let i = 0; i < 6; i++) {
    v1.node.port.postMessage({ type: 'trigger', midi: 36 + i, time: ctx.currentTime, accent: true, slide: false });
    await wait(45);
  }
  const extreme = stats(grab(v1.analyser));

  // ---- 3: Zipper-Test -- ruhige Referenz vs. harter Cutoff-Sprung ----
  const v2 = makeVoice();
  v2.node.port.postMessage({ type: 'params', params: {
    waveform: 'saw', tune: 0, cutoff: 300, resonance: 0.85, envMod: 0,
    fDecay: 3, accentDecay: 3, accent: 0, overdrive: 0, filterFM: 0,
    slideTime: 0.06, hiRes: false, ampDecay: 3,
  } });
  v2.node.port.postMessage({ type: 'trigger', midi: 36, time: ctx.currentTime, accent: false, slide: false });
  await wait(260);
  // Referenz A: gehaltener Ton bei 300Hz, kein Regler bewegt sich.
  const steady = stats(grab(v2.analyser));
  // Jetzt EIN harter Sprung über fast den ganzen Cutoff-Bereich.
  v2.node.port.postMessage({ type: 'params', params: { cutoff: 11000 } });
  await wait(22); // ~5ms Glättung + Puffer -- der Sprung liegt sicher im Fenster
  const jumped = stats(grab(v2.analyser));
  // Referenz B: derselbe Ton, EINGESCHWUNGEN bei 11000Hz. Entscheidend
  // für die Zipper-Frage: ein weit geöffneter Tiefpass lässt ein Sägezahn-
  // signal völlig zu Recht viel steilflankiger durch (grosse Sample-zu-
  // Sample-Sprünge sind hier NORMAL, kein Knacken). Verglichen werden darf
  // das Übergangsfenster deshalb nur mit diesem Zustand, nicht mit dem
  // dumpfen 300Hz-Ton -- sonst misst man die Klangänderung statt der
  // Unstetigkeit.
  await wait(200);
  const settled = stats(grab(v2.analyser));

  v1.dispose();
  v2.dispose();
  return { normal, extreme, steady, jumped, settled };
});

console.log(JSON.stringify(out, null, 1));

check('Grundton: Ausgabe enthält keine NaN/Infinity-Samples', out.normal.bad === 0);
check('Grundton: erzeugt tatsächlich Signal (RMS > 0.005)', out.normal.rms > 0.005);
check('Grundton: bleibt innerhalb ±1', out.normal.peak <= 1.0000001);
check('Extremeinstellung: keine NaN/Infinity-Samples', out.extreme.bad === 0);
check('Extremeinstellung: bleibt innerhalb ±1 (tanh-Kette + Clamp greifen)', out.extreme.peak <= 1.0000001);
check('Zipper: gehaltener Ton liefert Referenzsignal', out.steady.rms > 0.005);
check('Zipper: das Übergangsfenster eines harten Cutoff-Sprungs bleibt im Rahmen des '
  + 'EINGESCHWUNGENEN Zustands bei derselben Endfrequenz -- keine Unstetigkeit über die '
  + `normale Signalsteilheit hinaus (Sprung ${out.jumped.maxDelta.toFixed(4)} vs. eingeschwungen ${out.settled.maxDelta.toFixed(4)})`,
  out.jumped.maxDelta <= out.settled.maxDelta * 1.5 + 0.02);
check('Zipper: Sprung erzeugt keine NaN', out.jumped.bad === 0);
check('Keine Seitenfehler', errors.length === 0);
if (errors.length) console.log(errors);

await browser.close();
process.exit(finish());
