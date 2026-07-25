/**
 * AnalogKit — 11-Spur-Drum-Machine im 909-Stil (synthetisiert, keine
 * Samples). Gleiche Architektur wie die BeatBox (Pads + gemeinsames Grid,
 * Tune/Decay/Level/Sends pro Spur — beide erben von TrackedDrumMachine),
 * aber ein eigener Klangcharakter:
 *
 * - BD/SD/Toms: kürzere, knackigere Hüllkurven als die BeatBox, SD mit
 *   Doppel-Ton-Body (zwei leicht verstimmte Oszillatoren, je eigener
 *   Decay) statt einem gemeinsamen. BD zusätzlich durch ein neutrales
 *   (nicht resonantes -- dafür fehlt in der Original-Schaltung die Basis,
 *   s. bd()) Tiefpassfilter plus eine sanfte Sättigungsstufe (Waveshaper)
 *   für den Punch, SD-Body ebenso leicht angesättigt statt komplett sauber.
 * - CH/OH/CC/RC: das echte 909 nutzt hier gar keine Oszillator-Synthese,
 *   sondern 6-Bit-PCM-Samples echter Becken/Hi-Hats (per VCA/Filter
 *   geformt) — mit reiner Synthese und ohne Sample-Material (keine
 *   Lizenzklärung dafür) also grundsätzlich nicht hardware-identisch
 *   nachbaubar. Statt der (zur falschen 808/606-Generation gehörenden)
 *   6-Oszillatoren-Technik läuft hier eine Bank aus 6 resonanten
 *   Bandpassfiltern an frei gewählten, unharmonischen Frequenzen, gespeist
 *   aus einer einzigen LFSR-Rauschquelle, plus eine zusätzliche breitbandige
 *   Rauschschicht für die "Zisch"-Dichte — architektonisch näher am
 *   tatsächlichen dichten, nicht-tonalen Cymbal-Spektrum als ein
 *   gestimmtes Oszillatorbündel. Rauschquelle UND Resonatoren laufen dabei
 *   KONTINUIERLICH (s. #buildAudio) statt bei jedem Anschlag frisch zu
 *   starten — wie beim echten 909, wo Trigger nur ein VCA-Gate auf dem
 *   gerade aktuellen (frei laufenden) Rauschzustand öffnen.
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

/** Kurzform für env()s optionales {attack, release} -- ADR gilt pro Spur
 *  (nicht pro Layer): jeder interne Layer einer Stimme (z.B. SDs zwei
 *  Ton-Bodies + zwei Rauschpfade) bekommt dieselben Attack-/Release-Werte
 *  der Spur, damit sich der ganze Sound wie EIN Instrument formen lässt. */
const adr = (p) => ({ attack: p.attack, release: p.release });

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

  // Tiefpassfilter statt eines direkten Oszillator→VCA-Pfads -- entfernt
  // etwas vom oberen Sinus-Anteil, damit reiner Sinus+Hüllkurve nicht zu
  // rund/synthetisch klingt. KEINE Resonanz (Q nahe Butterworth-neutral):
  // die dokumentierte 909-Schaltung hat für den Kick-VCF keinen belegten
  // Resonanz-Wert -- anders als beim 808 kommt das "Boing" hier laut
  // Quellenlage primär aus der Pitch-Hüllkurve selbst, nicht aus einem
  // resonanten Filter (vorheriger Wert Q=2.2 war eine unbelegte Annahme).
  // Sättigung danach für den Punch (moderate 909-VCA-Übersteuerung bei
  // lauten Trommeln).
  const lpf = ctx.createBiquadFilter();
  lpf.type = 'lowpass';
  lpf.frequency.setValueAtTime(f0 * 1.4, t);
  lpf.frequency.exponentialRampToValueAtTime(f1 * 1.8, t + 0.05);
  lpf.Q.value = 0.707;
  const sat = ctx.createWaveShaper();
  sat.curve = satCurveWarm();
  const g = env(ctx, t, jitter(1.0 * p.level, 0.05), 0.35 * p.decay, adr(p));
  o.connect(lpf).connect(sat).connect(g).connect(dest);
  autoStop(o, t, g.totalDur, [lpf, sat, g]);

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
    const cg = env(ctx, t, jitter(snap * p.level * 1.6, 0.05), 0.004, adr(p));
    n.connect(lp).connect(cg).connect(dest);
    autoStop(n, t, cg.totalDur, [lp, cg], noiseOffset(0.01));
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
    const g = env(ctx, t, jitter(mix * p.level, 0.05), dur, adr(p));
    o.connect(sat).connect(g).connect(dest);
    autoStop(o, t, g.totalDur, [sat, g]);
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
  const lpg = env(ctx, t, jitter(0.37 * p.level, 0.05), 0.2 * p.decay, adr(p));
  nLow.connect(lp).connect(lpg).connect(dest);
  autoStop(nLow, t, lpg.totalDur, [lp, lpg], noiseOffset());

  const nHigh = ctx.createBufferSource();
  nHigh.buffer = lfsrNoise(ctx);
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 3500 * p.tune;
  const hpg = env(ctx, t, jitter(0.37 * p.level, 0.05), 0.1 * p.decay, adr(p));
  nHigh.connect(hp).connect(hpg).connect(dest);
  autoStop(nHigh, t, hpg.totalDur, [hp, hpg], noiseOffset());
}

function rs(ctx, t, dest, p) {
  // Rim Shot: das Original regt mit einem kurzen Trigger-Impuls drei
  // parallele, unterschiedlich gestimmte Resonanzfilter an (Bridged-T-
  // Filter, je ein eigener Kondensatorwert), die über eine einfache VCA
  // summiert werden — kein Ton, der durch EIN Filter läuft, sondern drei
  // gleichzeitig "angeschlagene" Resonanzen. Das ergibt den mehrschichtigen
  // Klack statt eines einzelnen Buzz-Tons.
  // Frequenzen aus dokumentierter 909-Schaltungsanalyse (drei Bridged-T-
  // Filter des Original-Rimshot-Kreises): f1≈500Hz, f2≈220Hz, f3≈1000Hz --
  // vorher [520, 1200, 2400] war spekulativ zu hoch/zu weit gespreizt.
  const RS_RESONANCES = [220, 500, 1000];
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
  // Streuung. Gain=5 (nach der Frequenzkorrektur auf [220, 500, 1000], s.
  // oben, erneut über 40 Rausch-Seeds nachgemessen): tiefere Resonanzen
  // liegen näher an der Rauschbuffer-Grundenergie als die alten, höheren
  // Werte -- bei Gain=3 sank der Pegel dadurch spürbar (Peak ~0.19 im
  // schlechtesten Fall statt vorher ~0.25), Gain=5 gleicht das auf
  // vergleichbare wahrgenommene Lautheit wie vorher aus (Mittel ~0.23,
  // Worst-Case ~0.34 über 40 Seeds) und bleibt damit weiterhin sicher
  // unter der etablierten Kick-Referenzobergrenze (~1.2).
  let totalDur = dur;
  for (const f of RS_RESONANCES) {
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = jitter(f * p.tune, 0.02);
    bp.Q.value = 6;
    const g = env(ctx, t, jitter(5 * p.level, 0.05), dur, adr(p));
    n.connect(bp).connect(g).connect(dest);
    nodes.push(bp, g);
    totalDur = g.totalDur;
  }
  autoStop(n, t, totalDur, nodes, noiseOffset());
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
  // Nutzt env() NICHT (eigene Mehrfach-Retrigger-Automation statt einer
  // einzelnen Hüllkurve) -- Attack/Release der Spur werden hier deshalb von
  // Hand angewandt statt über den adr()-Helfer: Attack verschiebt/streckt
  // NUR den allerersten Anstieg (die 3 folgenden Retrigger-Zacken bleiben
  // scharf, sonst verschwimmt der charakteristische Clap-Rattle), Release
  // ersetzt wie bei env() den letzten linearen Schritt auf echte 0.
  const attack = p.attack ?? 0;
  const release = Math.max(p.release ?? 0.05, 0.005);
  if (attack > 0) {
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(jitter(2.55 * p.level, 0.06), t + attack);
  } else {
    g.gain.setValueAtTime(jitter(2.55 * p.level, 0.06), t);
  }
  // Retrigger #1s Abklingen zum Zwischenpegel (bislang Teil der Schleife,
  // jetzt einzeln: der ERSTE Anstieg kommt oben ggf. schon vom Attack-Ramp).
  g.gain.linearRampToValueAtTime(0.6 * p.level, t + attack + 0.008);
  for (let i = 1; i < 4; i++) {
    g.gain.setValueAtTime(jitter(2.55 * p.level, 0.06), t + attack + i * 0.011);
    g.gain.linearRampToValueAtTime(0.6 * p.level, t + attack + i * 0.011 + 0.008);
  }
  g.gain.setValueAtTime(jitter(1.95 * p.level, 0.06), t + attack + 0.044);
  g.gain.exponentialRampToValueAtTime(0.001, t + attack + dur);
  // Wie env() (s. dsp.js) -- exponentialRamp erreicht nie echte 0. Ohne
  // diesen letzten linearen Schritt auf echte 0 GENAU im Release-Fenster
  // bliebe die Gain bis zum harten stop() bei 0.001 stehen -- hörbar als
  // leises Klicken am Ende.
  g.gain.linearRampToValueAtTime(0, t + attack + dur + release);

  n.connect(bp).connect(g).connect(dest);
  autoStop(n, t, attack + dur + release, [bp, g], noiseOffset());
}

/** Tom-Stimme: startet leicht über der Zielfrequenz, fällt schnell darauf. */
const tomVoice = (baseFreq) => (ctx, t, dest, p) => {
  const o = ctx.createOscillator();
  o.type = 'sine';
  const f = jitter(baseFreq * p.tune, 0.012);
  o.frequency.setValueAtTime(f * 1.3, t);
  o.frequency.exponentialRampToValueAtTime(f, t + 0.08);
  const g = env(ctx, t, jitter(0.85 * p.level, 0.05), 0.28 * p.decay, adr(p));
  o.connect(g).connect(dest);
  autoStop(o, t, g.totalDur, [g]);
};

/* ---------- Metallische Hats/Cymbals: Rauschen durch eine Bank von 6
   resonanten Bandpassfiltern statt (frühere Version) 6 unharmonischer
   Rechteckwellen-Oszillatoren.
   Grund für den Wechsel: das echte TR-909 nutzt für CH/OH/CC/RC KEINE
   Oszillator-Synthese, sondern komprimierte 6-Bit-PCM-Samples echter
   Becken/Hi-Hats (per VCA/Filter geformt, s. Roland-Service-Unterlagen/
   Hoshiai-Interview) -- die "6 unharmonische Oszillatoren durchs Hoch-/
   Bandpass"-Technik (s. Sound on Sound "Practical Cymbal Synthesis") ist
   tatsächlich TR-808/606-Generation, nicht 909. Echtes Sample-Material
   ist hier bewusst NICHT im Einsatz (keine Lizenzklärung dafür), aber
   ein resonantes Rauschfilterbündel kommt der TATSÄCHLICHEN Charakteristik
   (dichtes, breitbandiges, nicht-tonales Spektrum) architektonisch näher
   als eine Oszillatorbank, die eher nach einem gestimmten Akkord klingt.
   Das Ergebnis ist NICHT hardware-identisch (das wäre ohne echte Samples
   nicht erreichbar), aber der richtigen Familie von Klangerzeugung näher.
   Die 6 Resonatoren pro Stimme werden aus EINER persistenten, frei
   laufenden LFSR-Rauschquelle gespeist (s. AnalogKit#buildAudio, tr.metalNoise/
   tr.metalResonators/tr.metalBus) -- am echten 909 läuft der (digitale,
   31-stufige LFSR-) Rauschgenerator ebenfalls kontinuierlich, ein Trigger
   öffnet nur ein VCA-Gate auf dem gerade aktuellen Rauschzustand. Anders
   als bei der alten Oszillatorbank gibt es hier keine periodische
   Rückkehr zu einem "immer gleichen" Zustand (Rauschen ist nicht
   periodisch) -- das war der eigentliche Grund für den permanenten
   Detune-Jitter unten, der hier trotzdem beibehalten wird (jetzt einfach
   als generische Bauteiltoleranz-Analogie statt Anti-Periodizitäts-Fix).
   ---------- */
// Verhältnisse relativ zur ÄUSSEREN Voice-Filterfrequenz (synth.filterFreq),
// NICHT mehr zur alten, tiefen metalFreq-Basis (300-400Hz): ein resonantes
// Bandpass erzeugt (anders als ein Rechteckton mit reichem Oberton-
// spektrum) praktisch keine Energie oberhalb seiner eigenen Mittenfrequenz
// -- Zentren weit unterhalb des äußeren Filters (wie bei der alten
// Oszillator-Rechnung, dort über die Obertöne noch teilweise hörbar)
// würden hier fast vollständig weggefiltert und wären STUMM statt nur
// leiser. Die neue Spreizung liegt bewusst UM 1x (0.5x bis 2.75x) der
// jeweiligen filterFreq: die tieferen Resonanzen werden von der äußeren
// Filterflanke sanft beschnitten (jede Stimme hört dadurch einen anderen
// Ausschnitt derselben Rausch-/Resonatorbank -- ähnlich wie beim echten
// 909, wo CH/OH/CC vermutlich dieselbe/verwandte Sample-Quelle nur
// unterschiedlich gefiltert nutzen), die höheren überleben nahezu
// ungedämpft.
const RESONATOR_RATIOS = [0.5, 0.75, 1.05, 1.45, 2.0, 2.75];
// Moderates Q: hoch genug für hörbares "Klingeln"/Ringing pro Resonanz,
// niedrig genug um extreme Zufalls-Ausreisser zu vermeiden (dieselbe
// Abwägung wie bei RS oben, dort empirisch auf Q=6 bei Rauschanregung
// gesetzt -- hier etwas niedriger, weil 6 PARALLELE Resonanzen sich
// bereits gegenseitig zu einem dichteren Klangbild summieren, ein noch
// höheres Q pro Band würde das zu sehr Richtung 6 einzelner Pfeiftöne
// statt eines Cymbal-Charakters verschieben).
const RESONATOR_Q = 5;

// Durch die STIMMENZAHL geteilt (nicht durch Wurzel(Stimmenzahl)): mit
// einer gemeinsamen, aber frequenzmässig disjunkten Rauschquelle je
// Resonanzband gibt es (anders als bei der alten Oszillatorbank mit
// exakten rationalen Verhältnissen) keine garantierte periodische
// Rückkehr zu einem perfekt korrelierten "Alle-6-gleichzeitig"-Zustand --
// Rauschen ist nicht periodisch. Dennoch bewusst konservativ mit voller
// STIMMENZAHL-Teilung kalkuliert (nicht Wurzel(Stimmenzahl), die von
// vollständiger Dekorrelation ausginge) und zusätzlich per Sweep über
// viele Rausch-Seeds verifiziert (s. *_RES_BOOST-Konstanten unten).
const METAL_HEADROOM = 1 / RESONATOR_RATIOS.length;
// Zusätzlicher Pegel-Nachschlag (empirisch, gegen BD gemessen): das
// Schließen des Gates VOR dem Anschlag (s. metallic(), Fix fürs Bleed-
// vor-dem-Hit) senkt den gemessenen Pegel gegenüber dem alten Verhalten
// leicht -- gleicht das wieder auf die historisch eingemessenen
// Zielwerte (CH/OH/CC ~13/12/11dB unter BD) aus.
const METAL_MAKEUP = 1.35;

// Kompensiert den strukturellen Hoch-/Bandpass-Verlust der Resonatorbank
// (s. ausführliche Begründung bei `resBoost` in metallic() weiter unten) --
// je Stimme einzeln nach dem Technikwechsel neu gemessen (Werte lösen die
// alten CH/OH/CC/RC_OSC_BOOST-Konstanten ab, die für die Oszillatorbank
// kalibriert waren):
const CH_RES_BOOST = 1.3;
const OH_RES_BOOST = 1.25;
const CC_RES_BOOST = 1.2;
const RC_RES_BOOST = 1.15;

function metallic(ctx, t, dest, {
  tr, dur, level, resBoost = 1, oscMix = 1, noiseMix = 1, attack = 0, release = 0.05,
}) {
  const rel = Math.max(release, 0.005);
  // Live nach dem aktuellen TUNE-Regler nachführen -- hörbar erst beim
  // NÄCHSTEN Anschlag (zwischen Hits ist das Gate zu, eine Frequenz-
  // änderung am laufenden, aber stummen Resonator ist unhörbar).
  for (let i = 0; i < tr.metalResonators.length; i++) {
    tr.metalResonators[i].frequency.setValueAtTime(
      jitter(tr.synth.filterFreq * RESONATOR_RATIOS[i] * tr.metalDetunes[i] * tr.tune, 0.004), t,
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
  // resBoost gleicht einen kleinen strukturellen Pegelverlust aus: die
  // untersten Resonanzbänder (0.5x/0.75x der äußeren filterFreq, s.
  // RESONATOR_RATIOS) liegen noch etwas unter dem Hoch-/Bandpass jeder
  // Stimme und werden von dessen Flanke leicht gedämpft -- anders als bei
  // der alten Oszillatorbank (6.8-9.0dB Verlust, weil dort NUR die
  // schwachen Rechteckwellen-Obertöne oberhalb des Cutoffs überlebten)
  // ist der Verlust hier gering, da die meisten der 6 Resonanzen bereits
  // bei/über der Cutoff-Frequenz liegen.
  // Gate-Knoten kommt aus einem PERSISTENTEN Pool (s. AnalogKit#buildAudio,
  // tr.metalGatePool) statt bei jedem Hit frisch an tr.metalFilt an- und
  // wieder abzuklemmen. Grund (per Debug-Overlay am echten Gerät verifiziert,
  // s. PR-Historie): oscBusPeak (roh, vor dem Gate) war bei JEDEM Pad-Hit
  // gesund und nahezu identisch -- aber der Pegel NACH dem Gate schwankte
  // trotzdem um Faktor 8-9x zwischen sonst gleichartigen Hits, exakt
  // passend zum gemeldeten Symptom (nur der eine "laute" Hit klang tonal).
  // Verdächtig: tr.metalFilt.disconnect(g) entfernt bei eng aufeinander-
  // folgenden Anschlägen (reales Antippen erzeugt Lücken bis unter 150ms,
  // deutlich enger als die bis zu ~3s lange Cleanup-Frist bei hohem
  // DECAY-Wert) EINE von mehreren gleichzeitig an metalFilt hängenden
  // Ziel-Verbindungen -- ein Vorgang, der sich zwischen Audio-Engines
  // unterschiedlich verhalten kann. Der Pool umgeht das strukturell:
  // metalFilt->g wird pro Poolplatz EINMALIG in buildAudio() verbunden
  // und nie wieder getrennt -- ein Hit belegt per Round-Robin den
  // nächsten Platz (Voice-Stealing wie bei echter Hardware mit
  // begrenzter Polyphonie) und plant nur noch eine frische Hüllkurve,
  // OHNE die Graph-Topologie von tr.metalFilt anzufassen.
  const pool = tr.metalGatePool;
  const g = pool[tr.metalGatePoolIdx];
  tr.metalGatePoolIdx = (tr.metalGatePoolIdx + 1) % pool.length;
  g.gain.cancelScheduledValues(0);
  // ABSOLUTE Zeit 0, nicht ctx.currentTime -- garantiert vor jedem echten
  // `t` > 0 (s. ausführliche Begründung in früheren Commits): schließt das
  // Gate zuverlässig, bevor der Peak bei `t` einsetzt.
  g.gain.setValueAtTime(0, 0);
  // oscMix: Spur-Regler "Tone" (Default 1 = bisheriger fest eingemessener
  // Pegel, 0 = Resonatorbank komplett stumm -- z.B. um NUR den Rausch-
  // layer zu nutzen). Analog zu noiseMix beim Rauschlayer unten. Bei
  // oscMix=0 KEINE Rampe planen (nur die (0,0)-Schließung von oben steht) --
  // exponentialRampToValueAtTime verlangt einen von 0 verschiedenen
  // Startwert, echte Stille braucht daher einen eigenen Zweig statt nur
  // eines auf 0.001 gefloorten Peaks (der wäre technisch nie ganz stumm).
  if (oscMix > 0) {
    const peakG = Math.max(jitter(level * METAL_HEADROOM * resBoost * oscMix, 0.05), 0.001);
    if (attack > 0) {
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(peakG, t + attack);
    } else {
      g.gain.setValueAtTime(peakG, t);
    }
    g.gain.exponentialRampToValueAtTime(0.001, t + attack + dur);
    g.gain.linearRampToValueAtTime(0, t + attack + dur + rel);
  }
  g.connect(dest); // wiederholtes connect() auf dieselbe Verbindung ist ein No-Op, kein Fehler

  // Zusätzliche, ungefilterte Breitband-Rauschschicht UNTER der Resonator-
  // bank: reale Cymbal-/Hat-Samples haben neben den Resonanzspitzen auch
  // durchgehende breitbandige Energie zwischen den Peaks ("Zischen"/
  // "Kratzen") -- die 6 schmalen Resonanzbänder allein klingen sonst zu
  // sortiert/"gestimmt". Diese Schicht bleibt bewusst eigenständig
  // (eigene, bei `t` frisch startende Rausch-Quelle statt eines Abgriffs
  // von tr.metalNoise) statt selbst resonant gefiltert zu sein.
  //
  // noiseMix: Spur-Regler "Noise" (Default 1 = bisher fest eingemessenes
  // Verhältnis Ton/Rauschen, 0 = reiner Ton -- Rauschlayer entfällt dann
  // komplett statt nur sehr leise zu sein, 2 = doppelt so viel Rauschen)
  // -- direkt aus dem gemeldeten Pad-vs-Sequencer-Fall entstanden: sobald
  // beide Layer zuverlässig gleich klingen, will man sie nach Geschmack
  // gegeneinander abmischen können statt an einen festen Wert gebunden
  // zu sein, bis hin zu nur EINEM der beiden Layer.
  if (noiseMix > 0) {
    const n = ctx.createBufferSource();
    n.buffer = noise(ctx);
    const nf = ctx.createBiquadFilter();
    nf.type = 'highpass';
    nf.frequency.value = Math.max(tr.metalFilt.frequency.value * 0.5, 2000);
    const ng = env(ctx, t, jitter(level * METAL_HEADROOM * 0.45 * noiseMix, 0.05), dur, { attack, release });
    n.connect(nf).connect(ng).connect(dest);
    autoStop(n, t, ng.totalDur, [nf, ng], noiseOffset());
  }
}

/** Hi-Hat/Crash-Stimme: feste Klangfarbe, Tune/Decay/Level wirken wie bei
 *  den übrigen Spuren. `freq`/`filterFreq`/`filterType`/`filterQ` stehen
 *  zusätzlich auf der zurückgegebenen Funktion (wie schon `.metalFreq`),
 *  damit AnalogKit#buildAudio weiss, mit welcher Basisfrequenz und
 *  welchem Filter es den persistenten Rausch-/Resonatoren-Bus/Filter
 *  dieser Spur anlegen muss (einzige Quelle der Wahrheit, keine doppelt
 *  gepflegte Zahl in TRACK_DEFS). */
const metallicVoice = ({ freq, filterFreq, filterType, filterQ, durMult, level, resBoost }) => {
  const fn = (ctx, t, dest, p) => metallic(ctx, t, dest, {
    tr: p, dur: durMult * p.decay, level: level * p.level, resBoost,
    oscMix: p.oscMix ?? 1, noiseMix: p.noiseMix ?? 1, ...adr(p),
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
  // die reine Resonatorsumme zu einem unklaren Rauschband. Beide Pegel
  // (Metall-Anteil + Ping) moderat angehoben — Ride sass im Kit deutlich
  // zu weit hinten, viel Peak-Headroom war noch übrig.
  metallic(ctx, t, dest, {
    tr: p, dur: 1.0 * p.decay, level: 0.24 * Math.sqrt(6) * METAL_MAKEUP * p.level,
    resBoost: RC_RES_BOOST, oscMix: p.oscMix ?? 1, noiseMix: p.noiseMix ?? 1, ...adr(p),
  });
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.value = jitter(700 * p.tune, 0.01);
  const g = env(ctx, t, jitter(0.42 * p.level, 0.05), 0.15 * p.decay, adr(p));
  o.connect(g).connect(dest);
  autoStop(o, t, g.totalDur, [g]);
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
  { name: 'CH', synth: metallicVoice({ freq: 400, filterFreq: 8000, durMult: 0.2, level: 0.32 * Math.sqrt(6) * METAL_MAKEUP, resBoost: CH_RES_BOOST }), oscMix: 1, noiseMix: 1 },
  { name: 'OH', synth: metallicVoice({ freq: 400, filterFreq: 6500, durMult: 0.5, level: 0.31 * Math.sqrt(6) * METAL_MAKEUP, resBoost: OH_RES_BOOST }), oscMix: 1, noiseMix: 1 },
  { name: 'CC', synth: metallicVoice({ freq: 300, filterFreq: 5000, durMult: 1.6, level: 0.26 * Math.sqrt(6) * METAL_MAKEUP, resBoost: CC_RES_BOOST }), oscMix: 1, noiseMix: 1 },
  { name: 'RC', synth: rc, oscMix: 1, noiseMix: 1 },
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
   *  frei laufenden Rausch-/Resonatoren-Bus an -- einmalig bei der
   *  Konstruktion, nicht pro Anschlag (s. metallic() für das Warum). */
  buildAudio() {
    super.buildAudio();
    for (const tr of this.tracks) {
      if (tr.synth.metalFreq == null) continue;
      // Winziger, PERMANENTER Detune je Resonanzband (±0.3%, einmalig
      // gewürfelt, nicht bei jedem Anschlag neu) -- generische Bauteil-
      // toleranz-Analogie (wie beim jitter()-Helfer oben), macht 6 sonst
      // exakt gleich gestimmte Resonanzen minimal individuell.
      tr.metalDetunes = RESONATOR_RATIOS.map(() => 1 + (Math.random() * 2 - 1) * 0.003);
      tr.metalBus = engine.ctx.createGain();
      // EINE persistente, frei laufende Rauschquelle (LFSR statt Math.random()
      // -- s. dsp.js#lfsrNoise, dieselbe Quelle wie die 909-Snare, echte
      // Bauteil-Analogie zum tatsächlichen digitalen 909-Rauschgenerator)
      // speist alle 6 Resonanzbänder parallel. `loop = true` + einmaliges
      // start() statt pro-Hit-BufferSource: exakt dasselbe "kontinuierlich
      // laufend, Trigger öffnet nur ein Gate"-Prinzip wie zuvor bei den
      // Oszillatoren (s. metallic() oben) -- und beim echten 909 läuft der
      // Rauschgenerator ebenfalls durchgehend, nicht neu pro Trigger.
      tr.metalNoise = engine.ctx.createBufferSource();
      tr.metalNoise.buffer = lfsrNoise(engine.ctx);
      tr.metalNoise.loop = true;
      tr.metalNoise.start();
      tr.metalResonators = RESONATOR_RATIOS.map((ratio, i) => {
        const bp = engine.ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = tr.synth.filterFreq * ratio * tr.metalDetunes[i];
        bp.Q.value = RESONATOR_Q;
        tr.metalNoise.connect(bp);
        bp.connect(tr.metalBus);
        return bp;
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

      // Pool aus persistenten Gate-Knoten für metallic() (s. dort für die
      // ausführliche Begründung): einmalig an metalFilt angeschlossen,
      // nie wieder getrennt. 12 Plätze pro Spur reichen selbst für den
      // Extremfall aus enger Antipp-Folge (<150ms) bei langem DECAY
      // (bis 3.0 -> CC-Hüllkurve bis ~4.85s) komfortabel ab -- darüber
      // hinaus greift Voice-Stealing (ältester Platz wird wiederverwendet,
      // wie begrenzte Polyphonie bei echter Hardware).
      tr.metalGatePool = Array.from({ length: 12 }, () => {
        const g = engine.ctx.createGain();
        g.gain.value = 0;
        tr.metalFilt.connect(g);
        return g;
      });
      tr.metalGatePoolIdx = 0;
    }
  }

  /** Basisklasse kennt die metallischen Rausch-/Resonatoren-Busse/-Filter
   *  nicht -- selbst stoppen/trennen, sonst liefen sie nach dem Entfernen der
   *  Maschine unhörbar, aber unnötig weiter. */
  disposeAudio() {
    super.disposeAudio();
    for (const tr of this.tracks) {
      try { tr.metalNoise?.stop(); } catch { /* schon gestoppt */ }
      tr.metalNoise?.disconnect();
      for (const bp of tr.metalResonators ?? []) bp.disconnect();
      tr.metalFilt?.disconnect();
      tr.metalBus?.disconnect();
      for (const g of tr.metalGatePool ?? []) g.disconnect();
    }
  }
}
