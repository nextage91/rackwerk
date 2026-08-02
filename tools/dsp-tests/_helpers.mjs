/**
 * _helpers.mjs — gemeinsames Kleinzeug für die DSP-/Regressionstests in
 * diesem Verzeichnis (s. tools/dsp-check.mjs für den Runner, der sie alle
 * ausführt, und tools/layout-check.mjs für die gleiche Grundidee auf der
 * UI-Seite). Kein Test-Framework -- jede Datei ist ein eigenständiges
 * Skript mit `node datei.mjs [baseUrl]`, das bei Fehlschlag exit(1) macht.
 */
import { chromium } from 'playwright';

export const EXEC = process.env.PLAYWRIGHT_CHROMIUM ?? '/opt/pw-browsers/chromium';
export const DEFAULT_BASE_URL = 'http://127.0.0.1:8901/index.html';

export function baseUrlFromArgv() {
  return process.argv[2] ?? DEFAULT_BASE_URL;
}

export function launchBrowser(opts = {}) {
  return chromium.launch({ executablePath: EXEC, ...opts });
}

/** Sammelt PASS/FAIL-Zeilen, gibt sie sofort aus (praktisch beim
 *  Zusehen), und liefert am Ende Zusammenfassung + Exit-Code. */
export function makeReporter() {
  const results = [];
  const check = (name, cond) => {
    const ok = !!cond;
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}`);
    return ok;
  };
  const finish = () => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    return failed.length === 0 ? 0 : 1;
  };
  return { check, finish };
}

/** Öffnet die App, überspringt Start-Gate und Onboarding-Sheet -- der
 *  immer gleiche Vorlauf, den praktisch jeder UI-Test braucht. */
export async function openApp(page, baseUrl) {
  await page.goto(baseUrl);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const gate = page.locator('#btn-unlock');
  if (await gate.count()) await gate.click();
  await page.waitForSelector('.rack__add');
  const onboarding = page.locator('#onboarding-sheet [data-tut-skip]');
  if (await onboarding.count()) await onboarding.first().click();
  await page.waitForTimeout(200);
}

/** Leichte Variante für reine DSP-Tests, die `createInsert()` direkt per
 *  page.evaluate() aufrufen und nie mit dem Rack-UI interagieren -- braucht
 *  nur den Unlock-Tap (AudioContext.resume() hängt an einer echten
 *  Nutzer-Geste), nicht den vollen Onboarding-Vorlauf von openApp(). */
export async function unlockAudio(page, baseUrl) {
  await page.goto(baseUrl);
  await page.click('#btn-unlock');
  await page.waitForTimeout(300);
}
