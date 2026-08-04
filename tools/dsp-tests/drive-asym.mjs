/**
 * drive-asym.mjs — Regressionstest für den neuen "Asym"-Parameter beim
 * Drive-Insert (s. core/inserts.js#makeDriveCurve, DEFS.drive).
 *
 * asym=0 muss die bisherige, rein ungerade tanh(K*x)-Kurve unverändert
 * reproduzieren (Rückwärtskompatibilität für bestehende Projekte, die das
 * Feld noch nicht kennen). asym>0 mischt einen quadratischen Bias-Term vor
 * dem Waveshaper ein (wie Tape Machines makeTapeCurve) und bricht damit
 * bewusst die Punktsymmetrie curve(-x) = -curve(x) -- genau das soll den
 * "wärmeren" Klang (geradzahlige Obertöne) erzeugen. Ausserdem: das neue
 * DC-Blocker-Highpass im Drive-Insert (immer verdrahtet, s. DEFS.drive
 * build()) muss den durch asym entstehenden Gleichanteil tatsächlich
 * entfernen, sonst würde ein wahrnehmbarer DC-Offset ins Signal durch-
 * geschleift.
 *
 * Voraussetzung: ein lokaler Server auf dem Repo-Root, z. B.
 *   python3 -m http.server 8901
 * Dann:  node tools/dsp-tests/drive-asym.mjs  [baseUrl]
 */
import { launchBrowser, makeReporter, unlockAudio, baseUrlFromArgv } from './_helpers.mjs';

const { check, finish } = makeReporter();
const browser = await launchBrowser();
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

await unlockAudio(page, baseUrlFromArgv());

// ---------- 1) Reine Kurven-Mathematik (kein Audio-Graph nötig) ----------
const curveOut = await page.evaluate(() => {
  // Mirror-Scan über die GESAMTE Tabelle (statt nur weniger Stützstellen):
  // K=30 sättigt tanh() schon bei kleinen |x| fast vollständig, der
  // Bias-Term (character*0.15*x^2) wirkt sich also nur in einem SCHMALEN
  // Übergangsband um x=0 herum messbar aus (empirisch bei |x|~0.04, nicht
  // bei den "naheliegenden" grossen Stützstellen wie 0.5/0.95, die dort
  // längst beidseitig gesättigt und damit wieder fast symmetrisch sind).
  const maxMirrorAsymmetry = (curve) => {
    const n = curve.length;
    let max = 0;
    for (let i = 0; i < n; i++) max = Math.max(max, Math.abs(curve[i] + curve[n - 1 - i]));
    return max;
  };

  const symmetric = maxMirrorAsymmetry(makeDriveCurve(0.8, 0));
  const asym = maxMirrorAsymmetry(makeDriveCurve(0.8, 1));

  // asym=0 bleibt weiterhin eine reine Identität bei amount=0.
  const identity = makeDriveCurve(0, 0.7);
  const n = identity.length;
  let maxIdentityError = 0;
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / (n - 1) - 1;
    maxIdentityError = Math.max(maxIdentityError, Math.abs(identity[i] - x));
  }

  return { maxSymError: symmetric, maxAsymError: asym, maxIdentityError };
});

console.log('makeDriveCurve(0.8, 0): max |curve(-x)+curve(x)| über die ganze Tabelle =', curveOut.maxSymError.toFixed(5));
console.log('makeDriveCurve(0.8, 1): max |curve(-x)+curve(x)| über die ganze Tabelle =', curveOut.maxAsymError.toFixed(5));
console.log('makeDriveCurve(0, 0.7): max |curve(x)-x| (Identität bei amount=0) =', curveOut.maxIdentityError.toFixed(5));

check('asym=0 bleibt punktsymmetrisch (unverändert gegenüber der alten Kurve)', curveOut.maxSymError < 0.0005);
check('asym=1 bricht die Punktsymmetrie messbar (deutlich über der asym=0-Basislinie)', curveOut.maxAsymError > curveOut.maxSymError + 0.0015);
check('amount=0 ist weiterhin eine reine Identität, unabhängig von asym', curveOut.maxIdentityError < 0.001);

// ---------- 2) DC-Blocker im echten Insert-Graph: kein Gleichanteil am Ausgang ----------
const dcOut = await page.evaluate(async () => {
  const ctx = engine.ctx;
  if (ctx.state === 'suspended') await ctx.resume();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const insert = createInsert('drive');
  insert.setParam('drive', 0.9);
  insert.setParam('asym', 1);
  insert.setParam('tone', 1);
  insert.setParam('level', 1);
  insert.setParam('mix', 1);

  const len = ctx.sampleRate * 0.3;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.sin((2 * Math.PI * 220 * i) / ctx.sampleRate) * 0.6;
  const src = ctx.createBufferSource();
  src.buffer = buf;

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  const mute = ctx.createGain();
  mute.gain.value = 0;

  src.connect(insert.input);
  insert.output.connect(analyser).connect(mute).connect(ctx.destination);

  src.start();
  await wait(200);

  const td = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(td);
  let sum = 0;
  for (let i = 0; i < td.length; i++) sum += td[i];
  const dcMean = sum / td.length;

  src.stop();
  await wait(30);
  src.disconnect();
  insert.output.disconnect(analyser);
  analyser.disconnect();
  mute.disconnect();
  insert.dispose();

  return { dcMean };
});

console.log('Drive (asym=1, drive=0.9) Ausgangs-DC-Mittelwert:', dcOut.dcMean.toFixed(5));
check('DC-Blocker hält den Gleichanteil bei starker Asymmetrie klein', Math.abs(dcOut.dcMean) < 0.03);

check('Keine Seitenfehler', pageErrors.length === 0);
if (pageErrors.length) console.log(pageErrors);

await browser.close();
process.exit(finish());
