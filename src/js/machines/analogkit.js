/**
 * AnalogKit — 11-Spur-Drum-Machine im 909-Stil (synthetisiert, keine
 * Samples). Gleiche Architektur wie die BeatBox (Pads + gemeinsames Grid,
 * Tune/Decay/Level/Sends pro Spur), aber ein eigener Klangcharakter:
 *
 * - BD/SD/Toms: kürzere, knackigere Hüllkurven als die BeatBox, SD mit
 *   Doppel-Ton-Body (zwei leicht verstimmte Oszillatoren) statt einem.
 * - CH/OH/CC/RC: die klassische "6 verstimmte Oszillatoren durchs
 *   Hochpass/Bandpass"-Technik für einen metallischen, unharmonischen
 *   Klang — deutlich anders als die BeatBox-Hats (gefiltertes Rauschen).
 *
 * Kit: BD (Bass Drum), SD (Snare), LT/MT/HT (Toms), RS (Rim Shot),
 * CP (Clap), CH/OH (Hi-Hats), CC/RC (Cymbals).
 */
import { Machine } from './machine.js';
import { engine } from '../core/audio-engine.js';
import { transport } from '../core/transport.js';
import { StepSeq, resizePattern } from '../ui/step-seq.js';
import { createPatternBank } from '../ui/pattern-bank.js';
import { automation } from '../core/automation.js';
import { song } from '../core/song.js';
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

  // Attack-Klick: kurzer Dreieck-Ton statt gefiltertem Rauschen (BeatBox) —
  // klingt "elektronischer", eher wie der 909-typische Anschlag.
  const snap = p.snap ?? 0.5;
  if (snap > 0.01) {
    const c = ctx.createOscillator();
    c.type = 'triangle';
    c.frequency.value = 1800 * p.tune;
    const cg = env(ctx, t, snap * p.level, 0.008);
    c.connect(cg).connect(dest);
    autoStop(c, t, 0.008, [cg]);
  }
}

function sd(ctx, t, dest, p) {
  // Doppel-Ton-Body (zwei Dreieckwellen) statt einem — der charakteristische
  // 909-Snare-"Ping". Dazu ein helles, schmaleres Rauschband als die BeatBox.
  const bodyBus = ctx.createGain();
  const bodyEnv = env(ctx, t, 0.45 * p.level, 0.12 * p.decay);
  bodyBus.connect(bodyEnv).connect(dest);
  for (const f of [180, 330]) {
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = f * p.tune;
    o.connect(bodyBus);
    autoStop(o, t, 0.12 * p.decay, [bodyBus, bodyEnv]);
  }

  const n = ctx.createBufferSource();
  n.buffer = noise(ctx);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 2200 * p.tune;
  bp.Q.value = 1.2;
  const ng = env(ctx, t, 0.85 * p.level, 0.16 * p.decay);
  n.connect(bp).connect(ng).connect(dest);
  autoStop(n, t, 0.16 * p.decay, [bp, ng]);
}

function rs(ctx, t, dest, p) {
  // Rim Shot: sehr kurz, zwei verstimmte Rechtecke durch ein schmales
  // Bandpass — der metallische "Klack" neben dem Rand.
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1600 * p.tune;
  bp.Q.value = 3;
  const g = env(ctx, t, p.level, 0.02 * p.decay);
  bp.connect(g).connect(dest);
  for (const mult of [1, 1.7]) {
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = 340 * mult * p.tune;
    o.connect(bp);
    autoStop(o, t, 0.02 * p.decay, [bp, g]);
  }
}

function cp(ctx, t, dest, p) {
  // 4 schnelle Retrigger statt 3 (BeatBox) — etwas dichter/heller gefiltert.
  const n = ctx.createBufferSource();
  n.buffer = noise(ctx);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1300 * p.tune;
  bp.Q.value = 1.8;

  const g = ctx.createGain();
  const dur = 0.044 + 0.22 * p.decay;
  for (let i = 0; i < 4; i++) {
    g.gain.setValueAtTime(0.85 * p.level, t + i * 0.011);
    g.gain.linearRampToValueAtTime(0.2 * p.level, t + i * 0.011 + 0.008);
  }
  g.gain.setValueAtTime(0.65 * p.level, t + 0.044);
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
  // die reine Oszillatorsumme zu einem unklaren Rauschband.
  metallic(ctx, t, dest, {
    freq: 350 * p.tune, filterFreq: 4000, filterType: 'bandpass', filterQ: 1.4,
    dur: 1.0 * p.decay, level: 0.38 * p.level,
  });
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.value = 700 * p.tune;
  const g = env(ctx, t, 0.3 * p.level, 0.15 * p.decay);
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
  { name: 'CH', synth: metallicVoice({ freq: 400, filterFreq: 8000, durMult: 0.06, level: 0.42 }) },
  { name: 'OH', synth: metallicVoice({ freq: 400, filterFreq: 6500, durMult: 0.35, level: 0.4 }) },
  { name: 'CC', synth: metallicVoice({ freq: 300, filterFreq: 5000, durMult: 1.6, level: 0.5 }) },
  { name: 'RC', synth: rc },
];

/** Leeres Pattern-Slot: 11 Spuren × 16 leere Steps. */
const emptySlot = () => TRACK_DEFS.map(() => Array.from({ length: 16 }, () => ({ on: false })));

// Start-Groove: klassischer 909-Vierviertel-Groove
const SEED = { BD: [0, 4, 8, 12], SD: [4, 12], CH: [0, 2, 4, 6, 8, 10, 12, 14], OH: [7, 15] };

export class AnalogKit extends Machine {
  getParamForKnob(key) {
    return key === 'volume' ? this.volume : super.getParamForKnob(key);
  }

  static meta = {
    type: 'analogkit',
    name: 'AnalogKit',
    desc: '909-style analog kit, synthesized, 11 voices',
    color: '#9fb0bd',
    model: 'RW-05',
  };

  buildAudio() {
    this.volume = 0.8;
    this.output.gain.value = this.volume;
    this.selected = 0;
    /** Index der solo geschalteten Spur, oder null */
    this.soloTrack = null;

    // Jede Spur: eigener Panner + eigene Sends zu Delay/Reverb, parallel
    // zum trockenen Pfad (panner -> this.output) — identisch zur BeatBox.
    this.tracks = TRACK_DEFS.map((def) => {
      const panner = engine.ctx.createStereoPanner();
      panner.connect(this.output);
      const sendDelayNode = engine.ctx.createGain();
      sendDelayNode.gain.value = 0;
      panner.connect(sendDelayNode);
      sendDelayNode.connect(engine.delayBus);
      const sendReverbNode = engine.ctx.createGain();
      sendReverbNode.gain.value = 0;
      panner.connect(sendReverbNode);
      sendReverbNode.connect(engine.reverbBus);
      return {
        ...def, tune: 1, decay: 1, level: 0.9, pan: 0, panner,
        sendDelay: 0, sendReverb: 0, sendDelayNode, sendReverbNode,
      };
    });

    // 4 Pattern-Slots (A/B/C/D), je 11 Step-Spuren. A trägt den Start-Groove.
    this.patterns = [emptySlot(), emptySlot(), emptySlot(), emptySlot()];
    for (const [name, steps] of Object.entries(SEED)) {
      const ti = this.tracks.findIndex((t) => t.name === name);
      for (const s of steps) this.patterns[0][ti][s].on = true;
    }
    this.patternIndex = 0;
    this.patterns[0].forEach((steps, ti) => { this.tracks[ti].steps = steps; });
  }

  /* ---------- Pattern-Bank (A/B/C/D) ---------- */
  #bindSlot() {
    const slot = this.patterns[this.patternIndex];
    this.tracks.forEach((tr, ti) => { tr.steps = slot[ti]; });
  }
  setPatternIndex(i) {
    this.patternIndex = i;
    this.#bindSlot();
    this.patternBank?.setActive(i);
    this.seq?.setPattern(this.tracks[this.selected].steps);
    automation.setBars(this.id, this.seq?.bars ?? 1);
  }
  #cloneSlot(i) {
    return this.patterns[i].map((steps) => steps.map((s) => ({ on: s.on })));
  }

  /* ---------- Sequenzer ---------- */
  onStep(step, time) {
    const idx = step % this.tracks[0].steps.length;
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
        tune: tr.tune, decay: tr.decay, level: tr.level, snap: tr.snap, pan: tr.pan,
        sendDelay: tr.sendDelay, sendReverb: tr.sendReverb,
      })),
      patterns: this.patterns.map((slot) => slot.map((steps) => steps.map((s) => ({ on: s.on })))),
      patternIndex: this.patternIndex,
      pan: this.pan,
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
      this.setTrackPan(i, saved.pan ?? 0);
      tr.sendDelay = saved.sendDelay ?? 0;
      tr.sendDelayNode.gain.setTargetAtTime(tr.sendDelay, engine.now, 0.01);
      tr.sendReverb = saved.sendReverb ?? 0;
      tr.sendReverbNode.gain.setTargetAtTime(tr.sendReverb, engine.now, 0.01);
    });
    if (state.patterns) {
      this.patterns = state.patterns.map((slot) => slot.map((steps) => steps.map((s) => ({ on: !!s.on }))));
      this.patternIndex = state.patternIndex ?? 0;
    } else if (state.tracks?.some((t) => t.steps)) {
      const slotA = state.tracks.map((saved) => (saved.steps ?? []).map((s) => ({ on: !!s.on })));
      this.patterns = [slotA, emptySlot(), emptySlot(), emptySlot()];
      this.patternIndex = 0;
    }
    while (this.patterns.length < 4) this.patterns.push(emptySlot());
    this.patternIndex = Math.min(this.patternIndex ?? 0, 3);
    this.#bindSlot();
    this.setPan(state.pan ?? 0);
  }

  /* ---------- Mixer: Pegel (Volume separat, nicht in params) ---------- */
  get level() { return this.volume; }
  setLevel(v) {
    v = Math.min(1, Math.max(0, v));
    this.volume = v;
    this.output.gain.setTargetAtTime(v, engine.now, 0.01);
    const knob = this.el?.querySelector('x-knob[data-p="volume"]');
    if (knob) knob.value = v;
  }

  onTransport(event) {
    if (event === 'stop') this.seq?.clearPlayhead();
  }

  disposeAudio() {
    for (const tr of this.tracks) {
      tr.panner.disconnect();
      tr.meterAnalyser?.disconnect();
      tr.sendDelayNode.disconnect();
      tr.sendReverbNode.disconnect();
    }
  }

  getTrackMeterAnalyser(i) {
    const tr = this.tracks[i];
    if (!tr.meterAnalyser) {
      tr.meterAnalyser = engine.ctx.createAnalyser();
      tr.meterAnalyser.fftSize = 512;
      tr.panner.connect(tr.meterAnalyser);
    }
    return tr.meterAnalyser;
  }

  #trigger(tr, time) {
    this.pulse(time);
    tr.synth(engine.ctx, engine.quantizeTime(time), tr.panner, tr);
  }

  /* ---------- Mixer: Pegel & Panorama pro Spur ---------- */
  setTrackLevel(i, v) {
    const tr = this.tracks[i];
    if (!tr) return;
    tr.level = Math.min(1, Math.max(0, v));
    if (i === this.selected) this.knobs.level.value = tr.level;
  }
  setTrackPan(i, v) {
    const tr = this.tracks[i];
    if (!tr) return;
    tr.pan = Math.min(1, Math.max(-1, v));
    tr.panner.pan.setTargetAtTime(tr.pan, engine.now, 0.01);
  }
  setTrackSend(i, which, v) {
    const tr = this.tracks[i];
    if (!tr) return;
    v = Math.min(1, Math.max(0, v));
    const key = which === 'delay' ? 'sendDelay' : 'sendReverb';
    const node = which === 'delay' ? tr.sendDelayNode : tr.sendReverbNode;
    tr[key] = v;
    node.gain.setTargetAtTime(v, engine.now, 0.01);
    if (i === this.selected) this.knobs[key].value = v;
  }

  /* ---------- UI ---------- */
  buildControls(container) {
    const row = document.createElement('div');
    row.className = 'machine__row';
    row.innerHTML = `
      <x-knob label="Tune"  min="0.5" max="2" value="1"   default="1" curve="log" data-p="tune"></x-knob>
      <x-knob label="Decay" min="0.25" max="3" value="1"  default="1" curve="log" data-p="decay"></x-knob>
      <x-knob label="Level" min="0" max="1" value="0.9"   data-p="level"></x-knob>
      <x-knob label="Snap"  min="0" max="1" value="0.5"   data-p="snap"></x-knob>
      <x-knob label="Send D" min="0" max="1" value="0" data-p="trackSendDelay"></x-knob>
      <x-knob label="Send R" min="0" max="1" value="0" data-p="trackSendReverb"></x-knob>
      <x-knob label="Volume" min="0" max="1" value="0.8"  data-p="volume" data-auto></x-knob>
    `;
    row.addEventListener('input', (e) => {
      const key = e.target.dataset?.p;
      if (!key) return;
      const val = e.detail.value;
      if (key === 'volume') {
        this.setLevel(val);
      } else if (key === 'trackSendDelay' || key === 'trackSendReverb') {
        this.setTrackSend(this.selected, key === 'trackSendDelay' ? 'delay' : 'reverb', val);
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
      sendDelay: row.querySelector('[data-p="trackSendDelay"]'),
      sendReverb: row.querySelector('[data-p="trackSendReverb"]'),
    };

    for (const param of ['tune', 'decay', 'level', 'snap']) {
      const applyForKey = (key, value) => {
        const trIdx = parseInt(key.split(':')[1], 10);
        if (this.tracks[trIdx][param] === undefined) return;
        this.tracks[trIdx][param] = value;
        if (trIdx === this.selected) this.knobs[param].value = value;
      };
      automation.registerDynamic(
        this.knobs[param],
        () => `${this.id}:${this.selected}:${param}`,
        applyForKey,
      );
      for (let ti = 0; ti < this.tracks.length; ti++) {
        const key = `${this.id}:${ti}:${param}`;
        automation.ensureTarget(key, this.knobs[param], (v) => applyForKey(key, v));
      }
    }

    const pads = document.createElement('div');
    pads.className = 'pads';
    this.padEls = this.tracks.map((tr, i) => {
      const pad = document.createElement('button');
      pad.className = 'pad';
      pad.textContent = tr.name;
      pad.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        if (this.isLiveRecording) {
          tr.steps[this.liveStepIndex(tr.steps.length)].on = true;
        }
        this.#trigger(tr, engine.ctx.currentTime);
        this.#selectTrack(i);
      });
      pads.appendChild(pad);
      return pad;
    });
    container.appendChild(pads);

    this.patternBank = createPatternBank({
      index: this.patternIndex,
      shape: 'drums',
      onSwitch: (i) => { this.setPatternIndex(i); song.recordPattern(this.id, i); },
      getSlot: (i) => this.#cloneSlot(i),
      putSlot: (i, data) => {
        this.patterns[i] = data.map((steps) => steps.map((s) => ({ on: !!s.on })));
        this.setPatternIndex(i);
      },
    });
    container.appendChild(this.patternBank.el);

    this.seq = new StepSeq(this.tracks[0].steps, {
      pitch: false,
      onLengthChange: (bars) => {
        for (const tr of this.tracks) resizePattern(tr.steps, bars);
        this.seq.setPattern(this.tracks[this.selected].steps);
        automation.setBars(this.id, bars);
      },
    });
    container.appendChild(this.seq.el);
    automation.setBars(this.id, this.seq.bars);

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
    this.knobs.sendDelay.value = tr.sendDelay;
    this.knobs.sendReverb.value = tr.sendReverb;
    for (const param of ['tune', 'decay', 'level', 'snap']) {
      this.knobs[param].classList.toggle('has-auto',
        automation.hasLane(`${this.id}:${i}:${param}`));
    }
    this.seq.el.querySelector('.stepseq__title').textContent = tr.name;
    this.#refreshSoloUI();
  }

  onLanesImported() {
    this.#selectTrack(this.selected);
  }

  #refreshSoloUI() {
    this.soloBtn.classList.toggle('is-active', this.soloTrack === this.selected);
    this.padEls.forEach((p, j) => p.classList.toggle('is-solo', j === this.soloTrack));
  }
}
