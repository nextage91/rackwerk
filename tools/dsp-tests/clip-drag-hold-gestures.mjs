/**
 * clip-drag-hold-gestures.mjs — Regressionstest für die drei Jam-Clip-
 * Gesten (Tap zum Starten/Stoppen, Ziehen zum Umsortieren, Halten öffnet
 * das Löschen-Menü, s. makeReorderable() in jam-view.js) nach dem Umbau
 * von 'click' auf direktes pointerdown/pointerup (s. xypad-multitouch.mjs
 * für den Hintergrund dieses Umbaus).
 *
 * Deckt dabei einen ECHTEN, schon VOR diesem Umbau bestehenden Bug ab, der
 * beim Verifizieren auffiel: makeReorderable() lief bei JEDEM Hinzufügen
 * eines weiteren Clips erneut (renderClips() ruft es bei jedem neuen Clip
 * wieder auf), baute dabei aber jedes Mal einen KOMPLETT NEUEN, unabhängigen
 * Satz pointerdown/move/up-Listener auf demselben, dauerhaften `clipsEl`
 * auf -- ab dem zweiten Clip verarbeiteten zwei (oder mehr) Listener-Sätze
 * dieselbe Ziehgeste parallel, und ein SPÄTERER Satz sah beim eigenen
 * pointerup bereits die vom ERSTEN entfernte 'is-dragging'-Klasse, wertete
 * das fälschlich als "kein Ziehen" und löste zusätzlich zum Umsortieren
 * noch ein ungewolltes Starten/Stoppen des gezogenen Clips aus. Behoben
 * über eine WeakSet-Sperre (reorderableWired), die die Listener-
 * Registrierung auf EINMAL pro `clipsEl` begrenzt.
 *
 * Voraussetzung: ein lokaler Server auf dem Repo-Root, z. B.
 *   python3 -m http.server 8901
 * Dann:  node tools/dsp-tests/clip-drag-hold-gestures.mjs  [baseUrl]
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
await page.waitForTimeout(300);
await page.click('.machine-focus:not([hidden]) .cell[data-cell="0"]');
await page.waitForTimeout(100);
await page.click('.machine-focus:not([hidden]) .cell[data-cell="4"]');
await page.waitForTimeout(100);
await page.click('.machine-focus:not([hidden]) .machine-focus__back');
await page.waitForTimeout(200);
await page.click('.bb-mode[data-mode="jam"]');
await page.waitForSelector('#jam-sheet:not([hidden])');
await page.waitForTimeout(300);

// .channel--master (s. jam-view.js#buildMasterColumn) sitzt jetzt fest am
// Ende der Liste, hat aber keine Clips -- ausschliessen, sonst zielt
// .last() auf den Master- statt den letzten Maschinen-Kanal.
const channel = page.locator('.channel:not(.channel--master)').last();
// Zwei Clips anlegen -- ERST ab dem zweiten Clip lief makeReorderable()
// vor dem Fix ein zweites Mal und stapelte die doppelten Listener.
await channel.locator('.proto-clip[data-slot="0"]').click();
await page.waitForTimeout(150);
await channel.locator('.proto-clip[data-slot="1"]').click();
await page.waitForTimeout(150);

const clips = channel.locator('.clip[data-clip-id]');
check('zwei Clips angelegt', (await clips.count()) === 2);
const idsBefore = await clips.evaluateAll((els) => els.map((el) => el.dataset.clipId));

// --- Tap zum Starten/Stoppen funktioniert weiterhin.
const first = clips.first();
const stateBefore = await first.getAttribute('data-state');
await first.click();
await page.waitForTimeout(150);
const stateAfterTap = await first.getAttribute('data-state');
check('Normaler Tap toggelt den Clip weiterhin', stateBefore !== stateAfterTap);

// --- Ziehen zum Umsortieren -- MUSS die Reihenfolge ändern, DARF den
// gezogenen Clip dabei NICHT zusätzlich starten/stoppen.
const box0 = await clips.nth(0).boundingBox();
const box1 = await clips.nth(1).boundingBox();
await page.mouse.move(box0.x + box0.width / 2, box0.y + box0.height / 2);
await page.mouse.down();
await page.mouse.move(box0.x + box0.width / 2, box1.y + box1.height / 2 + 5, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(200);
const idsAfterDrag = await clips.evaluateAll((els) => els.map((el) => el.dataset.clipId));
console.log('Reihenfolge:', idsBefore, '->', idsAfterDrag);
check('Ziehen sortiert die Clips um', idsAfterDrag[0] !== idsBefore[0]);

const draggedClip = channel.locator(`.clip[data-clip-id="${idsBefore[0]}"]`);
const stateAfterDrag = await draggedClip.getAttribute('data-state');
console.log('Status des gezogenen Clips: vor Drag', stateAfterTap, '-- nach Drag', stateAfterDrag);
check('Ziehen selbst löst KEIN zusätzliches Toggle aus (der frühere Doppel-Listener-Bug)', stateAfterDrag === stateAfterTap);

// --- Halten öffnet das Löschen-Menü, ebenfalls OHNE zusätzliches Toggle.
const target = clips.first();
const box = await target.boundingBox();
const stateBeforeHold = await target.getAttribute('data-state');
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.waitForTimeout(650); // über CLIP_HOLD_MS (500ms)
const menuVisible = await page.locator('.pat-chip', { hasText: 'Delete Clip' }).count();
await page.mouse.up();
await page.waitForTimeout(150);
const stateAfterHold = await target.getAttribute('data-state');
check('Halten öffnet das Löschen-Menü', menuVisible > 0);
check('Halten löst KEIN zusätzliches Toggle aus', stateBeforeHold === stateAfterHold);

check('Keine Seitenfehler', errors.length === 0);
if (errors.length) console.log(errors);

await browser.close();
process.exit(finish());
