/**
 * live-envelope-reanchor.mjs — Regressionstest für die DX7/Operator-nahe
 * Live-Reglernachführung in SubSynth/PolySynth/FMSynth/PsySynth (Chat:
 * "wenn ich die envelope release... kurz auf max stelle und dann wieder
 * auf kurz, klingen trotzdem die vollen 10 sekunden aus" -> Nachfrage "wie
 * ist das denn beim originalen dx7 oder z.b. beim operator in ableton?" ->
 * "es soll ja so nah wie möglich beim original sein... das gilt für alle
 * parameter").
 *
 * Auf echter Hardware/in professionellen Nachbauten liest die Hüllkurve
 * den AKTUELLEN Reglerwert kontinuierlich, nicht nur einmalig beim
 * Anschlag/Loslassen. Vorher: `this.voices` (Halte-Map) verlor eine Stimme
 * SOFORT bei noteOff(), obwohl sie noch hörbar auskling -- Regler-Dreher
 * während der Release-Fahne (oder an einer Sequenzer-Note) erreichten sie
 * nicht mehr. Jetzt: `this.activeVoices` (s. dsp.js#trackVoice) verfolgt
 * JEDE Stimme -- gehalten UND Sequenzer-Fire-and-Forget -- über ihre
 * GESAMTE Hörbarkeitsdauer inkl. Release, Regler-Handler iterieren darüber.
 *
 * Deckt für jede der vier Maschinen ab:
 *  1) Release live: Note mit Release=max auslösen+loslassen, WÄHREND des
 *     Ausklingens Release auf min zurückdrehen -- die Note muss daraufhin
 *     schnell verstummen statt die alten 10s auszuklingen.
 *  2) Attack live: Note mit Attack=max anschlagen, WÄHREND der Rampe
 *     Attack auf min zurückdrehen -- die Stimme muss danach schnell ihr
 *     Ziel erreichen statt die alte lange Rampe fertig zu fahren.
 *  3) Sequenzer-Pfad (playNote): dieselbe Release-Live-Probe wie 1),
 *     aber über eine Fire-and-Forget-Note statt eine gehaltene Keybed-Note.
 *
 * Voraussetzung: ein lokaler Server auf dem Repo-Root, z. B.
 *   python3 -m http.server 8901
 * Dann:  node tools/dsp-tests/live-envelope-reanchor.mjs  [baseUrl]
 */
import { launchBrowser, makeReporter, openApp, baseUrlFromArgv } from './_helpers.mjs';

const { check, finish } = makeReporter();
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await openApp(page, baseUrlFromArgv());

async function addMachine(label) {
  await page.click('.rack__add');
  await page.waitForSelector('.sheet__item');
  await page.locator('.sheet__item', { hasText: label }).first().click();
  await page.waitForTimeout(500);
}

async function measure(machineName, gainField) {
  return page.evaluate(async ({ machineName, gainField }) => {
    const ctx = engine.ctx;
    if (ctx.state === 'suspended') await ctx.resume();
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const machines = song.rack.machines.filter((mm) => mm.constructor.name === machineName);
    const m = machines[machines.length - 1];
    const panel = document.querySelector('.machine-focus:not([hidden])');
    const releaseKnob = panel.querySelector('x-knob[data-p="release"]');
    const attackKnob = panel.querySelector('x-knob[data-p="attack"]');
    const setKnob = (el, val) => el.dispatchEvent(new CustomEvent('input', { detail: { value: val }, bubbles: true }));
    // PolySynth speichert pro Root-Note ein ARRAY von Chord-Ton-Stimmen
    // (voiceList) statt eines einzelnen Stimmen-Objekts -- [0] ist immer
    // die Root-Note (offset 0) selbst.
    const gainOf = (v) => (Array.isArray(v) ? v[0] : v)[gainField].gain.value;

    // --- 1) Release live (gehaltene Keybed-Note) ---
    setKnob(releaseKnob, 10);
    m.params.attack = 0.002;
    m.noteOn(60);
    await wait(50);
    const v = m.voices.get(60);
    m.noteOff(60);
    await wait(50);
    const gainSoonAfterRelease = gainOf(v);
    setKnob(releaseKnob, 0.02);
    await wait(300);
    const gainAfterLiveReleaseTurn = gainOf(v);

    // --- 2) Attack live (gehaltene Keybed-Note) ---
    setKnob(attackKnob, 8);
    m.params.release = 1;
    m.noteOn(61);
    await wait(30);
    const gainEarlyInLongAttack = gainOf(m.voices.get(61));
    setKnob(attackKnob, 0.01);
    await wait(150);
    const gainAfterLiveAttackTurn = gainOf(m.voices.get(61));
    m.noteOff(61);
    await wait(1200);

    // --- 3) Sequenzer-Pfad (playNote): Release live während des
    // Ausklingens einer Fire-and-Forget-Note (keine this.voices-Referenz,
    // RMS-Check statt direktem Gain-Peilen). ---
    setKnob(releaseKnob, 10);
    m.playNote(60, ctx.currentTime + 0.01, 0.05, 1);
    await wait(150);
    setKnob(releaseKnob, 0.02);
    await wait(300);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    const mute = ctx.createGain();
    mute.gain.value = 0;
    m.output.connect(analyser).connect(mute).connect(ctx.destination);
    await wait(30);
    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    const rmsAfterSeqLiveRelease = Math.sqrt(buf.reduce((s, x) => s + x * x, 0) / buf.length);
    m.output.disconnect(analyser);
    m.allNotesOff();
    await wait(300);

    return {
      gainSoonAfterRelease, gainAfterLiveReleaseTurn,
      gainEarlyInLongAttack, gainAfterLiveAttackTurn,
      rmsAfterSeqLiveRelease,
    };
  }, { machineName, gainField });
}

const MACHINES = [
  { name: 'SubSynth', label: 'SubSynth', gainField: 'env' },
  { name: 'PolySynth', label: 'PolySynth', gainField: 'env' },
  { name: 'FMSynth', label: 'FM Synth', gainField: 'ampEnv' },
  { name: 'PsySynth', label: 'PsySynth', gainField: 'ampEnv' },
];

for (const [i, { name, label, gainField }] of MACHINES.entries()) {
  if (i > 0) {
    await page.locator('.machine-focus:not([hidden]) .machine-focus__back').click();
    await page.waitForTimeout(150);
  }
  await addMachine(label);
  const r = await measure(name, gainField);

  console.log(`${name}: Gain kurz nach Release-Start (Release=10s):`, r.gainSoonAfterRelease.toFixed(4));
  check(`${name}: Note klingt tatsächlich mit dem 10s-Release, bevor der Regler zurückgedreht wird`, r.gainSoonAfterRelease > 0.03);
  check(`${name}: Release-Regler erreicht eine bereits ausklingende (gehaltene) Note live`, r.gainAfterLiveReleaseTurn < 0.01);

  console.log(`${name}: Attack-Gain früh in 8s-Rampe:`, r.gainEarlyInLongAttack.toFixed(4));
  console.log(`${name}: Attack-Gain nach Live-Zurückdrehen auf 0.01s:`, r.gainAfterLiveAttackTurn.toFixed(4));
  check(`${name}: Attack-Regler erreicht eine noch rampende Note live (deutlicher Sprung Richtung Ziel)`,
    r.gainAfterLiveAttackTurn > r.gainEarlyInLongAttack * 3);

  console.log(`${name}: RMS nach Sequenzer-Note + Live-Release-Zurückdrehen:`, r.rmsAfterSeqLiveRelease.toFixed(4));
  check(`${name}: Release-Regler erreicht auch eine Sequenzer-Fire-and-Forget-Note live`, r.rmsAfterSeqLiveRelease < 0.01);
}

check('Keine Seitenfehler', errors.length === 0);
if (errors.length) console.log(errors);

await browser.close();
process.exit(finish());
