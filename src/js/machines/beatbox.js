/**
 * BeatBox — 8-Spur-Drum-Machine mit synthetisierten Sounds (808-Stil).
 *
 * Keine Sample-Dateien: Alle Drums werden bei jedem Trigger aus
 * Oszillatoren + Rauschen gebaut. Das hält das Projekt asset-frei
 * (läuft offline im Capacitor-WebView) und macht Tune/Decay echt
 * parametrisch statt nur Playback-Tricks.
 *
 * UI-Konzept (Touch-first statt 8×16-Matrix, die auf Phones zu klein wird):
 * - 8 Pads: Tippen spielt den Sound an UND wählt die Spur aus
 * - Ein gemeinsames 16-Step-Grid zeigt immer die gewählte Spur
 * - Tune/Decay/Level-Knobs wirken auf die gewählte Spur
 *
 * Das komplette Chassis (Bind/Serialize/Sequenzer/Automation/UI) sitzt in
 * TrackedDrumMachine — hier bleibt nur, was den BeatBox-Klangcharakter
 * ausmacht: die Drum-Synthese-Funktionen und TRACK_DEFS.
 */
import { TrackedDrumMachine } from './tracked-drum-machine.js';
import { noise, env, autoStop } from '../core/dsp.js';

/* ================= Drum-Synthese ================= */

/* Jede Drum: (ctx, t, dest, {tune, decay, level}) */

/** Kurzform für env()s optionales {attack, release} -- ADR gilt pro Spur
 *  (nicht pro Layer): jeder interne Layer einer Stimme (z.B. Snares Ton +
 *  Rauschen) bekommt dieselben Attack-/Release-Werte der Spur, damit sich
 *  der ganze Sound wie EIN Instrument formen lässt. */
const adr = (p) => ({ attack: p.attack, release: p.release });

function kick(ctx, t, dest, p) {
  // Körper: Sinus mit Pitch-Hüllkurve. Zielfrequenz nach unten begrenzen —
  // unter ~30 Hz ist auf Phone-Lautsprechern nichts mehr hörbar und der
  // Anschlag zerfällt in Artefakte.
  const f0 = Math.max(60, 160 * p.tune);
  const f1 = Math.max(30, 45 * p.tune);
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(f1, t + 0.1);
  const g = env(ctx, t, 1.0 * p.level, 0.4 * p.decay, adr(p));
  o.connect(g).connect(dest);
  autoStop(o, t, g.totalDur, [g]);

  // Klick: 12 ms Hochpass-Rauschen als Attack-Transient. Startet immer an
  // derselben Buffer-Position → klingt bei jedem Anschlag identisch und
  // hält den Punch unabhängig von der Stimmung konstant. Anteil über
  // den Snap-Regler der Kick-Spur; bei 0 wird er ganz weggelassen.
  const snap = p.snap ?? 0.45;
  if (snap > 0.01) {
    const n = ctx.createBufferSource();
    n.buffer = noise(ctx);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1500;
    const cg = env(ctx, t, snap * p.level, 0.012, adr(p));
    n.connect(hp).connect(cg).connect(dest);
    autoStop(n, t, cg.totalDur, [hp, cg]);
  }
}

function snare(ctx, t, dest, p) {
  // Körper (Ton) + Teppich (Rauschen)
  const o = ctx.createOscillator();
  o.type = 'triangle';
  o.frequency.value = 190 * p.tune;
  const og = env(ctx, t, 0.5 * p.level, 0.1 * p.decay, adr(p));
  o.connect(og).connect(dest);
  autoStop(o, t, og.totalDur, [og]);

  const n = ctx.createBufferSource();
  n.buffer = noise(ctx);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1800 * p.tune;
  const ng = env(ctx, t, 0.8 * p.level, 0.18 * p.decay, adr(p));
  n.connect(bp).connect(ng).connect(dest);
  autoStop(n, t, ng.totalDur, [bp, ng]);
}

function clap(ctx, t, dest, p) {
  const n = ctx.createBufferSource();
  n.buffer = noise(ctx);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1100 * p.tune;
  bp.Q.value = 1.5;

  // 3 schnelle Retrigger, dann Ausklang — der typische Clap. Nutzt env()
  // NICHT (eigene Mehrfach-Retrigger-Automation) -- Attack/Release der Spur
  // werden hier deshalb von Hand angewandt: Attack streckt NUR den ersten
  // Anstieg (die 2 folgenden Retrigger bleiben scharf), Release ersetzt den
  // finalen Schritt auf echte 0 (fehlte hier bisher komplett -- s.u.).
  const g = ctx.createGain();
  const dur = 0.036 + 0.2 * p.decay;
  const attack = p.attack ?? 0;
  const release = Math.max(p.release ?? 0.05, 0.005);
  if (attack > 0) {
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.9 * p.level, t + attack);
  } else {
    g.gain.setValueAtTime(0.9 * p.level, t);
  }
  g.gain.linearRampToValueAtTime(0.2 * p.level, t + attack + 0.01);
  for (let i = 1; i < 3; i++) {
    g.gain.setValueAtTime(0.9 * p.level, t + attack + i * 0.012);
    g.gain.linearRampToValueAtTime(0.2 * p.level, t + attack + i * 0.012 + 0.01);
  }
  g.gain.setValueAtTime(0.7 * p.level, t + attack + 0.036);
  g.gain.exponentialRampToValueAtTime(0.001, t + attack + dur);
  // Bisher fehlte hier der letzte lineare Schritt auf echte 0 (anders als
  // bei env()/cp() in AnalogKit) -- die Quelle sprang beim harten stop()
  // von 0.001 abrupt auf 0, ein winziges, aber echtes Klicken. Mit
  // Release jetzt konsistent behoben.
  g.gain.linearRampToValueAtTime(0, t + attack + dur + release);

  n.connect(bp).connect(g).connect(dest);
  autoStop(n, t, attack + dur + release, [bp, g]);
}

const hat = (baseDur) => (ctx, t, dest, p) => {
  const n = ctx.createBufferSource();
  n.buffer = noise(ctx);
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 7000 * p.tune;
  const g = env(ctx, t, 0.45 * p.level, baseDur * p.decay, adr(p));
  n.connect(hp).connect(g).connect(dest);
  autoStop(n, t, g.totalDur, [hp, g]);
};

const tom = (mult) => (ctx, t, dest, p) => {
  const o = ctx.createOscillator();
  o.type = 'sine';
  const f = 150 * mult * p.tune;
  o.frequency.setValueAtTime(f, t);
  o.frequency.exponentialRampToValueAtTime(f * 0.55, t + 0.15);
  const g = env(ctx, t, 0.8 * p.level, 0.3 * p.decay, adr(p));
  o.connect(g).connect(dest);
  autoStop(o, t, g.totalDur, [g]);
};

function perc(ctx, t, dest, p) {
  // Zwei verstimmte Rechtecke durch Bandpass ≈ Cowbell
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 900 * p.tune;
  const g = env(ctx, t, 0.4 * p.level, 0.18 * p.decay, adr(p));
  bp.connect(g).connect(dest);
  for (const f of [540, 810]) {
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = f * p.tune;
    o.connect(bp);
    autoStop(o, t, g.totalDur, [bp, g]);
  }
}

/* ================= Die Maschine ================= */

const TRACK_DEFS = [
  { name: 'Kick',  synth: kick, snap: 0.45 },
  { name: 'Snare', synth: snare },
  { name: 'Clap',  synth: clap },
  { name: 'HH cl', synth: hat(0.05) },
  { name: 'HH op', synth: hat(0.4) },
  { name: 'Tom L', synth: tom(0.7) },
  { name: 'Tom H', synth: tom(1.4) },
  { name: 'Perc',  synth: perc },
];

// Start-Groove: Kick 4-to-the-floor, Snare auf 2+4, Hats offbeat — nur für
// die Startbesetzung einer neuen Session genutzt (project.js#newProject),
// nicht automatisch beim Hinzufügen über "+ Add Machine" (die soll leer
// starten, s. seedDemo()).
const SEED = { Kick: [0, 4, 8, 12], Snare: [4, 12], 'HH cl': [2, 6, 10, 14] };

export class BeatBox extends TrackedDrumMachine {
  static TRACK_DEFS = TRACK_DEFS;

  static meta = {
    type: 'beatbox',
    name: 'BeatBox',
    desc: '8-track drum machine, synthesized sounds',
    color: '#ff8c42',
    model: 'RW-02',
  };

  /**
   * Start-Groove in Slot A einfüllen — nur von der Startbesetzung einer neuen
   * Session genutzt (project.js#newProject), damit die App sofort klingt.
   * Über "+ Add Machine" hinzugefügte Maschinen bleiben leer.
   */
  seedDemo() {
    for (const [name, steps] of Object.entries(SEED)) {
      const ti = this.tracks.findIndex((t) => t.name === name);
      for (const s of steps) this.patterns[0][ti][s].on = true;
    }
    if (this.patternIndex === 0) this.seq?.setPattern(this.tracks[this.selected].steps);
  }
}
