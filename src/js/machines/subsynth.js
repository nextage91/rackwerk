/**
 * SubSynth — erste Beispielmaschine, damit das Rack von Anfang an klingt.
 *
 * Signalfluss pro Stimme:
 *   Oscillator (Saw) → Lowpass-Filter → Hüllkurven-Gain → machine.output
 *
 * Ein Touch-Keybed (eine Oktave) mit Glissando-Unterstützung dient als
 * Spielfläche; später ersetzt/ergänzt durch den Pattern-Sequenzer.
 */
import { Machine } from './machine.js';
import { engine } from '../core/audio-engine.js';
import { transport } from '../core/transport.js';
import { StepSeq, resizePattern } from '../ui/step-seq.js';
import { createPatternBank } from '../ui/pattern-bank.js';
import { createKeybed } from '../ui/keybed.js';
import { midiToHz } from '../core/dsp.js';
import { automation } from '../core/automation.js';
import { song } from '../core/song.js';

/** Leeres 1-Takt-Pattern (16 Steps aus). */
const emptyPattern = (len = 16) =>
  Array.from({ length: len }, () => ({ on: false, midi: 48 }));

export class SubSynth extends Machine {
  static meta = {
    type: 'subsynth',
    name: 'SubSynth',
    desc: 'Subtraktiver Synthesizer mit Tiefpassfilter',
    color: '#6fb8d6',
    model: 'RW-01',
  };

  buildAudio() {
    this.params = {
      cutoff: 1800,       // Hz (Basis, auf die die Hüllkurve zurückfällt)
      resonance: 4,       // Q
      envAmt: 0.3,        // Filterhüllkurve: 0..1 ≙ 0..+4 Oktaven über Cutoff
      fDecay: 0.18,       // s — Abklingzeit der Filterhüllkurve
      attack: 0.005,      // s (Amp)
      release: 0.25,      // s (Amp)
      volume: 0.7,
      filterType: 'lowpass',
    };
    /** aktive Stimmen: midi → {osc, filter, env} */
    this.voices = new Map();
    this.output.gain.value = this.params.volume;

    /** 4 Pattern-Slots (A/B/C/D), {on, midi} pro Step. A trägt die Demo-
     *  Line, B–D starten leer. `this.pattern` zeigt aufs aktive Slot. */
    const seedPat = Array.from({ length: 16 }, () => ({ on: false, midi: 48 }));
    const seed = { 0: 36, 3: 48, 6: 36, 8: 39, 11: 48, 14: 46 }; // kleine Acid-Line
    for (const [step, midi] of Object.entries(seed)) {
      seedPat[step].on = true;
      seedPat[step].midi = midi;
    }
    this.patterns = [seedPat, emptyPattern(), emptyPattern(), emptyPattern()];
    this.patternIndex = 0;
    this.pattern = this.patterns[0];
  }

  /* ---------- Pattern-Bank (A/B/C/D) ---------- */
  /** Aktives Pattern setzen. Auch von der Song-Wiedergabe aufgerufen —
   *  ohne selbst wieder aufzunehmen. */
  setPatternIndex(i) {
    this.patternIndex = i;
    this.pattern = this.patterns[i];
    this.seq?.setPattern(this.pattern);
    this.patternBank?.setActive(i);
    automation.setBars(this.id, this.seq?.bars ?? 1);
  }
  #copyPattern(i) {
    this.patterns[i] = this.pattern.map((s) => ({ ...s })); // aktuelles → Slot i
    this.setPatternIndex(i);
    song.recordPattern(this.id, i);
  }

  /* ---------- Sequenzer-Anbindung (vom Transport aufgerufen) ---------- */
  onStep(step, time) {
    const idx = step % this.pattern.length; // Pattern loopt selbst (1–8 Takte)
    const delayMs = (time - engine.now) * 1000;
    this.seq?.flashStep(idx, delayMs, transport.stepDuration * 900);

    const st = this.pattern[idx];
    if (st.on) this.playNote(st.midi, time, transport.stepDuration * 0.8);
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
      // Altes Format (ein Pattern): in Slot A, B–D leer in gleicher Länge
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

  /**
   * Fire-and-forget-Stimme für den Sequenzer — sample-genau bei `time`
   * geplant, unabhängig von den gehaltenen Keybed-Stimmen.
   */
  playNote(midi, time, dur) {
    time = engine.quantizeTime(time); // konsistente Block-Ausrichtung
    this.pulse(time);
    const ctx = engine.ctx;
    const p = this.params;

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = midiToHz(midi);

    const filter = ctx.createBiquadFilter();
    filter.type = p.filterType;
    filter.Q.value = p.resonance;
    this.#applyFilterEnv(filter, time);

    const env = ctx.createGain();
    const atk = Math.min(p.attack, dur * 0.5); // Attack nie länger als die Note
    env.gain.setValueAtTime(0, time);
    env.gain.linearRampToValueAtTime(1, time + atk);
    env.gain.setTargetAtTime(0, time + dur, p.release / 4);

    osc.connect(filter).connect(env).connect(this.output);
    osc.start(time);
    osc.stop(time + dur + p.release + 0.1);
    osc.onended = () => { osc.disconnect(); filter.disconnect(); env.disconnect(); };
  }

  /* ---------- Stimmenverwaltung ---------- */
  noteOn(midi) {
    if (this.voices.has(midi)) return;
    this.pulse();
    const ctx = engine.ctx;
    const t = ctx.currentTime;
    const p = this.params;

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = midiToHz(midi);

    const filter = ctx.createBiquadFilter();
    filter.type = p.filterType;
    filter.Q.value = p.resonance;
    this.#applyFilterEnv(filter, t);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(1, t + p.attack);

    osc.connect(filter).connect(env).connect(this.output);
    osc.start(t);

    this.voices.set(midi, { osc, filter, env });
  }

  noteOff(midi) {
    const v = this.voices.get(midi);
    if (!v) return;
    this.voices.delete(midi);

    const t = engine.ctx.currentTime;
    const rel = this.params.release;
    v.env.gain.cancelScheduledValues(t);
    v.env.gain.setTargetAtTime(0, t, rel / 4);
    v.osc.stop(t + rel + 0.1);
    v.osc.onended = () => { v.osc.disconnect(); v.filter.disconnect(); v.env.disconnect(); };
  }

  allNotesOff() {
    for (const midi of [...this.voices.keys()]) this.noteOff(midi);
  }

  disposeAudio() {
    this.allNotesOff();
  }

  /**
   * Filterhüllkurve: startet envAmt Oktaven über dem Cutoff (bis +4 Okt.)
   * und fällt exponentiell auf den Cutoff zurück — der klassische
   * Pluck/Acid-Charakter. Gilt für Keybed- und Sequenzer-Stimmen gleich.
   */
  #applyFilterEnv(filter, t) {
    const p = this.params;
    const peak = Math.min(16000, p.cutoff * Math.pow(2, p.envAmt * 4));
    filter.frequency.setValueAtTime(peak, t);
    filter.frequency.setTargetAtTime(p.cutoff, t, Math.max(0.01, p.fDecay) / 3);
  }

  /* ---------- UI ---------- */
  buildControls(container) {
    // Filtertyp: LP / HP / BP — wirkt sofort auch auf klingende Stimmen
    const seg = document.createElement('div');
    seg.className = 'seg';
    seg.innerHTML = `
      <span class="seg__label">Filter</span>
      <button class="seg__btn" data-ft="lowpass">LP</button>
      <button class="seg__btn" data-ft="highpass">HP</button>
      <button class="seg__btn" data-ft="bandpass">BP</button>
    `;
    seg.querySelectorAll('.seg__btn').forEach((b) =>
      b.classList.toggle('is-active', b.dataset.ft === this.params.filterType));
    seg.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-ft]');
      if (!btn) return;
      this.params.filterType = btn.dataset.ft;
      seg.querySelectorAll('.seg__btn').forEach((b) =>
        b.classList.toggle('is-active', b === btn));
      for (const v of this.voices.values()) v.filter.type = btn.dataset.ft;
    });
    container.appendChild(seg);

    const row = document.createElement('div');
    row.className = 'machine__row';
    row.innerHTML = `
      <x-knob label="Cutoff" min="80" max="12000" value="1800" curve="log" unit="Hz" data-p="cutoff" data-auto></x-knob>
      <x-knob label="Reso"   min="0.5" max="20"  value="4"  data-p="resonance" data-auto></x-knob>
      <x-knob label="Env Amt" min="0" max="1" value="0.3" data-p="envAmt" data-auto></x-knob>
      <x-knob label="F.Decay" min="0.03" max="1.5" value="0.18" curve="log" unit="s" data-p="fDecay" data-auto></x-knob>
      <x-knob label="Attack" min="0.002" max="1" value="0.005" curve="log" unit="s" data-p="attack" data-auto></x-knob>
      <x-knob label="Release" min="0.02" max="2" value="0.25" curve="log" unit="s" data-p="release" data-auto></x-knob>
      <x-knob label="Volume" min="0" max="1" value="0.7" data-p="volume" data-auto></x-knob>
    `;
    row.addEventListener('input', (e) => {
      const key = e.target.dataset?.p;
      if (!key) return;
      const val = e.detail.value;
      this.params[key] = val;

      // Live-Parameter direkt auf laufende Stimmen anwenden
      const t = engine.ctx.currentTime;
      if (key === 'cutoff') {
        for (const v of this.voices.values()) v.filter.frequency.setTargetAtTime(val, t, 0.01);
      } else if (key === 'resonance') {
        for (const v of this.voices.values()) v.filter.Q.setTargetAtTime(val, t, 0.01);
      } else if (key === 'volume') {
        this.output.gain.setTargetAtTime(val, t, 0.01);
      }
    });
    container.appendChild(row);

    this.patternBank = createPatternBank({
      index: this.patternIndex,
      onSwitch: (i) => { this.setPatternIndex(i); song.recordPattern(this.id, i); },
      onCopy: (i) => this.#copyPattern(i),
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

    container.appendChild(createKeybed({
      onNoteOn: (midi) => this.noteOn(midi),
      onNoteOff: (midi) => this.noteOff(midi),
    }));
  }

}
