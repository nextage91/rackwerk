/**
 * FMSynth — 2-Operatoren-FM-Synth (Carrier moduliert von Modulator, plus
 * Modulator-Eigenrückkopplung), angelehnt an Abletons "FM Synth" (nicht
 * dessen komplexeren "Operator": kein wählbares Algorithmus-Set, keine
 * 4 Operatoren mit eigenen Filtern/Panning -- eine bewusst kleinere,
 * kuratierte Variante mit denselben Kern-Reglern, die den FM-Charakter
 * tatsächlich ausmachen).
 *
 * Signalfluss pro Stimme:
 *   Modulator (Sinus) --[Feedback-Gain: moduliert SICH SELBST]--> Modulator
 *   Modulator --[FM-Index-Gain]--> Carrier.frequency (Sinus, Notenfrequenz)
 *   Carrier --> Lowpass-Filter --> Amp-Hüllkurve --> Output
 *
 * Beide Operatoren sind FEST Sinus (kein Waveform-Regler): echte FM
 * (Frequenzmodulation im Sinne von Chowning) braucht reine Sinus-Träger/
 * -Modulatoren -- ein Rechteck/Sägezahn als Operator ergibt kein
 * kontrollierbares FM-Spektrum mehr, sondern nur unvorhersehbaren Lärm.
 * Das ist musikalisch/technisch korrekt, keine Einschränkung.
 *
 * Klangdesign-Kernideen (die zwei Regler-Reihen unten):
 * - Der Modulator-Index (FM Amount) bestimmt die Helligkeit/Obertonzahl,
 *   NICHT die Lautstärke -- klassischer FM-Unterschied zu Subtraktiv-
 *   Synthese. Ratio (Modulator-Frequenz als Vielfaches der Notenfrequenz)
 *   bestimmt, OB das Ergebnis harmonisch (ganzzahliges Ratio) oder
 *   metallisch/unharmonisch (krummes Ratio) klingt -- Fixed-Modus setzt
 *   die Modulatorfrequenz stattdessen auf einen festen Hz-Wert (klassisch
 *   für Glocken/Gongs, die NICHT mit der gespielten Note mitwandern).
 * - FM Env/Decay: der Index bekommt eine EIGENE, von der Amp-Hüllkurve
 *   unabhängige Abkling-Hüllkurve (Peak -> Sustain-Wert aus FM Amount) --
 *   das ist der eigentliche Grund, warum FM-Patches (E-Piano, Bells)
 *   lebendig statt statisch klingen: der Klang wird beim Anschlag heller
 *   und dunkelt danach ab, unabhängig davon, ob die Note gehalten wird.
 * - Feedback: der Modulator moduliert zusätzlich SEINE EIGENE Frequenz
 *   (Web Audio erlaubt einen Knoten, der auf seinen EIGENEN AudioParam
 *   zurückwirkt -- der Zyklus ist wohldefiniert, weil die Berechnung mit
 *   dem Ausgabewert des VORHERIGEN Render-Quantums arbeitet). Klassische
 *   DX7-Technik: bei niedrigen Werten wärmt/sättigt es den Ton leicht,
 *   bei hohen Werten kippt der Modulator in geräuschhaftes, unharmonisches
 *   Rauschen -- beides ist gewolltes FM-Charakterverhalten, kein Fehler.
 */
import { StepSequencedSynth } from './step-sequenced-synth.js';
import { engine } from '../core/audio-engine.js';
import { createKeybed } from '../ui/keybed.js';
import { midiToHz } from '../core/dsp.js';

/** Headroom pro Stimme -- wie SubSynth/PolySynth (dort ausführlich gegen
 *  den Rest des Kits austariert): eine gehaltene Note braucht Kopfraum,
 *  weil sie (anders als ein perkussiver Klang) die ganze Haltedauer nahe
 *  der Spitzenlautstärke bleibt statt abzuklingen. */
const VOICE_HEADROOM = 0.55;

/** Skaliert die 0..1-Regler "FM Amount"/"FM Env" auf den tatsächlichen
 *  Modulationsindex (klassische FM-Grössenordnung, s. Chowning: Index
 *  0 = kein Effekt, ~1-3 = moderat, 6+ = hell/metallisch/rauschig). Über
 *  eine Offline-Sweep-Messung (Ratio/Fixed/Feedback-Extreme, s. PR)
 *  bestätigt: bis zum vollen Regelweg bleibt der Peak sicher unter der
 *  Kick-Referenzobergrenze (~1.2), auch mit maximalem Feedback zugleich. */
const FM_INDEX_SCALE = 6;

/** Skaliert den 0..1 "Feedback"-Regler auf die tatsächliche
 *  Rückkopplungs-Gain (Anteil des Modulator-Ausgangs, der auf seine
 *  eigene Frequenz zurückwirkt). Bei 1.0 kippt der Modulator hörbar in
 *  Rauschen -- gewollter Extremwert, kein Sicherheitslimit nötig (reine
 *  Frequenzmodulation kann nicht wie ein Delay-/Reverb-Feedback-Pfad
 *  exponentiell aufschaukeln, s. Kommentar oben). */
const FEEDBACK_SCALE = 400;

export class FMSynth extends StepSequencedSynth {
  static meta = {
    type: 'fmsynth',
    name: 'FM Synth',
    desc: '2-operator FM: ratio, feedback, its own mod envelope',
    color: '#e0609a',
    model: 'RW-07',
  };

  buildAudio() {
    this.params = {
      ratio: 2,           // Modulator-Frequenz = Trägerfrequenz * ratio (Ratio-Modus)
      modMode: 'ratio',   // 'ratio' | 'fixed'
      modFreq: 220,       // Modulator-Frequenz in Hz (Fixed-Modus)
      fmAmount: 0.25,      // Sustain-Modulationsindex (0..1, s. FM_INDEX_SCALE)
      fmEnv: 0.35,         // zusätzlicher Peak-Boost beim Anschlag (0..1)
      fmDecay: 0.25,       // s — Abklingzeit des FM-Index-Peaks
      feedback: 0,         // Modulator-Eigenrückkopplung (0..1, s. FEEDBACK_SCALE)
      cutoff: 8000,
      resonance: 0.7,
      attack: 0.005,
      release: 0.4,
      volume: 0.7,
    };
    /** aktive Stimmen: midi → {car, mod, modGain, fbGain, filter, ampEnv} */
    this.voices = new Map();
    this.output.gain.value = this.params.volume;

    /** 4 leere Pattern-Slots (A/B/C/D) — neu hinzugefügte Maschinen starten
     *  ohne vorprogrammierte Steps. */
    this.patterns = [this.emptyPattern(), this.emptyPattern(), this.emptyPattern(), this.emptyPattern()];
    this.patternIndex = 0;
    this.pattern = this.patterns[0];
  }

  /** Modulatorfrequenz für `midi` nach dem aktuellen Modus -- Ratio folgt
   *  der gespielten Note (harmonisch/mitwandernd), Fixed bleibt an einer
   *  absoluten Hz-Zahl (Glocken/Gongs, die NICHT mit der Tonhöhe wandern). */
  #modFreqFor(carrierFreq) {
    const p = this.params;
    return p.modMode === 'fixed' ? p.modFreq : carrierFreq * p.ratio;
  }

  /** Ein-Stimmen-Aufbau (geteilt zwischen Sequenzer & Keybed) — baut den
   *  kompletten Knoten-Graphen, OHNE die zeitabhängige Hüllkurven-
   *  Automation zu planen (die unterscheidet sich zwischen Fire-and-
   *  Forget/playNote und gehaltenen Keybed-Noten/noteOn, s. dort). */
  #buildVoice(midi, t) {
    const ctx = engine.ctx;
    const p = this.params;
    const carrierFreq = midiToHz(midi);
    const modFreq = this.#modFreqFor(carrierFreq);

    const car = ctx.createOscillator();
    car.type = 'sine';
    car.frequency.value = carrierFreq;

    const mod = ctx.createOscillator();
    mod.type = 'sine';
    mod.frequency.value = Math.max(0.01, modFreq);

    // FM-Index-Gain: der Modulator-Ausgang (Amplitude ±1) wird auf einen
    // Frequenzhub skaliert und direkt auf car.frequency addiert -- die
    // Gain-AUTOMATION (Peak->Sustain-Hüllkurve) übernimmt applyFmEnv() bei
    // jedem Aufrufer separat, hier nur die Verkabelung.
    const modGain = ctx.createGain();
    mod.connect(modGain).connect(car.frequency);

    // Feedback: der Modulator wirkt zusätzlich auf SEINE EIGENE Frequenz
    // zurück (fester Gain, keine eigene Hüllkurve -- Feedback ist ein
    // Klangfarbe-Regler, kein Anschlags-Element).
    const fbGain = ctx.createGain();
    fbGain.gain.value = p.feedback * FEEDBACK_SCALE;
    mod.connect(fbGain).connect(mod.frequency);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = p.cutoff;
    filter.Q.value = p.resonance;
    car.connect(filter);

    return { car, mod, modGain, fbGain, filter, carrierFreq, modFreq };
  }

  /** FM-Index-Hüllkurve: startet bei (fmAmount+fmEnv), fällt exponentiell
   *  auf den Sustain-Wert fmAmount zurück -- derselbe Peak->Sustain-Ansatz
   *  wie dsp.js#applyFilterEnv, nur auf den Modulationsindex statt eine
   *  Filterfrequenz angewandt (s. Dateikopf-Kommentar fürs "Warum"). */
  #applyFmEnv(modGain, modFreq, t) {
    const p = this.params;
    const peak = (p.fmAmount + p.fmEnv) * FM_INDEX_SCALE * modFreq;
    const sustain = p.fmAmount * FM_INDEX_SCALE * modFreq;
    modGain.gain.setValueAtTime(peak, t);
    modGain.gain.setTargetAtTime(sustain, t, Math.max(0.01, p.fmDecay) / 3);
  }

  /** Fire-and-forget-Stimme für den Sequenzer. */
  playNote(midi, time, dur, vel = 1) {
    time = engine.quantizeTime(time);
    this.pulse(time);
    const p = this.params;
    const { car, mod, modGain, fbGain, filter, modFreq } = this.#buildVoice(midi, time);
    this.#applyFmEnv(modGain, modFreq, time);

    const ampEnv = engine.ctx.createGain();
    // KEIN Math.min(p.attack, dur*0.5) mehr -- s. subsynth.js#playNote
    // für die Begründung (dieselbe Kappe, derselbe unnötige Effekt).
    ampEnv.gain.setValueAtTime(0, time);
    ampEnv.gain.linearRampToValueAtTime(VOICE_HEADROOM * vel, time + p.attack);
    ampEnv.gain.setTargetAtTime(0, time + dur, p.release / 4);
    filter.connect(ampEnv).connect(this.output);

    const stopAt = time + dur + p.release + 0.1;
    car.start(time); mod.start(time);
    car.stop(stopAt); mod.stop(stopAt);
    car.onended = () => { car.disconnect(); mod.disconnect(); modGain.disconnect(); fbGain.disconnect(); filter.disconnect(); ampEnv.disconnect(); };
  }

  /* ---------- Stimmenverwaltung (gehaltene Keybed-Noten) ---------- */
  noteOn(midi) {
    if (this.voices.has(midi)) return;
    this.pulse();
    if (this.isLiveRecording) {
      const idx = this.liveStepIndex(this.pattern.length);
      this.pattern[idx] = { on: true, midi };
      this.seq?.refreshStep(idx);
    }
    const t = engine.ctx.currentTime;
    const p = this.params;
    const { car, mod, modGain, fbGain, filter, modFreq } = this.#buildVoice(midi, t);
    this.#applyFmEnv(modGain, modFreq, t);

    const ampEnv = engine.ctx.createGain();
    ampEnv.gain.setValueAtTime(0, t);
    ampEnv.gain.linearRampToValueAtTime(VOICE_HEADROOM, t + p.attack);
    filter.connect(ampEnv).connect(this.output);

    car.start(t); mod.start(t);
    this.voices.set(midi, { car, mod, modGain, fbGain, filter, ampEnv, modFreq });
  }

  noteOff(midi) {
    const v = this.voices.get(midi);
    if (!v) return;
    this.voices.delete(midi);

    const t = engine.ctx.currentTime;
    const rel = this.params.release;
    v.ampEnv.gain.cancelScheduledValues(t);
    v.ampEnv.gain.setTargetAtTime(0, t, rel / 4);
    const stopAt = t + rel + 0.1;
    v.car.stop(stopAt); v.mod.stop(stopAt);
    v.car.onended = () => { v.car.disconnect(); v.mod.disconnect(); v.modGain.disconnect(); v.fbGain.disconnect(); v.filter.disconnect(); v.ampEnv.disconnect(); };
  }

  allNotesOff() {
    for (const midi of [...this.voices.keys()]) this.noteOff(midi);
  }

  disposeAudio() {
    this.allNotesOff();
  }

  /* ---------- UI ---------- */
  buildControls(container) {
    // Ratio/Fixed: bestimmt, ob die Modulatorfrequenz mit der gespielten
    // Note mitwandert (harmonisch) oder an einem festen Hz-Wert bleibt
    // (Glocken/Gongs) -- wirkt erst auf den NÄCHSTEN Anschlag, wie
    // Filtertyp bei SubSynth/PolySynth (kein rückwirkendes Umschalten
    // schon klingender Stimmen, sonst springt die Tonhöhe unter der Hand).
    const seg = document.createElement('div');
    seg.className = 'seg';
    seg.innerHTML = `
      <span class="seg__label">Mod</span>
      <button class="seg__btn" data-mode="ratio">Ratio</button>
      <button class="seg__btn" data-mode="fixed">Fixed</button>
    `;
    seg.querySelectorAll('.seg__btn').forEach((b) =>
      b.classList.toggle('is-active', b.dataset.mode === this.params.modMode));
    seg.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-mode]');
      if (!btn) return;
      this.params.modMode = btn.dataset.mode;
      seg.querySelectorAll('.seg__btn').forEach((b) => b.classList.toggle('is-active', b === btn));
    });
    container.appendChild(seg);

    const opRow = document.createElement('div');
    opRow.className = 'machine__row';
    opRow.innerHTML = `
      <x-knob label="Ratio"    min="0.25" max="8" value="2" curve="log" data-p="ratio" data-auto></x-knob>
      <x-knob label="Mod Hz"   min="1" max="5000" value="220" curve="log" unit="Hz" data-p="modFreq" data-auto></x-knob>
      <x-knob label="FM Amount" min="0" max="1" value="0.25" data-p="fmAmount" data-auto></x-knob>
      <x-knob label="FM Env"   min="0" max="1" value="0.35" data-p="fmEnv" data-auto></x-knob>
      <x-knob label="FM Decay" min="0.02" max="2" value="0.25" curve="log" unit="s" data-p="fmDecay" data-auto></x-knob>
      <x-knob label="Feedback" min="0" max="1" value="0" data-p="feedback" data-auto></x-knob>
    `;
    opRow.addEventListener('input', (e) => {
      const key = e.target.dataset?.p;
      if (!key) return;
      const val = e.detail.value;
      this.params[key] = val;

      // Live-Parameter direkt auf laufende Stimmen anwenden. Ratio/ModHz/
      // FM Amount/Env/Decay wirken bewusst NICHT rückwirkend auf schon
      // laufende Hüllkurven (die wurden beim Anschlag fest eingeplant,
      // wie bei jeder anderen Hüllkurve in dieser App) -- nur Feedback
      // ist ein reiner, ungehüllter Klangfarbe-Regler und lässt sich
      // deshalb ohne Widerspruch live nachziehen.
      if (key === 'feedback') {
        const t = engine.ctx.currentTime;
        for (const v of this.voices.values()) v.fbGain.gain.setTargetAtTime(val * FEEDBACK_SCALE, t, 0.01);
      }
    });
    container.appendChild(opRow);

    const ampRow = document.createElement('div');
    ampRow.className = 'machine__row';
    ampRow.innerHTML = `
      <x-knob label="Cutoff"  min="200" max="16000" value="8000" curve="log" unit="Hz" data-p="cutoff" data-auto></x-knob>
      <x-knob label="Reso"    min="0.5" max="12" value="0.7" data-p="resonance" data-auto></x-knob>
      <x-knob label="Attack"  min="0.002" max="10" value="0.005" curve="log" unit="s" data-p="attack" data-auto></x-knob>
      <x-knob label="Release" min="0.02" max="10" value="0.4" curve="log" unit="s" data-p="release" data-auto></x-knob>
      <x-knob label="Volume"  min="0" max="1" value="0.7" data-p="volume" data-auto></x-knob>
    `;
    ampRow.addEventListener('input', (e) => {
      const key = e.target.dataset?.p;
      if (!key) return;
      const val = e.detail.value;
      this.params[key] = val;
      const t = engine.ctx.currentTime;
      if (key === 'cutoff') {
        for (const v of this.voices.values()) v.filter.frequency.setTargetAtTime(val, t, 0.01);
      } else if (key === 'resonance') {
        for (const v of this.voices.values()) v.filter.Q.setTargetAtTime(val, t, 0.01);
      } else if (key === 'volume') {
        this.setLevel(val);
      }
    });
    container.appendChild(ampRow);

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
