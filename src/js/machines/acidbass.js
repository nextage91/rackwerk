/**
 * AcidBass — monophone Bassline-Synthese im Stil der Roland TB-303, plus
 * ausgewählte "Devil Fish"-Mod-Regler (Overdrive, Filter FM, Hi-Resonance,
 * einstellbare Slide-Zeit, separates Accent-Decay).
 *
 * ZWEITER ANLAUF (s. Chat): die erste Version (kaskadierte BiquadFilterNodes
 * + native Rückkopplungsschleife) klang trotz mehrerer Kalibrierungsrunden
 * nie wirklich nach 303 -- Grund, nach genauerem Quellcode-Studium von
 * Open303 (RobinSchmidt, MIT-lizenziert, github.com/RobinSchmidt/Open303):
 * die echte 303 nutzt weder kaskadierte 2-polige Biquads noch einen simplen
 * Feedback-Gain, sondern eine ganz bestimmte 4-stufige "Leapfrog"-Rekursion
 * MIT einem Hochpass IN der Rückkopplung, dazu eine Filterhüllkurve, die
 * NICHT wie ein ADSR rampt, sondern eine reine Decay-Kurve durch ein RC-
 * Tiefpassglied schickt (mit getrennter Zeitkonstante für Accent), UND eine
 * Amp-Hüllkurve, die einen Teil der Filterhüllkurve direkt mit einrechnet.
 * Das alles lässt sich mit nativen AudioNodes/AudioParam-Automation nicht
 * nachbilden -- deshalb jetzt ein echter Sample-für-Sample-DSP-Kern per
 * AudioWorklet (s. acidbass-worklet.js für die volle Herleitung/Quellen-
 * Zuordnung; AudioWorklet-Browser-Support seit iOS 14.5/Safari 14.1 (2021),
 * kein Blocker mehr für die beim ersten Anlauf bewusst vermiedene Variante).
 *
 * Architektur-Unterschied zu SubSynth/PolySynth/FMSynth: die 303 ist
 * monophon MIT Slide (Legato-Glide zwischen zwei Noten) -- pro Trigger wird
 * KEINE neue Stimme erzeugt, sondern eine einzige, dauerhaft laufende
 * Worklet-Stimme umgestimmt (hart bei normalem Trigger, weich geglitten bei
 * Slide). Deshalb kein `voices`-Map wie bei den anderen Synths.
 *
 * Der komplette DSP-Kern (Oszillator, Filter, beide Hüllkurven, Devil-Fish-
 * Mods) läuft SAMPLE-GENAU im Worklet-Thread; dieses Modul hier ist nur
 * noch dünne Verdrahtung: Parameter per postMessage() rüberreichen, Trigger-
 * Events mit Zielzeit rüberreichen (das Worklet feuert sie exakt zum
 * richtigen Sample, s. acidbass-worklet.js#process()).
 */
import { StepSequencedSynth } from './step-sequenced-synth.js';
import { engine } from '../core/audio-engine.js';
import { transport } from '../core/transport.js';
import { createKeybed } from '../ui/keybed.js';
import { ACIDBASS_WORKLET_SRC } from './acidbass-worklet.js';

/** Modul-weiter Cache für das addModule()-Promise -- der AudioContext ist
 *  ein App-weites Singleton (s. audio-engine.js), das Worklet-Modul darf
 *  nur EINMAL registriert werden, egal wie viele AcidBass-Instanzen entstehen.
 *  RackWerk wird als einzelne gebündelte index.html ausgeliefert (s.
 *  README), es gibt also keinen zweiten Dateipfad für ein Worklet-Modul --
 *  der Quelltext wird deshalb als Blob-URL "virtuell" bereitgestellt. */
let workletReadyPromise = null;
function ensureAcidBassWorklet(ctx) {
  if (!workletReadyPromise) {
    if (!ctx.audioWorklet) {
      workletReadyPromise = Promise.resolve(false);
    } else {
      const blob = new Blob([ACIDBASS_WORKLET_SRC], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      workletReadyPromise = ctx.audioWorklet.addModule(url)
        .then(() => { URL.revokeObjectURL(url); return true; })
        .catch((err) => {
          URL.revokeObjectURL(url);
          console.error('AcidBass: Worklet-Modul konnte nicht geladen werden', err);
          return false;
        });
    }
  }
  return workletReadyPromise;
}

export class AcidBass extends StepSequencedSynth {
  static meta = {
    type: 'acidbass',
    name: 'AcidBass',
    desc: '303-style acid bassline synth with Devil Fish filter mods',
    color: '#c3e02e',
    model: 'RW-08',
  };

  static DEFAULT_MIDI = 36;

  /** Pattern-Steps brauchen zusätzlich Accent/Slide (s. Dateikopf) --
   *  ohne diese Überschreibung würde die Basisklasse Steps ohne die
   *  beiden Felder anlegen, das Step-Grid (accentSlide:true, s.
   *  buildControls()) läse dann konsequent `undefined` (harmlos falsy,
   *  aber ohne diese Defaults fehlten die Felder z. B. beim Klonen eines
   *  Patterns über die Pattern-Bank -- {...s} kopiert nur, was da ist). */
  emptyPattern(len = 16) {
    return Array.from({ length: len }, () => ({
      on: false, midi: this.constructor.DEFAULT_MIDI, accent: false, slide: false,
    }));
  }

  buildAudio() {
    this.params = {
      waveform: 'saw',
      tune: 0,
      cutoff: 500,
      resonance: 0.5,
      envMod: 0.5,
      decay: 0.3,
      accentDecay: 0.15,
      accent: 0.6,
      overdrive: 0,
      filterFM: 0,
      slideTime: 0.06,
      hiRes: false,
      ampDecay: 1.23,
      volume: 0.7,
    };

    this.patterns = [this.emptyPattern(), this.emptyPattern(), this.emptyPattern(), this.emptyPattern()];
    this.patternIndex = 0;
    this.pattern = this.patterns[0];

    this.workletNode = null;
    this._disposed = false;
    this.output.gain.value = this.params.volume;

    const ctx = engine.ctx;
    ensureAcidBassWorklet(ctx).then((ok) => {
      if (!ok || this._disposed) return;
      this.workletNode = new AudioWorkletNode(ctx, 'acidbass-voice', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      this.workletNode.connect(this.output);
      this.workletNode.port.postMessage({ type: 'params', params: { ...this.params } });
    });
  }

  /** Alle Parameter am Worklet aktualisieren -- einmal pro Reglerbewegung/
   *  Laden, bewusst als kompletter Snapshot statt Einzelkeys (Regler ändern
   *  sich hier selten genug, dass das kein Performance-Thema ist, macht die
   *  Nachrichten-Verdrahtung aber deutlich simpler). */
  #syncParams() {
    this.workletNode?.port.postMessage({ type: 'params', params: { ...this.params } });
  }

  /* ---------- Kernauslösung: harter Trigger ODER Slide ---------- */
  trigger(midi, time, accent, slide) {
    this.pulse(time);
    // Worklet lädt asynchron (s. buildAudio()) -- in der kurzen Zeitspanne
    // direkt nach dem Anlegen der Maschine (typ. < 50ms) einfach stumm
    // bleiben, statt den Trigger zu verwerfen oder fehlerhaft zu puffern;
    // dieselbe Toleranz wie beim Sampler, der Pad-Trigger vor geladenem
    // Sample ebenfalls no-op behandelt (s. sampler.js).
    if (!this.workletNode) return;
    this.workletNode.port.postMessage({
      type: 'trigger', midi, time, accent: !!accent, slide: !!slide,
    });
  }

  /** Eigener onStep() statt des ererbten -- der kennt nur {on, midi}, hier
   *  müssen zusätzlich Accent/Slide an trigger() durchgereicht werden. */
  onStep(step, time) {
    const idx = step % this.pattern.length;
    const delayMs = (time - engine.now) * 1000;
    this.seq?.flashStep(idx, delayMs, transport.stepDuration * 900);
    const st = this.pattern[idx];
    if (!st.on) return;
    this.trigger(st.midi, time, st.accent, st.slide);
  }

  disposeAudio() {
    this._disposed = true;
    if (this.workletNode) {
      this.workletNode.port.postMessage({ type: 'dispose' });
      this.workletNode.disconnect();
      this.workletNode = null;
    }
  }

  /* ---------- Persistenz ---------- */
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
      this.patterns = state.patterns.map((p) => p.map((s) => ({
        on: !!s.on, midi: s.midi ?? this.constructor.DEFAULT_MIDI, accent: !!s.accent, slide: !!s.slide,
      })));
      this.patternIndex = state.patternIndex ?? 0;
    }
    while (this.patterns.length < 4) this.patterns.push(this.emptyPattern());
    this.pattern = this.patterns[this.patternIndex] ?? this.patterns[0];
    this.output.gain.value = this.params.volume;
    this.setPan(state.pan ?? 0);
    this.#syncParams();
  }

  /* ---------- UI ---------- */
  buildControls(container) {
    const seg = document.createElement('div');
    seg.className = 'seg';
    seg.innerHTML = `
      <span class="seg__label">Wave</span>
      <button class="seg__btn" data-wave="saw">Saw</button>
      <button class="seg__btn" data-wave="square">Square</button>
    `;
    seg.querySelectorAll('.seg__btn').forEach((b) =>
      b.classList.toggle('is-active', b.dataset.wave === this.params.waveform));
    seg.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-wave]');
      if (!btn) return;
      this.params.waveform = btn.dataset.wave;
      seg.querySelectorAll('.seg__btn').forEach((b) => b.classList.toggle('is-active', b === btn));
      this.#syncParams();
    });
    container.appendChild(seg);

    const row = document.createElement('div');
    row.className = 'machine__row';
    row.innerHTML = `
      <x-knob label="Tune" min="-12" max="12" value="0" step="1" unit="st" data-p="tune" data-auto></x-knob>
      <x-knob label="Cutoff" min="60" max="6000" value="500" curve="log" unit="Hz" data-p="cutoff" data-auto></x-knob>
      <x-knob label="Resonance" min="0" max="1" value="0.5" data-p="resonance" data-auto></x-knob>
      <x-knob label="Env Mod" min="0" max="1" value="0.5" data-p="envMod" data-auto></x-knob>
      <x-knob label="Decay" min="0.03" max="2" value="0.3" curve="log" unit="s" data-p="decay" data-auto></x-knob>
      <x-knob label="Accent" min="0" max="1" value="0.6" data-p="accent" data-auto></x-knob>
      <x-knob label="Volume" min="0" max="1" value="0.7" data-p="volume" data-auto></x-knob>
    `;
    container.appendChild(row);

    // Devil-Fish-Zusatzregler in einer eigenen, klar abgegrenzten Reihe --
    // markiert als "Mod"-Zeile, damit erkennbar bleibt: das ist die
    // Erweiterung, nicht der 303-Grundregelsatz oben.
    const modRow = document.createElement('div');
    modRow.className = 'machine__row acidbass__devilfish';
    modRow.innerHTML = `
      <span class="acidbass__devilfish-label">Devil Fish</span>
      <x-knob label="Overdrive" min="0" max="1" value="0" data-p="overdrive" data-auto></x-knob>
      <x-knob label="Filter FM" min="0" max="1" value="0" data-p="filterFM" data-auto></x-knob>
      <x-knob label="Slide Time" min="0.01" max="0.5" value="0.06" curve="log" unit="s" data-p="slideTime" data-auto></x-knob>
      <x-knob label="Acc. Decay" min="0.03" max="2" value="0.15" curve="log" unit="s" data-p="accentDecay" data-auto></x-knob>
      <x-knob label="Amp Decay" min="0.016" max="3" value="1.23" curve="log" unit="s" data-p="ampDecay" data-auto></x-knob>
      <button type="button" class="m-btn acidbass__hires${this.params.hiRes ? ' is-active' : ''}" data-hires>Hi-Res</button>
    `;
    modRow.querySelector('[data-hires]').addEventListener('click', (e) => {
      this.params.hiRes = !this.params.hiRes;
      e.target.classList.toggle('is-active', this.params.hiRes);
      this.#syncParams();
    });
    container.appendChild(modRow);

    [row, modRow].forEach((r) => r.addEventListener('input', (e) => {
      const key = e.target.dataset?.p;
      if (!key) return;
      const val = e.detail.value;
      this.params[key] = val;
      if (key === 'volume') {
        this.setLevel(val);
      } else {
        this.#syncParams();
      }
    }));

    this.buildPatternControls(container, { accentSlide: true });

    container.appendChild(createKeybed({
      baseMidi: 36,
      onNoteOn: (midi) => this.trigger(midi, engine.ctx.currentTime, false, false),
    }));
  }
}
