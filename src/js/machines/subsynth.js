/**
 * SubSynth — erste Beispielmaschine, damit das Rack von Anfang an klingt.
 *
 * Signalfluss pro Stimme:
 *   Oscillator (Saw) → Lowpass-Filter → Hüllkurven-Gain → machine.output
 *
 * Ein Touch-Keybed (eine Oktave) mit Glissando-Unterstützung dient als
 * Spielfläche; später ersetzt/ergänzt durch den Pattern-Sequenzer.
 *
 * Pattern-Bank/Step-Grid/Jam-Clip-Bindung sitzen in StepSequencedSynth —
 * hier bleibt nur, was den SubSynth-Klangcharakter und die gehaltenen
 * Keybed-Stimmen ausmacht.
 */
import { StepSequencedSynth } from './step-sequenced-synth.js';
import { engine } from '../core/audio-engine.js';
import { createKeybed } from '../ui/keybed.js';
import { midiToHz, applyFilterEnv } from '../core/dsp.js';

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

export class SubSynth extends StepSequencedSynth {
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
    this.patterns = [this.emptyPattern(), this.emptyPattern(), this.emptyPattern(), this.emptyPattern()];
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
    // KEIN Math.min(p.attack, dur * 0.5) mehr (frühere Fassung) -- die
    // anschliessende setTargetAtTime(0, time+dur, ...) startet ihre
    // Abklingkurve ohnehin korrekt von dem Wert, den die noch laufende
    // Attack-Rampe zu diesem Zeitpunkt tatsächlich hätte (kein expliziter
    // "Sprung"-Anker wie beim alten Modular-Envelope-Bug, s. dort) --
    // die Kappe verhinderte hier gar keinen Sprung, sie machte den Regler
    // bei kurzen Sequenzer-Schritten nur wirkungslos (Chat: "kann es sein
    // das der attack wert der envelope mit bis max. 1s zu tief ist").
    env.gain.setValueAtTime(0, time);
    env.gain.linearRampToValueAtTime(VOICE_HEADROOM, time + p.attack);
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
      <x-knob label="Attack" min="0.002" max="10" value="0.005" curve="log" unit="s" data-p="attack" data-auto></x-knob>
      <x-knob label="Release" min="0.02" max="10" value="0.25" curve="log" unit="s" data-p="release" data-auto></x-knob>
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

    this.buildPatternControls(container);

    container.appendChild(createKeybed({
      // Bei aktivem Arpeggiator-Modulator übernimmt der die gehaltenen
      // Noten (s. modulators.js) statt sie direkt an die eigene Stimmen-
      // verwaltung zu geben -- derselbe Umleitungspunkt bei PolySynth/
      // FMSynth (s. dort für die ausführliche Begründung).
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

  /** SubSynth hält Stimmen (this.voices) -- ein Arpeggiator hat hier
   *  wirklich gehaltene Noten zum Arbeiten (anders als PercSynths reines
   *  Fire-and-Forget, s. machine.js#modulatorTypes). */
  get modulatorTypes() { return ['lfo', 'arp']; }
}
