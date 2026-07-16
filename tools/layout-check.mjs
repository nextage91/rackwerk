/**
 * layout-check.mjs — automatischer Layout-Test über echte iPhone-Breiten.
 *
 * Bootet das gebündelte index.html in Chromium bei mehreren Viewport-
 * Breiten und prüft, dass nichts horizontal aus dem Bild läuft und die
 * wichtigen Bedien-Elemente sichtbar sind. Fängt die Fehlerklasse
 * „Element ragt über den Rand" (z. B. Play-Button abgeschnitten) ab,
 * bevor sie aufs Gerät kommt.
 *
 * Voraussetzung: ein lokaler Server auf dem Repo-Root, z. B.
 *   python3 -m http.server 8901
 * Dann:  node tools/layout-check.mjs  [http://127.0.0.1:8901/index.html]
 *
 * Playwright ist ein reines Dev-Werkzeug (nicht Teil der App):
 *   npm i playwright   (Chromium wird über PLAYWRIGHT-Env gefunden)
 */
import { chromium } from 'playwright';

const URL = process.argv[2] ?? 'http://127.0.0.1:8901/index.html';
const EXEC = process.env.PLAYWRIGHT_CHROMIUM ?? '/opt/pw-browsers/chromium';

// Gängige iPhone-Breiten (CSS-Pixel), von groß bis Uralt-SE
const WIDTHS = [430, 414, 393, 390, 375, 360, 320];

// Bedien-Elemente, die auf jeder Breite komplett im Bild liegen müssen
const MUST_FIT = ['#btn-play', '#btn-projects', '#btn-rec', '#btn-bpm-up', '#btn-bpm-down'];

const browser = await chromium.launch({ executablePath: EXEC });
let problems = 0;

for (const width of WIDTHS) {
  const page = await browser.newPage({
    viewport: { width, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  });
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.click('#btn-unlock');
  await page.waitForTimeout(300);

  const r = await page.evaluate((sels) => {
    const vw = window.innerWidth;
    const out = { vw, overflow: document.documentElement.scrollWidth - vw, clipped: [] };
    for (const s of sels) {
      const el = document.querySelector(s);
      if (!el) { out.clipped.push(s + ' (fehlt)'); continue; }
      const b = el.getBoundingClientRect();
      if (b.right > vw + 0.5 || b.left < -0.5) {
        out.clipped.push(`${s} [${Math.round(b.left)}..${Math.round(b.right)}]`);
      }
    }
    // Elemente, die vollständig INNERHALB eines Containers liegen müssen
    // (z. B. die BPM-Zahl im LCD — reicht nicht, dass die Breite passt,
    //  sie darf auch nicht über die Ränder hinausragen).
    const within = [['#lcd-bpm', '.transport__lcd']];
    for (const [innerSel, outerSel] of within) {
      const inner = document.querySelector(innerSel);
      const outer = document.querySelector(outerSel);
      if (!inner || !outer) continue;
      const a = inner.getBoundingClientRect();
      const o = outer.getBoundingClientRect();
      if (a.left < o.left - 0.5 || a.right > o.right + 0.5) {
        out.clipped.push(`${innerSel} ragt aus ${outerSel}`);
      }
    }
    return out;
  }, MUST_FIT);

  const horiz = r.overflow > 0.5;
  const ok = !horiz && r.clipped.length === 0;
  if (!ok) problems++;
  const notes = [];
  if (horiz) notes.push(`h-Überlauf +${r.overflow}px`);
  if (r.clipped.length) notes.push('abgeschnitten: ' + r.clipped.join(', '));
  console.log(`w=${width}: ${ok ? '✓ ok' : '✗ ' + notes.join(' | ')}`);
  await page.close();
}

await browser.close();
console.log(problems === 0 ? '\nLAYOUT OK — nichts läuft über den Rand'
  : `\n${problems} BREITE(N) MIT PROBLEMEN`);
process.exit(problems === 0 ? 0 : 1);
