/**
 * eq8-cut-q-curve.mjs — Regressionstest für die Resonanz-/Senken-Stufe von
 * Low Cut/High Cut-Bändern (Nutzer-Anfrage: "es hat diesen fixen ca. +2db
 * boost... es wäre toll wenn ich dort absenken könnte und auch ins minus
 * gehen könnte").
 *
 * Ein reines Highpass/Lowpass-Biquad kann physikalisch nie unter 0dB
 * sacken (nur asymptotisch annähern oder resonant überschwingen, s. PR).
 * Deshalb hängt jedes Low Cut/High Cut-Band jetzt IMMER eine zusätzliche
 * Peaking-Biquad an seiner eigenen Grenzfrequenz an (s. inserts.js#
 * eq8BuildBandNodes) -- b.gain (wie bei jedem anderen Bandtyp) bestimmt
 * direkt den dB-Wert AN der Grenzfrequenz (0 = flach, negativ = echte
 * Senke, positiv = Resonanzspitze), b.q bestimmt die BREITE dieser Spitze/
 * Senke (schmal bei hohem Q, breit bei niedrigem Q) -- exakt wie bei einem
 * normalen Peaking-Band.
 *
 * Voraussetzung: ein lokaler Server auf dem Repo-Root, z. B.
 *   python3 -m http.server 8901
 * Dann:  node tools/dsp-tests/eq8-cut-q-curve.mjs  [baseUrl]
 */
import { launchBrowser, makeReporter, openApp, baseUrlFromArgv } from './_helpers.mjs';

const { check, finish } = makeReporter();
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await openApp(page, baseUrlFromArgv());

await page.click('.rack__add');
await page.waitForSelector('.sheet__item');
await page.click('.sheet__item');
await page.waitForSelector('.machine-focus:not([hidden])');
await page.click('.machine-focus:not([hidden]) [data-add-insert]');
await page.waitForSelector('.sheet--insert-picker:not([hidden])');
await page.click('.sheet--insert-picker [data-type="eq8"]');
await page.waitForSelector('.eq8__graph');

const out = await page.evaluate(async () => {
  const ctx = engine.ctx;
  if (ctx.state === 'suspended') await ctx.resume();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const m = song.rack.machines[song.rack.machines.length - 1];
  const insert = m.inserts.find((i) => i.type === 'eq8');
  await new Promise((r) => setTimeout(r, 300)); // Worklet-Ladezeit

  const atFreq = (f) => insert.getEq8Response(new Float32Array([f]))[0];

  const b = insert.params.bands[0];
  b.active = true;
  b.type = 'highpass'; // Low Cut
  b.freq = 1000;
  b.slope = 12;
  b.q = 1;
  insert.setBand(0, 'active');
  insert.setBand(0, 'type');
  insert.setBand(0, 'freq');
  insert.setBand(0, 'slope');
  insert.setBand(0, 'q');

  // ---- 1) b.gain=0 ist flach, negativ erzeugt eine ECHTE Senke unter 0dB ----
  b.gain = 0;
  insert.setBand(0, 'gain');
  await wait(150);
  const flatAtCutoff = atFreq(1000);

  b.gain = -6;
  insert.setBand(0, 'gain');
  await wait(150);
  const dipAtCutoff = atFreq(1000);

  b.gain = 6;
  insert.setBand(0, 'gain');
  await wait(150);
  const boostAtCutoff = atFreq(1000);

  // ---- 2) b.q bestimmt die BREITE der Spitze/Senke, nicht mehr ihre Höhe ----
  // Bei gleichem Gain (+9dB) sollte ein niedriges Q einen deutlich breiteren
  // (also auch bei einer Oktave Abstand noch spürbaren) Effekt haben als ein
  // hohes, schmales Q.
  b.gain = 9;
  b.q = 0.5;
  insert.setBand(0, 'gain');
  insert.setBand(0, 'q');
  await wait(150);
  const wideAtOctave = atFreq(2000); // eine Oktave über der Grenzfrequenz

  b.q = 8;
  insert.setBand(0, 'q');
  await wait(150);
  const narrowAtOctave = atFreq(2000);

  return { flatAtCutoff, dipAtCutoff, boostAtCutoff, wideAtOctave, narrowAtOctave };
});

console.log('An der Grenzfrequenz -- gain=0:', out.flatAtCutoff.toFixed(2), 'dB | gain=-6:', out.dipAtCutoff.toFixed(2), 'dB | gain=+6:', out.boostAtCutoff.toFixed(2), 'dB');
check('b.gain=0 ergibt einen sauber flachen Verlauf an der Grenzfrequenz (~0dB)', Math.abs(out.flatAtCutoff) < 0.3);
check('b.gain=-6 erzeugt eine ECHTE Senke unter 0dB an der Grenzfrequenz (die eigentliche Nutzer-Anfrage)', out.dipAtCutoff < -5 && out.dipAtCutoff > -7);
check('b.gain=+6 erzeugt eine Resonanzspitze von +6dB an der Grenzfrequenz', out.boostAtCutoff > 5 && out.boostAtCutoff < 7);

console.log('Eine Oktave über der Grenzfrequenz bei +9dB -- Q=0.5 (breit):', out.wideAtOctave.toFixed(2), 'dB, Q=8 (schmal):', out.narrowAtOctave.toFixed(2), 'dB');
check('Niedriges Q wirkt breiter (mehr Resteffekt eine Oktave entfernt) als hohes Q', out.wideAtOctave > out.narrowAtOctave + 1);

check('Keine Seitenfehler', errors.length === 0);
if (errors.length) console.log(errors);

await browser.close();
process.exit(finish());
