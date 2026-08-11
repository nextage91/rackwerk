/**
 * tail-flush-scope.mjs — Regressionstest für machine.js#refreshGates'
 * flushTails()-Aufruf (Master-Hall/Delay-Zurücksetzen bei "solo in place").
 *
 * Nutzer-Bugreport: "Hall und Delay klingen nicht aus, wenn ich eine Spur
 * stoppe" -- per Reproduktion bestätigt: flushTails() (fx.js) baut den
 * kompletten Hall-/Delay-Tank neu auf (verwirft den gesamten inneren
 * Zustand) JEDES MAL, wenn die hörbare Menge irgendwie schrumpft -- auch
 * bei einem simplen Mute/Jam-Stop EINER Spur, während andere ungestört
 * weiterspielen. Der Nachhall dieser einen Spur sprang dabei binnen
 * ~60ms auf exakt 0 und kehrte NIE zurück, statt normal auszuklingen.
 *
 * Der Fix beschränkt den Flush auf den tatsächlich gemeinten Fall: NUR
 * wenn ein aktives Solo die Ursache ist ("solo in place", s. Datei-
 * kopf-Kommentar bei refreshGates()). Prüft beide Seiten:
 *  - Muten einer Spur OHNE aktives Solo darf den Hall NICHT hart auf 0
 *    reissen -- er soll normal (aus)klingen dürfen.
 *  - Solo (auf einer ANDEREN Spur) MUSS weiterhin flushen -- sonst hört
 *    man beim Soloen den Nachhall der gerade stumm gewordenen Spur mit.
 *
 * Voraussetzung: ein lokaler Server auf dem Repo-Root, z. B.
 *   python3 -m http.server 8901
 * Dann:  node tools/dsp-tests/tail-flush-scope.mjs  [baseUrl]
 */
import { launchBrowser, makeReporter, openApp, baseUrlFromArgv } from './_helpers.mjs';

const { check, finish } = makeReporter();
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await openApp(page, baseUrlFromArgv());

async function setupReverbTail() {
  const rows = page.locator('.rack-row');
  const n = await rows.count();
  await rows.nth(n - 1).locator('.rack-row__name').click(); // SubSynth (Default-Projekt: BeatBox dann SubSynth)
  await page.waitForTimeout(300);
  await page.locator('.machine-focus:not([hidden]) x-knob[data-p="sendReverb"]').evaluate((el) => {
    el.value = 1;
    el.dispatchEvent(new CustomEvent('input', { detail: { value: 1 }, bubbles: true }));
  });
  await page.click('.machine-focus:not([hidden]) .machine-focus__back');
  await page.waitForTimeout(200);
  await page.click('#btn-play');
  await page.waitForTimeout(1500); // Hall aufbauen lassen

  await page.evaluate(() => {
    const ctx = engine.ctx;
    window.__tailAnalyser = ctx.createAnalyser();
    window.__tailAnalyser.fftSize = 512;
    const mute = ctx.createGain();
    mute.gain.value = 0;
    masterFX.reverbInsert.output.connect(window.__tailAnalyser).connect(mute).connect(ctx.destination);
  });
}

async function sampleRms(count, everyMs) {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(await page.evaluate(() => {
      const buf = new Float32Array(window.__tailAnalyser.fftSize);
      window.__tailAnalyser.getFloatTimeDomainData(buf);
      let sumSq = 0;
      for (const s of buf) sumSq += s * s;
      return Math.sqrt(sumSq / buf.length);
    }));
    await page.waitForTimeout(everyMs);
  }
  return out;
}

async function teardownReverbTail() {
  await page.evaluate(() => window.__tailAnalyser && (window.__tailAnalyser = null));
  await page.click('#btn-play'); // Transport wieder anhalten
  // Fokus-Overlay wieder schliessen, damit die Rack-Liste für den nächsten
  // Testfall wieder klickbar ist (nur EIN Overlay kann offen sein).
  const backBtn = page.locator('.machine-focus:not([hidden]) .machine-focus__back');
  if (await backBtn.count()) await backBtn.click();
  await page.waitForTimeout(150);
}

// --- Fall 1: Mute EINER Spur, keine Solo aktiv -- Hall darf nicht hart auf 0 springen.
await setupReverbTail();
const rows = page.locator('.rack-row');
await rows.nth((await rows.count()) - 1).locator('.rack-row__name').click(); // SubSynth erneut öffnen
await page.waitForTimeout(100);
await page.click('.machine-focus:not([hidden]) [data-mute]');
const muteSamples = await sampleRms(20, 15);
console.log('RMS nach Mute (ohne Solo):', muteSamples.map((v) => v.toFixed(4)).join(', '));
const hitsHardZero = muteSamples.some((v) => v === 0) && muteSamples.slice(muteSamples.indexOf(0)).every((v) => v === 0);
check('Mute ohne Solo: Hall klingt aus (kein harter Sprung auf 0, der nie zurückkehrt)', !hitsHardZero);
await page.click('.machine-focus:not([hidden]) [data-mute]'); // wieder entmuten für den nächsten Fall
await teardownReverbTail();

// --- Fall 2: Solo auf einer ANDEREN Spur -- Hall MUSS weiterhin geflusht werden.
await setupReverbTail();
await rows.nth(0).locator('.rack-row__name').click(); // BeatBox (die andere Standard-Maschine)
await page.waitForTimeout(100);
await page.click('.machine-focus:not([hidden]) [data-solo]');
const soloSamples = await sampleRms(15, 15);
console.log('RMS nach Solo (andere Spur):', soloSamples.map((v) => v.toFixed(4)).join(', '));
check('Solo auf anderer Spur: Hall der jetzt stummen Spur wird weiterhin geflusht (erreicht 0)', soloSamples.some((v) => v === 0));
await page.click('.machine-focus:not([hidden]) [data-solo]'); // Solo wieder aufheben
await teardownReverbTail();

check('Keine Seitenfehler', errors.length === 0);
if (errors.length) console.log(errors);

await browser.close();
process.exit(finish());
