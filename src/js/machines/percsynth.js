/**
 * PercSynth — getunte FM-Percussion (Zaps, Bells, Congas, Laser, Blips).
 *
 * Stimme pro Trigger:
 *   Modulator (Sinus, f·Ratio) → FM auf den Carrier (Sinus, Notenfrequenz
 *   mit Pitch-Sweep von oben) → Amp-Hüllkurve → Output.
 *   Dazu optional ein Bandpass-Rauschanteil für Attack/„Skin".
 *
 * Charakter über vier Klangregler:
 *   Ratio  — Verhältnis Modulator/Carrier: ganzzahlig = tonal (Conga,
 *            Woodblock), krumm = metallisch/glockig (Bell, Clank)
 *   FM Amt — Modulationstiefe (abklingend → lebendiger Attack)
 *   Sweep  — Pitch-Hüllkurve von oben (der „Zap")
 *   Noise  — Rauschanteil im Anschlag
 *
 * Noten kommen aus dem Pitch-Step-Grid (wie SubSynth) oder vom Keybed.
 */
import { Machine } from './machine.js';
import { engine } from '../core/audio-engine.js';
import { transport } from '../core/transport.js';
import { noise, autoStop, midiToHz } from '../core/dsp.js';
import { StepSeq, resizePattern } from '../ui/step-seq.js';
import { createPatternBank } from '../ui/pattern-bank.js';
import { createKeybed } from '../ui/keybed.js';
import { automation } from '../core/automation.js';
import { song } from '../core/song.js';

/** Leeres 1-Takt-Pattern (16 Steps aus). */
const emptyPattern = (len = 16) =>
  Array.from({ length: len }, () => ({ on: false, midi: 76 }));

export class PercSynth extends Machine {
  static meta = {
    type: 'percsynth',
    name: 'PercSynth',
    desc: 'FM-Percussion: Zaps, Bells, Congas, Laser',
    color: '#e3bf5a',
    model: 'RW-03',
  };

  buildAudio() {
    this.params = {
      ratio: 2.7,     // Modulator-Verhältnis (krumm = metallisch)
      fmAmt: 0.4,     // Modulationstiefe 0..1
      sweep: 0.3,     // Pitch-Hüllkurve 0..1 (0 = kein Zap)
      noiseMix: 0.2,  // Rauschanteil 0..1
      decay: 0.25,    // s — Amp-Hüllkurve
      volume: 0.8,
    };
    this.output.gain.value = this.params.volume;

    /** 4 Pattern-Slots (A/B/C/D). A trägt die Offbeat-Perc, B–D leer. */
    const seedPat = emptyPattern();
    const seed = { 2: 79, 7: 72, 10: 84, 15: 76 }; // sparsame Offbeat-Perc
    for (const [step, midi] of Object.entries(seed)) {
      seedPat[step].on = true;
      seedPat[step].midi = midi;
    }
    this.patterns = [seedPat, emptyPattern(), emptyPattern(), emptyPattern()];
    this.patternIndex = 0;
    this.pattern = this.patterns[0];
  }

  /* ---------- Pattern-Bank (A/B/C/D) ---------- */
  /** Aktives Pattern setzen (auch von der Song-Wiedergabe). */
  setPatternIndex(i) {
    this.patternIndex = i;
    this.pattern = this.patterns[i];
    this.seq?.setPattern(this.pattern);
    this.patternBank?.setActive(i);
    automation.setBars(this.id, this.seq?.bars ?? 1);
  }

  /* ---------- Sequenzer ---------- */
  onStep(step, time) {
    const idx = step % this.pattern.length;
    const delayMs = (time - engine.now) * 1000;
    this.seq?.flashStep(idx, delayMs, transport.stepDuration * 900);

    const st = this.pattern[idx];
    if (st.on) this.playNote(st.midi, time);
  }

  serialize() {
    return {
      params: { ...this.params },
      patterns: this.patterns.map((p) => p.map((s) => ({ ...s }))),
      patternIndex: this.patternIndex,
    };
  }

  deserialize(state) {
    Object.assign(this.params, state.params);
    if (state.patterns) {
      this.patterns = state.patterns.map((p) => p.map((s) => ({ ...s })));
      this.patternIndex = state.patternIndex ?? 0;
    } else if (state.pattern) {
      const a = state.pattern.map((s) => ({ ...s }));
      this.patterns = [a, emptyPattern(a.length), emptyPattern(a.length), emptyPattern(a.length)];
      this.patternIndex = 0;
    }
    while (this.patterns.length < 4) this.patterns.push(emptyPattern());
    this.pattern = this.patterns[this.patternIndex] ?? this.patterns[0];
    this.output.gain.value = this.params.volume;
  }

  onTransport(event) {
    if (event === 'stop') this.seq?.clearPlayhead();
  }

  /* ---------- Stimme (fire-and-forget) ---------- */
  playNote(midi, time) {
    time = engine.quantizeTime(time); // konsistente Block-Ausrichtung
    this.pulse(time);
    const ctx = engine.ctx;
    const p = this.params;
    const f = midiToHz(midi);
    const dur = Math.max(0.03, p.decay);

    // Carrier mit Pitch-Sweep von oben
    const car = ctx.createOscillator();
    car.type = 'sine';
    car.frequency.setValueAtTime(f * (1 + p.sweep * 3), time);
    car.frequency.setTargetAtTime(f, time, 0.02);

    // FM: Modulator moduliert die Carrier-Frequenz, Tiefe klingt mit ab
    const mod = ctx.createOscillator();
    mod.type = 'sine';
    mod.frequency.value = f * p.ratio;
    const modGain = ctx.createGain();
    modGain.gain.setValueAtTime(f * p.fmAmt * 8, time);
    modGain.gain.setTargetAtTime(0, time, dur / 4);
    mod.connect(modGain).connect(car.frequency);

    // Amp-Hüllkurve
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.9, time);
    amp.gain.exponentialRampToValueAtTime(0.001, time + dur);
    car.connect(amp).connect(this.output);

    autoStop(car, time, dur, [amp]);
    autoStop(mod, time, dur, [modGain]);

    // Rauschanteil im Anschlag (Bandpass um die doppelte Notenfrequenz)
    if (p.noiseMix > 0.01) {
      const n = ctx.createBufferSource();
      n.buffer = noise(ctx);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = Math.min(14000, f * 2);
      bp.Q.value = 2;
      const ng = ctx.createGain();
      const nDur = Math.min(dur, 0.12);
      ng.gain.setValueAtTime(0.8 * p.noiseMix, time);
      ng.gain.exponentialRampToValueAtTime(0.001, time + nDur);
      n.connect(bp).connect(ng).connect(this.output);
      autoStop(n, time, nDur, [bp, ng]);
    }
  }

  /* ---------- UI ---------- */
  buildControls(container) {
    const row = document.createElement('div');
    row.className = 'machine__row';
    row.innerHTML = `
      <x-knob label="Ratio"  min="0.25" max="8" value="2.7" curve="log" data-p="ratio" data-auto></x-knob>
      <x-knob label="FM Amt" min="0" max="1" value="0.4" data-p="fmAmt" data-auto></x-knob>
      <x-knob label="Sweep"  min="0" max="1" value="0.3" data-p="sweep" data-auto></x-knob>
      <x-knob label="Noise"  min="0" max="1" value="0.2" data-p="noiseMix" data-auto></x-knob>
      <x-knob label="Decay"  min="0.03" max="1.5" value="0.25" curve="log" unit="s" data-p="decay" data-auto></x-knob>
      <x-knob label="Volume" min="0" max="1" value="0.8" data-p="volume" data-auto></x-knob>
    `;
    row.addEventListener('input', (e) => {
      const key = e.target.dataset?.p;
      if (!key) return;
      const val = e.detail.value;
      this.params[key] = val;
      if (key === 'volume') {
        this.output.gain.setTargetAtTime(val, engine.now, 0.01);
      }
    });
    container.appendChild(row);

    this.patternBank = createPatternBank({
      index: this.patternIndex,
      shape: 'notes',
      onSwitch: (i) => { this.setPatternIndex(i); song.recordPattern(this.id, i); },
      getSlot: (i) => this.patterns[i].map((s) => ({ ...s })),
      putSlot: (i, data) => { this.patterns[i] = data.map((s) => ({ ...s })); this.setPatternIndex(i); },
    });
    container.appendChild(this.patternBank.el);

    this.seq = new StepSeq(this.pattern, {
      onLengthChange: (bars) => {
        resizePattern(this.pattern, bars);
        this.seq.setPattern(this.pattern);
        automation.setBars(this.id, bars); // Lanes mitwachsen lassen
      },
    });
    container.appendChild(this.seq.el);
    this.seq.el.querySelector('.stepseq__title').textContent = ''; // Bank labelt schon
    // Automations-Lanes an die (ggf. geladene) Pattern-Länge koppeln
    automation.setBars(this.id, this.seq.bars);

    // Keybed eine Oktave höher als der Synth — Perc lebt weiter oben
    container.appendChild(createKeybed({
      baseMidi: 72,
      onNoteOn: (midi) => this.playNote(midi, engine.ctx.currentTime),
    }));
  }
}
