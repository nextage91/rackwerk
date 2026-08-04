/**
 * PsySynth — Synth für komplexe, psychedelische Klangflächen (s. Chat:
 * "etwas für komplexere psychedelische Sounds").
 *
 * Stimme pro Note (× Unisono-Kopien, s. unten):
 *   Modulator (Sinus, mit Eigenrückkopplung wie FMSynth) → FM auf den
 *   Carrier (Sinus) → Ring-Modulator (dritter Sinus-Oszillator, multipliziert
 *   statt zu addieren -- metallische/unharmonische Seitenbänder zusätzlich
 *   zur FM) → Panner (feste Unisono-Stereobreite) → gemeinsamer Filter+Amp-
 *   Bus für ALLE Unisono-Kopien dieser Note.
 *
 * Unisono: 1-5 leicht verstimmte Kopien der GESAMTEN Stimme (Carrier UND
 * Modulator UND Ring-Oszillator wandern gemeinsam, s. #buildSubVoice) pro
 * Note, linear über die Detune-Reglerbreite gespreizt (±Detune) und über die
 * volle Stereobreite verteilt -- der klassische "Supersaw"-Trick, hier auf
 * eine FM+Ringmod-Stimme statt eines einzelnen Sägezahns angewandt.
 *
 * Das eigentliche "psychedelische" Element sind drei IMMER laufende, fest
 * verdrahtete Swirl-LFOs (Pitch/Filter/Pan) -- bewusst statt der generischen
 * Modulationskette (die aktuell nur 1 LFO mit 1 Ziel pro Maschine erlaubt,
 * s. Chat): ein Swirl-Rate-Regler skaliert alle drei LFOs mit FESTEN, NICHT-
 * ganzzahligen Verhältnissen zueinander (0.37/0.6/1.0) -- die drei laufen so
 * dauerhaft aus der Phase, das Muster wiederholt sich nie exakt (anders als
 * z. B. Tape Machines Wow+Flutter, die zusammen EINEN Parameter modulieren,
 * hier moduliert jeder LFO ein ANDERES Ziel gleichzeitig). Pitch wirkt über
 * `detune` (nativ in Cent, kein Umrechnen nötig) auf Carrier/Modulator/Ring
 * gemeinsam (FM-Verhältnis bleibt beim Vibrato-Schweben erhalten), Filter
 * wirkt auf den gemeinsamen Bus-Filter, Pan addiert sich auf die feste
 * Unisono-Stereoposition jeder Kopie oben drauf.
 */
import { StepSequencedSynth } from './step-sequenced-synth.js';
import { engine } from '../core/audio-engine.js';
import { createKeybed } from '../ui/keybed.js';
import { midiToHz } from '../core/dsp.js';

/** Headroom pro Unisono-Einzelstimme, zusätzlich durch Wurzel(Stimmenzahl)
 *  geteilt (s. PolySynth für dieselbe Konvention) -- niedriger als
 *  FMSynths 0.55, weil hier zusätzlich Ringmod-Seitenbänder und bis zu 5
 *  Kopien Energie beisteuern. */
const VOICE_HEADROOM = 0.4;

/** Deckel für gleichzeitig gehaltene Stimmen -- s. subsynth.js#MAX_VOICES.
 *  Bewusst nicht niedriger trotz bis zu 5 Unisono-Kopien pro Note: der
 *  Deckel begrenzt gehaltene NOTEN, nicht die (davon abgeleitete) Zahl der
 *  tatsächlichen Oszillator-Nodes. */
const MAX_VOICES = 16;
/** Fester, sehr kurzer Release beim Stimmen-Diebstahl -- s.
 *  subsynth.js#STEAL_RELEASE_S. */
const STEAL_RELEASE_S = 0.015;

/** Skaliert die 0..1-Regler "FM Amount"/"FM Env" auf den Modulationsindex --
 *  identisch zu FMSynth (dieselbe Sinus-auf-Sinus-FM-Mathematik, dort per
 *  Offline-Sweep als sicher bis zum vollen Regelweg bestätigt). */
const FM_INDEX_SCALE = 6;
/** Skaliert den 0..1 "Feedback"-Regler -- identisch zu FMSynth. */
const FEEDBACK_SCALE = 400;

/** Feste Drehzahl-Verhältnisse der drei Swirl-LFOs zueinander (relativ zum
 *  "Swirl Rate"-Regler) -- bewusst NICHT ganzzahlig, damit die drei
 *  Modulationen dauerhaft gegeneinander aus der Phase laufen und sich das
 *  Zusammenspiel nie exakt wiederholt (s. Dateikopf-Kommentar). */
const SWIRL_PITCH_MULT = 1;
const SWIRL_FILTER_MULT = 0.6;
const SWIRL_PAN_MULT = 0.37;

export class PsySynth extends StepSequencedSynth {
  static meta = {
    type: 'psysynth',
    name: 'PsySynth',
    desc: 'FM + ring mod with unison and built-in swirl LFOs',
    color: '#c15be8',
    model: 'RW-10',
  };

  buildAudio() {
    this.params = {
      ratio: 1.5,
      fmAmount: 0.3,
      fmEnv: 0.4,
      fmDecay: 0.3,
      feedback: 0.15,
      ringRatio: 1.5,
      ringAmount: 0.3,
      unisonVoices: 3,
      unisonDetune: 15,   // Cent, volle Spreizung (±Detune/2 je äusserster Stimme)
      cutoff: 3000,
      resonance: 2,
      attack: 0.02,
      release: 0.6,
      volume: 0.6,
      swirlRate: 0.3,     // Hz -- Basis-Drehzahl, s. SWIRL_*_MULT oben
      pitchDepth: 8,      // Cent
      filterDepth: 0.3,   // 0..1 -> Oktaven-Hub um den Cutoff
      panDepth: 0.5,      // 0..1 -- Anteil der vollen Stereobreite
    };
    /** aktive Stimmen: midi → { subVoices: [...], filter, ampEnv, noteBus } */
    this.voices = new Map();
    this.output.gain.value = this.params.volume;

    // Drei dauerhaft laufende Swirl-LFOs (wie Tape Machines Wow/Flutter --
    // NICHT pro Stimme neu gebaut, ein einziges, immer aktives Trio fürs
    // ganze Maschinen-Leben). Je LFO ein Depth-Gain als Skalierungsstufe,
    // dessen AUSGANG bei jeder neuen Stimme an die passenden Ziele
    // angeschlossen wird (s. #connectSwirl) -- so entkoppelt vom
    // Stimmenlebenszyklus, dass Anschlagszeitpunkt/Stimmenzahl keine Rolle
    // spielen: alle Stimmen teilen sich exakt dieselbe Phase.
    const ctx = engine.ctx;
    this.pitchLfo = ctx.createOscillator();
    this.pitchLfo.type = 'sine';
    this.pitchLfo.frequency.value = this.params.swirlRate * SWIRL_PITCH_MULT;
    this.pitchDepthGain = ctx.createGain();
    this.pitchDepthGain.gain.value = this.params.pitchDepth;
    this.pitchLfo.connect(this.pitchDepthGain);

    this.filterLfo = ctx.createOscillator();
    this.filterLfo.type = 'sine';
    this.filterLfo.frequency.value = this.params.swirlRate * SWIRL_FILTER_MULT;
    this.filterDepthGain = ctx.createGain();
    this.filterDepthGain.gain.value = this.params.cutoff * (2 ** (this.params.filterDepth * 2) - 1);
    this.filterLfo.connect(this.filterDepthGain);

    this.panLfo = ctx.createOscillator();
    this.panLfo.type = 'sine';
    this.panLfo.frequency.value = this.params.swirlRate * SWIRL_PAN_MULT;
    this.panDepthGain = ctx.createGain();
    this.panDepthGain.gain.value = this.params.panDepth;
    this.panLfo.connect(this.panDepthGain);

    this.pitchLfo.start();
    this.filterLfo.start();
    this.panLfo.start();

    this.patterns = [this.emptyPattern(), this.emptyPattern(), this.emptyPattern(), this.emptyPattern()];
    this.patternIndex = 0;
    this.pattern = this.patterns[0];
  }

  /** Eine einzelne Unisono-Kopie (Carrier+Modulator+Ring, alle drei mit
   *  demselben statischen Detune-Versatz, s. Dateikopf-Kommentar) -- baut
   *  den Knoten-Graphen OHNE die zeitabhängige FM-/Amp-Automation zu planen
   *  (dieselbe Aufteilung wie FMSynths #buildVoice). `pan` ist die feste
   *  Unisono-Stereoposition, NICHT die Swirl-Pan-Modulation (die kommt on
   *  top über panDepthGain, s. #connectSwirl). */
  #buildSubVoice(carrierFreq, detuneCents, pan) {
    const ctx = engine.ctx;
    const p = this.params;

    const car = ctx.createOscillator();
    car.type = 'sine';
    car.frequency.value = carrierFreq;
    car.detune.value = detuneCents;

    const mod = ctx.createOscillator();
    mod.type = 'sine';
    mod.frequency.value = Math.max(0.01, carrierFreq * p.ratio);
    mod.detune.value = detuneCents;

    const modGain = ctx.createGain();
    mod.connect(modGain).connect(car.frequency);

    const fbGain = ctx.createGain();
    fbGain.gain.value = p.feedback * FEEDBACK_SCALE;
    mod.connect(fbGain).connect(mod.frequency);

    // Ringmodulation: `ring` treibt NICHT den Eingang von ringGain, sondern
    // dessen gain-Param -- eine GainNode multipliziert ihren Eingang pro
    // Sample mit ihrem (hier komplett audio-rate getriebenen) gain-Wert,
    // genau das ist Ringmodulation (Carrier × Ring-Oszillator). ringAmount
    // blendet zwischen unverändertem Durchlauf (gain bleibt bei 1) und
    // vollem Ringmod (gain schwingt zwischen -1..1, inkl. Phasenumkehr --
    // der klassische, "harte" Ringmod-Klang) -- dieselbe Depth-Blend-Technik
    // wie bei den LFO-Zielen in modulators.js, nur audio-rate.
    const ring = ctx.createOscillator();
    ring.type = 'sine';
    ring.frequency.value = Math.max(0.01, carrierFreq * p.ringRatio);
    ring.detune.value = detuneCents;
    const ringGain = ctx.createGain();
    ringGain.gain.value = 1 - p.ringAmount;
    const ringDepthGain = ctx.createGain();
    ringDepthGain.gain.value = p.ringAmount;
    ring.connect(ringDepthGain).connect(ringGain.gain);
    car.connect(ringGain);

    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    ringGain.connect(panner);

    return { car, mod, modGain, fbGain, ring, ringGain, ringDepthGain, panner };
  }

  /** FM-Index-Hüllkurve -- identisch zu FMSynth#applyFmEnv (s. dortigen
   *  Kommentar fürs "Warum": Peak->Sustain macht FM-Patches beim Anschlag
   *  heller statt statisch). */
  #applyFmEnv(subVoice, carrierFreq, t) {
    const p = this.params;
    const modFreq = Math.max(0.01, carrierFreq * p.ratio);
    const peak = (p.fmAmount + p.fmEnv) * FM_INDEX_SCALE * modFreq;
    const sustain = p.fmAmount * FM_INDEX_SCALE * modFreq;
    subVoice.modGain.gain.setValueAtTime(peak, t);
    subVoice.modGain.gain.setTargetAtTime(sustain, t, Math.max(0.01, p.fmDecay) / 3);
  }

  /** Verbindet die drei Swirl-LFOs mit einer neu gebauten Note -- Pitch auf
   *  Carrier/Modulator/Ring JEDER Unisono-Kopie (FM-Verhältnis bleibt beim
   *  Vibrato-Schweben erhalten), Pan auf JEDE Kopie einzeln (addiert sich
   *  auf deren feste Unisono-Position), Filter EINMAL auf den gemeinsamen
   *  Bus-Filter (s. Dateikopf-Kommentar: der Filter ist geteilt, nicht pro
   *  Unisono-Kopie). */
  #connectSwirl(note) {
    for (const sv of note.subVoices) {
      this.pitchDepthGain.connect(sv.car.detune);
      this.pitchDepthGain.connect(sv.mod.detune);
      this.pitchDepthGain.connect(sv.ring.detune);
      this.panDepthGain.connect(sv.panner.pan);
    }
    this.filterDepthGain.connect(note.filter.frequency);
  }

  /** Gegenstück zu #connectSwirl -- MUSS vorm endgültigen Verwerfen einer
   *  Note laufen: die geteilten Depth-Gains sind die QUELLE dieser
   *  Verbindungen, `sv.car.disconnect()` (Ziel-seitig) räumt sie NICHT mit
   *  auf (Web-Audio-Verbindungen trennt man von der Quelle aus). Ohne das
   *  blieben pro Note vier verwaiste Verbindungen an den geteilten,
   *  dauerhaft laufenden LFO-Gains hängen. */
  #disconnectSwirl(note) {
    for (const sv of note.subVoices) {
      this.pitchDepthGain.disconnect(sv.car.detune);
      this.pitchDepthGain.disconnect(sv.mod.detune);
      this.pitchDepthGain.disconnect(sv.ring.detune);
      this.panDepthGain.disconnect(sv.panner.pan);
    }
    this.filterDepthGain.disconnect(note.filter.frequency);
  }

  /** Baut eine komplette Note (Unisono-Kopien + gemeinsamer Filter/Amp-Bus),
   *  OHNE die Amp-Hüllkurve zu planen (unterscheidet sich zwischen Fire-and-
   *  Forget/playNote und gehaltenen Keybed-Noten/noteOn, s. dort). */
  #buildNote(midi, t) {
    const ctx = engine.ctx;
    const p = this.params;
    const carrierFreq = midiToHz(midi);
    const n = Math.max(1, Math.round(p.unisonVoices));

    const noteBus = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = p.cutoff;
    filter.Q.value = p.resonance;
    noteBus.connect(filter);

    const subVoices = [];
    for (let i = 0; i < n; i++) {
      // Linear über die volle Regelbreite gespreizt (bei n=1 exakt 0, kein
      // Sonderfall nötig) -- derselbe "0..1 über n-1 Schritte, bei n=1
      // durch max(1,n-1) sicher vor Division durch 0" wie an mehreren
      // Stellen im Rest der App (z. B. WaveShaper-Kurven-Indizierung).
      const spread = n > 1 ? (2 * i) / (n - 1) - 1 : 0;
      const sv = this.#buildSubVoice(carrierFreq, spread * (p.unisonDetune / 2), spread);
      this.#applyFmEnv(sv, carrierFreq, t);
      sv.panner.connect(noteBus);
      subVoices.push(sv);
    }

    const note = { subVoices, filter, noteBus, carrierFreq };
    this.#connectSwirl(note);
    return note;
  }

  /** Räumt eine Note vollständig ab -- geteilt zwischen playNote (Sequenzer)
   *  und noteOff (Keybed), damit beide Pfade denselben Aufräum-Code
   *  (inkl. #disconnectSwirl) nutzen. Läuft im onended der ERSTEN Carrier-
   *  Stimme, also erst NACHDEM alle Oszillatoren tatsächlich gestoppt haben
   *  (nicht schon beim Auslösen der Freigabe) -- sonst würde das Swirl-
   *  Schweben schon während der noch hörbaren Release-Fahne abrupt
   *  abreissen. */
  #teardownNote(note) {
    this.#disconnectSwirl(note);
    for (const sv of note.subVoices) {
      sv.car.disconnect(); sv.mod.disconnect(); sv.ring.disconnect();
      sv.modGain.disconnect(); sv.fbGain.disconnect();
      sv.ringGain.disconnect(); sv.ringDepthGain.disconnect(); sv.panner.disconnect();
    }
    note.noteBus.disconnect();
    note.filter.disconnect();
    note.ampEnv.disconnect();
  }

  /** Fire-and-forget-Stimme für den Sequenzer. */
  playNote(midi, time, dur, vel = 1) {
    time = engine.quantizeTime(time);
    this.pulse(time);
    const p = this.params;
    const note = this.#buildNote(midi, time);
    const n = note.subVoices.length;

    const ampEnv = engine.ctx.createGain();
    note.ampEnv = ampEnv;
    const headroom = VOICE_HEADROOM / Math.sqrt(n);
    // KEIN Math.min(p.attack, dur*0.5) mehr -- s. subsynth.js#playNote
    // für die Begründung (dieselbe Kappe, derselbe unnötige Effekt).
    ampEnv.gain.setValueAtTime(0, time);
    ampEnv.gain.linearRampToValueAtTime(headroom * vel, time + p.attack);
    ampEnv.gain.setTargetAtTime(0, time + dur, p.release / 4);
    note.filter.connect(ampEnv).connect(this.output);

    const stopAt = time + dur + p.release + 0.1;
    for (const sv of note.subVoices) {
      sv.car.start(time); sv.mod.start(time); sv.ring.start(time);
      sv.car.stop(stopAt); sv.mod.stop(stopAt); sv.ring.stop(stopAt);
    }
    note.subVoices[0].car.onended = () => this.#teardownNote(note);
  }

  /* ---------- Stimmenverwaltung (gehaltene Keybed-Noten) ---------- */
  noteOn(midi) {
    if (this.voices.has(midi)) return;
    // s. subsynth.js#noteOn -- älteste Stimme verdrängen statt unbegrenzt
    // weitere anzuhäufen.
    if (this.voices.size >= MAX_VOICES) this.noteOff(this.voices.keys().next().value, true);
    this.pulse();
    if (this.isLiveRecording) {
      const idx = this.liveStepIndex(this.pattern.length);
      this.pattern[idx] = { on: true, midi };
      this.seq?.refreshStep(idx);
    }
    const t = engine.ctx.currentTime;
    const p = this.params;
    const note = this.#buildNote(midi, t);
    const n = note.subVoices.length;

    const ampEnv = engine.ctx.createGain();
    note.ampEnv = ampEnv;
    ampEnv.gain.setValueAtTime(0, t);
    ampEnv.gain.linearRampToValueAtTime(VOICE_HEADROOM / Math.sqrt(n), t + p.attack);
    note.filter.connect(ampEnv).connect(this.output);

    for (const sv of note.subVoices) { sv.car.start(t); sv.mod.start(t); sv.ring.start(t); }
    this.voices.set(midi, note);
  }

  /** `steal`: true nur beim Verdrängen durch MAX_VOICES (s. noteOn oben). */
  noteOff(midi, steal = false) {
    const note = this.voices.get(midi);
    if (!note) return;
    this.voices.delete(midi);

    const t = engine.ctx.currentTime;
    const rel = steal ? STEAL_RELEASE_S : this.params.release;
    note.ampEnv.gain.cancelScheduledValues(t);
    note.ampEnv.gain.setTargetAtTime(0, t, rel / 4);
    const stopAt = t + rel + 0.1;
    for (const sv of note.subVoices) { sv.car.stop(stopAt); sv.mod.stop(stopAt); sv.ring.stop(stopAt); }
    note.subVoices[0].car.onended = () => this.#teardownNote(note);
  }

  allNotesOff() {
    for (const midi of [...this.voices.keys()]) this.noteOff(midi);
  }

  disposeAudio() {
    this.allNotesOff();
    this.pitchLfo.stop(); this.pitchLfo.disconnect(); this.pitchDepthGain.disconnect();
    this.filterLfo.stop(); this.filterLfo.disconnect(); this.filterDepthGain.disconnect();
    this.panLfo.stop(); this.panLfo.disconnect(); this.panDepthGain.disconnect();
  }

  /* ---------- UI ---------- */
  buildControls(container) {
    const fmRow = document.createElement('div');
    fmRow.className = 'machine__row';
    fmRow.innerHTML = `
      <x-knob label="Ratio" min="0.25" max="8" value="1.5" curve="log" data-p="ratio" data-auto></x-knob>
      <x-knob label="FM Amount" min="0" max="1" value="0.3" data-p="fmAmount" data-auto></x-knob>
      <x-knob label="FM Env" min="0" max="1" value="0.4" data-p="fmEnv" data-auto></x-knob>
      <x-knob label="FM Decay" min="0.02" max="2" value="0.3" curve="log" unit="s" data-p="fmDecay" data-auto></x-knob>
      <x-knob label="Feedback" min="0" max="1" value="0.15" data-p="feedback" data-auto></x-knob>
    `;
    container.appendChild(fmRow);

    const ringRow = document.createElement('div');
    ringRow.className = 'machine__row';
    ringRow.innerHTML = `
      <x-knob label="Ring Ratio" min="0.25" max="8" value="1.5" curve="log" data-p="ringRatio" data-auto></x-knob>
      <x-knob label="Ring Amount" min="0" max="1" value="0.3" data-p="ringAmount" data-auto></x-knob>
      <x-knob label="Voices" min="1" max="5" value="3" step="1" data-p="unisonVoices" data-auto></x-knob>
      <x-knob label="Detune" min="0" max="50" value="15" unit="ct" data-p="unisonDetune" data-auto></x-knob>
    `;
    container.appendChild(ringRow);

    const ampRow = document.createElement('div');
    ampRow.className = 'machine__row';
    ampRow.innerHTML = `
      <x-knob label="Cutoff" min="200" max="16000" value="3000" curve="log" unit="Hz" data-p="cutoff" data-auto></x-knob>
      <x-knob label="Reso" min="0.5" max="12" value="2" data-p="resonance" data-auto></x-knob>
      <x-knob label="Attack" min="0.002" max="10" value="0.02" curve="log" unit="s" data-p="attack" data-auto></x-knob>
      <x-knob label="Release" min="0.02" max="10" value="0.6" curve="log" unit="s" data-p="release" data-auto></x-knob>
      <x-knob label="Volume" min="0" max="1" value="0.6" data-p="volume" data-auto></x-knob>
    `;
    container.appendChild(ampRow);

    // Swirl: die drei immer laufenden LFOs, die den psychedelischen
    // Charakter ausmachen (s. Dateikopf-Kommentar) -- eigene, klar
    // abgegrenzte Reihe wie AcidBashs Devil-Fish-Zeile.
    const swirlRow = document.createElement('div');
    swirlRow.className = 'machine__row psysynth__swirl';
    swirlRow.innerHTML = `
      <span class="psysynth__swirl-label">Swirl</span>
      <x-knob label="Rate" min="0.02" max="4" value="0.3" curve="log" unit="Hz" data-p="swirlRate" data-auto></x-knob>
      <x-knob label="Pitch Depth" min="0" max="50" value="8" unit="ct" data-p="pitchDepth" data-auto></x-knob>
      <x-knob label="Filter Depth" min="0" max="1" value="0.3" data-p="filterDepth" data-auto></x-knob>
      <x-knob label="Pan Depth" min="0" max="1" value="0.5" data-p="panDepth" data-auto></x-knob>
    `;
    container.appendChild(swirlRow);

    [fmRow, ringRow, ampRow, swirlRow].forEach((row) => row.addEventListener('input', (e) => {
      const key = e.target.dataset?.p;
      if (!key) return;
      const val = e.detail.value;
      this.params[key] = val;
      const t = engine.ctx.currentTime;

      // Live-Parameter direkt auf laufende Stimmen/LFOs anwenden -- wie bei
      // FMSynth wirken Ratio/FM-Amount/Env/Decay/RingRatio/RingAmount/
      // Unisono bewusst NICHT rückwirkend (beim Anschlag fest eingeplant),
      // nur ungehüllte Klangfarbe-Regler (Feedback, Cutoff, Resonance) UND
      // die Swirl-LFOs (dauerhaft laufender Hintergrund-Modulator, kein
      // Bezug zu einzelnen Notenanschlägen) ziehen live nach.
      if (key === 'feedback') {
        for (const note of this.voices.values()) {
          for (const sv of note.subVoices) sv.fbGain.gain.setTargetAtTime(val * FEEDBACK_SCALE, t, 0.01);
        }
      } else if (key === 'cutoff') {
        for (const note of this.voices.values()) note.filter.frequency.setTargetAtTime(val, t, 0.01);
        this.filterDepthGain.gain.setTargetAtTime(val * (2 ** (this.params.filterDepth * 2) - 1), t, 0.01);
      } else if (key === 'resonance') {
        for (const note of this.voices.values()) note.filter.Q.setTargetAtTime(val, t, 0.01);
      } else if (key === 'volume') {
        this.setLevel(val);
      } else if (key === 'swirlRate') {
        this.pitchLfo.frequency.setTargetAtTime(val * SWIRL_PITCH_MULT, t, 0.05);
        this.filterLfo.frequency.setTargetAtTime(val * SWIRL_FILTER_MULT, t, 0.05);
        this.panLfo.frequency.setTargetAtTime(val * SWIRL_PAN_MULT, t, 0.05);
      } else if (key === 'pitchDepth') {
        this.pitchDepthGain.gain.setTargetAtTime(val, t, 0.05);
      } else if (key === 'filterDepth') {
        this.filterDepthGain.gain.setTargetAtTime(this.params.cutoff * (2 ** (val * 2) - 1), t, 0.05);
      } else if (key === 'panDepth') {
        this.panDepthGain.gain.setTargetAtTime(val, t, 0.05);
      }
    }));

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
