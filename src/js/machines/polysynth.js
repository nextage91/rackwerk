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
 *
 * Pattern-Bank/Step-Grid/Jam-Clip-Bindung sitzen in StepSequencedSynth —
 * hier bleibt nur, was den PolySynth-Klangcharakter (Chord-Voicing) und
 * die gehaltenen Keybed-Stimmen ausmacht.
 */
import { StepSequencedSynth } from './step-sequenced-synth.js';
import { engine } from '../core/audio-engine.js';
import { createKeybed } from '../ui/keybed.js';
import { midiToHz, applyFilterEnv } from '../core/dsp.js';
import { automation } from '../core/automation.js';

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
/** Feste Reihenfolge für die Chord-Automation (Lane speichert einen
 *  Options-INDEX, nicht den String-Key — s. automation.js#recordSwitch). */
const CHORD_KEYS = Object.keys(CHORDS);

/** Headroom pro Einzelstimme — durch Wurzel(Stimmenzahl) geteilt, damit ein
 *  4-stimmiger Maj7 nicht deutlich lauter ist als ein Single-Voicing (grobe
 *  RMS-Kompensation für die Summe unkorrelierter Oszillatoren). Basiswert
 *  wie bei SubSynth (dort ausführlich gegen den Rest des Kits austariert). */
const VOICE_HEADROOM = 0.6;

export class PolySynth extends StepSequencedSynth {
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
    this.patterns = [this.emptyPattern(), this.emptyPattern(), this.emptyPattern(), this.emptyPattern()];
    this.patternIndex = 0;
    this.pattern = this.patterns[0];
  }

  /* ---------- Persistenz: chordType kommt oben drauf ---------- */
  serialize() {
    return { ...super.serialize(), chordType: this.chordType };
  }

  deserialize(state) {
    super.deserialize(state);
    if (state.chordType && CHORDS[state.chordType]) this.chordType = state.chordType;
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
    applyFilterEnv(filter, t, p);

    return { osc, filter };
  }

  /**
   * Fire-and-forget-Voicing für den Sequenzer — eine Stimme pro Chord-Ton,
   * alle sample-genau bei `time` geplant.
   */
  playNote(rootMidi, time, dur, vel = 1) {
    time = engine.quantizeTime(time);
    this.pulse(time);
    const offsets = CHORDS[this.chordType].offsets;
    const headroom = VOICE_HEADROOM / Math.sqrt(offsets.length);
    const p = this.params;

    for (const offset of offsets) {
      const midi = rootMidi + p.transpose + offset;
      const { osc, filter } = this.#buildVoice(midi, time);

      const env = engine.ctx.createGain();
      // KEIN Math.min(p.attack, dur*0.5) mehr -- s. subsynth.js#playNote
      // für die Begründung (dieselbe Kappe, derselbe unnötige Effekt).
      env.gain.setValueAtTime(0, time);
      env.gain.linearRampToValueAtTime(headroom * vel, time + p.attack);
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

  /* ---------- UI ---------- */
  buildControls(container) {
    // Chord-Typ: bestimmt die Voicing künftig getriggerter Noten (wirkt
    // NICHT rückwirkend auf schon klingende Stimmen — sonst tauchen/
    // verschwinden Töne scheinbar grundlos aus einem gehaltenen Akkord).
    // Automatisierbar wie ein Knob (registerSwitch/recordSwitch, s.
    // automation.js) -- die Lane speichert den Options-INDEX (Position in
    // CHORD_KEYS), kein Ziehen nötig: jeder Klick schreibt sofort einen
    // Wertwechsel ab der aktuellen Playhead-Position (Halte-/Step-
    // Verhalten, keine Überblendung zwischen zwei Chord-Typen).
    const seg = document.createElement('div');
    seg.className = 'seg';
    seg.setAttribute('label', 'Chord');
    seg.innerHTML = `
      <span class="seg__label">Chord</span>
      ${Object.entries(CHORDS).map(([key, c]) =>
        `<button class="seg__btn" data-chord="${key}">${c.label}</button>`).join('')}
    `;
    const syncChordButtons = () => seg.querySelectorAll('.seg__btn').forEach((b) =>
      b.classList.toggle('is-active', b.dataset.chord === this.chordType));
    syncChordButtons();
    seg.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-chord]');
      if (!btn) return;
      const oldIdx = CHORD_KEYS.indexOf(this.chordType);
      this.chordType = btn.dataset.chord;
      syncChordButtons();
      automation.recordSwitch(`${this.id}:chordType`, oldIdx, CHORD_KEYS.indexOf(this.chordType));
    });
    container.appendChild(seg);

    automation.registerSwitch(`${this.id}:chordType`, seg, (v) => {
      const idx = Math.max(0, Math.min(CHORD_KEYS.length - 1, Math.round(v)));
      this.chordType = CHORD_KEYS[idx];
      syncChordButtons();
    });

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
      <x-knob label="Attack" min="0.002" max="10" value="0.02" curve="log" unit="s" data-p="attack" data-auto></x-knob>
      <x-knob label="Release" min="0.02" max="10" value="0.6" curve="log" unit="s" data-p="release" data-auto></x-knob>
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

    this.buildPatternControls(container);

    container.appendChild(createKeybed({
      // s. subsynth.js für die ausführliche Begründung des Arp-Umleitungspunkts.
      onNoteOn: (midi) => {
        const arp = this.getActiveModulator('arp');
        if (arp) arp.noteOn(midi); else this.noteOn(midi);
      },
      onNoteOff: (midi) => {
        const arp = this.getActiveModulator('arp');
        if (arp) arp.noteOff(midi); else this.noteOff(midi);
      },
    }));
  }

  get modulatorTypes() { return ['lfo', 'arp']; }
}
