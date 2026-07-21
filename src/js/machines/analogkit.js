/**
 * AnalogKit — 11-Spur-Drum-Machine im 909-Stil (synthetisiert, keine
 * Samples). Gleiche Architektur wie die BeatBox (Pads + gemeinsames Grid,
 * Tune/Decay/Level/Sends pro Spur — beide erben von TrackedDrumMachine),
 * aber ein eigener Klangcharakter:
 *
 * - BD/SD/Toms: kürzere, knackigere Hüllkurven als die BeatBox, SD mit
 *   Doppel-Ton-Body (zwei leicht verstimmte Oszillatoren, je eigener
 *   Decay) statt einem gemeinsamen. BD zusätzlich durch ein leicht
 *   resonantes Tiefpassfilter (das "Boing" einer echten VCF) plus eine
 *   sanfte Sättigungsstufe (Waveshaper) für den Punch, SD-Body ebenso
 *   leicht angesättigt statt komplett sauber.
 * - CH/OH/CC/RC: 6 verstimmte Oszillatoren durchs Hochpass/Bandpass für
 *   den metallischen Grundklang, plus eine hochpassgefilterte Rausch-
 *   schicht darunter für die Dichte, die das echte 909-PCM-Cymbal-Sample
 *   hat (ein reines Oszillatorbündel klingt sonst zu "sauber"/808-artig).
 *   Die 6 Oszillatoren pro Stimme laufen dabei KONTINUIERLICH (s.
 *   #buildAudio) statt bei jedem Anschlag frisch bei Phase 0 zu starten
 *   — wie beim echten 909, wo Trigger nur ein VCA-Gate auf dem gerade
 *   aktuellen (frei driftenden) Phasenverhältnis öffnen. Das ist der
 *   eigentliche Grund, warum zwei Anschläge derselben Hi-Hat am echten
 *   Gerät nie identisch klingen — mit frischen Oszillatoren pro Hit
 *   (frühere Version hier) ist jeder Anschlag dagegen bit-identisch, ein
 *   klassischer "das ist Software"-Verräter.
 * - Jede Spur bekommt zusätzlich eine winzige, zufällige Tonhöhen-/Pegel-
 *   Abweichung pro Anschlag (Bauteiltoleranz-Simulation, s. jitter()) —
 *   ohne das klingt jeder Hit exakt gleich laut/hoch, was sich digital/
 *   "einprogrammiert" statt analog/lebendig anfühlt.
 *
 * Kit: BD (Bass Drum), SD (Snare), LT/MT/HT (Toms), RS (Rim Shot),
 * CP (Clap), CH/OH (Hi-Hats), CC/RC (Cymbals).
 */
import { TrackedDrumMachine } from './tracked-drum-machine.js';
import { engine } from '../core/audio-engine.js';
import { noise, lfsrNoise, env, autoStop } from '../core/dsp.js';

/** Zufällige, kleine relative Abweichung (±pct) — Bauteiltoleranz-Analogie:
 *  zwei Anschläge derselben Stimme sind nie exakt gleich hoch/laut. */
const jitter = (base, pct) => base * (1 + (Math.random() * 2 - 1) * pct);

/** Zufälliger Start-Offset in den gecachten 1s-Rauschbuffer (s. dsp.js#noise)
 *  -- ohne das spielt jeder Anschlag denselben Rauschausschnitt (deterministisch
 *  per Design für BeatBox & co., s. dort), was bei percussiven Analog-Sounds
 *  wie Snare-Rattle/Rimshot/Clap unnatürlich identisch klingt. `maxDur` ist
 *  die längste hier genutzte Klangdauer -- lässt genug Buffer übrig. */
const noiseOffset = (maxDur = 0.3) => Math.random() * (1 - maxDur);

/** Sanfte Tanh-Sättigung für Kick-/Snare-Body — der "Punch", den ein
 *  cleaner Oszillator+Hüllkurve-Pfad allein nicht hat (reale 909-VCAs
 *  clippen leicht bei den lauten Trommeln). Fest verdrahtete, moderate
 *  Stärke statt eines Reglers -- das ist Teil des Stimmcharakters, kein
 *  Nutzerparameter (dafür gibt es die Drive-Insert-FX). */
function makeSatCurve(amount) {
  const n = 512;
  const curve = new Float32Array(n);
  const k = 1 + amount * 8;
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    // (n - 1), NICHT n: WaveShaperNode rechnet einen Eingabewert x intern
    // auf virtual_index = (x+1)*(N-1)/2 um (N = Tabellenlänge), nicht auf
    // (x+1)*N/2. Mit `n` statt `n - 1` hier landet x=0 NICHT auf dem
    // Index, den der Knoten tatsächlich für x=0 abfragt -- die Kurve war
    // an dieser Stelle um einen Sample-Schritt verschoben, wodurch echte
    // Stille (Eingang 0) NICHT auf Ausgang 0 abgebildet wurde, sondern auf
    // einen kleinen, aber hörbaren DC-Versatz (~-0.007). Solange der davor
    // liegende GainNode noch auf seinem Default-Wert 1.0 steht (vor der
    // ersten geplanten Automation, s. env() in dsp.js), lief dieser
    // Versatz ungedämpft durch -- ein kurzes, helles "Klicken" beim
    // Scheduling jedes Hits, bevor die eigentliche Hüllkurve einsetzt.
    const x = (i * 2) / (n - 1) - 1;
    curve[i] = Math.tanh(k * x) / norm;
  }
  return curve;
}
let _satCurveWarm = null, _satCurveHot = null;
const satCurveWarm = () => (_satCurveWarm ??= makeSatCurve(0.35));
const satCurveHot = () => (_satCurveHot ??= makeSatCurve(0.6));

/* ================= Drum-Synthese ================= */

/* Jede Drum: (ctx, t, dest, {tune, decay, level}) */

function bd(ctx, t, dest, p) {
  // Kurze, knackige Pitch-Hüllkurve — startet höher/fällt schneller als
  // die BeatBox-Kick, weniger Sub-Betonung, mehr "Klack" im Attack.
  // ±1.5% Tonhöhen-Jitter pro Anschlag (Bauteiltoleranz) -- ohne das
  // klingt jeder Kick exakt gleich, was digital/programmiert wirkt.
  const f0 = jitter(Math.max(80, 200 * p.tune), 0.015);
  const f1 = jitter(Math.max(35, 58 * p.tune), 0.015);
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(f1, t + 0.045);

  // Leicht resonantes Tiefpassfilter statt eines direkten Oszillator→VCA-
  // Pfads: das echte 909-Kick-VCF "boingt" hörbar mit, statt den Sinus
  // unverändert durchzureichen -- reiner Sinus+Hüllkurve klingt sonst zu
  // rund/synthetisch. Sättigung danach für den Punch (moderate 909-VCA-
  // Übersteuerung bei lauten Trommeln).
  const lpf = ctx.createBiquadFilter();
  lpf.type = 'lowpass';
  lpf.frequency.setValueAtTime(f0 * 1.4, t);
  lpf.frequency.exponentialRampToValueAtTime(f1 * 1.8, t + 0.05);
  lpf.Q.value = 2.2;
  const sat = ctx.createWaveShaper();
  sat.curve = satCurveWarm();
  const g = env(ctx, t, jitter(1.0 * p.level, 0.05), 0.35 * p.decay);
  o.connect(lpf).connect(sat).connect(g).connect(dest);
  autoStop(o, t, 0.35 * p.decay, [lpf, sat, g]);

  // Attack-Klick: beim echten 909 kein Ton, sondern ein sehr kurzer,
  // tiefpassgefilterter Rauschimpuls aus einer eigenen Klick-Schaltung
  // (separater Rauschgenerator + Filter, mischt sich vor der VCA-Hüllkurve
  // zum Sinus-Body dazu). Ein reiner Ton an dieser Stelle (die vorherige
  // Version) klingt wie eine Clave statt wie ein Attack-Transient.
  const snap = p.snap ?? 0.5;
  if (snap > 0.01) {
    const n = ctx.createBufferSource();
    n.buffer = noise(ctx);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3800 * p.tune;
    const cg = env(ctx, t, jitter(snap * p.level * 1.6, 0.05), 0.004);
    n.connect(lp).connect(cg).connect(dest);
    autoStop(n, t, 0.004, [lp, cg], noiseOffset(0.01));
  }
}

function sd(ctx, t, dest, p) {
  // Doppel-Ton-Body (zwei Dreieckwellen) — der charakteristische 909-Snare-
  // "Ping". Beim Original bekommt jeder Oszillator eine EIGENE Hüllkurve,
  // und der tiefere Ton (mehr "Fell") klingt spürbar länger nach als der
  // höhere ("Ping") — nicht ein gemeinsamer Bus mit einer Hüllkurve.
  //
  // Pegel-Balance (gemessen per gleitendem 50ms-RMS-Fenster gegen BD): SD
  // lag ~10dB unter der Kick — hörbar zu leise im Kit. Body-/Rausch-Dauern
  // etwas gestreckt (mehr wahrgenommene Lautheit ohne den Attack-Peak zu
  // erhöhen, da env() unabhängig von der Dauer denselben Spitzenwert hat)
  // plus moderater Pegel-Nachschlag — SD hat wenig Peak-Headroom (mehrere
  // gleichzeitig einsetzende Schichten), daher hier bewusst zurückhaltender
  // als bei den anderen leisen Stimmen unten.
  // ±1% Tonhöhen-, ±5% Pegel-Jitter pro Anschlag (wie BD) plus eine
  // sanfte Sättigung auf jedem Ton-Body -- ein cleaner Dreieck-Mix klingt
  // sonst zu synthetisch/steril für den 909-"Ping". Eigene Sättigungs-
  // Node je Oszillator (nicht geteilt): die beiden Töne klingen
  // unterschiedlich lang nach (durMul 1.0 vs. 0.6) -- ein gemeinsamer
  // Knoten würde beim früheren autoStop() des kürzeren Tons auch den
  // noch klingenden längeren mit abklemmen.
  for (const { f, durMul, mix } of [{ f: 180, durMul: 1.0, mix: 0.38 }, { f: 330, durMul: 0.6, mix: 0.28 }]) {
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = jitter(f * p.tune, 0.01);
    const dur = 0.17 * p.decay * durMul;
    const sat = ctx.createWaveShaper();
    sat.curve = satCurveWarm();
    const g = env(ctx, t, jitter(mix * p.level, 0.05), dur);
    o.connect(sat).connect(g).connect(dest);
    autoStop(o, t, dur, [sat, g]);
  }

  // "Snare-Kabel"-Rauschen: beim Original zwei PARALLELE Pfade (Tiefpass +
  // Hochpass), je eigene Hüllkurve, statt eines einzelnen Bandpasses — der
  // Tiefpass-Anteil gibt den dumpferen Rattle-Körper, der Hochpass-Anteil
  // das helle Zischen im Attack. Beide aus dem LFSR-Rauschen (s. dsp.js) —
  // die echte 909-Snare nutzt ein 31-stufiges Schieberegister statt echtem
  // Zufall als Rauschquelle, das ist hörbar "körniger" als Math.random().
  // Pegel-Koeffizient gegenüber dem alten Math.random()-Wert (0.46) leicht
  // gesenkt (0.37): SD summiert hier VIER unabhängig peakende Schichten
  // (2 Ton-Bodies + 2 Rauschpfade) direkt auf `dest`. Über 40 Durchläufe
  // gemessen (test-analogkit-sd-scan.mjs): schon VOR dem LFSR-Wechsel
  // überschritt SD bei Koeffizient 0.46 in 28/40 Fällen Peak 1.0 (bis
  // 1.203) -- das war also kein neues Problem, nur bisher nie mit
  // mehreren Durchläufen geprüft. Bei 0.37 bleibt der Peak zuverlässig
  // unter 1.0, bei vergleichbarem Pegel zu BD wie vorher.
  const nLow = ctx.createBufferSource();
  nLow.buffer = lfsrNoise(ctx);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 1100 * p.tune;
  const lpg = env(ctx, t, jitter(0.37 * p.level, 0.05), 0.2 * p.decay);
  nLow.connect(lp).connect(lpg).connect(dest);
  autoStop(nLow, t, 0.2 * p.decay, [lp, lpg], noiseOffset());

  const nHigh = ctx.createBufferSource();
  nHigh.buffer = lfsrNoise(ctx);
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 3500 * p.tune;
  const hpg = env(ctx, t, jitter(0.37 * p.level, 0.05), 0.1 * p.decay);
  nHigh.connect(hp).connect(hpg).connect(dest);
  autoStop(nHigh, t, 0.1 * p.decay, [hp, hpg], noiseOffset());
}

function rs(ctx, t, dest, p) {
  // Rim Shot: das Original regt mit einem kurzen Trigger-Impuls drei
  // parallele, unterschiedlich gestimmte Resonanzfilter an (Bridged-T-
  // Filter, je ein eigener Kondensatorwert), die über eine einfache VCA
  // summiert werden — kein Ton, der durch EIN Filter läuft, sondern drei
  // gleichzeitig "angeschlagene" Resonanzen. Das ergibt den mehrschichtigen
  // Klack statt eines einzelnen Buzz-Tons.
  const RS_RESONANCES = [520, 1200, 2400];
  // Etwas länger als das "reine" 909-Original klingen lassen (0.02 → 0.08s
  // Basisdauer) — kostet keinen zusätzlichen Peak (env() erreicht denselben
  // Spitzenwert unabhängig von der Ausklingzeit), gibt dem Rimshot im Kit
  // aber spürbar mehr wahrgenommene Lautheit/Präsenz gegen die Kick.
  const dur = 0.08 * p.decay;
  const n = ctx.createBufferSource();
  n.buffer = noise(ctx);
  const nodes = [];
  // Makeup-Gain: ein enges Bandpass lässt von breitbandigem Rauschen nur
  // einen schmalen Frequenzausschnitt durch (anders als vorher, wo ein
  // Oszillator exakt auf der Resonanz sass) — ohne Kompensation war der
  // Rimshot fast unhörbar leise. Q hier bewusst von 12 auf 6 gesenkt: bei
  // reinem Rauschen als Anregung (statt eines exakt getroffenen Tons)
  // erzeugt ein sehr enges Filter je nach Zufalls-Buffer teils extreme
  // Ausreisser (gemessen über 40 unabhängige Rausch-Seeds bei Q=12: Peak
  // schwankte zwischen 0.95 und 1.78 bei GLEICHEM Gain!). Q=6 dämpft diese
  // Streuung; Gain=3 hält selbst den schlechtesten von 40 gemessenen Fällen
  // sicher unter der etablierten Kick-Referenzobergrenze (~1.2).
  for (const f of RS_RESONANCES) {
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = jitter(f * p.tune, 0.02);
    bp.Q.value = 6;
    const g = env(ctx, t, jitter(3 * p.level, 0.05), dur);
    n.connect(bp).connect(g).connect(dest);
    nodes.push(bp, g);
  }
  autoStop(n, t, dur, nodes, noiseOffset());
}

function cp(ctx, t, dest, p) {
  // 4 schnelle Retrigger statt 3 (BeatBox) — etwas dichter/heller gefiltert.
  // Pegel-Balance: die Retrigger-Peaks sassen im gemessenen Kit weit unten
  // (Peak nur ~0.26 bei level=0.9, viel Headroom übrig) — Nachschlag ~3x,
  // damit der Clap im Kit nicht untergeht.
  const n = ctx.createBufferSource();
  n.buffer = noise(ctx);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = jitter(1300 * p.tune, 0.02);
  bp.Q.value = 1.8;

  const g = ctx.createGain();
  const dur = 0.044 + 0.22 * p.decay;
  for (let i = 0; i < 4; i++) {
    g.gain.setValueAtTime(jitter(2.55 * p.level, 0.06), t + i * 0.011);
    g.gain.linearRampToValueAtTime(0.6 * p.level, t + i * 0.011 + 0.008);
  }
  g.gain.setValueAtTime(jitter(1.95 * p.level, 0.06), t + 0.044);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  // Wie env() (s. dsp.js) -- exponentialRamp erreicht nie echte 0, und
  // autoStop() stoppt erst 50ms nach `dur`. Ohne diesen letzten linearen
  // Schritt auf 0 GENAU in diesem Fenster bliebe die Gain bis zum harten
  // stop() bei 0.001 stehen -- hörbar als leises Klicken am Ende.
  g.gain.linearRampToValueAtTime(0, t + dur + 0.05);

  n.connect(bp).connect(g).connect(dest);
  autoStop(n, t, dur, [bp, g], noiseOffset());
}

/** Tom-Stimme: startet leicht über der Zielfrequenz, fällt schnell darauf. */
const tomVoice = (baseFreq) => (ctx, t, dest, p) => {
  const o = ctx.createOscillator();
  o.type = 'sine';
  const f = jitter(baseFreq * p.tune, 0.012);
  o.frequency.setValueAtTime(f * 1.3, t);
  o.frequency.exponentialRampToValueAtTime(f, t + 0.08);
  const g = env(ctx, t, jitter(0.85 * p.level, 0.05), 0.28 * p.decay);
  o.connect(g).connect(dest);
  autoStop(o, t, 0.28 * p.decay, [g]);
};

/* ---------- Metallische Hats/Cymbals: 6 unharmonisch verstimmte
   Rechteckwellen durch ein Hoch-/Bandpass — die klassische analoge
   Cymbal-Synthese-Technik (statt gefiltertem Rauschen wie bei der
   BeatBox). Die Verhältnisse sind bewusst nicht-ganzzahlig, damit die
   Summe unharmonisch/metallisch statt tonal klingt.
   Die 6 Oszillatoren pro Stimme sind FREI LAUFEND statt pro Anschlag neu
   erzeugt (s. AnalogKit#buildAudio, das sie einmalig anlegt und in
   tr.metalOscs/tr.metalBus ablegt): am echten 909 laufen diese
   Oszillatoren kontinuierlich, ein Trigger öffnet nur ein VCA-Gate auf
   dem gerade aktuellen (frei driftenden) Phasenverhältnis. Frische
   Oszillatoren pro Hit (jeder startet bei Phase 0) klingen dagegen JEDES
   Mal bit-identisch -- der klassische Software-Verräter bei Cymbal-
   Emulationen. ---------- */
// Verhältnisse nach der klassischen 6-Oszillatoren-Referenztechnik für
// analoge Cymbal-/Hi-Hat-Synthese (s. Sound on Sound "Practical Cymbal
// Synthesis", wie sie u.a. auch beim TR-808 verwendet wird): breiterer
// Streubereich (2x bis 8.2x der Basisfrequenz) als die vorherige, enger
// gruppierte Auswahl -- damit landen bei gleichem Hochpass/Bandpass mehr
// Quadratwellen-Obertöne im hörbaren Band, was dichter/metallischer statt
// "gestimmt akkordisch" klingt.
const METAL_RATIOS = [2, 3, 4.16, 5.43, 6.79, 8.21];

// Durch die STIMMENZAHL geteilt, nicht durch Wurzel(Stimmenzahl): die 6
// Oszillatoren laufen jetzt persistent/frei (s. buildAudio/metallic oben)
// -- ihre Summe ist damit KEIN einmaliger Anschlag-Moment mehr, sondern
// ein fortlaufendes Signal, das durch die exakten (rationalen) Verhältnisse
// zwangsläufig irgendwann wieder nahezu perfekt phasengleich wird (LCM-
// Periodizität; gemessen: Summenpeak bis 5.7 von theoretisch max. 6, bei
// zufälligem Trigger-Zeitpunkt). Die alte Wurzel(6)-Kompensation ging vom
// EINMALIGEN, immer gleich phasenstarren Anschlag frischer Oszillatoren
// aus (dafür war sie korrekt kalibriert) -- hier muss der SCHLECHTESTE
// Fall (alle 6 phasengleich) sicher im Rahmen bleiben, nicht nur der
// durchschnittliche. `level` in TRACK_DEFS unten ist um Wurzel(6)
// angehoben, um den dadurch leiseren Normalfall wieder auszugleichen.
const METAL_HEADROOM = 1 / METAL_RATIOS.length;
// Zusätzlicher Pegel-Nachschlag (empirisch, gegen BD gemessen): das
// Schließen des Gates VOR dem Anschlag (s. metallic(), Fix fürs Bleed-
// vor-dem-Hit) senkt den gemessenen Pegel gegenüber dem alten Verhalten
// leicht -- gleicht das wieder auf die historisch eingemessenen
// Zielwerte (CH/OH/CC ~13/12/11dB unter BD) aus.
const METAL_MAKEUP = 1.35;

// Kompensiert den strukturellen Hoch-/Bandpass-Verlust der Oszillatorbank
// (s. ausführliche Begründung bei `oscBoost` in metallic() weiter unten) --
// je Stimme einzeln gemessen (Rauschschicht als Referenz verliert am
// selben Filter nur ~0.3dB, egal welche Stimme):
//   CH (8000Hz Hochpass): -9.0dB   OH (6500Hz Hochpass): -8.0dB
//   CC (5000Hz Hochpass): -7.7dB   RC (4000Hz Bandpass): -6.8dB
// Boost = ca. 75% des gemessenen Verlusts (nicht 100%: der Rest bleibt
// bewusst Kopfraum/Streuung -- ein voller 1:1-Ausgleich würde die
// Oszillatorbank in den durchschnittlichen Fällen zu dominant über die
// Rauschschicht heben, die dem Klang bewusst Dichte gibt).
const CH_OSC_BOOST = 2.2;
const OH_OSC_BOOST = 2.0;
const CC_OSC_BOOST = 1.95;
const RC_OSC_BOOST = 1.8;

function metallic(ctx, t, dest, { tr, dur, level, oscBoost = 1 }) {
  // Live nach dem aktuellen TUNE-Regler nachführen -- hörbar erst beim
  // NÄCHSTEN Anschlag (zwischen Hits ist das Gate zu, eine Frequenz-
  // änderung am laufenden, aber stummen Oszillator ist unhörbar).
  for (let i = 0; i < tr.metalOscs.length; i++) {
    tr.metalOscs[i].frequency.setValueAtTime(
      jitter(tr.metalFreq * METAL_RATIOS[i] * tr.metalDetunes[i] * tr.tune, 0.004), t,
    );
  }
  // tr.metalFilt ist PERSISTENT (s. AnalogKit#buildAudio) -- Typ/Frequenz/Q
  // sind pro Spur fest verdrahtet und ändern sich nie pro Anschlag, es gab
  // also keinen Grund, hier bei JEDEM Hit einen frischen BiquadFilterNode
  // anzulegen. Das war zusätzlich zur reinen Verschwendung auch eine
  // eigene Fehlerquelle: nur DIESER pro-Hit-erzeugte Filter (anders als
  // z.B. die Rauschschicht unten, die eine eigene, natürlich bei `t`
  // startende Quelle hat) musste jedes Mal frisch an den durchgehend
  // laufenden metalBus an- UND wieder abgeklemmt werden -- ein Vorgang mit
  // eigenem Zeitfenster, in dem etwas schiefgehen kann. Mit dem
  // persistenten Filter bleibt pro Anschlag nur noch EIN neuer Knoten (die
  // Hüllkurve `g`) übrig -- strukturell so einfach wie bei jeder anderen
  // Stimme in dieser Datei.
  // oscBoost gleicht einen strukturellen Pegelverlust aus: alle 6
  // Rechteckwellen-Grundtöne (2x bis 8.21x der Basisfrequenz, s.
  // METAL_RATIOS) liegen UNTER dem Hoch-/Bandpass jeder Stimme -- nur
  // ihre (bei Rechteckwellen mit 1/n abfallenden) Obertöne oberhalb des
  // Cutoffs überleben. Gemessen: die Oszillatorbank verliert dadurch
  // 6.8-9.0dB (je nach Stimme), während die parallele Breitband-
  // Rauschschicht am selben Filter nur ~0.3dB verliert (Rauschen hat
  // schon von Natur aus Energie im ganzen Spektrum, keine tiefen
  // Grundtöne, die erst wegfallen könnten). Ohne diesen Ausgleich ist
  // die Rauschschicht nach dem Filter TROTZ niedrigerem Nominalpegel
  // (s. `* 0.45` unten) real lauter als die Oszillatorbank -- zusammen
  // mit der ohnehin gewollten Anschlag-zu-Anschlag-Variation (s.
  // METAL_RATIOS-Kommentar oben) kippt die Oszillatorbank dadurch bei
  // manchen Anschlägen komplett unter die Rauschschicht: der Hit klingt
  // dann nur noch nach Rauschen statt nach Metall/Ton.
  const g = env(ctx, t, jitter(level * METAL_HEADROOM * oscBoost, 0.05), dur);
  // Der Bus liefert (anders als bei allen anderen Stimmen) schon VOR
  // diesem Anschlag durchgehend Signal (persistente Oszillatoren) -- ein
  // frischer GainNode steht bis zu seinem ERSTEN geplanten Automations-
  // Wert per Spec auf dem Default 1.0, nicht auf 0! Ohne diese explizite
  // Schließung liefe das rohe Summensignal für das gesamte Lookahead-
  // Fenster (Aufruf-Zeitpunkt bis t) ungedämpft durch -- hörbar als
  // Vorecho/Bleed vor jedem Anschlag.
  //
  // ABSOLUTE Zeit 0 hier, NICHT ctx.currentTime: `t` kann je nach
  // Aufrufer beliebig knapp in der Zukunft liegen (Pad-Press: nur bis zu
  // 128 Samples/~2.7ms Vorlauf durch quantizeTime, s. audio-engine.js --
  // der Sequencer-Scheduler dagegen plant mit 100ms Vorlauf, s.
  // SCHEDULE_AHEAD in transport.js). Mit ctx.currentTime lief hier ein
  // echtes Wettrennen: reichten die paar ms Vorlauf beim Pad-Press nicht
  // (JS-Overhead, GC-Pause, langsames Gerät), landete diese Zeile NACH
  // `t` -- die Automations-Warteschlange ist zeit-, nicht aufruf-
  // reihenfolge-sortiert, das Gate ging dann NACH dem Envelope-Peak
  // wieder zu statt davor und schnitt den Oszillatorbank-Layer fast
  // komplett weg. Das allein war ein echter, seltener werdender Bug,
  // aber NICHT die Hauptursache für "klingt beim Antippen deutlich
  // rauschiger/inkonsistenter als im Sequencer" -- die eigentliche
  // Hauptursache war der oben dokumentierte strukturelle Filterverlust
  // (oscBoost). Beides zusammen ergab das gemeldete
  // Symptom). Zeit 0 liegt garantiert vor jedem echten `t` > 0, egal wie
  // viel JS-Zeit zwischen dem Berechnen von `t` und dieser Zeile vergeht.
  g.gain.setValueAtTime(0, 0);
  tr.metalFilt.connect(g).connect(dest);
  // Kein autoStop() -- der Bus (und jetzt auch der Filter) laufen weiter
  // (persistente Oszillatoren), nur der Gate-Zweig dieses EINEN Anschlags
  // wird nach Ablauf der Hüllkurve wieder abgeklemmt. Dafür EXTRA einen
  // stummen ConstantSourceNode als reinen Zeitgeber -- NICHT setTimeout():
  // das läuft an der JS-Wall-Clock, nicht an der Audio-Uhr, und kann bei
  // vielbeschäftigtem Hauptthread (schnelles Antippen erzeugt viele
  // Pointer-Events + DOM-Updates durch #selectTrack) beliebig spät
  // feuern. Ein per start()/stop() audio-uhr-genau geplanter Knoten
  // (wie autoStop() es für echte Klangquellen schon tut, s. dsp.js)
  // feuert sein onended dagegen exakt zur Audio-Zeit, unabhängig davon,
  // wie beschäftigt der Haupt-Thread gerade ist.
  const cleanupTimer = ctx.createConstantSource();
  cleanupTimer.start(t);
  cleanupTimer.stop(t + dur + 0.05);
  cleanupTimer.onended = () => {
    try { tr.metalFilt.disconnect(g); } catch { /* Maschine evtl. schon disposed */ }
    g.disconnect(dest);
    cleanupTimer.disconnect();
  };

  // Das Original nutzt für Hats/Cymbals kein Oszillatorbündel, sondern ein
  // komprimiertes 6-Bit-PCM-Sample eines echten Beckens (per VCA/Filter
  // geformt) — im Spektrum deutlich dichter/"kratziger", als 6 diskrete
  // Rechteckwellen je erreichen (die klingen eher nach einem gestimmten
  // Akkord, "808-artig"). Eine hochpassgefilterte Rauschschicht unter dem
  // Oszillatorbündel nähert diese Dichte an, ohne selbst ein Sample zu sein.
  const n = ctx.createBufferSource();
  n.buffer = noise(ctx);
  const nf = ctx.createBiquadFilter();
  nf.type = 'highpass';
  nf.frequency.value = Math.max(tr.metalFilt.frequency.value * 0.5, 2000);
  const ng = env(ctx, t, jitter(level * METAL_HEADROOM * 0.45, 0.05), dur);
  n.connect(nf).connect(ng).connect(dest);
  autoStop(n, t, dur, [nf, ng], noiseOffset());
}

/** Hi-Hat/Crash-Stimme: feste Klangfarbe, Tune/Decay/Level wirken wie bei
 *  den übrigen Spuren. `freq`/`filterFreq`/`filterType`/`filterQ` stehen
 *  zusätzlich auf der zurückgegebenen Funktion (wie schon `.metalFreq`),
 *  damit AnalogKit#buildAudio weiss, mit welcher Basisfrequenz und
 *  welchem Filter es den persistenten Oszillatoren-Bus/Filter dieser
 *  Spur anlegen muss (einzige Quelle der Wahrheit, keine doppelt
 *  gepflegte Zahl in TRACK_DEFS). */
const metallicVoice = ({ freq, filterFreq, filterType, filterQ, durMult, level, oscBoost }) => {
  const fn = (ctx, t, dest, p) => metallic(ctx, t, dest, {
    tr: p, dur: durMult * p.decay, level: level * p.level, oscBoost,
  });
  fn.metalFreq = freq;
  fn.filterFreq = filterFreq;
  fn.filterType = filterType;
  fn.filterQ = filterQ;
  return fn;
};

function rc(ctx, t, dest, p) {
  // Ride: schmaleres Bandpass (mehr "Ping"-Charakter als die Crash) plus
  // ein kurzer Sinus-Ping für einen definierten Attack — sonst verwäscht
  // die reine Oszillatorsumme zu einem unklaren Rauschband. Beide Pegel
  // (Metall-Anteil + Ping) moderat angehoben — Ride sass im Kit deutlich
  // zu weit hinten, viel Peak-Headroom war noch übrig.
  metallic(ctx, t, dest, {
    tr: p, dur: 1.0 * p.decay, level: 0.24 * Math.sqrt(6) * METAL_MAKEUP * p.level,
    oscBoost: RC_OSC_BOOST,
  });
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.value = jitter(700 * p.tune, 0.01);
  const g = env(ctx, t, jitter(0.42 * p.level, 0.05), 0.15 * p.decay);
  o.connect(g).connect(dest);
  autoStop(o, t, 0.15 * p.decay, [g]);
}
rc.metalFreq = 350;
rc.filterFreq = 4000;
rc.filterType = 'bandpass';
rc.filterQ = 1.4;

/* ================= Die Maschine ================= */

const TRACK_DEFS = [
  { name: 'BD', synth: bd, snap: 0.5 },
  { name: 'SD', synth: sd },
  { name: 'LT', synth: tomVoice(95) },
  { name: 'MT', synth: tomVoice(140) },
  { name: 'HT', synth: tomVoice(190) },
  { name: 'RS', synth: rs },
  { name: 'CP', synth: cp },
  // Pegel-Balance (gleitendes 50ms-RMS gegen BD gemessen): CH lag ~22dB,
  // OH ~17dB, CC ~13dB unter der Kick — durMult/level hier angehoben
  // (CH zusätzlich etwas länger ausklingend statt reinem Klick, kostet
  // dank env() keinen zusätzlichen Peak), Headroom liess das jeweils zu.
  // level-Werte zusätzlich um Wurzel(6) angehoben, um METAL_HEADROOMs
  // Wechsel von 1/Wurzel(6) auf 1/6 auszugleichen (s. dort), plus
  // METAL_MAKEUP: das Schließen des Gates VOR dem Anschlag (s. metallic(),
  // Fix für das Bleed-vor-dem-Hit) senkt den gemessenen Pegel gegenüber
  // dem alten, unbeabsichtigt "vorglühenden" Verhalten leicht -- Makeup
  // gleicht das wieder auf die historisch eingemessenen Zielwerte
  // (CH/OH/CC ~13/12/11dB unter BD) aus.
  { name: 'CH', synth: metallicVoice({ freq: 400, filterFreq: 8000, durMult: 0.2, level: 0.32 * Math.sqrt(6) * METAL_MAKEUP, oscBoost: CH_OSC_BOOST }) },
  { name: 'OH', synth: metallicVoice({ freq: 400, filterFreq: 6500, durMult: 0.5, level: 0.31 * Math.sqrt(6) * METAL_MAKEUP, oscBoost: OH_OSC_BOOST }) },
  { name: 'CC', synth: metallicVoice({ freq: 300, filterFreq: 5000, durMult: 1.6, level: 0.26 * Math.sqrt(6) * METAL_MAKEUP, oscBoost: CC_OSC_BOOST }) },
  { name: 'RC', synth: rc },
];

export class AnalogKit extends TrackedDrumMachine {
  static TRACK_DEFS = TRACK_DEFS;

  static meta = {
    type: 'analogkit',
    name: 'AnalogKit',
    desc: '909-style analog kit, synthesized, 11 voices',
    color: '#9fb0bd',
    model: 'RW-05',
  };

  /** Legt für jede metallische Spur (CH/OH/CC/RC, erkennbar an
   *  synth.metalFreq, s. metallicVoice()/rc oben) einen persistenten,
   *  frei laufenden 6-Oszillatoren-Bus an -- einmalig bei der
   *  Konstruktion, nicht pro Anschlag (s. metallic() für das Warum). */
  buildAudio() {
    super.buildAudio();
    for (const tr of this.tracks) {
      const metalFreq = tr.synth.metalFreq;
      if (metalFreq == null) continue;
      tr.metalFreq = metalFreq;
      // Winziger, PERMANENTER Detune je Oszillator (±0.3%, einmalig
      // gewürfelt, nicht bei jedem Anschlag neu) -- METAL_RATIOS sind
      // exakte rationale Zahlen, das Summensignal daher rein periodisch
      // (LCM der 6 Frequenzen). Ohne Detune läuft ein Anschlag irgendwann
      // GARANTIERT wieder in einen fast perfekt phasengleichen Moment wie
      // beim allerersten Start -- und klippt dann hart (gemessen: Summen-
      // Peak bis 5.7 bei 6 unity-Rechtecken, statt der für sqrt(6)-
      // Headroom angenommenen Dekorrelation). Echte Bauteiltoleranz macht
      // die 6 Frequenzen NIE exakt rational zueinander -- das bilden wir
      // hier nach, statt uns auf "läuft schon lang genug, um dekorreliert
      // zu sein" zu verlassen (was bei exakten Verhältnissen nie zutrifft).
      tr.metalDetunes = METAL_RATIOS.map(() => 1 + (Math.random() * 2 - 1) * 0.003);
      tr.metalBus = engine.ctx.createGain();
      tr.metalOscs = METAL_RATIOS.map((ratio, i) => {
        const o = engine.ctx.createOscillator();
        o.type = 'square';
        o.frequency.value = metalFreq * ratio * tr.metalDetunes[i];
        o.connect(tr.metalBus);
        o.start();
        return o;
      });
      // Ebenfalls persistent (s. metallic() für die Begründung): Typ/
      // Frequenz/Q sind pro Spur fest (aus synth.filterFreq/Type/Q, s.
      // metallicVoice()/rc), ändern sich nie pro Anschlag -- ein einziger
      // dauerhaft an metalBus hängender Filter statt einem frischen pro
      // Hit.
      tr.metalFilt = engine.ctx.createBiquadFilter();
      tr.metalFilt.type = tr.synth.filterType ?? 'highpass';
      tr.metalFilt.frequency.value = tr.synth.filterFreq;
      if (tr.synth.filterQ !== undefined) tr.metalFilt.Q.value = tr.synth.filterQ;
      tr.metalBus.connect(tr.metalFilt);

      // TEMPORÄR (Debug, s. tracked-drum-machine.js #trigger): reiner
      // Abgriff auf die rohe Oszillatorsumme VOR jedem Gate/Filter, um
      // live auf dem Gerät zu prüfen, ob der Oszillatorbus im Moment
      // eines Pad-Press tatsächlich Signal führt. Kein Effekt auf den
      // Klang (Dead-End-Tap, wie tr.meterAnalyser).
      tr.metalBusAnalyser = engine.ctx.createAnalyser();
      tr.metalBusAnalyser.fftSize = 256;
      tr.metalBus.connect(tr.metalBusAnalyser);

      // TEMPORÄR (Debug): zweiter Abgriff NACH Gate/Filter/Panner --
      // zeigt, ob das (laut metalBusAnalyser gesunde) Signal bis zum
      // Spur-Ausgang durchkommt oder irgendwo dazwischen verschwindet.
      tr.postGateAnalyser = engine.ctx.createAnalyser();
      tr.postGateAnalyser.fftSize = 256;
      tr.panner.connect(tr.postGateAnalyser);
    }
  }

  /** Basisklasse kennt die metallischen Oszillatoren-Busse/-Filter nicht --
   *  selbst stoppen/trennen, sonst liefen sie nach dem Entfernen der
   *  Maschine unhörbar, aber unnötig weiter. */
  disposeAudio() {
    super.disposeAudio();
    for (const tr of this.tracks) {
      for (const o of tr.metalOscs ?? []) {
        try { o.stop(); } catch { /* schon gestoppt */ }
        o.disconnect();
      }
      tr.metalFilt?.disconnect();
      tr.metalBus?.disconnect();
      tr.metalBusAnalyser?.disconnect();
      tr.postGateAnalyser?.disconnect();
    }
  }
}
