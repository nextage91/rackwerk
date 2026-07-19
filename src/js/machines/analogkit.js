/**
 * AnalogKit — 11-Spur-Drum-Machine im 909-Stil (synthetisiert, keine
 * Samples). Gleiche Architektur wie die BeatBox (Pads + gemeinsames Grid,
 * Tune/Decay/Level/Sends pro Spur — beide erben von TrackedDrumMachine),
 * aber ein eigener Klangcharakter:
 *
 * - BD/SD/Toms: kürzere, knackigere Hüllkurven als die BeatBox, SD mit
 *   Doppel-Ton-Body (zwei leicht verstimmte Oszillatoren, je eigener
 *   Decay) statt einem gemeinsamen.
 * - CH/OH/CC/RC: 6 verstimmte Oszillatoren durchs Hochpass/Bandpass für
 *   den metallischen Grundklang, plus eine hochpassgefilterte Rausch-
 *   schicht darunter für die Dichte, die das echte 909-PCM-Cymbal-Sample
 *   hat (ein reines Oszillatorbündel klingt sonst zu "sauber"/808-artig).
 *
 * Kit: BD (Bass Drum), SD (Snare), LT/MT/HT (Toms), RS (Rim Shot),
 * CP (Clap), CH/OH (Hi-Hats), CC/RC (Cymbals).
 */
import { TrackedDrumMachine } from './tracked-drum-machine.js';
import { noise, env, autoStop } from '../core/dsp.js';

/* ================= Drum-Synthese ================= */

/* Jede Drum: (ctx, t, dest, {tune, decay, level}) */

function bd(ctx, t, dest, p) {
  // Kurze, knackige Pitch-Hüllkurve — startet höher/fällt schneller als
  // die BeatBox-Kick, weniger Sub-Betonung, mehr "Klack" im Attack.
  const f0 = Math.max(80, 200 * p.tune);
  const f1 = Math.max(35, 58 * p.tune);
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(f1, t + 0.045);
  const g = env(ctx, t, 1.0 * p.level, 0.35 * p.decay);
  o.connect(g).connect(dest);
  autoStop(o, t, 0.35 * p.decay, [g]);

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
    const cg = env(ctx, t, snap * p.level * 1.6, 0.004);
    n.connect(lp).connect(cg).connect(dest);
    autoStop(n, t, 0.004, [lp, cg]);
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
  for (const { f, durMul, mix } of [{ f: 180, durMul: 1.0, mix: 0.38 }, { f: 330, durMul: 0.6, mix: 0.28 }]) {
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = f * p.tune;
    const dur = 0.17 * p.decay * durMul;
    const g = env(ctx, t, mix * p.level, dur);
    o.connect(g).connect(dest);
    autoStop(o, t, dur, [g]);
  }

  // "Snare-Kabel"-Rauschen: beim Original zwei PARALLELE Pfade (Tiefpass +
  // Hochpass), je eigene Hüllkurve, statt eines einzelnen Bandpasses — der
  // Tiefpass-Anteil gibt den dumpferen Rattle-Körper, der Hochpass-Anteil
  // das helle Zischen im Attack.
  const nLow = ctx.createBufferSource();
  nLow.buffer = noise(ctx);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 1100 * p.tune;
  const lpg = env(ctx, t, 0.46 * p.level, 0.2 * p.decay);
  nLow.connect(lp).connect(lpg).connect(dest);
  autoStop(nLow, t, 0.2 * p.decay, [lp, lpg]);

  const nHigh = ctx.createBufferSource();
  nHigh.buffer = noise(ctx);
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 3500 * p.tune;
  const hpg = env(ctx, t, 0.46 * p.level, 0.1 * p.decay);
  nHigh.connect(hp).connect(hpg).connect(dest);
  autoStop(nHigh, t, 0.1 * p.decay, [hp, hpg]);
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
    bp.frequency.value = f * p.tune;
    bp.Q.value = 6;
    const g = env(ctx, t, 3 * p.level, dur);
    n.connect(bp).connect(g).connect(dest);
    nodes.push(bp, g);
  }
  autoStop(n, t, dur, nodes);
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
  bp.frequency.value = 1300 * p.tune;
  bp.Q.value = 1.8;

  const g = ctx.createGain();
  const dur = 0.044 + 0.22 * p.decay;
  for (let i = 0; i < 4; i++) {
    g.gain.setValueAtTime(2.55 * p.level, t + i * 0.011);
    g.gain.linearRampToValueAtTime(0.6 * p.level, t + i * 0.011 + 0.008);
  }
  g.gain.setValueAtTime(1.95 * p.level, t + 0.044);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);

  n.connect(bp).connect(g).connect(dest);
  autoStop(n, t, dur, [bp, g]);
}

/** Tom-Stimme: startet leicht über der Zielfrequenz, fällt schnell darauf. */
const tomVoice = (baseFreq) => (ctx, t, dest, p) => {
  const o = ctx.createOscillator();
  o.type = 'sine';
  const f = baseFreq * p.tune;
  o.frequency.setValueAtTime(f * 1.3, t);
  o.frequency.exponentialRampToValueAtTime(f, t + 0.08);
  const g = env(ctx, t, 0.85 * p.level, 0.28 * p.decay);
  o.connect(g).connect(dest);
  autoStop(o, t, 0.28 * p.decay, [g]);
};

/* ---------- Metallische Hats/Cymbals: 6 unharmonisch verstimmte
   Rechteckwellen durch ein Hoch-/Bandpass — die klassische analoge
   Cymbal-Synthese-Technik (statt gefiltertem Rauschen wie bei der
   BeatBox). Die Verhältnisse sind bewusst nicht-ganzzahlig, damit die
   Summe unharmonisch/metallisch statt tonal klingt. ---------- */
const METAL_RATIOS = [1, 1.48, 1.62, 2.03, 2.28, 2.67];

// 6 Rechteckwellen ohne Gegenmaßnahme können sich am Anschlag (alle starten
// phasengleich bei t=0) kurzzeitig weit über den nominellen Level aufsummieren
// (gemessen: >0 dBFS bei level=0.5) — durch Wurzel(Stimmenzahl) geteilt, damit
// der tatsächliche Pegel wieder beim eingestellten `level` landet (dieselbe
// Kompensation wie beim PolySynth-Akkord-Voicing).
const METAL_HEADROOM = 1 / Math.sqrt(METAL_RATIOS.length);

function metallic(ctx, t, dest, { freq, filterFreq, filterType = 'highpass', filterQ, dur, level }) {
  const bus = ctx.createGain();
  const filt = ctx.createBiquadFilter();
  filt.type = filterType;
  filt.frequency.value = filterFreq;
  if (filterQ !== undefined) filt.Q.value = filterQ;
  const g = env(ctx, t, level * METAL_HEADROOM, dur);
  bus.connect(filt).connect(g).connect(dest);
  for (const ratio of METAL_RATIOS) {
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = freq * ratio;
    o.connect(bus);
    autoStop(o, t, dur, [bus, filt, g]);
  }

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
  nf.frequency.value = Math.max(filterFreq * 0.5, 2000);
  const ng = env(ctx, t, level * METAL_HEADROOM * 0.45, dur);
  n.connect(nf).connect(ng).connect(dest);
  autoStop(n, t, dur, [nf, ng]);
}

/** Hi-Hat/Crash-Stimme: feste Klangfarbe, Tune/Decay/Level wirken wie bei
 *  den übrigen Spuren. */
const metallicVoice = ({ freq, filterFreq, filterType, filterQ, durMult, level }) =>
  (ctx, t, dest, p) => metallic(ctx, t, dest, {
    freq: freq * p.tune, filterFreq, filterType, filterQ,
    dur: durMult * p.decay, level: level * p.level,
  });

function rc(ctx, t, dest, p) {
  // Ride: schmaleres Bandpass (mehr "Ping"-Charakter als die Crash) plus
  // ein kurzer Sinus-Ping für einen definierten Attack — sonst verwäscht
  // die reine Oszillatorsumme zu einem unklaren Rauschband. Beide Pegel
  // (Metall-Anteil + Ping) moderat angehoben — Ride sass im Kit deutlich
  // zu weit hinten, viel Peak-Headroom war noch übrig.
  metallic(ctx, t, dest, {
    freq: 350 * p.tune, filterFreq: 4000, filterType: 'bandpass', filterQ: 1.4,
    dur: 1.0 * p.decay, level: 0.58 * p.level,
  });
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.value = 700 * p.tune;
  const g = env(ctx, t, 0.42 * p.level, 0.15 * p.decay);
  o.connect(g).connect(dest);
  autoStop(o, t, 0.15 * p.decay, [g]);
}

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
  { name: 'CH', synth: metallicVoice({ freq: 400, filterFreq: 8000, durMult: 0.2, level: 0.84 }) },
  { name: 'OH', synth: metallicVoice({ freq: 400, filterFreq: 6500, durMult: 0.5, level: 0.65 }) },
  { name: 'CC', synth: metallicVoice({ freq: 300, filterFreq: 5000, durMult: 1.6, level: 0.6 }) },
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
}
