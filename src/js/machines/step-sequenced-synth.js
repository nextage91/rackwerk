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
import { transport, shuffleTime } from '../core/transport.js';
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
    // Loser Hook fürs Rack (kompakte Zeile zeigt den aktiven Pattern-
    // Buchstaben) -- analog zu onMixerChange fürs Mute/Solo-Sync.
    this.onPatternChange?.();
  }

  /** Für Jam-Clip-Wiedergabe: Live-Sequenzer-Zustand direkt auf beliebige
   *  Daten binden, OHNE this.patterns/patternIndex zu berühren — ein Clip
   *  ist kein fünfter A/B/C/D-Slot, sondern läuft daneben. */
  bindClipData(data) {
    this.pattern = data;
    this.seq?.setPattern(this.pattern);
    automation.setBars(this.id, this.seq?.bars ?? 1);
  }

  /** Ob Pattern-Slot i überhaupt einen Ton enthält — für die Jam-Proto-
   *  Clip-Kacheln (jam-view.js), die leere Slots blass darstellen. */
  hasPatternContent(i) {
    return this.patterns[i].some((s) => s.on);
  }

  /** Pattern-Slot i direkt als neuen Jam-Clip anlegen — dieselbe Kopie wie
   *  über den Halten-Chip im Rack (s. buildPatternControls#onAddClip),
   *  nur ohne den Umweg dorthin (Jam-Proto-Clips, s. jam-view.js). */
  addClipFromPattern(i) {
    return this.addClip({ name: `Pattern ${'ABCD'[i]}`, shape: 'notes', data: this.patterns[i].map((s) => ({ ...s })), sourceSlot: i });
  }

  /* ---------- Sequenzer-Anbindung (vom Transport aufgerufen) ---------- */
  onStep(step, time) {
    // Pattern loopt selbst (1–8 Takte), relativ zu stepOffset (s. machine.js)
    // statt zum rohen globalen Schritt -- sonst startet ein frisch gebundener
    // Jam-Clip irgendwo mitten in seinem eigenen Takt statt bei Schritt 0.
    const len = this.pattern.length;
    const idx = (((step - this.stepOffset) % len) + len) % len;
    // Shuffle/Groove: verschiebt jeden zweiten 16tel (s. transport.js#
    // shuffleTime) -- pro Maschine einstellbar (this.params.shuffle,
    // Regler in buildPatternControls() unten), Default 50 = kein Effekt.
    const t = shuffleTime(step, time, this.params.shuffle, transport.stepDuration);
    const delayMs = (t - engine.now) * 1000;
    this.seq?.flashStep(idx, delayMs, transport.stepDuration * 900);

    const st = this.pattern[idx];
    // dur-Argument wird von playNote()-Implementierungen ohne Halte-Dauer
    // (z. B. PercSynth, deren Hüllkurve rein aus params.decay kommt) einfach
    // ignoriert — kein Sonderfall pro Unterklasse nötig.
    if (st.on) this.playNote(st.midi, t, transport.stepDuration * 0.8);
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
   *  eigenen Reglern/Keybed, je nach gewünschter Panel-Reihenfolge.
   *  `accentSlide` reicht die beiden zusätzlichen Tippzonen des Grids
   *  durch (s. step-seq.js) -- bislang nur vom AcidBass genutzt, Default
   *  false lässt alle anderen Unterklassen unverändert. */
  buildPatternControls(container, { accentSlide = false } = {}) {
    // Shuffle/Groove -- pro Maschine (s. transport.js#shuffleTime/Chat),
    // deshalb hier im Pattern-Teil statt im Transport verankert. Lazy-
    // Default direkt hier statt in jeder Unterklassen-buildAudio(): diese
    // Methode ist der EINE gemeinsame Ort, den alle Unterklassen sowieso
    // aufrufen, ein Default-Eintrag pro Unterklasse wäre nur Wiederholung.
    if (this.params.shuffle === undefined) this.params.shuffle = 50;
    const shuffleRow = document.createElement('div');
    shuffleRow.className = 'machine__row';
    shuffleRow.innerHTML = `<x-knob label="Shuffle" min="50" max="75" value="${this.params.shuffle}" unit="%" data-p="shuffle" data-auto></x-knob>`;
    shuffleRow.addEventListener('input', (e) => {
      if (e.target.dataset?.p === 'shuffle') this.params.shuffle = e.detail.value;
    });
    container.appendChild(shuffleRow);

    this.patternBank = createPatternBank({
      index: this.patternIndex,
      shape: 'notes',
      onSwitch: (i) => { this.setPatternIndex(i); song.recordPattern(this.id, i); },
      getSlot: (i) => this.patterns[i].map((s) => ({ ...s })),
      putSlot: (i, data) => { this.patterns[i] = data.map((s) => ({ ...s })); this.setPatternIndex(i); },
      onAddClip: (i) => this.addClipFromPattern(i),
    });
    container.appendChild(this.patternBank.el);

    this.seq = new StepSeq(this.pattern, {
      accentSlide,
      onLengthChange: (bars) => {
        resizePattern(this.pattern, bars);
        this.seq.setPattern(this.pattern);
        automation.setBars(this.id, bars, { resize: true }); // Lanes mitwachsen lassen
      },
    });
    container.appendChild(this.seq.el);
    this.seq.el.querySelector('.stepseq__title').textContent = ''; // Bank labelt schon
    // Automations-Lanes an die (ggf. geladene) Pattern-Länge koppeln
    automation.setBars(this.id, this.seq.bars);
  }
}
