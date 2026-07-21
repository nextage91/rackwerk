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
 * Rein fire-and-forget (kein noteOff/gehaltene Stimmen wie bei SubSynth/
 * PolySynth) — Pattern-Bank/Step-Grid/Jam-Clip-Bindung sitzen in
 * StepSequencedSynth.
 */
import { StepSequencedSynth } from './step-sequenced-synth.js';
import { engine } from '../core/audio-engine.js';
import { noise, autoStop, midiToHz } from '../core/dsp.js';
import { createKeybed } from '../ui/keybed.js';

export class PercSynth extends StepSequencedSynth {
  static DEFAULT_MIDI = 76;

  static meta = {
    type: 'percsynth',
    name: 'PercSynth',
    desc: 'FM percussion: zaps, bells, congas, lasers',
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

    /** 4 leere Pattern-Slots (A/B/C/D) — neu hinzugefügte Maschinen starten
     *  ohne vorprogrammierte Steps. */
    this.patterns = [this.emptyPattern(), this.emptyPattern(), this.emptyPattern(), this.emptyPattern()];
    this.patternIndex = 0;
    this.pattern = this.patterns[0];
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

    // Amp-Hüllkurve. Letzter linearer Schritt auf echte 0 (exponentialRamp
    // erreicht nie echte 0) GENAU im TAIL-Fenster vor autoStop()s stop() --
    // ohne den bliebe die Gain bis zum harten stop() bei 0.001 hängen und
    // spränge dann abrupt auf 0 (hörbares Klicken, s. dsp.js#env).
    const TAIL = 0.05;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.9, time);
    amp.gain.exponentialRampToValueAtTime(0.001, time + dur);
    amp.gain.linearRampToValueAtTime(0, time + dur + TAIL);
    car.connect(amp).connect(this.output);

    autoStop(car, time, dur + TAIL, [amp]);
    autoStop(mod, time, dur + TAIL, [modGain]);

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
      ng.gain.linearRampToValueAtTime(0, time + nDur + TAIL);
      n.connect(bp).connect(ng).connect(this.output);
      autoStop(n, time, nDur + TAIL, [bp, ng]);
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
        this.setLevel(val); // eine Quelle der Wahrheit, auch für den Mixer
      }
    });
    container.appendChild(row);

    this.buildPatternControls(container);

    // Keybed eine Oktave höher als der Synth — Perc lebt weiter oben
    container.appendChild(createKeybed({
      baseMidi: 72,
      onNoteOn: (midi) => {
        if (this.isLiveRecording) {
          const idx = this.liveStepIndex(this.pattern.length);
          this.pattern[idx] = { on: true, midi };
          this.seq?.refreshStep(idx);
        }
        this.playNote(midi, engine.ctx.currentTime);
      },
    }));
  }
}
