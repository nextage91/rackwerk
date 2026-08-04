/**
 * sequencer-velocity.mjs — Regressionstest für Step-Velocity im Sequenzer
 * (Nutzer-Anfrage: "ich fände es cool, wenn man im sequencer pro step auch
 * noch volume/velocity hätte damit man präzise dynamik ins pattern
 * programmieren kann").
 *
 * Deckt beide Hälften ab:
 * 1) DSP: vel (0..1, gespeichert pro Step) skaliert TATSÄCHLICH den
 *    Trigger-Pegel -- bei Pitch-Synths (SubSynth#playNote, s. step-
 *    sequenced-synth.js#onStep) UND bei Drum-Spuren (TrackedDrumMachine#
 *    trigger, level-Skalierung ohne die Klangerzeuger-Funktionen selbst
 *    anzufassen). Ein Regler, der sich bewegt, aber den Klang nicht ändert,
 *    wäre ein kaputtes Feature.
 * 2) UI: Halten auf einem aktiven Step öffnet ein Popup mit Velocity-
 *    Ziehbalken (Pitch-Picker bei Synths, schlankeres Popup bei Drums, s.
 *    ui/step-seq.js#openPitchPopup/openVelocityPopup), Ziehen ändert die
 *    Anzeige UND den gespeicherten Step-Wert. AcidBass bleibt bewusst
 *    AUSSER acht (Accent/Slide ist dort das Dynamik-Konzept, kein
 *    zusätzlicher Velocity-Balken, s. Proposal).
 *
 * Voraussetzung: ein lokaler Server auf dem Repo-Root, z. B.
 *   python3 -m http.server 8901
 * Dann:  node tools/dsp-tests/sequencer-velocity.mjs  [baseUrl]
 */
import { launchBrowser, makeReporter, openApp, baseUrlFromArgv } from './_helpers.mjs';

const { check, finish } = makeReporter();
const browser = await launchBrowser({ args: ['--touch-events=enabled'] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await openApp(page, baseUrlFromArgv());

// ---------- 1) DSP: vel skaliert den tatsächlichen Pegel ----------
const dsp = await page.evaluate(async () => {
  const ctx = engine.ctx;
  if (ctx.state === 'suspended') await ctx.resume();

  async function measureRms(vel, fn) {
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    const mute = ctx.createGain();
    mute.gain.value = 0;
    engine.masterBus.connect(analyser).connect(mute).connect(ctx.destination);
    fn(vel);
    await new Promise((r) => setTimeout(r, 60));
    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    engine.masterBus.disconnect(analyser);
    analyser.disconnect();
    mute.disconnect();
    let sumSq = 0;
    for (const s of buf) sumSq += s * s;
    return Math.sqrt(sumSq / buf.length);
  }

  // dur bewusst sehr kurz (0.05s) + grosszügige Pause zwischen den beiden
  // Messungen -- sonst hält die erste (laute) Note bei ihrer Sustain-Phase
  // noch an, wenn die zweite (leise) Note gemessen wird, und die Messung
  // misst fälschlich die AUSKLINGENDE erste statt der neuen zweiten Note.
  const sub = song.rack.machines.find((m) => m.constructor.name === 'SubSynth');
  const rmsSubFull = await measureRms(1, (v) => sub.playNote(48, ctx.currentTime, 0.05, v));
  await new Promise((r) => setTimeout(r, 500));
  const rmsSubQuiet = await measureRms(0.25, (v) => sub.playNote(48, ctx.currentTime, 0.05, v));

  const beat = song.rack.machines.find((m) => m.constructor.name === 'BeatBox');
  const track = beat.tracks[0];
  const origSteps = track.steps;
  const origSolo = beat.soloTrack;
  // Isolierter 1-Step-Test-Pattern statt des echten Patterns + soloTrack=0
  // -- vermeidet, dass gleichzeitig laufende andere Steps/Spuren (die
  // seeded Demo-Beat hat mehrere Spuren gleichzeitig aktiv) die Messung
  // verfälschen. Läuft trotzdem über den ECHTEN onStep()/#trigger()-Pfad,
  // nicht nur direkt über track.synth() -- testet damit auch, dass der
  // step.vel-Wert tatsächlich durchgereicht wird, nicht nur die DSP-Formel
  // isoliert.
  const testSteps = Array.from({ length: 16 }, () => ({ on: false, vel: 1 }));
  testSteps[0].on = true;
  track.steps = testSteps;
  beat.soloTrack = 0;
  const rmsDrumFull = await measureRms(1, () => { testSteps[0].vel = 1; beat.onStep(0, ctx.currentTime); });
  await new Promise((r) => setTimeout(r, 500));
  const rmsDrumQuiet = await measureRms(0.25, () => { testSteps[0].vel = 0.25; beat.onStep(0, ctx.currentTime); });
  track.steps = origSteps;
  beat.soloTrack = origSolo;

  return { rmsSubFull, rmsSubQuiet, rmsDrumFull, rmsDrumQuiet };
});

console.log(`SubSynth RMS bei vel=1: ${dsp.rmsSubFull.toFixed(4)}, bei vel=0.25: ${dsp.rmsSubQuiet.toFixed(4)}`);
check('SubSynth: vel=0.25 klingt deutlich leiser als vel=1', dsp.rmsSubQuiet < dsp.rmsSubFull * 0.6);
check('SubSynth: vel=0.25 ist trotzdem noch hörbar (nicht stumm)', dsp.rmsSubQuiet > dsp.rmsSubFull * 0.05);

console.log(`BeatBox Kick RMS bei vel=1: ${dsp.rmsDrumFull.toFixed(4)}, bei vel=0.25: ${dsp.rmsDrumQuiet.toFixed(4)}`);
check('BeatBox: vel=0.25 klingt deutlich leiser als vel=1', dsp.rmsDrumQuiet < dsp.rmsDrumFull * 0.6);
check('BeatBox: vel=0.25 ist trotzdem noch hörbar (nicht stumm)', dsp.rmsDrumQuiet > dsp.rmsDrumFull * 0.05);

// ---------- 2) UI: Velocity-Popup bei SubSynth (Pitch-Picker) ----------
await page.locator('.rack-row', { hasText: 'SubSynth' }).click();
await page.waitForSelector('.machine-focus:not([hidden])');
await page.waitForTimeout(300);

const cell = page.locator('.machine-focus:not([hidden]) .cell[data-cell="0"]'); // Demo-Line: Step 0 an
await cell.scrollIntoViewIfNeeded();
const cdp = await context.newCDPSession(page);

async function holdCell(locator, ms) {
  const box = await locator.boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
  await page.waitForTimeout(ms);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(100);
  return { x, y };
}

await holdCell(cell, 600);
check('Halten auf einem aktiven SubSynth-Step öffnet den Pitch-Picker', (await page.locator('.pitch-picker').count()) === 1);
check('Der Pitch-Picker zeigt einen Velocity-Balken', (await page.locator('.pitch-picker__vel-bar').count()) === 1);
check('Velocity startet standardmässig bei 100%', (await page.locator('[data-velpct]').textContent()) === '100%');

// Balken auf ~30% ziehen (linkes Drittel antippen).
const velBar = page.locator('[data-velbar]');
const velBox = await velBar.boundingBox();
await cdp.send('Input.dispatchTouchEvent', {
  type: 'touchStart',
  touchPoints: [{ x: velBox.x + velBox.width * 0.3, y: velBox.y + velBox.height / 2, id: 2 }],
});
await page.waitForTimeout(80);
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await page.waitForTimeout(150);

const velLabel = await page.locator('[data-velpct]').textContent();
console.log(`Velocity nach Ziehen auf ~30%: ${velLabel}`);
check('Ziehen des Velocity-Balkens ändert die Anzeige (ungefähr Zielposition)',
  parseInt(velLabel, 10) > 15 && parseInt(velLabel, 10) < 45);

const storedVel = await page.evaluate(() => {
  const sub = song.rack.machines.find((m) => m.constructor.name === 'SubSynth');
  return sub.pattern[0].vel;
});
console.log(`Gespeicherter Step-vel-Wert: ${storedVel}`);
check('Der gezogene Wert landet tatsächlich im Pattern-Step (nicht nur optisch)',
  storedVel > 0.15 && storedVel < 0.45);

// Ausserhalb (unten im leeren Bereich der Bottom-Bar-Zone) tippen schliesst
// das Popup wieder -- NICHT (20,20): das läge ausserhalb von
// .machine-focus__panel (startet erst bei --transport-h) und würde
// stattdessen die Transport-Leiste dahinter treffen.
await page.mouse.click(195, 820);
await page.waitForTimeout(150);
check('Popup schliesst nach Tap ausserhalb', (await page.locator('.pitch-picker').count()) === 0);

// ---------- 3) UI: Drum-Grid bekommt ein schlankeres Velocity-Popup ----------
// Frischer openApp()-Lauf statt Zurück-Navigation -- robuster als die
// Back-Button-Geste (vermeidet jede Mehrdeutigkeit, welches Element ein
// "Tap ausserhalb" gerade trifft) und jede Maschine startet ohnehin wieder
// mit der bekannten Demo-Besetzung (s. project.js#newProject).
await openApp(page, baseUrlFromArgv());
await page.locator('.rack-row', { hasText: 'BeatBox' }).click();
await page.waitForSelector('.machine-focus:not([hidden])');
await page.waitForTimeout(300);

const drumCell = page.locator('.machine-focus:not([hidden]) .cell.is-on').first();
check('BeatBox hat mindestens einen aktiven Demo-Step', (await drumCell.count()) === 1);
await drumCell.scrollIntoViewIfNeeded();
await holdCell(drumCell, 600);
check('Halten auf einem aktiven Drum-Step öffnet ein Popup', (await page.locator('.pitch-picker').count()) === 1);
check('Das Drum-Popup zeigt einen Velocity-Balken', (await page.locator('.pitch-picker__vel-bar').count()) === 1);
check('Das Drum-Popup zeigt KEINE Tonhöhen-Auswahl (kein Pitch-Konzept bei Drums)',
  (await page.locator('.pitch-picker__notes').count()) === 0);
check('Das Drum-Popup hat einen Turn-off-Knopf', (await page.locator('[data-stepoff]').count()) === 1);

// ---------- 4) UI: AcidBass bleibt ohne Velocity-Balken (Accent/Slide statt) ----------
// Wieder ein frischer openApp()-Lauf statt Zurück-Navigation -- die Popup-
// Position hängt vom Tap-Punkt ab (unterschiedlich hoch je nach Panel-
// Länge), ein "sicherer" fester Ausserhalb-Koordinatenpunkt liesse sich
// nicht zuverlässig für jedes Panel vorhersagen. AcidBass muss dafür eigens
// zur Maschine hinzugefügt werden (kein Teil der Demo-Besetzung).
await openApp(page, baseUrlFromArgv());
await page.click('.rack__add');
await page.waitForSelector('.sheet__item');
await page.locator('.sheet__item', { hasText: 'AcidBass' }).first().click();
await page.waitForTimeout(300);
await page.waitForSelector('.machine-focus:not([hidden])');
await page.waitForTimeout(300);

const acidGrid = page.locator('.machine-focus:not([hidden]) .stepseq__grid .cell').first();
await acidGrid.scrollIntoViewIfNeeded();
await acidGrid.click(); // Step einschalten (Default-Tonhöhe)
await page.waitForTimeout(150);
// AcidBass-Zellen sind höher (68px, s. .stepseq--accent-slide .cell) und
// dreigeteilt (Label oben, Accent-/Slide-Streifen unten je 13px, s.
// components.css) -- die exakte Zellmitte liegt zu nah an dieser Grenze,
// deshalb bewusst höher (30% von oben, sicher im Label-Bereich) statt
// holdCell()s Mitte antippen (sonst landet der Tap im Accent-Streifen und
// das Halten wird als Accent-Toggle statt als Pitch-Picker-Öffnung gewertet).
const acidBox = await acidGrid.boundingBox();
const acidX = acidBox.x + acidBox.width / 2, acidY = acidBox.y + acidBox.height * 0.3;
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: acidX, y: acidY, id: 1 }] });
await page.waitForTimeout(600);
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await page.waitForTimeout(100);
check('Halten auf einem aktiven AcidBass-Step öffnet den Pitch-Picker', (await page.locator('.pitch-picker').count()) === 1);
check('AcidBass zeigt KEINEN Velocity-Balken (Accent/Slide ist dort das Dynamik-Konzept)',
  (await page.locator('.pitch-picker__vel-bar').count()) === 0);

check('Keine Seitenfehler', errors.length === 0);
if (errors.length) console.log(errors);

await browser.close();
process.exit(finish());
