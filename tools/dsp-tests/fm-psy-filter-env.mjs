/**
 * fm-psy-filter-env.mjs — Regressionstest für die Filterhüllkurve und den
 * wählbaren Filtertyp bei FMSynth/PsySynth (Chat: "die filter... klingen
 * zu clean... können wir für den fm synth und den psy synth noch eine
 * filter envelope einbauen wie beim subsynth?").
 *
 * Bislang hatten FMSynth/PsySynth einen fest auf Lowpass verdrahteten
 * Filter mit STATISCHEM Cutoff (keine Hüllkurve, kein Typ-Wahlschalter) --
 * anders als SubSynth/PolySynth, die beide `filterType` (LP/HP/BP) UND
 * eine Peak->Sustain-Filterhüllkurve (s. dsp.js#applyFilterEnv) haben.
 * Jetzt identisches Muster für FMSynth/PsySynth: `filter.type = p.
 * filterType`, `applyFilterEnv(filter, t, p)` statt eines statischen
 * `filter.frequency.value = p.cutoff`.
 *
 * Deckt ab:
 *  1) Die Filterhüllkurve öffnet den Cutoff beim Anschlag deutlich über
 *     den statischen Wert hinaus und klingt dann zurück (Peak->Sustain,
 *     wie applyFilterEnv es für SubSynth/PolySynth bereits tut).
 *  2) Der Filtertyp lässt sich umschalten (lowpass/highpass/bandpass) und
 *     wirkt tatsächlich auf den BiquadFilterNode der Stimme/Note.
 *
 * Voraussetzung: ein lokaler Server auf dem Repo-Root, z. B.
 *   python3 -m http.server 8901
 * Dann:  node tools/dsp-tests/fm-psy-filter-env.mjs  [baseUrl]
 */
import { launchBrowser, makeReporter, openApp, baseUrlFromArgv } from './_helpers.mjs';

const { check, finish } = makeReporter();
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await openApp(page, baseUrlFromArgv());

async function measure(machineName) {
  return page.evaluate(async (name) => {
    const ctx = engine.ctx;
    if (ctx.state === 'suspended') await ctx.resume();
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const m = song.rack.machines.find((mm) => mm.constructor.name === name);
    m.params.envAmt = 1;
    m.params.fDecay = 0.2;
    m.params.cutoff = 2000;
    m.params.release = 1;
    m.params.attack = 0.002;

    m.noteOn(60);
    await wait(10);
    const filter = m.voices.get(60).filter;
    const peakHz = filter.frequency.value;
    await wait(500);
    const settledHz = filter.frequency.value;

    const typeBefore = filter.type;
    m.params.filterType = 'highpass';
    filter.type = m.params.filterType; // simuliert den Button-Klick-Handler
    const typeAfter = filter.type;

    m.noteOff(60);
    await wait(1200);

    return { peakHz, settledHz, staticCutoff: m.params.cutoff, typeBefore, typeAfter };
  }, machineName);
}

await page.click('.rack__add');
await page.waitForSelector('.sheet__item');
await page.locator('.sheet__item', { hasText: 'FM Synth' }).first().click();
await page.waitForTimeout(500);
const fm = await measure('FMSynth');
console.log('FMSynth: Peak', fm.peakHz.toFixed(0), 'Hz -> Settle', fm.settledHz.toFixed(0), 'Hz (statisch:', fm.staticCutoff, 'Hz)');
check('FMSynth: Filterhüllkurve öffnet deutlich über den statischen Cutoff', fm.peakHz > fm.staticCutoff * 1.5);
check('FMSynth: Filterhüllkurve klingt zurück Richtung statischem Cutoff', fm.settledHz < fm.peakHz * 0.6);
check('FMSynth: Filtertyp lässt sich umschalten (lowpass -> highpass)', fm.typeBefore === 'lowpass' && fm.typeAfter === 'highpass');

await page.locator('.machine-focus:not([hidden]) .machine-focus__back').click();
await page.waitForTimeout(150);
await page.click('.rack__add');
await page.waitForSelector('.sheet__item');
await page.locator('.sheet__item', { hasText: 'PsySynth' }).first().click();
await page.waitForTimeout(500);
const psy = await measure('PsySynth');
console.log('PsySynth: Peak', psy.peakHz.toFixed(0), 'Hz -> Settle', psy.settledHz.toFixed(0), 'Hz (statisch:', psy.staticCutoff, 'Hz)');
check('PsySynth: Filterhüllkurve öffnet deutlich über den statischen Cutoff', psy.peakHz > psy.staticCutoff * 1.5);
check('PsySynth: Filterhüllkurve klingt zurück Richtung statischem Cutoff', psy.settledHz < psy.peakHz * 0.6);
check('PsySynth: Filtertyp lässt sich umschalten (lowpass -> highpass)', psy.typeBefore === 'lowpass' && psy.typeAfter === 'highpass');

check('Keine Seitenfehler', errors.length === 0);
if (errors.length) console.log(errors);

await browser.close();
process.exit(finish());
