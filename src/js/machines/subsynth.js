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
import { midiToHz, applyFilterEnv } from '../core/dsp.js';
import { automation } from '../core/automation.js';
import { song } from '../core/song.js';

/** Leeres 1-Takt-Pattern (16 Steps aus). */
const emptyPattern = (len = 16) =>
  Array.from({ length: len }, () => ({ on: false, midi: 48 }));

/**
 * Headroom für die Amp-Hüllkurve: Ohne diese Skalierung ramp(t) immer bis
 * 1 (volle Aussteuerung) — anders als bei der BeatBox, wo jeder Drum-Klang
 * intern schon gegen die anderen austariert ist (Kick 1.0, Snare-Körper
 * 0.5, Hats 0.45 …). Gemessen (OfflineAudioContext, RMS über 0.6 s nach
 * Trigger, jeweils an Default-Einstellungen): eine gehaltene SubSynth-Note
 * lag ohne Headroom 7 dB über einem einzelnen Kick und 13 dB über der
 * Snare — ein Sequenzer-Bass drängt sich damit permanent vor den Rest des
 * Kits, weil er (anders als ein perkussiver Klang) die ganze Notenlänge
 * über nahe der Spitzenlautstärke gehalten wird statt abzuklingen.
 */
const VOICE_HEADROOM = 0.6;

export class SubSynth extends Machine {
  static meta = {
    type: 'subsynth',
    name: 'SubSynth',
    desc: 'Subtractive synth with lowpass filter',
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

    /** 4 leere Pattern-Slots (A/B/C/D), {on, midi} pro Step. `this.pattern`
     *  zeigt aufs aktive Slot. Die Demo-Line kommt nicht von hier, sondern
     *  optional über seedDemo() (s. dort). */
    this.patterns = [emptyPattern(), emptyPattern(), emptyPattern(), emptyPattern()];
    this.patternIndex = 0;
    this.pattern = this.patterns[0];
  }

  /**
   * Kleine Acid-Line in Slot A einfüllen — nur von der Startbesetzung einer
   * neuen Session genutzt (project.js#newProject), damit die App sofort
   * klingt. Über "+ Add Machine" hinzugefügte Maschinen bleiben leer.
   */
  seedDemo() {
    const seed = { 0: 36, 3: 48, 6: 36, 8: 39, 11: 48, 14: 46 };
    for (const [step, midi] of Object.entries(seed)) {
      this.patterns[0][step].on = true;
      this.patterns[0][step].midi = midi;
    }
    if (this.patternIndex === 0) this.seq?.setPattern(this.pattern);
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

  /** Für Jam-Clip-Wiedergabe: Live-Sequenzer-Zustand direkt auf beliebige
   *  Daten binden, OHNE this.patterns/patternIndex zu berühren — ein Clip
   *  ist kein fünfter A/B/C/D-Slot, sondern läuft daneben. */
  bindClipData(data) {
    this.pattern = data;
    this.seq?.setPattern(this.pattern);
    automation.setBars(this.id, this.seq?.bars ?? 1);
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
      pan: this.pan,
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
    this.setPan(state.pan ?? 0);
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
    applyFilterEnv(filter, time, p);

    const env = ctx.createGain();
    const atk = Math.min(p.attack, dur * 0.5); // Attack nie länger als die Note
    env.gain.setValueAtTime(0, time);
    env.gain.linearRampToValueAtTime(VOICE_HEADROOM, time + atk);
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
    if (this.isLiveRecording) {
      const idx = this.liveStepIndex(this.pattern.length);
      this.pattern[idx] = { on: true, midi };
      this.seq?.refreshStep(idx);
    }
    const ctx = engine.ctx;
    const t = ctx.currentTime;
    const p = this.params;

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = midiToHz(midi);

    const filter = ctx.createBiquadFilter();
    filter.type = p.filterType;
    filter.Q.value = p.resonance;
    applyFilterEnv(filter, t, p);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(VOICE_HEADROOM, t + p.attack);

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
      onAddClip: (i, letter) => {
        this.addClip({ name: `Pattern ${letter}`, shape: 'notes', data: this.patterns[i].map((s) => ({ ...s })) });
      },
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
