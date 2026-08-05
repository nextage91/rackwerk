/**
 * eq8-cut-q-curve.mjs — Regressionstest für zwei EQ8-Anpassungen (Nutzer-
 * Anfrage): (1) Low Cut/High Cut-Bänder haben keinen wirksamen Gain (Web-
 * Audio-Spec) -- ihr Punkt vertikal ziehen stellt jetzt die Flankenresonanz
 * (Q) ein, wie bei Ableton EQ8/FabFilter Pro-Q, statt wirkungslos zu bleiben.
 * (2) Die Kurve klemmt nicht mehr auf eine hässliche, rein darstellungs-
 * bedingte horizontale Linie an der sichtbaren Zoomstufe, sondern läuft aus
 * dem sichtbaren Bereich heraus, sobald die echte Antwort ausserhalb liegt.
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
  const m = song.rack.machines[song.rack.machines.length - 1];
  const insert = m.inserts.find((i) => i.type === 'eq8');
  await new Promise((r) => setTimeout(r, 300)); // Worklet-Ladezeit

  const N = 120, FREQ_MIN = 20, FREQ_MAX = 20000;
  const freqs = new Float32Array(N);
  for (let i = 0; i < N; i++) freqs[i] = FREQ_MIN * (FREQ_MAX / FREQ_MIN) ** (i / (N - 1));

  // ---- 1) Q ist jetzt live über setBand(i,'q') wirksam für Low Cut ----
  const b = insert.params.bands[0];
  b.active = true;
  b.type = 'highpass'; // Low Cut
  b.freq = 1000;
  b.slope = 12; // reiner Biquad, damit Q sofort (kein Worklet-Ladeversatz) wirkt
  insert.setBand(0, 'active');
  insert.setBand(0, 'type');
  insert.setBand(0, 'freq');
  insert.setBand(0, 'slope');

  // setBand('q') rampt per setTargetAtTime (Klick-Vermeidung, s. eq8ApplyBandParams)
  // -- kurz warten, bis der Ramp eingeschwungen ist, bevor der Frequenzgang
  // gemessen wird, sonst liest getEq8Response() noch den alten Q-Wert.
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  b.q = 0.5;
  insert.setBand(0, 'q');
  await wait(120);
  const dbLowQ = insert.getEq8Response(freqs);
  const peakLowQ = Math.max(...dbLowQ);

  b.q = 8;
  insert.setBand(0, 'q');
  await wait(120);
  const dbHighQ = insert.getEq8Response(freqs);
  const peakHighQ = Math.max(...dbHighQ);

  // ---- 2) Kurve klemmt nicht mehr auf eine flache Linie an der Zoomgrenze ----
  // Niedriger Cutoff + kleine Zoomstufe -> die echte Antwort unterschreitet
  // sicher die sichtbare Spanne (s. PR-Messung: cutoff=1000Hz/range=12
  // erreicht ca. -23dB, deutlich unter ±12).
  const b2 = insert.params.bands[1];
  b2.active = true;
  b2.type = 'lowpass'; // High Cut
  b2.freq = 1000;
  b2.slope = 6; // 1-Pol, s. PR-Kommentar zur Nyquist-Boden-Messung
  insert.setBand(1, 'active');
  insert.setBand(1, 'type');
  insert.setBand(1, 'freq');
  insert.setBand(1, 'slope');
  insert.setGainRange(12);
  await new Promise((r) => setTimeout(r, 200)); // Worklet-Ladezeit für Band 1
  const dbClamp = insert.getEq8Response(freqs);
  const belowRangeCount = dbClamp.filter((v) => v < -12).length;

  return { peakLowQ, peakHighQ, belowRangeCount };
});

console.log('Peak bei Q=0.5:', out.peakLowQ.toFixed(2), 'dB -- Peak bei Q=8:', out.peakHighQ.toFixed(2), 'dB');
check('Niedriges Q zeigt nur eine kleine Resonanzspitze', out.peakLowQ < 3);
check('Hohes Q erzeugt eine deutlich grössere Resonanzspitze (Ableton/Pro-Q-Verhalten)', out.peakHighQ > out.peakLowQ * 3);

console.log('Anzahl Stützstellen unterhalb der sichtbaren ±12dB-Zoomstufe:', out.belowRangeCount);
check('Die reale Antwort verlässt tatsächlich die sichtbare Zoomstufe (Testaufbau korrekt)', out.belowRangeCount > 5);

check('Keine Seitenfehler', errors.length === 0);
if (errors.length) console.log(errors);

await browser.close();
process.exit(finish());
