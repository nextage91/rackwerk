/**
 * modular-dsp.mjs — DSP-Regressionstest für die beiden neuen Modular-
 * Bausteine aus dem Techno/House-Sounddesign-Umbau (core/modular.js):
 *
 *  - Distortion: reine Identitätskurve bei drive=0 (makeDriveCurve(0),
 *    dieselbe Kurve wie der Drive-Insert), deutlich hörbare Sättigung bei
 *    drive=1. Gemessen über den Crest-Faktor (Peak/RMS) eines Sinustons --
 *    Sättigung komprimiert die Spitzen Richtung Rechteck, senkt also den
 *    Crest-Faktor spürbar. Referenz ist der TATSÄCHLICHE Oszillator-
 *    Ausgang (der hat schon vor dieser Änderung einen eigenen Weich-
 *    begrenzer, s. safeOutput() im Dateikopf von modular.js), nicht der
 *    idealisierte Lehrbuch-Sinus-Wert 1.41.
 *  - Envelope: volle ADSR-Hüllkurve statt nur Attack/Release -- muss
 *    tatsächlich beim eingestellten Sustain-Pegel ankommen und dort halten
 *    (nicht bei 1 wie das alte AR-Verhalten), und nach Notenende+Release
 *    auf 0 zurückkehren.
 *
 * Voraussetzung: ein lokaler Server auf dem Repo-Root, z. B.
 *   python3 -m http.server 8901
 * Dann:  node tools/dsp-tests/modular-dsp.mjs  [baseUrl]
 */
import { launchBrowser, makeReporter, openApp, baseUrlFromArgv } from './_helpers.mjs';

const { check, finish } = makeReporter();
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await openApp(page, baseUrlFromArgv());
// A Modular machine has to exist once so the shared engine.ctx is running & unlocked.
await page.click('.rack__add');
await page.waitForSelector('.sheet__item');
await page.locator('.sheet__item', { hasText: 'Modular' }).first().click();
await page.waitForSelector('.machine-focus:not([hidden])');
await page.waitForTimeout(300);

// --- Distortion: crest factor should drop sharply from ~sine (1.41) to ~square (~1.0) as drive goes 0 -> 1.
const crestFactors = await page.evaluate(async () => {
  const ctx = engine.ctx;
  if (ctx.state === 'suspended') await ctx.resume();

  function measureNode(node) {
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    const mute = ctx.createGain();
    mute.gain.value = 0;
    node.connect(analyser).connect(mute).connect(ctx.destination);
    return new Promise((resolve) => {
      setTimeout(() => {
        const buf = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(buf);
        let peak = 0, sumSq = 0;
        for (const s of buf) { const a = Math.abs(s); if (a > peak) peak = a; sumSq += s * s; }
        const rms = Math.sqrt(sumSq / buf.length);
        analyser.disconnect(); mute.disconnect();
        resolve(rms > 0 ? peak / rms : 0);
      }, 150);
    });
  }

  // Baseline: die Oszillator-Maschine hat schon VOR dieser Änderung einen
  // eigenen Weichbegrenzer (safeOutput(), s. modular.js-Dateikopf) -- bei
  // voller Amplitude ist das messbar keine reine Identität mehr (Crest-
  // Faktor liegt schon OHNE jede Distortion über dem theoretischen
  // Sinus-Wert 1.41). Referenz ist deshalb der TATSÄCHLICHE Oszillator-
  // Ausgang, nicht der idealisierte Lehrbuch-Sinus.
  const basePatch = new ModularPatch();
  const baseOscId = basePatch.addModule('oscillator');
  const cfBaseline = await measureNode(basePatch.modules.get(baseOscId).instance.outputs.audio);
  basePatch.dispose();

  function measureDrive(drive) {
    const patch = new ModularPatch();
    const oscId = patch.addModule('oscillator');
    const distId = patch.addModule('distortion', { params: { drive } });
    patch.connect(oscId, 'audio', distId, 'audio');
    return measureNode(patch.modules.get(distId).instance.outputs.audio).finally(() => patch.dispose());
  }

  const cfDry = await measureDrive(0);
  const cfWet = await measureDrive(1);
  return { cfBaseline, cfDry, cfWet };
});
console.log('Crest-Faktor Oszillator pur (Referenz):', crestFactors.cfBaseline.toFixed(3));
console.log('Crest-Faktor Distortion drive=0:', crestFactors.cfDry.toFixed(3), '(sollte nah an der Referenz bleiben -- Identitätskurve)');
console.log('Crest-Faktor Distortion drive=1:', crestFactors.cfWet.toFixed(3), '(erwartet deutlich niedriger, Richtung Rechteck ~1.0)');
check('Distortion drive=0 verändert den Crest-Faktor gegenüber dem reinen Oszillator kaum (Identitätskurve)', Math.abs(crestFactors.cfDry - crestFactors.cfBaseline) < 0.2);
check('Distortion drive=1 komprimiert die Spitzen deutlich messbar (Crest-Faktor sinkt klar unter drive=0)', crestFactors.cfWet < crestFactors.cfDry - 0.2);

// --- Envelope: full ADSR shape must actually reach & hold sustain, then release to 0.
const envShape = await page.evaluate(async () => {
  const ctx = engine.ctx;
  if (ctx.state === 'suspended') await ctx.resume();

  const patch = new ModularPatch();
  const envId = patch.addModule('envelope', { params: { attack: 0.05, decay: 0.05, sustain: 0.4, release: 0.05 } });
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 32;
  const mute = ctx.createGain();
  mute.gain.value = 0;
  patch.modules.get(envId).instance.outputs.cv.connect(analyser).connect(mute).connect(ctx.destination);

  const readNow = () => {
    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    return buf.reduce((a, b) => a + b, 0) / buf.length;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const t0 = ctx.currentTime;
  patch.modules.get(envId).instance.trigger(t0, 0.4); // dur=0.4s, weit länger als attack+decay=0.1s
  await wait(5);
  const atStart = readNow(); // 5ms in einen 50ms-Attack -- linear ~10% des Weges, also klar < sustain (0.4) und < 1
  await wait(200); // ~205ms nach Trigger -- weit in der Sustain-Phase (Attack+Decay=100ms längst vorbei, Notenende erst bei 400ms)
  const atSustain = readNow();
  await wait(400); // ~605ms nach Trigger -- Notenende (400ms) + Release (50ms) längst vorbei
  const atEnd = readNow();
  patch.dispose();
  analyser.disconnect(); mute.disconnect();
  return { atStart, atSustain, atEnd };
});
console.log('Envelope-Werte: Start (~10% Attack)?', envShape.atStart.toFixed(3), '| Sustain ~0.4?', envShape.atSustain.toFixed(3), '| Ende ~0?', envShape.atEnd.toFixed(3));
check('Envelope ist am Anfang des Attacks klar unter dem Sustain-Pegel (Ramp läuft noch)', envShape.atStart >= 0 && envShape.atStart < 0.3);
check('Envelope hält tatsächlich beim Sustain-Pegel (0.4), NICHT bei 1 wie ein reines AR', Math.abs(envShape.atSustain - 0.4) < 0.1);
check('Envelope kehrt nach Release auf ~0 zurück', Math.abs(envShape.atEnd) < 0.05);

check('Keine Seitenfehler', errors.length === 0);
if (errors.length) console.log(errors);

await browser.close();
process.exit(finish());
