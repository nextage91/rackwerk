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
import { midiToHz, applyFilterEnv, makeLadderFilter, trackVoice, scheduleVoicePhaseRelease, liveReanchorAttack, liveReanchorDecay } from '../core/dsp.js';

/** Baut den Filterknoten für eine Stimme -- entweder ein natives
 *  BiquadFilterNode (LP/HP/BP, wie bisher) oder den selbstschwingungs-
 *  fähigen Ladder-Tiefpass (s. core/dsp.js#makeLadderFilter, generalisiert
 *  aus AcidBass' TB-303-Filterkern). Ein Ladder-Filter ist strukturell ein
 *  anderer Knotentyp (ein `.input`/`.output`-Wrapper um einen Worklet-Knoten,
 *  kein einzelnes natives AudioNode) -- deshalb hier eine gemeinsame Stelle
 *  statt an jeder Anschlussstelle einzeln zu unterscheiden. Ein Wechsel des
 *  Filtertyps WÄHREND eine Note klingt (s. buildControls unten) baut
 *  bestehende Stimmen bewusst NICHT um (bräuchte ein komplettes Rewiring
 *  mitten im Klingen) -- er gilt erst für die nächste neu angeschlagene Note,
 *  identisch zu Devil-Fish-artigen Hardware-Filtern, die auch nicht mitten
 *  im Ton die Topologie wechseln. */
function createFilterNode(ctx, p) {
  const filter = p.filterType === 'ladder' ? makeLadderFilter(ctx) : ctx.createBiquadFilter();
  filter.type = p.filterType;
  filter.Q.value = p.resonance;
  return filter;
}
/** Der Ladder-Wrapper hat `.input`/`.output` (zwei stabile GainNodes), ein
 *  natives BiquadFilterNode ist selbst schon Ein- UND Ausgang zugleich. */
const filterIn = (f) => f.input ?? f;
const filterOut = (f) => f.output ?? f;
/** BiquadFilterNode kennt nur `.disconnect()`; der Ladder-Wrapper braucht
 *  `.dispose()` (stoppt zusätzlich die beiden ConstantSourceNodes hinter
 *  `.frequency`/`.Q`, s. core/dsp.js) -- sonst liefen die für immer weiter. */
const disposeFilterNode = (f) => (f.dispose ? f.dispose() : f.disconnect());

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

/** Deckel für gleichzeitig GEHALTENE Keybed-Stimmen (this.voices, s. unten)
 *  -- ohne den würde jede neue, andere Tonhöhe unbegrenzt neue native
 *  Audio-Nodes anhäufen (Arp/viele gehaltene Tasten über eine lange Jam-
 *  Session, besonders auf dem Handy ein reales Ressourcenrisiko). Beim
 *  Erreichen wird die ÄLTESTE Stimme "gestohlen" (s. noteOn/noteOff unten)
 *  -- ausreichend hoch für jedes reale Spielen mit zwei Händen plus Arp,
 *  ohne spürbar zu limitieren. */
const MAX_VOICES = 16;
/** Fester, sehr kurzer Release beim Stimmen-Diebstahl -- deutlich kürzer
 *  als der reguläre, vom Nutzer eingestellte Release (der oft viel länger
 *  ist), aber lang genug, um den harten Cutoff hörbar zu entschärfen
 *  (Fast-Fade-Out statt Klick). */
const STEAL_RELEASE_S = 0.015;

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
      transpose: 0,       // Halbtöne -- verschiebt die ganze gezeichnete
                           // Pattern-Linie, ohne die Steps selbst zu ändern
                           // (Nutzer-Anfrage), s. polysynth.js für dasselbe
                           // Prinzip/denselben Knob.
    };
    /** aktive Stimmen: midi → {osc, filter, env} */
    this.voices = new Map();
    // Verfolgt JEDE klingende Stimme (gehalten UND Sequenzer-Fire-and-
    // Forget) über ihre gesamte Hörbarkeitsdauer inkl. Release, s. dsp.js#
    // trackVoice fürs "Warum" (Chat: "so nah wie möglich beim Original
    // DX7/Operator... das gilt für alle Parameter" -- Regler sollen bereits
    // klingende/ausklingende Noten live nachziehen, nicht nur die nächste).
    this.activeVoices = new Set();
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
  playNote(midi, time, dur, vel = 1) {
    time = engine.quantizeTime(time); // konsistente Block-Ausrichtung
    this.pulse(time);
    const ctx = engine.ctx;
    const p = this.params;

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = midiToHz(midi + p.transpose);

    const filter = createFilterNode(ctx, p);
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
    const attackTarget = VOICE_HEADROOM * vel;
    env.gain.setValueAtTime(0, time);
    env.gain.linearRampToValueAtTime(attackTarget, time + p.attack);
    env.gain.setTargetAtTime(0, time + dur, p.release / 4);

    osc.connect(filterIn(filter));
    filterOut(filter).connect(env).connect(this.output);
    osc.start(time);
    const stopAt = time + dur + p.release + 0.1;
    osc.stop(stopAt);

    // Live-Reglernachführung (s. dsp.js#trackVoice): diese Fire-and-Forget-
    // Stimme bleibt in activeVoices bis sie tatsächlich verstummt, nicht
    // nur bis playNote() zurückkehrt -- der Release-Regler muss sie auch
    // NACH `time+dur` noch erreichen können, während sie ausklingt.
    const voice = { osc, filter, env, attackTarget };
    trackVoice(this.activeVoices, voice);
    scheduleVoicePhaseRelease(voice, time, time + dur);
    osc.onended = () => { osc.disconnect(); disposeFilterNode(filter); env.disconnect(); this.activeVoices.delete(voice); };
  }

  /* ---------- Stimmenverwaltung ---------- */
  noteOn(midi) {
    if (this.voices.has(midi)) return;
    // Deckel erreicht -- älteste Stimme (erster Map-Eintrag, Maps behalten
    // Einfügereihenfolge) mit kurzem Fade-Out abräumen statt unbegrenzt
    // weitere Nodes anzuhäufen, s. MAX_VOICES oben.
    if (this.voices.size >= MAX_VOICES) this.noteOff(this.voices.keys().next().value, true);
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
    osc.frequency.value = midiToHz(midi + p.transpose);

    const filter = createFilterNode(ctx, p);
    applyFilterEnv(filter, t, p);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(VOICE_HEADROOM, t + p.attack);

    osc.connect(filterIn(filter));
    filterOut(filter).connect(env).connect(this.output);
    osc.start(t);

    // Map-Schlüssel bleibt die ROHE (nicht transponierte) MIDI-Note -- so
    // findet noteOff(midi) mit derselben Note vom Keybed die Stimme wieder,
    // unabhängig davon, ob Transpose inzwischen weitergedreht wurde.
    const voice = { osc, filter, env, attackTarget: VOICE_HEADROOM };
    trackVoice(this.activeVoices, voice);
    this.voices.set(midi, voice);
  }

  /** `steal`: true nur beim Verdrängen durch MAX_VOICES (s. noteOn oben) --
   *  fester, sehr kurzer Release statt des vom Nutzer eingestellten. */
  noteOff(midi, steal = false) {
    const v = this.voices.get(midi);
    if (!v) return;
    this.voices.delete(midi);

    const t = engine.ctx.currentTime;
    const rel = steal ? STEAL_RELEASE_S : this.params.release;
    v.env.gain.cancelScheduledValues(t);
    v.env.gain.setTargetAtTime(0, t, rel / 4);
    v.osc.stop(t + rel + 0.1);
    // Echtes, synchrones Ereignis -- anders als playNote() braucht noteOff()
    // keinen scheduleVoicePhaseRelease()-Timer, s. dsp.js#trackVoice.
    v.phase = 'release';
    v.osc.onended = () => { v.osc.disconnect(); disposeFilterNode(v.filter); v.env.disconnect(); this.activeVoices.delete(v); };
  }

  allNotesOff() {
    for (const midi of [...this.voices.keys()]) this.noteOff(midi);
  }

  disposeAudio() {
    this.allNotesOff();
  }

  /* ---------- UI ---------- */
  buildControls(container) {
    // Filtertyp: LP / HP / BP wirken sofort auch auf klingende Stimmen
    // (natives BiquadFilterNode, reiner Typ-Umschalter). Ladder ist
    // strukturell ein anderer Knoten (s. createFilterNode oben) -- ein
    // Wechsel zu/von Ladder gilt deshalb erst für die NÄCHSTE neu
    // angeschlagene Note, bereits klingende Stimmen behalten ihren
    // bisherigen Filtertyp bis sie enden.
    const seg = document.createElement('div');
    seg.className = 'seg';
    seg.innerHTML = `
      <span class="seg__label">Filter</span>
      <button class="seg__btn" data-ft="lowpass">LP</button>
      <button class="seg__btn" data-ft="highpass">HP</button>
      <button class="seg__btn" data-ft="bandpass">BP</button>
      <button class="seg__btn" data-ft="ladder">Ladder</button>
    `;
    seg.querySelectorAll('.seg__btn').forEach((b) =>
      b.classList.toggle('is-active', b.dataset.ft === this.params.filterType));
    seg.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-ft]');
      if (!btn) return;
      this.params.filterType = btn.dataset.ft;
      seg.querySelectorAll('.seg__btn').forEach((b) =>
        b.classList.toggle('is-active', b === btn));
      for (const v of this.activeVoices) v.filter.type = btn.dataset.ft;
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
      <x-knob label="Transpose" min="-24" max="24" step="1" default="0" value="0" data-p="transpose" data-auto></x-knob>
      <x-knob label="Volume" min="0" max="1" value="0.7" data-p="volume" data-auto></x-knob>
    `;
    row.addEventListener('input', (e) => {
      const key = e.target.dataset?.p;
      if (!key) return;
      const val = e.detail.value;
      this.params[key] = val;

      // Live-Parameter direkt auf laufende Stimmen anwenden -- DX7/Operator-
      // nah (s. dsp.js#trackVoice fürs "Warum"): Cutoff/Reso/F.Decay wirken
      // auf JEDE klingende Stimme (activeVoices, phasenunabhängig, wie ein
      // Hardware-Regler es jederzeit tut); Attack nur auf Stimmen, die noch
      // in der Attack-Rampe stehen; Release nur auf bereits loslassende.
      const t = engine.ctx.currentTime;
      if (key === 'cutoff') {
        for (const v of this.activeVoices) v.filter.frequency.setTargetAtTime(val, t, 0.01);
      } else if (key === 'resonance') {
        for (const v of this.activeVoices) v.filter.Q.setTargetAtTime(val, t, 0.01);
      } else if (key === 'fDecay') {
        for (const v of this.activeVoices) v.filter.frequency.setTargetAtTime(this.params.cutoff, t, Math.max(0.01, val) / 3);
      } else if (key === 'attack') {
        for (const v of this.activeVoices) if (v.phase === 'attack') liveReanchorAttack(v.env.gain, t, val, v.attackTarget);
      } else if (key === 'release') {
        for (const v of this.activeVoices) if (v.phase === 'release') liveReanchorDecay(v.env.gain, t, val / 4, 0);
      } else if (key === 'transpose') {
        // Gehaltene Stimmen gleiten live mit -- wie bei polysynth.js'
        // Transpose-Knob, hier ohne zusätzliche Chord-Offsets.
        for (const [rawMidi, v] of this.voices) {
          v.osc.frequency.setTargetAtTime(midiToHz(rawMidi + val), t, 0.01);
        }
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
