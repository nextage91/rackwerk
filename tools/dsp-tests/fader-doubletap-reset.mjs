/**
 * fader-doubletap-reset.mjs — Regressionstest für einen echten Bug im
 * Doppel-Tap-Reset von <x-fader> (s. fader.js), gemeldet als "Doppel-Tap
 * setzt das Graphic-EQ-Band nicht zurück".
 *
 * Root Cause: `.fader__cap` und `.fader__hitzone` sind DOM-KINDER von
 * `.fader__track` (s. innerHTML in connectedCallback), aber alle drei
 * tragen denselben pointerdown-Listener (#onDown). Ein Tap direkt auf die
 * Kappe oder die Hitzone -- der NORMALFALL, da man genau dorthin tippt,
 * um zurückzusetzen -- löst #onDown darum ZWEIMAL für denselben
 * physischen Tap aus: einmal in der Zielphase (Kappe/Hitzone), dann
 * erneut, wenn dasselbe Event zum Track (Elternteil) hochblubbert.
 *
 * Für einen normalen Tap/Drag ist das harmlos (beide Aufrufe setzen
 * denselben Wert). Für den Doppel-Tap-Reset ist es fatal: beim ZWEITEN
 * Tap des Paares erkennt der ERSTE (Ziel-)Aufruf den Doppel-Tap korrekt
 * und resettet, aber der ZWEITE (gebubbelte) Aufruf sieht #lastTap dann
 * schon auf 0 zurückgesetzt, hält das für einen frischen Einzel-Tap und
 * zieht den Wert sofort wieder von 0 weg, an die aktuelle Tipp-Position --
 * das Reset "hält" nie sichtbar an. Ein exakt pixelgleicher Doppel-Klick
 * per Playwright-Maus verschleiert das (0px Bewegung landet zufällig
 * wieder nahe 0), ein realer Finger mit auch nur wenigen Pixeln primärer
 * Positionsabweichung zwischen den beiden Taps deckt es zuverlässig auf --
 * genau das simuliert dieser Test.
 *
 * Fix: ein Guard direkt am Event-Objekt (e.__xfaderHandled), der die
 * zweite (gebubbelte) Ausführung von #onDown für dasselbe physische
 * Pointer-Event unterdrückt, ohne e.stopPropagation() zu nutzen (das
 * würde auch externe Listener auf dem Host-Element blockieren, z. B. die
 * Graphic-EQ-Drag-Anzeige aus insert-chain.js).
 *
 * Voraussetzung: ein lokaler Server auf dem Repo-Root, z. B.
 *   python3 -m http.server 8901
 * Dann:  node tools/dsp-tests/fader-doubletap-reset.mjs  [baseUrl]
 */
import { launchBrowser, makeReporter, openApp, baseUrlFromArgv } from './_helpers.mjs';

const { check, finish } = makeReporter();
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await openApp(page, baseUrlFromArgv());
await page.waitForSelector('.rack-row');
await page.click('.rack-row .rack-row__name');
await page.waitForTimeout(300);
const machine = await page.evaluateHandle(() => {
  const all = [...document.querySelectorAll('.machine')].filter((m) => m.offsetParent !== null && !m.classList.contains('machine--master') && m.querySelector('[data-add-insert]'));
  return all[0] || null;
});
await machine.evaluate((el) => el.querySelector('[data-add-insert]').click());
await page.waitForTimeout(150);
await page.click('.sheet--insert-picker [data-type="geq"]');
await page.waitForTimeout(150);

const fader = page.locator('.geq-bands x-fader').first();
await fader.scrollIntoViewIfNeeded();
const track = fader.locator('.fader__track');
const box = await track.boundingBox();

const dragToBoost = async () => {
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.7);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.2, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(100);
};

// Realistischer Doppel-Tap: die zweite Berührung landet ein paar Pixel
// neben der ersten (wie ein echter Finger), aber innerhalb der
// bestehenden 6px-"kein Ziehen"-Toleranz aus fader.js -- muss trotzdem
// zuverlässig als Doppel-Tap erkannt werden.
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
const jitterTap = async (dy) => {
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy + dy);
  await page.mouse.up();
};

for (const dy of [0, 3, 5]) {
  await dragToBoost();
  const before = await fader.evaluate((el) => el.value);
  await jitterTap(dy);
  await page.waitForTimeout(80);
  await jitterTap(dy);
  await page.waitForTimeout(100);
  const after = await fader.evaluate((el) => el.value);
  check(`Doppel-Tap mit ${dy}px Jitter setzt zuverlässig auf 0 dB zurück (vorher ${before.toFixed(1)}dB)`, after === 0);
}

// Eine tatsächliche, deutliche Ziehbewegung (weit über der 6px-Toleranz)
// darf weiterhin NICHT als Tap gewertet werden -- der Fix darf die
// Drag/Tap-Unterscheidung nicht aufweichen.
await dragToBoost();
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.move(cx, cy - 30, { steps: 5 });
await page.mouse.up();
await page.waitForTimeout(100);
const afterRealDrag = await fader.evaluate((el) => el.value);
check('Eine echte 30px-Ziehbewegung wird weiterhin als Drag behandelt (nicht als Tap/Reset)', afterRealDrag !== 0);

check('Keine Seitenfehler', errors.length === 0);
if (errors.length) console.log(errors);

await browser.close();
process.exit(finish());
