/**
 * sweep-pad-trail.mjs — Regressionstest für die Sweep-Pad-Verfeinerung im
 * Jam-Master-Kanal (Nutzer-Feedback nach dem ersten Pad-Umbau: "kann nur
 * halb so breit sein, braucht keinen Punkt, aber ein visuelles Feedback
 * beim Betätigen -- wie ein Licht um den Finger, mit einem Schweif", dazu
 * "der Reso-Encoder ist proportional zu gross").
 *
 * Deckt drei unabhängige Änderungen ab (s. jam-view.js#buildSweepPanel):
 * - Pad ist ~50% der Kanalbreite (nicht mehr volle Breite wie das X/Y-Pad).
 * - Reso-Knob ist kleiner (--knob-size 26px statt der 34px-Vorgabe).
 * - Kein dauerhafter Punkt mehr -- der Kometenschweif (Licht + Nachzieh-
 *   Punkte) ist NUR während einer echten Zieh-Geste sichtbar (opacity 1,
 *   .is-active), in Ruhe unsichtbar (opacity 0), und blendet nach dem
 *   Loslassen wieder aus (.is-active entfernt).
 *
 * Voraussetzung: ein lokaler Server auf dem Repo-Root, z. B.
 *   python3 -m http.server 8901
 * Dann:  node tools/dsp-tests/sweep-pad-trail.mjs  [baseUrl]
 */
import { launchBrowser, makeReporter, openApp, baseUrlFromArgv } from './_helpers.mjs';

const { check, finish } = makeReporter();
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await openApp(page, baseUrlFromArgv());
await page.click('.bb-mode[data-mode="jam"]');
await page.waitForSelector('#jam-sheet:not([hidden])');
await page.waitForTimeout(300);

const idle = await page.evaluate(() => {
  const channel = document.querySelector('.channel--master');
  const pad = channel.querySelector('.sweep-pad');
  const trail = pad.querySelector('.sweep-trail');
  const resoDial = channel.querySelector('.sweep-head x-knob .knob__dial');
  return {
    padWidthRatio: pad.getBoundingClientRect().width / channel.getBoundingClientRect().width,
    trailActive: trail.classList.contains('is-active'),
    trailOpacity: parseFloat(getComputedStyle(trail).opacity),
    dotExists: !!pad.querySelector('.xypad__dot'),
    resoDialWidth: resoDial.getBoundingClientRect().width,
  };
});

console.log('Pad-Breite / Kanal-Breite:', idle.padWidthRatio.toFixed(2));
console.log('Reso-Dial-Breite (px):', idle.resoDialWidth);

check('Das Pad ist deutlich schmaler als die volle Kanalbreite (Ziel ~50%)',
  idle.padWidthRatio > 0.35 && idle.padWidthRatio < 0.65);
check('Es gibt keinen dauerhaften Punkt mehr (.xypad__dot)', !idle.dotExists);
check('In Ruhe ist der Kometenschweif unsichtbar (opacity 0, nicht aktiv)',
  !idle.trailActive && idle.trailOpacity === 0);
check('Der Reso-Knob ist kleiner als der Standard-Makro-Knob (< 34px Dial)',
  idle.resoDialWidth < 30);

// ---- Kometenschweif erscheint beim Ziehen, verblasst beim Loslassen ----
const pad = page.locator('.channel--master .sweep-pad');
const box = await pad.boundingBox();
const cx = box.x + box.width / 2;
await page.mouse.move(cx, box.y + box.height * 0.5);
await page.mouse.down();
await page.mouse.move(cx, box.y + box.height * 0.2, { steps: 5 });
await page.waitForTimeout(50);

const duringDrag = await page.evaluate(() => {
  const trail = document.querySelector('.channel--master .sweep-trail');
  const light = trail.querySelector('.sweep-trail__light');
  return {
    trailActive: trail.classList.contains('is-active'),
    trailOpacity: parseFloat(getComputedStyle(trail).opacity),
    lightTop: parseFloat(light.style.top),
  };
});
check('Während des Ziehens ist der Schweif sichtbar (opacity 1, aktiv)',
  duringDrag.trailActive && duringDrag.trailOpacity === 1);
check('Das Licht folgt der Zugposition (nahe oben -- niedriger top%-Wert)',
  duringDrag.lightTop < 30);

await page.mouse.up();
await page.waitForTimeout(50);
const afterRelease = await page.evaluate(() =>
  document.querySelector('.channel--master .sweep-trail').classList.contains('is-active'));
check('Nach dem Loslassen wird der Schweif wieder ausgeblendet (.is-active entfernt)', !afterRelease);

// ---- Die eigentliche Filterwirkung (DSP) bleibt unverändert funktional ----
const sweepValue = await page.evaluate(() =>
  parseFloat(document.querySelector('#master-fx x-knob[data-p="filterSweep"]').value));
check('Das Ziehen nach oben hat den echten filterSweep-Wert Richtung -1 bewegt', sweepValue < -0.3);

check('Keine Seitenfehler', errors.length === 0);
if (errors.length) console.log(errors);

await browser.close();
process.exit(finish());
