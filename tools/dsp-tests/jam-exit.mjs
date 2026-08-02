/**
 * jam-exit.mjs — Regressionstest für core/rack/jam-view.js#exitJamMode.
 *
 * Nutzer-Bugreport: nach einem Jam-Besuch (Clips gestartet, Szenen
 * gespeichert, eine Spur über den Stop-Button der Jam-Ansicht stumm-
 * geschaltet) liess sich im Rack nicht mehr einfach alles zusammen
 * abspielen -- die Spur blieb dauerhaft an ihren Jam-Zustand gebunden,
 * auch nachdem man die Jam-Ansicht längst verlassen hatte.
 *
 * Ursache (s. jam-view.js-Dateikopf): `jamGateOpen` ist ein zusätzliches,
 * von Mute/Solo unabhängiges Gate, das eine per Jam-Stop-Button
 * stummgeschaltete Spur schliesst -- ohne eine explizite Rückkehr-Aktion
 * blieb dieses Gate für immer zu, auch weit ausserhalb von Jam.
 *
 * Dieser Test schaltet eine Spur in Jam stumm, verlässt die Jam-Ansicht
 * OHNE sie manuell wieder hörbar zu machen (genau der Schritt, den der
 * Nutzer erwartungsgemäss NICHT extra macht), und prüft über den echten
 * Kopf-Meter (kein interner Zustand -- reale, hörbare Pegel-LEDs), dass
 * die Spur beim Abspielen im Rack trotzdem wieder klingt.
 *
 * Gegenprobe (beim Schreiben dieses Tests durchgeführt, nicht Teil des
 * automatisierten Laufs): mit deaktiviertem Fix blieb der Meter über den
 * gesamten Messzeitraum bei 0 gelit-Segmenten -- mit Fix leuchtet er
 * durchgehend.
 *
 * Voraussetzung: ein lokaler Server auf dem Repo-Root, z. B.
 *   python3 -m http.server 8901
 * Dann:  node tools/dsp-tests/jam-exit.mjs  [baseUrl]
 */
import { launchBrowser, makeReporter, openApp, baseUrlFromArgv } from './_helpers.mjs';

const { check, finish } = makeReporter();
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await openApp(page, baseUrlFromArgv());

// Frische Maschine anlegen (Fokus öffnet automatisch) -- ihre ID lesen wir
// aus dem Typenschild, um sie später in der Jam-Spalte wiederzufinden.
await page.click('.rack__add');
await page.waitForSelector('.sheet__item');
await page.click('.sheet__item');
await page.waitForSelector('.machine-focus:not([hidden])');
await page.waitForTimeout(300);
const typeText = await page.locator('.machine-focus:not([hidden]) .machine__type').first().textContent();
const id = Number(typeText.match(/#(\d+)/)[1]);
check('neue Maschine hat eine ID bekommen', Number.isInteger(id));

// Alle 16 Schritte in Pattern A einschalten -- durchgängiges, verlässlich
// hörbares Signal statt eines einzelnen kurzen Hits, dessen Meter-Ausschlag
// je nach Sample-Timing schon wieder abgeklungen sein könnte.
for (let c = 0; c < 16; c++) {
  const cell = page.locator('.machine-focus:not([hidden]) .cell').nth(c);
  if (!(await cell.evaluate((el) => el.classList.contains('is-on')))) await cell.click();
}
await page.waitForTimeout(100);
await page.click('.machine-focus:not([hidden]) .machine-focus__back');
await page.waitForTimeout(200);

// In Jam die Spur dieser Maschine explizit stumm schalten.
await page.click('.bb-mode[data-mode="jam"]');
await page.waitForSelector('#jam-sheet:not([hidden])');
await page.waitForTimeout(300);
const channel = page.locator('.channel').filter({ has: page.locator('.channel__name', { hasText: `#${id}` }) });
check('Jam-Spalte für die neue Maschine gefunden', (await channel.count()) === 1);
await channel.locator('.clip-stop').click();
await page.waitForTimeout(150);
check('Stop-Button zeigt aktiven Zustand', await channel.locator('.clip-stop').evaluate((el) => el.classList.contains('is-active')));

// Jam verlassen -- OHNE die Spur manuell wieder hörbar zu machen. Das ist
// der Kern des Bugreports: einfach zurück ins Rack soll reichen.
await page.click('.bb-mode[data-mode="rack"]');
await page.waitForTimeout(200);
check('Jam-Sheet ist geschlossen', await page.locator('#jam-sheet').isHidden());

// Play drücken und die Maschine wieder öffnen, um ihren echten Kopf-Meter
// zu beobachten -- reale Pegel-LEDs statt eines internen Zustands.
await page.click('#btn-play');
const rowCount = await page.locator('.rack-row').count();
let found = false;
for (let i = 0; i < rowCount; i++) {
  await page.locator('.rack-row').nth(i).locator('.rack-row__name').click();
  await page.waitForTimeout(150);
  const t = await page.locator('.machine-focus:not([hidden]) .machine__type').first().textContent().catch(() => '');
  if (t.includes(`#${id}`)) { found = true; break; }
  await page.click('.machine-focus:not([hidden]) .machine-focus__back');
}
check('Maschine nach dem Wechsel zurück ins Rack wiedergefunden', found);

let anyLit = false;
for (let i = 0; i < 6 && !anyLit; i++) {
  await page.waitForTimeout(300);
  const lit = await page.locator('.machine-focus:not([hidden]) [data-head-meter] .x-meter__seg.is-lit').count();
  if (lit > 0) anyLit = true;
}
check('Spur ist beim Abspielen im Rack wieder hörbar, ohne manuelles Wiederaufnehmen '
  + '(Kopf-Meter leuchtet), obwohl sie in Jam zuletzt gestoppt war', anyLit);

check('Keine Seitenfehler', errors.length === 0);
if (errors.length) console.log(errors);

// Transport wieder anhalten -- sonst läuft er über das Ende des Skripts
// hinaus in der geschlossenen Seite weiter (kein Fehler, aber unnötig).
await page.click('#btn-play');

await browser.close();
process.exit(finish());
