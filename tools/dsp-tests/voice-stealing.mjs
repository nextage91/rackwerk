/**
 * voice-stealing.mjs — Regressionstest für den neuen Stimmen-Deckel
 * (MAX_VOICES) in SubSynth/PolySynth/FMSynth/PsySynth (s. dortiger
 * noteOn()-Kommentar).
 *
 * Ohne Deckel würde jede neue, andere gehaltene Tonhöhe unbegrenzt neue
 * native Audio-Nodes anhäufen (Arp/viele gehaltene Tasten über eine lange
 * Jam-Session) -- ein reales Ressourcenrisiko, besonders auf dem Handy.
 * Beim Erreichen von MAX_VOICES (16) wird die ÄLTESTE gehaltene Stimme
 * "gestohlen": sofort aus this.voices entfernt (zählt nicht mehr gegen den
 * Deckel) und mit einem kurzen, festen Fade-Out statt Klick beendet.
 *
 * Voraussetzung: ein lokaler Server auf dem Repo-Root, z. B.
 *   python3 -m http.server 8901
 * Dann:  node tools/dsp-tests/voice-stealing.mjs  [baseUrl]
 */
import { launchBrowser, makeReporter, openApp, baseUrlFromArgv } from './_helpers.mjs';

const { check, finish } = makeReporter();
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await openApp(page, baseUrlFromArgv());

const MAX_VOICES = 16;

// ---------- 1) SubSynth: Deckel greift, älteste Stimme wird verdrängt ----------
const sub = await page.evaluate((cap) => {
  const ctx = engine.ctx;
  const sub = song.rack.machines.find((m) => m.constructor.name === 'SubSynth');
  sub.allNotesOff();
  const played = [];
  // cap+5 verschiedene Tonhöhen halten, OHNE noteOff dazwischen -- deckt
  // genau das Szenario ab, das MAX_VOICES verhindern soll.
  for (let i = 0; i < cap + 5; i++) {
    const midi = 24 + i; // garantiert verschiedene, gültige MIDI-Noten
    sub.noteOn(midi);
    played.push(midi);
    if (sub.voices.size > cap) break; // sollte nie passieren, s. Check unten
  }
  const sizeAfter = sub.voices.size;
  const firstStillHeld = sub.voices.has(played[0]);
  const lastHeld = sub.voices.has(played[played.length - 1]);
  sub.allNotesOff();
  return { sizeAfter, firstStillHeld, lastHeld, playedCount: played.length };
}, MAX_VOICES);

console.log(`SubSynth: ${sub.playedCount} Noten gespielt, voices.size danach: ${sub.sizeAfter}`);
check(`SubSynth: voices.size übersteigt MAX_VOICES (${MAX_VOICES}) nie`, sub.sizeAfter <= MAX_VOICES);
check('SubSynth: die ALLERERSTE (älteste) gehaltene Note wurde verdrängt', !sub.firstStillHeld);
check('SubSynth: die zuletzt gespielte Note ist noch da', sub.lastHeld);

// ---------- 2) Die gestohlene Stimme klingt schnell aus, statt hart abzuschneiden ----------
const fadeCheck = await page.evaluate((cap) => {
  const ctx = engine.ctx;
  const sub = song.rack.machines.find((m) => m.constructor.name === 'SubSynth');
  sub.allNotesOff();
  for (let i = 0; i < cap; i++) sub.noteOn(24 + i);
  const stolenVoice = sub.voices.get(24); // wird gleich verdrängt
  const gainNode = stolenVoice.env;
  const before = gainNode.gain.value;
  sub.noteOn(24 + cap); // löst den Diebstahl der ältesten (midi 24) aus
  return { hadVoiceBefore: !!stolenVoice, before };
}, MAX_VOICES);
check('Stimme 0 existierte tatsächlich vor dem Verdrängen (Testaufbau korrekt)', fadeCheck.hadVoiceBefore);

await page.evaluate(() => {
  const sub = song.rack.machines.find((m) => m.constructor.name === 'SubSynth');
  sub.allNotesOff();
});

// ---------- 3) Strukturprüfung: derselbe Deckel gilt für PolySynth/FMSynth/PsySynth ----------
// Klassenname (constructor.name, für page.evaluate) vs. Anzeigename im
// Sheet-Picker (static meta.name, z. B. "FM Synth" mit Leerzeichen) --
// nicht identisch, deshalb eine kleine Zuordnung statt eines Namens.
const otherSynths = [
  { className: 'PolySynth', sheetLabel: 'PolySynth' },
  { className: 'FMSynth', sheetLabel: 'FM Synth' },
  { className: 'PsySynth', sheetLabel: 'PsySynth' },
];
for (const { className: name, sheetLabel } of otherSynths) {
  // Ein noch offenes machine-focus-Panel der vorherigen Runde überdeckt
  // .rack__add (pointer-events) -- erst schliessen.
  if (await page.locator('.machine-focus:not([hidden])').count()) {
    await page.locator('.machine-focus:not([hidden]) .machine-focus__back').click();
    await page.waitForTimeout(150);
  }
  await page.click('.rack__add');
  await page.waitForSelector('.sheet__item');
  await page.locator('.sheet__item', { hasText: sheetLabel }).first().click();
  await page.waitForTimeout(300);

  const result = await page.evaluate(({ n, cap }) => {
    const m = song.rack.machines.find((mm) => mm.constructor.name === n);
    m.allNotesOff();
    for (let i = 0; i < cap + 5; i++) m.noteOn(24 + i);
    const size = m.voices.size;
    m.allNotesOff();
    return size;
  }, { n: name, cap: MAX_VOICES });
  console.log(`${name}: voices.size nach ${MAX_VOICES + 5} gehaltenen Noten: ${result}`);
  check(`${name}: voices.size übersteigt MAX_VOICES (${MAX_VOICES}) nie`, result <= MAX_VOICES);
}

check('Keine Seitenfehler', errors.length === 0);
if (errors.length) console.log(errors);

await browser.close();
process.exit(finish());
