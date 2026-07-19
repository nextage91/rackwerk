/**
 * StepSequencedSynth — gemeinsame Basis für notengetriebene Pattern-Synths
 * (SubSynth, PercSynth, PolySynth): 4 A/B/C/D-Pattern-Slots mit {on, midi}
 * pro Step, Pattern-Bank + Step-Grid im Panel, Jam-Clip-Bindung.
 *
 * Unterklassen liefern weiterhin selbst:
 *   static meta         — Registry/Faceplate-Angaben
 *   static DEFAULT_MIDI — Vorbelegung für neue/leere Pattern-Steps
 *                         (Default 48, PercSynth überschreibt auf 76)
 *   buildAudio()         — eigene params + this.patterns/this.pattern setzen
 *   playNote(midi, time, dur?) — Klangerzeugung (Sequenzer-Trigger)
 *   buildControls()      — eigenes Panel; ruft buildPatternControls() für
 *                          den gemeinsamen Pattern-Bank/Grid-Teil auf
 * Stimmenverwaltung (gehaltene Keybed-Noten via noteOn/noteOff) bleibt
 * bewusst in den Unterklassen: PercSynth ist rein fire-and-forget ohne
 * gehaltene Stimmen, SubSynth/PolySynth halten Noten — zu unterschiedlich
 * für eine gemeinsame Basis.
 */
import { Machine } from './machine.js';
import { engine } from '../core/audio-engine.js';
import { transport } from '../core/transport.js';
import { StepSeq, resizePattern } from '../ui/step-seq.js';
import { createPatternBank } from '../ui/pattern-bank.js';
import { automation } from '../core/automation.js';
import { song } from '../core/song.js';

export class StepSequencedSynth extends Machine {
  static DEFAULT_MIDI = 48;

  /** Leeres 1-Takt-Pattern (16 Steps aus). Bewusst KEIN privates Feld
   *  (kein #): buildAudio() ruft das aus dem Konstruktor der Basisklasse
   *  Machine heraus auf, bevor private Elemente dieser Zwischenklasse
   *  initialisiert sind (dieselbe Falle wie bei TrackedDrumMachine#
   *  emptySlot, real reproduziert: "Receiver must be an instance of
   *  class ..."). */
  emptyPattern(len = 16) {
    return Array.from({ length: len }, () => ({ on: false, midi: this.constructor.DEFAULT_MIDI }));
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
    // dur-Argument wird von playNote()-Implementierungen ohne Halte-Dauer
    // (z. B. PercSynth, deren Hüllkurve rein aus params.decay kommt) einfach
    // ignoriert — kein Sonderfall pro Unterklasse nötig.
    if (st.on) this.playNote(st.midi, time, transport.stepDuration * 0.8);
  }

  onTransport(event) {
    if (event === 'stop') this.seq?.clearPlayhead();
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
      this.patterns = [a, this.emptyPattern(a.length), this.emptyPattern(a.length), this.emptyPattern(a.length)];
      this.patternIndex = 0;
    }
    while (this.patterns.length < 4) this.patterns.push(this.emptyPattern());
    this.pattern = this.patterns[this.patternIndex] ?? this.patterns[0];
    this.output.gain.value = this.params.volume;
    this.setPan(state.pan ?? 0);
  }

  /** Pattern-Bank (A/B/C/D) + gemeinsames Step-Grid in den Body bauen —
   *  identisch für alle notengetriebenen Synths. Erwartet this.patterns/
   *  this.pattern/this.patternIndex bereits aus buildAudio() gesetzt.
   *  Unterklassen rufen das aus buildControls() auf, VOR/NACH ihren
   *  eigenen Reglern/Keybed, je nach gewünschter Panel-Reihenfolge. */
  buildPatternControls(container) {
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
  }
}
