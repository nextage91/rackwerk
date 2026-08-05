/**
 * lookahead-envelope-leak.mjs — Regressionstest gegen ein hörbares Knacksen
 * bei FMSynth/PsySynth, das NUR bei Sequenzer-, nie bei Tastentriggerung
 * auftrat (Nutzer-Bugreport, s. fmsynth.js#playNote/psysynth.js#playNote).
 *
 * Root Cause: `playNote(midi, time, dur, vel)` bekommt vom Sequenzer-
 * Lookahead-Planer (s. transport.js, SCHEDULE_AHEAD=0.1s) ein `time`, das
 * bis zu 100ms in der ZUKUNFT liegt. Die Amp-Hüllkurve (`ampEnv`, ein
 * frisches GainNode) plante bislang NUR `setValueAtTime(0, time)` -- ein
 * GainNode steht aber bis zum ERSTEN Automations-Event auf seinem
 * Default-Gain 1, nicht auf 0. Die fm-voice (aus dem Wiederverwendungs-
 * Pool, s. fmsynth.js#fmPool -- nie gestoppt, läuft dauerhaft) wird aber
 * schon JETZT (beim Aufruf von playNote, nicht erst bei `time`) in die
 * Filter/Amp-Kette verbunden. Ergebnis: das Signal lief bis zu 100ms lang
 * auf Gain 1 unhüllt durch, bevor die Hüllkurve bei `time` abrupt auf 0
 * sprang und wieder hochfuhr -- ein deutliches Knacksen, das (weil
 * `noteOn()`/Tastenspiel immer mit `time == currentTime` arbeitet, die
 * Lücke dort praktisch null ist) NUR den Sequenzer betraf, wie im
 * Bugreport beschrieben. Fix: `ampEnv.gain.value = 0` SOFORT bei
 * Konstruktion, zusätzlich zum bestehenden `setValueAtTime(0, time)`.
 *
 * Test: plant eine Note mit `time` = jetzt + 80ms (wie SCHEDULE_AHEAD),
 * nachdem eine vorherige Note die fm-voice(s) bereits "warmgelaufen" hat
 * (Pool-Wiederverwendung, der Fall, in dem die vorher laufende Stimme
 * schon VOR `time` real Audio produziert). Misst den RMS-Pegel 40ms nach
 * dem Aufruf (also klar VOR der geplanten Notenzeit) -- muss praktisch
 * Stille sein.
 *
 * Voraussetzung: ein lokaler Server auf dem Repo-Root, z. B.
 *   python3 -m http.server 8901
 * Dann:  node tools/dsp-tests/lookahead-envelope-leak.mjs  [baseUrl]
 */
import { launchBrowser, makeReporter, openApp, baseUrlFromArgv } from './_helpers.mjs';

const { check, finish } = makeReporter();
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await openApp(page, baseUrlFromArgv());

async function measurePreScheduleLeak(machineName) {
  return page.evaluate(async (name) => {
    const ctx = engine.ctx;
    if (ctx.state === 'suspended') await ctx.resume();
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const m = song.rack.machines.find((mm) => mm.constructor.name === name);
    m.params.release = 0.05;
    m.params.attack = 0.005;

    // Vorheriges Warmlaufen: fm-voice(s) im Pool sind bereits gebaut &
    // laufen (der reale Fall -- eine frisch konstruierte Stimme beim
    // allerersten Ton wäre trivial silent, entscheidend ist die
    // WIEDERVERWENDETE, dauerhaft laufende Stimme).
    m.playNote(60, ctx.currentTime + 0.01, 0.05, 1);
    await wait(300);

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    const mute = ctx.createGain();
    mute.gain.value = 0;
    m.output.connect(analyser).connect(mute).connect(ctx.destination);

    // Wie transport.js's SCHEDULE_AHEAD: Note 80ms in der Zukunft.
    m.playNote(72, ctx.currentTime + 0.08, 0.1, 1);

    // 40ms später -- die geplante Notenzeit ist noch 40ms entfernt, es
    // MUSS noch Stille sein.
    await wait(40);
    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    const rms = Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length);

    m.output.disconnect(analyser);
    await wait(400);
    return rms;
  }, machineName);
}

await page.click('.rack__add');
await page.waitForSelector('.sheet__item');
await page.locator('.sheet__item', { hasText: 'FM Synth' }).first().click();
await page.waitForTimeout(500);
const fmRms = await measurePreScheduleLeak('FMSynth');
console.log('FMSynth: RMS vor der geplanten Notenzeit:', fmRms.toFixed(4));
check('FMSynth: kein hörbares Durchsickern vor der geplanten Sequenzer-Notenzeit', fmRms < 0.02);

await page.locator('.machine-focus:not([hidden]) .machine-focus__back').click();
await page.waitForTimeout(150);
await page.click('.rack__add');
await page.waitForSelector('.sheet__item');
await page.locator('.sheet__item', { hasText: 'PsySynth' }).first().click();
await page.waitForTimeout(500);
const psyRms = await measurePreScheduleLeak('PsySynth');
console.log('PsySynth: RMS vor der geplanten Notenzeit:', psyRms.toFixed(4));
check('PsySynth: kein hörbares Durchsickern vor der geplanten Sequenzer-Notenzeit', psyRms < 0.02);

check('Keine Seitenfehler', errors.length === 0);
if (errors.length) console.log(errors);

await browser.close();
process.exit(finish());
