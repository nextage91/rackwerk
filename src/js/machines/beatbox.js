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
 */
import { Machine } from './machine.js';
import { engine } from '../core/audio-engine.js';
import { transport } from '../core/transport.js';
import { StepSeq, resizePattern } from '../ui/step-seq.js';
import { automation } from '../core/automation.js';
import { noise, env, autoStop } from '../core/dsp.js';

/* ================= Drum-Synthese ================= */

/* Jede Drum: (ctx, t, dest, {tune, decay, level}) */

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
  const g = env(ctx, t, 1.0 * p.level, 0.4 * p.decay);
  o.connect(g).connect(dest);
  autoStop(o, t, 0.4 * p.decay, [g]);

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
    const cg = env(ctx, t, snap * p.level, 0.012);
    n.connect(hp).connect(cg).connect(dest);
    autoStop(n, t, 0.012, [hp, cg]);
  }
}

function snare(ctx, t, dest, p) {
  // Körper (Ton) + Teppich (Rauschen)
  const o = ctx.createOscillator();
  o.type = 'triangle';
  o.frequency.value = 190 * p.tune;
  const og = env(ctx, t, 0.5 * p.level, 0.1 * p.decay);
  o.connect(og).connect(dest);
  autoStop(o, t, 0.1 * p.decay, [og]);

  const n = ctx.createBufferSource();
  n.buffer = noise(ctx);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1800 * p.tune;
  const ng = env(ctx, t, 0.8 * p.level, 0.18 * p.decay);
  n.connect(bp).connect(ng).connect(dest);
  autoStop(n, t, 0.18 * p.decay, [bp, ng]);
}

function clap(ctx, t, dest, p) {
  const n = ctx.createBufferSource();
  n.buffer = noise(ctx);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1100 * p.tune;
  bp.Q.value = 1.5;

  // 3 schnelle Retrigger, dann Ausklang — der typische Clap
  const g = ctx.createGain();
  const dur = 0.036 + 0.2 * p.decay;
  for (let i = 0; i < 3; i++) {
    g.gain.setValueAtTime(0.9 * p.level, t + i * 0.012);
    g.gain.linearRampToValueAtTime(0.2 * p.level, t + i * 0.012 + 0.01);
  }
  g.gain.setValueAtTime(0.7 * p.level, t + 0.036);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);

  n.connect(bp).connect(g).connect(dest);
  autoStop(n, t, dur, [bp, g]);
}

const hat = (baseDur) => (ctx, t, dest, p) => {
  const n = ctx.createBufferSource();
  n.buffer = noise(ctx);
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 7000 * p.tune;
  const g = env(ctx, t, 0.45 * p.level, baseDur * p.decay);
  n.connect(hp).connect(g).connect(dest);
  autoStop(n, t, baseDur * p.decay, [hp, g]);
};

const tom = (mult) => (ctx, t, dest, p) => {
  const o = ctx.createOscillator();
  o.type = 'sine';
  const f = 150 * mult * p.tune;
  o.frequency.setValueAtTime(f, t);
  o.frequency.exponentialRampToValueAtTime(f * 0.55, t + 0.15);
  const g = env(ctx, t, 0.8 * p.level, 0.3 * p.decay);
  o.connect(g).connect(dest);
  autoStop(o, t, 0.3 * p.decay, [g]);
};

function perc(ctx, t, dest, p) {
  // Zwei verstimmte Rechtecke durch Bandpass ≈ Cowbell
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 900 * p.tune;
  const g = env(ctx, t, 0.4 * p.level, 0.18 * p.decay);
  bp.connect(g).connect(dest);
  for (const f of [540, 810]) {
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = f * p.tune;
    o.connect(bp);
    autoStop(o, t, 0.18 * p.decay, [bp, g]);
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

// Start-Groove: Kick 4-to-the-floor, Snare auf 2+4, Hats offbeat
const SEED = { Kick: [0, 4, 8, 12], Snare: [4, 12], 'HH cl': [2, 6, 10, 14] };

export class BeatBox extends Machine {
  getParamForKnob(key) {
    // volume liegt hier nicht in params — alles andere (z. B. die
    // FX-Sends) beantwortet die Basisklasse
    return key === 'volume' ? this.volume : super.getParamForKnob(key);
  }

  static meta = {
    type: 'beatbox',
    name: 'BeatBox',
    desc: '8-Spur-Drum-Machine, synthetisierte Sounds',
    color: '#ff7a59',
  };

  buildAudio() {
    this.volume = 0.8;
    this.output.gain.value = this.volume;
    this.selected = 0;
    /** Index der solo geschalteten Spur, oder null */
    this.soloTrack = null;

    this.tracks = TRACK_DEFS.map((def) => ({
      ...def,
      steps: Array.from({ length: 16 }, () => ({ on: false })),
      tune: 1,
      decay: 1,
      level: 0.9,
    }));
    for (const [name, steps] of Object.entries(SEED)) {
      const tr = this.tracks.find((t) => t.name === name);
      for (const s of steps) tr.steps[s].on = true;
    }
  }

  /* ---------- Sequenzer ---------- */
  onStep(step, time) {
    const idx = step % this.tracks[0].steps.length; // alle Spuren gleich lang
    const delayMs = (time - engine.now) * 1000;
    this.seq?.flashStep(idx, delayMs, transport.stepDuration * 900);

    for (let i = 0; i < this.tracks.length; i++) {
      if (this.soloTrack != null && i !== this.soloTrack) continue;
      const tr = this.tracks[i];
      if (tr.steps[idx].on) this.#trigger(tr, time);
    }
  }

  serialize() {
    return {
      volume: this.volume,
      tracks: this.tracks.map((tr) => ({
        tune: tr.tune,
        decay: tr.decay,
        level: tr.level,
        snap: tr.snap,
        steps: tr.steps.map((s) => ({ on: s.on })),
      })),
    };
  }

  deserialize(state) {
    this.volume = state.volume ?? 0.8;
    this.output.gain.value = this.volume;
    state.tracks?.forEach((saved, i) => {
      const tr = this.tracks[i];
      if (!tr) return;
      tr.tune = saved.tune ?? tr.tune;
      tr.decay = saved.decay ?? tr.decay;
      tr.level = saved.level ?? tr.level;
      if (saved.snap !== undefined) tr.snap = saved.snap;
      tr.steps = saved.steps.map((s) => ({ on: !!s.on }));
    });
  }

  onTransport(event) {
    if (event === 'stop') this.seq?.clearPlayhead();
  }

  #trigger(tr, time) {
    // Auf die Render-Quantum-Grenze ausrichten → jeder Anschlag ist
    // identisch im Audio-Block positioniert (siehe engine.quantizeTime)
    tr.synth(engine.ctx, engine.quantizeTime(time), this.output, tr);
  }

  /* ---------- UI ---------- */
  buildControls(container) {
    // Spur-Parameter + Maschinen-Volume
    const row = document.createElement('div');
    row.className = 'machine__row';
    row.innerHTML = `
      <x-knob label="Tune"  min="0.5" max="2" value="1"   default="1" curve="log" data-p="tune"></x-knob>
      <x-knob label="Decay" min="0.25" max="3" value="1"  default="1" curve="log" data-p="decay"></x-knob>
      <x-knob label="Level" min="0" max="1" value="0.9"   data-p="level"></x-knob>
      <x-knob label="Snap"  min="0" max="1" value="0.45"  data-p="snap"></x-knob>
      <x-knob label="Volume" min="0" max="1" value="0.8"  data-p="volume" data-auto></x-knob>
    `;
    row.addEventListener('input', (e) => {
      const key = e.target.dataset?.p;
      if (!key) return;
      const val = e.detail.value;
      if (key === 'volume') {
        this.volume = val;
        this.output.gain.setTargetAtTime(val, engine.now, 0.01);
      } else {
        this.tracks[this.selected][key] = val;
      }
    });
    container.appendChild(row);
    this.knobs = {
      tune: row.querySelector('[data-p="tune"]'),
      decay: row.querySelector('[data-p="decay"]'),
      level: row.querySelector('[data-p="level"]'),
      snap: row.querySelector('[data-p="snap"]'),
    };

    // Per-Spur-Automation: Der Lane-Schlüssel entsteht beim Anfassen aus
    // der gerade gewählten Spur — jede Drum-Spur hat eigene Fahrten.
    // Playback schreibt direkt in die Spur-Parameter; der Knob bewegt
    // sich nur mit, wenn seine Spur gerade ausgewählt ist.
    for (const param of ['tune', 'decay', 'level', 'snap']) {
      const applyForKey = (key, value) => {
        const trIdx = parseInt(key.split(':')[1], 10);
        if (this.tracks[trIdx][param] === undefined) return; // Spur ohne diesen Param
        this.tracks[trIdx][param] = value;
        if (trIdx === this.selected) this.knobs[param].value = value;
      };
      automation.registerDynamic(
        this.knobs[param],
        () => `${this.id}:${this.selected}:${param}`,
        applyForKey,
      );
      // Alle Spur-Ziele vorregistrieren, damit GELADENE Lanes sofort
      // abspielen (ohne dass der Knob erst angefasst werden muss)
      for (let ti = 0; ti < this.tracks.length; ti++) {
        const key = `${this.id}:${ti}:${param}`;
        automation.ensureTarget(key, this.knobs[param], (v) => applyForKey(key, v));
      }
    }

    // Pads: anspielen + Spur wählen
    const pads = document.createElement('div');
    pads.className = 'pads';
    this.padEls = this.tracks.map((tr, i) => {
      const pad = document.createElement('button');
      pad.className = 'pad';
      pad.textContent = tr.name;
      pad.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.#trigger(tr, engine.ctx.currentTime);
        this.#selectTrack(i);
      });
      pads.appendChild(pad);
      return pad;
    });
    container.appendChild(pads);

    // Ein Grid für alle Spuren — zeigt immer die gewählte
    this.seq = new StepSeq(this.tracks[0].steps, {
      pitch: false,
      onLengthChange: (bars) => {
        for (const tr of this.tracks) resizePattern(tr.steps, bars);
        this.seq.setPattern(this.tracks[this.selected].steps);
      },
    });
    container.appendChild(this.seq.el);

    // Solo-Button für die gewählte Spur in die Grid-Kopfzeile einhängen
    const ctrl = this.seq.el.querySelector('.stepseq__ctrl');
    this.soloBtn = document.createElement('button');
    this.soloBtn.className = 'm-btn m-btn--solo';
    this.soloBtn.textContent = 'SOLO';
    this.soloBtn.addEventListener('click', () => {
      this.soloTrack = this.soloTrack === this.selected ? null : this.selected;
      this.#refreshSoloUI();
    });
    ctrl.insertBefore(this.soloBtn, ctrl.querySelector('[data-clear]'));

    this.#selectTrack(0);
  }

  #selectTrack(i) {
    this.selected = i;
    const tr = this.tracks[i];
    this.padEls.forEach((p, j) => p.classList.toggle('is-selected', j === i));
    this.seq.setPattern(tr.steps);
    this.knobs.tune.value = tr.tune;
    this.knobs.decay.value = tr.decay;
    this.knobs.level.value = tr.level;
    this.knobs.snap.style.display = tr.snap === undefined ? 'none' : '';
    if (tr.snap !== undefined) this.knobs.snap.value = tr.snap;
    for (const param of ['tune', 'decay', 'level', 'snap']) {
      this.knobs[param].classList.toggle('has-auto',
        automation.hasLane(`${this.id}:${i}:${param}`));
    }
    this.seq.el.querySelector('.stepseq__title').textContent = `Pattern · ${tr.name}`;
    this.#refreshSoloUI();
  }

  /** Nach dem Laden eines Projekts: LEDs an die gewählte Spur anpassen. */
  onLanesImported() {
    this.#selectTrack(this.selected);
  }

  #refreshSoloUI() {
    this.soloBtn.classList.toggle('is-active', this.soloTrack === this.selected);
    this.padEls.forEach((p, j) => p.classList.toggle('is-solo', j === this.soloTrack));
  }
}
