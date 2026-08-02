/**
 * modular-redesign-ui.mjs — UI-Regressionstest für den Techno/House-
 * Sounddesign-Umbau der Modular-Modulauswahl (core/modular.js#MODULE_DEFS,
 * ui/modular-view.js).
 *
 * Nutzer-Feedback: "die Modulauswahl ist nicht passend" -- die "+ Add
 * Module"-Liste ist jetzt nach Sounddesign-Rolle gruppiert (Klangquellen ->
 * Klangformung -> Modulation -> Utility -> Output) statt in wilder
 * Entstehungsreihenfolge, plus zwei neue/erweiterte Bausteine: Distortion
 * (neu) und Envelope (jetzt volles ADSR statt nur Attack/Release), sowie
 * Notch als vierter Filtertyp.
 *
 * Voraussetzung: ein lokaler Server auf dem Repo-Root, z. B.
 *   python3 -m http.server 8901
 * Dann:  node tools/dsp-tests/modular-redesign-ui.mjs  [baseUrl]
 */
import { launchBrowser, makeReporter, openApp, baseUrlFromArgv } from './_helpers.mjs';

const { check, finish } = makeReporter();
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await openApp(page, baseUrlFromArgv());

// Add a Modular machine (last item in the +Add sheet per REGISTRY order).
await page.click('.rack__add');
await page.waitForSelector('.sheet__item');
const modularBtn = page.locator('.sheet__item', { hasText: 'Modular' });
await modularBtn.first().click();
await page.waitForSelector('.machine-focus:not([hidden])');
await page.waitForTimeout(300);

// Open the "+ Add Module" picker inside the Modular rack.
await page.click('.machine-focus:not([hidden]) [data-add-module]');
await page.waitForSelector('.sheet--module-picker:not([hidden])');
const items = page.locator('.sheet--module-picker:not([hidden]) .sheet__item .sheet__name');
const names = await items.allInnerTexts();
console.log('Modul-Reihenfolge im Picker:', names);

check('Distortion ist in der Liste', names.includes('Distortion'));
check('Reihenfolge: Oscillator vor Noise vor Filter vor Distortion vor VCA', (() => {
  const idx = (n) => names.indexOf(n);
  return idx('Oscillator') < idx('Noise') && idx('Noise') < idx('Filter') && idx('Filter') < idx('Distortion') && idx('Distortion') < idx('VCA');
})());
check('Envelope kommt nach VCA (Modulation-Gruppe)', names.indexOf('VCA') < names.indexOf('Envelope'));
check('Mixer/Ring Mod/Utility/Delay kommen nach Slew (Utility-Gruppe)', names.indexOf('Slew') < names.indexOf('Mixer'));
check('Output ist zuletzt', names[names.length - 1] === 'Output');

// Add the Distortion module, verify its Drive knob renders.
await page.locator('.sheet--module-picker:not([hidden]) .sheet__item', { hasText: 'Distortion' }).click();
await page.waitForTimeout(300);
const allRowNames = await page.locator('.modrack__row-name').allInnerTexts();
console.log('Zeilen im Modular-Rack nach dem Hinzufügen:', allRowNames);
const distRow = page.locator('.modrack__row', { has: page.locator('.modrack__row-name', { hasText: 'Distortion' }) });
check('Distortion-Modul wurde hinzugefügt', (await distRow.count()) > 0);
check('Drive-Regler ist sichtbar', (await distRow.locator('x-knob[data-module-param="drive"]').count()) > 0);

// Envelope now has 4 knobs (ADSR) instead of 2 (AR).
const envRow = page.locator('.modrack__row', { has: page.locator('.modrack__row-name', { hasText: 'Envelope' }) });
const envKnobs = await envRow.locator('x-knob').count();
console.log('Envelope-Regler-Anzahl:', envKnobs);
check('Envelope hat jetzt 4 Regler (ADSR statt nur AR)', envKnobs === 4);

// Add a Filter module too (default patch has none) and check its type picker includes Notch.
await page.click('.machine-focus:not([hidden]) [data-add-module]');
await page.waitForSelector('.sheet--module-picker:not([hidden])');
await page.locator('.sheet--module-picker:not([hidden]) [data-type="filter"]').click();
await page.waitForTimeout(200);
const filterRow = page.locator('.modrack__row', { has: page.locator('.modrack__row-name', { hasText: 'Filter' }) });
const filterSegLabels = await filterRow.locator('[data-module-enum="type"] button').allInnerTexts().catch(() => []);
console.log('Filter-Typ-Buttons:', filterSegLabels);
check('Filter hat einen Notch-Typ', filterSegLabels.some((t) => /notch/i.test(t)));

check('Keine Seitenfehler', errors.length === 0);
if (errors.length) console.log(errors);

await browser.close();
process.exit(finish());
