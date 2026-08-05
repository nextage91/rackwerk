/**
 * live-envelope-rapid-drag.mjs — Regressionstest gegen kurze Aussetzer beim
 * SCHNELLEN Ziehen eines Live-Reglers während der Release-Fahne (Bugreport:
 * "beim PsySynth, wenn ich den release regler bewege... klingt eher so als
 * ob die release zeit ganz kurz auf ganz kurz springen würde").
 *
 * Ursache: dsp.js#liveReanchorAttack/liveReanchorDecay planten Automation
 * exakt bei `ctx.currentTime` -- bei VIELEN 'input'-Events pro Sekunde
 * (aktives Reglerziehen) kann das Audio-Rendering diesen Zeitpunkt schon
 * überholt haben, bevor der Befehl den Audio-Thread erreicht; die meisten
 * Browser "schnappen" die Kurve dann auf den Zielwert statt sie glatt
 * weiterzuführen -- ein winziger, aber hörbarer Lautstärke-Einbruch pro
 * betroffenem Event. Fix: Automation mit kleinem Sicherheitsvorlauf planen
 * (`t + LIVE_SCHED_LOOKAHEAD_S`, s. dsp.js).
 *
 * Diese Race ist an sich nicht 100% deterministisch reproduzierbar (hängt
 * von Timing zwischen Haupt- und Audio-Thread ab) -- dieser Test prüft
 * deshalb, was ZUVERLÄSSIG prüfbar ist: dass sehr schnelles, wiederholtes
 * Reglerziehen während einer aktiven Release-Fahne (a) keine Exceptions/NaN
 * erzeugt, (b) die Gain-Kurve monoton fällt (nie unerwartet wieder steigt --
 * ein Wiederanstieg wäre ein klarer struktureller Fehler, unabhängig von der
 * eigentlichen Timing-Race) und (c) die Note am Ende trotzdem sauber bei
 * ~0 ankommt.
 *
 * Voraussetzung: ein lokaler Server auf dem Repo-Root, z. B.
 *   python3 -m http.server 8901
 * Dann:  node tools/dsp-tests/live-envelope-rapid-drag.mjs  [baseUrl]
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

async function rapidDragDuringRelease(machineName, gainField) {
  return page.evaluate(async ({ machineName, gainField }) => {
    const ctx = engine.ctx;
    if (ctx.state === 'suspended') await ctx.resume();
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const machines = song.rack.machines.filter((mm) => mm.constructor.name === machineName);
    const m = machines[machines.length - 1];
    const panel = document.querySelector('.machine-focus:not([hidden])');
    const releaseKnob = panel.querySelector('x-knob[data-p="release"]');
    const setKnob = (val) => releaseKnob.dispatchEvent(new CustomEvent('input', { detail: { value: val }, bubbles: true }));
    const gainOf = (v) => (Array.isArray(v) ? v[0] : v)[gainField].gain.value;

    setKnob(6);
    m.params.attack = 0.002;
    m.noteOn(60);
    await wait(50);
    const v = m.voices.get(60);
    m.noteOff(60); // Release-Fahne beginnt

    // Simuliert ein aggressives Reglerziehen: ~80 'input'-Events über
    // ~400ms, mit realistisch schwankenden Werten (ein Finger überschiesst
    // beim Ziehen oft leicht, statt streng monoton zu bewegen), WÄHREND die
    // Note aktiv ausklingt -- genau das Szenario aus dem Bugreport.
    const samples = [];
    const t0 = performance.now();
    let i = 0;
    while (performance.now() - t0 < 400) {
      const jitter = 0.3 + 0.25 * Math.sin(i * 0.7) + 0.1 * Math.sin(i * 2.3);
      setKnob(Math.max(0.02, jitter));
      samples.push(gainOf(v));
      i++;
      await wait(5);
    }
    const sampleCount = i;

    // Regler beruhigen (auf einen kurzen, festen Wert) und Ausklang zu Ende
    // beobachten.
    setKnob(0.05);
    for (let k = 0; k < 20; k++) {
      samples.push(gainOf(v));
      await wait(20);
    }
    const finalGain = gainOf(v);

    // Monotonie: erlaubt eine winzige Toleranz (Fliesskomma-/Lesejitter),
    // aber KEIN echter Wiederanstieg.
    let maxIncrease = 0;
    for (let k = 1; k < samples.length; k++) {
      maxIncrease = Math.max(maxIncrease, samples[k] - samples[k - 1]);
    }
    const anyNaN = samples.some((s) => Number.isNaN(s) || !Number.isFinite(s));

    return { sampleCount, maxIncrease, finalGain, anyNaN };
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
  const r = await rapidDragDuringRelease(name, gainField);

  console.log(`${name}: ${r.sampleCount} Samples während aggressivem Reglerziehen, max. Anstieg zwischen zwei Samples: ${r.maxIncrease.toFixed(5)}, Gain am Ende: ${r.finalGain.toFixed(4)}`);
  check(`${name}: keine NaN/Infinity in der Gain-Kurve`, !r.anyNaN);
  check(`${name}: Gain steigt beim schnellen Reglerziehen NIE wieder an (max. Anstieg <= 0.01)`, r.maxIncrease <= 0.01);
  check(`${name}: Note kommt trotz aggressivem Reglerziehen sauber bei ~0 an`, r.finalGain < 0.01);
}

check('Keine Seitenfehler', errors.length === 0);
if (errors.length) console.log(errors);

await browser.close();
process.exit(finish());
