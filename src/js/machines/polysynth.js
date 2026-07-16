/**
 * PolySynth — Akkord-Synth. Baut auf derselben Engine wie SubSynth
 * (Sawtooth → Lowpass → Amp-Hüllkurve), aber jede gespielte/sequenzierte
 * Note ist eine ROOT-Note: der Chord-Typ (Voicing, z. B. Maj7) bestimmt,
 * wie viele zusätzliche Stimmen im festen Intervall dazu erklingen.
 * Dadurch bleibt das Pattern-Format unverändert ({on, midi} pro Step,
 * genau wie bei SubSynth) — programmiert wird nur die eine Root-Note,
 * den Rest baut die Maschine aus dem gewählten Chord-Typ.
 *
 * Der Transpose-Knob (automatisierbar) verschiebt die ganze Voicing in
 * Halbtonschritten — auch live, für bereits klingende (gehaltene) Noten.
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

/** Chord-Voicings als Halbtonabstände zur Root-Note. */
const CHORDS = {
  single: { label: 'Single', offsets: [0] },
  fifth:  { label: '5th',    offsets: [0, 7] },
  maj:    { label: 'Maj',    offsets: [0, 4, 7] },
  min:    { label: 'Min',    offsets: [0, 3, 7] },
  maj7:   { label: 'Maj7',   offsets: [0, 4, 7, 11] },
  min7:   { label: 'Min7',   offsets: [0, 3, 7, 10] },
  sus4:   { label: 'Sus4',   offsets: [0, 5, 7] },
};

/** Leeres 1-Takt-Pattern (16 Steps aus). */
const emptyPattern = (len = 16) =>
  Array.from({ length: len }, () => ({ on: false, midi: 48 }));

/** Headroom pro Einzelstimme — durch Wurzel(Stimmenzahl) geteilt, damit ein
 *  4-stimmiger Maj7 nicht deutlich lauter ist als ein Single-Voicing (grobe
 *  RMS-Kompensation für die Summe unkorrelierter Oszillatoren). Basiswert
 *  wie bei SubSynth (dort ausführlich gegen den Rest des Kits austariert). */
const VOICE_HEADROOM = 0.6;

export class PolySynth extends Machine {
  static meta = {
    type: 'polysynth',
    name: 'PolySynth',
    desc: 'Chord synth — one root note, a full voicing',
    color: '#b98fd1',
    model: 'RW-04',
  };

  buildAudio() {
    this.params = {
      cutoff: 2200,
      resonance: 3,
      envAmt: 0.2,
      fDecay: 0.3,
      attack: 0.02,
      release: 0.6,
      volume: 0.7,
      filterType: 'lowpass',
      transpose: 0,
    };
    this.chordType = 'maj';
    /** aktive Stimmen: Root-MIDI → [{osc, filter, env, offset}, …] */
    this.voices = new Map();
    this.output.gain.value = this.params.volume;

    /** 4 leere Pattern-Slots (A/B/C/D) — neu hinzugefügte Maschinen starten
     *  ohne vorprogrammierte Steps. */
    this.patterns = [emptyPattern(), emptyPattern(), emptyPattern(), emptyPattern()];
    this.patternIndex = 0;
    this.pattern = this.patterns[0];
  }

  /* ---------- Pattern-Bank (A/B/C/D) ---------- */
  setPatternIndex(i) {
    this.patternIndex = i;
    this.pattern = this.patterns[i];
    this.seq?.setPattern(this.pattern);
    this.patternBank?.setActive(i);
    automation.setBars(this.id, this.seq?.bars ?? 1);
  }

  /* ---------- Sequenzer-Anbindung (vom Transport aufgerufen) ---------- */
  onStep(step, time) {
    const idx = step % this.pattern.length;
    const delayMs = (time - engine.now) * 1000;
    this.seq?.flashStep(idx, delayMs, transport.stepDuration * 900);

    const st = this.pattern[idx];
    if (st.on) this.playNote(st.midi, time, transport.stepDuration * 0.8);
  }

  serialize() {
    return {
      params: { ...this.params },
      chordType: this.chordType,
      patterns: this.patterns.map((p) => p.map((s) => ({ ...s }))),
      patternIndex: this.patternIndex,
      pan: this.pan,
    };
  }

  deserialize(state) {
    Object.assign(this.params, state.params);
    if (state.chordType && CHORDS[state.chordType]) this.chordType = state.chordType;
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
    this.setPan(state.pan ?? 0);
  }

  onTransport(event) {
    if (event === 'stop') this.seq?.clearPlayhead();
  }

  /* ---------- Ein-Stimmen-Aufbau (geteilt zwischen Sequenzer & Keybed) ---------- */
  #buildVoice(midi, t) {
    const ctx = engine.ctx;
    const p = this.params;

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = midiToHz(midi);

    const filter = ctx.createBiquadFilter();
    filter.type = p.filterType;
    filter.Q.value = p.resonance;
    this.#applyFilterEnv(filter, t);

    return { osc, filter };
  }

  /**
   * Fire-and-forget-Voicing für den Sequenzer — eine Stimme pro Chord-Ton,
   * alle sample-genau bei `time` geplant.
   */
  playNote(rootMidi, time, dur) {
    time = engine.quantizeTime(time);
    this.pulse(time);
    const offsets = CHORDS[this.chordType].offsets;
    const headroom = VOICE_HEADROOM / Math.sqrt(offsets.length);
    const p = this.params;

    for (const offset of offsets) {
      const midi = rootMidi + p.transpose + offset;
      const { osc, filter } = this.#buildVoice(midi, time);

      const env = engine.ctx.createGain();
      const atk = Math.min(p.attack, dur * 0.5);
      env.gain.setValueAtTime(0, time);
      env.gain.linearRampToValueAtTime(headroom, time + atk);
      env.gain.setTargetAtTime(0, time + dur, p.release / 4);

      osc.connect(filter).connect(env).connect(this.output);
      osc.start(time);
      osc.stop(time + dur + p.release + 0.1);
      osc.onended = () => { osc.disconnect(); filter.disconnect(); env.disconnect(); };
    }
  }

  /* ---------- Stimmenverwaltung (gehaltene Keybed-Voicings) ---------- */
  noteOn(rootMidi) {
    if (this.voices.has(rootMidi)) return;
    this.pulse();
    if (this.isLiveRecording) {
      const idx = this.liveStepIndex(this.pattern.length);
      this.pattern[idx] = { on: true, midi: rootMidi };
      this.seq?.refreshStep(idx);
    }
    const t = engine.ctx.currentTime;
    const offsets = CHORDS[this.chordType].offsets;
    const headroom = VOICE_HEADROOM / Math.sqrt(offsets.length);
    const p = this.params;

    const voiceList = offsets.map((offset) => {
      const midi = rootMidi + p.transpose + offset;
      const { osc, filter } = this.#buildVoice(midi, t);

      const env = engine.ctx.createGain();
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(headroom, t + p.attack);

      osc.connect(filter).connect(env).connect(this.output);
      osc.start(t);

      return { osc, filter, env, offset };
    });

    this.voices.set(rootMidi, voiceList);
  }

  noteOff(rootMidi) {
    const voiceList = this.voices.get(rootMidi);
    if (!voiceList) return;
    this.voices.delete(rootMidi);

    const t = engine.ctx.currentTime;
    const rel = this.params.release;
    for (const v of voiceList) {
      v.env.gain.cancelScheduledValues(t);
      v.env.gain.setTargetAtTime(0, t, rel / 4);
      v.osc.stop(t + rel + 0.1);
      v.osc.onended = () => { v.osc.disconnect(); v.filter.disconnect(); v.env.disconnect(); };
    }
  }

  allNotesOff() {
    for (const midi of [...this.voices.keys()]) this.noteOff(midi);
  }

  disposeAudio() {
    this.allNotesOff();
  }

  /** Filterhüllkurve — wie bei SubSynth: startet über dem Cutoff, fällt
   *  darauf zurück. Gilt für jede Stimme einzeln, gleich wie beim Filter. */
  #applyFilterEnv(filter, t) {
    const p = this.params;
    const peak = Math.min(16000, p.cutoff * Math.pow(2, p.envAmt * 4));
    filter.frequency.setValueAtTime(peak, t);
    filter.frequency.setTargetAtTime(p.cutoff, t, Math.max(0.01, p.fDecay) / 3);
  }

  /* ---------- UI ---------- */
  buildControls(container) {
    // Chord-Typ: bestimmt die Voicing künftig getriggerter Noten (wirkt
    // NICHT rückwirkend auf schon klingende Stimmen — sonst tauchen/
    // verschwinden Töne scheinbar grundlos aus einem gehaltenen Akkord).
    const seg = document.createElement('div');
    seg.className = 'seg';
    seg.innerHTML = `
      <span class="seg__label">Chord</span>
      ${Object.entries(CHORDS).map(([key, c]) =>
        `<button class="seg__btn" data-chord="${key}">${c.label}</button>`).join('')}
    `;
    seg.querySelectorAll('.seg__btn').forEach((b) =>
      b.classList.toggle('is-active', b.dataset.chord === this.chordType));
    seg.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-chord]');
      if (!btn) return;
      this.chordType = btn.dataset.chord;
      seg.querySelectorAll('.seg__btn').forEach((b) =>
        b.classList.toggle('is-active', b === btn));
    });
    container.appendChild(seg);

    // Filtertyp — wie bei SubSynth, wirkt sofort auch auf klingende Stimmen
    const filterSeg = document.createElement('div');
    filterSeg.className = 'seg';
    filterSeg.innerHTML = `
      <span class="seg__label">Filter</span>
      <button class="seg__btn" data-ft="lowpass">LP</button>
      <button class="seg__btn" data-ft="highpass">HP</button>
      <button class="seg__btn" data-ft="bandpass">BP</button>
    `;
    filterSeg.querySelectorAll('.seg__btn').forEach((b) =>
      b.classList.toggle('is-active', b.dataset.ft === this.params.filterType));
    filterSeg.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-ft]');
      if (!btn) return;
      this.params.filterType = btn.dataset.ft;
      filterSeg.querySelectorAll('.seg__btn').forEach((b) =>
        b.classList.toggle('is-active', b === btn));
      for (const voiceList of this.voices.values())
        for (const v of voiceList) v.filter.type = btn.dataset.ft;
    });
    container.appendChild(filterSeg);

    const row = document.createElement('div');
    row.className = 'machine__row';
    row.innerHTML = `
      <x-knob label="Cutoff" min="80" max="12000" value="2200" curve="log" unit="Hz" data-p="cutoff" data-auto></x-knob>
      <x-knob label="Reso"   min="0.5" max="20"  value="3"  data-p="resonance" data-auto></x-knob>
      <x-knob label="Env Amt" min="0" max="1" value="0.2" data-p="envAmt" data-auto></x-knob>
      <x-knob label="F.Decay" min="0.03" max="1.5" value="0.3" curve="log" unit="s" data-p="fDecay" data-auto></x-knob>
      <x-knob label="Attack" min="0.002" max="1" value="0.02" curve="log" unit="s" data-p="attack" data-auto></x-knob>
      <x-knob label="Release" min="0.02" max="2" value="0.6" curve="log" unit="s" data-p="release" data-auto></x-knob>
      <x-knob label="Transpose" min="-24" max="24" step="1" default="0" value="0" data-p="transpose" data-auto></x-knob>
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
        for (const voiceList of this.voices.values())
          for (const v of voiceList) v.filter.frequency.setTargetAtTime(val, t, 0.01);
      } else if (key === 'resonance') {
        for (const voiceList of this.voices.values())
          for (const v of voiceList) v.filter.Q.setTargetAtTime(val, t, 0.01);
      } else if (key === 'transpose') {
        // Gehaltene Stimmen live nachziehen — dafür ist der Knob da:
        // während der Akkord klingt (oder automatisiert läuft), am
        // Transpose drehen und die ganze Voicing gleitet mit.
        for (const [rootMidi, voiceList] of this.voices) {
          for (const v of voiceList) {
            const midi = rootMidi + val + v.offset;
            v.osc.frequency.setTargetAtTime(midiToHz(midi), t, 0.01);
          }
        }
      } else if (key === 'volume') {
        this.setLevel(val); // eine Quelle der Wahrheit, auch für den Mixer
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
        automation.setBars(this.id, bars);
      },
    });
    container.appendChild(this.seq.el);
    this.seq.el.querySelector('.stepseq__title').textContent = '';
    automation.setBars(this.id, this.seq.bars);

    container.appendChild(createKeybed({
      onNoteOn: (midi) => this.noteOn(midi),
      onNoteOff: (midi) => this.noteOff(midi),
    }));
  }
}
