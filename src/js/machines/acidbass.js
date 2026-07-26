/**
 * AcidBass — monophone Bassline-Synthese im Stil der Roland TB-303, plus
 * ausgewählte "Devil Fish"-Mod-Regler (Overdrive, Filter FM, Hi-Resonance,
 * einstellbare Slide-Zeit, separates Accent-Decay).
 *
 * Recherche-Grundlage (s. Chat): Open303 (RobinSchmidt, DSP-Kern MIT-
 * lizenziert, github.com/RobinSchmidt/Open303) als algorithmische
 * Referenz für Hüllkurven-/Accent-Verhalten -- KEIN Code übernommen,
 * hier komplett neu in Web Audio geschrieben. Ebenso das Devil-Fish-
 * Handbuch (firstpr.com.au/rwi/dfish) für die Mod-Feature-Liste.
 *
 * Architektur-Unterschied zu SubSynth/PolySynth/FMSynth: die 303 ist
 * monophon MIT Slide (Legato-Glide zwischen zwei Noten) -- pro Trigger
 * wird KEINE neue Stimme erzeugt, sondern ein einziger, dauerhaft
 * laufender Oszillator umgestimmt (hart bei normalem Trigger, weich
 * geglitten bei Slide). Deshalb kein `voices`-Map wie bei den anderen
 * Synths, sondern eine feste Signalkette, die schon in buildAudio()
 * einmal aufgebaut wird.
 *
 * Filter: 4 kaskadierte Tiefpässe (24dB/Okt gesamt) MIT einer echten
 * Rückkopplungsschleife (Ausgang -> Resonanz-Gain -> weicher Dioden-
 * artiger Clipper -> minimales Delay [von Web Audio für jede Schleife
 * verlangt] -> zurück an den Eingang) -- rein native Web-Audio-Nodes
 * (keine AudioWorklet-Nichtlinearität pro Sample), aber echte
 * Selbstschwingung bei hoher Resonanz statt nur eines hohen Biquad-Q.
 * Der Clipper übernimmt zwei Rollen gleichzeitig: das dreckige,
 * obertonreiche 303-typische Resonanz-"Growl" UND einen Sicherheits-
 * Begrenzer gegen unkontrolliertes Aufschaukeln der Schleife.
 */
import { StepSequencedSynth } from './step-sequenced-synth.js';
import { engine } from '../core/audio-engine.js';
import { transport } from '../core/transport.js';
import { createKeybed } from '../ui/keybed.js';
import { midiToHz, applyFilterEnv } from '../core/dsp.js';

/** Gain-Headroom für die Amp-Hüllkurve -- deutlich niedriger als bei den
 *  anderen Synths (SubSynth: 0.6), weil die Resonanz-Rückkopplung SELBST
 *  bereits kräftig Pegel zulegt (per Messung bis zu ~4x bei hoher
 *  Resonanz, s. Chat-Verifikation) -- ohne diese Kompensation würde eine
 *  aufgedrehte AcidBass den Rest des Mixes an den Limiter drücken. Der
 *  Pegelanstieg mit steigender Resonanz bleibt bewusst hörbar (genau das
 *  macht den Resonanz-Sweep-Charakter aus), nur die BASIS ist niedriger
 *  angesetzt. */
const VOICE_HEADROOM = 0.3;
const AMP_ATTACK = 0.003;
const AMP_RELEASE = 0.03;

/** Wie stark Accent zusätzlich zur Grund-Filterhüllkurve/-Lautstärke
 *  draufgibt, skaliert vom globalen Accent-Regler (0..1). Werte per
 *  Ohr/Messung gegen Clipping abgeglichen (s. Chat-Verifikation). */
const ACCENT_ENV_BOOST = 0.6;
const ACCENT_AMP_BOOST = 0.7;

/** Maximaler Rückkopplungs-Gain je Resonanz-Reglerstellung (0..1) --
 *  per OfflineAudioContext-Sweep ermittelt (s. Chat-Verifikation): die
 *  Schleife geht mit dem festen Dioden-Clipper (s. u.) schon ab ca. 0.5
 *  Rückkopplungs-Gain in Selbstschwingung über, ein naiver hoher Wert
 *  (ursprünglich 3.4) sättigte dadurch schon in den ersten ~15% des
 *  Reglerwegs -- der Rest des Knopfs hätte sich "tot" angefühlt. Diese
 *  Werte verteilen den hörbaren Übergang (sauber -> resonant -> pfeifend)
 *  über den GANZEN Regelweg; Hi-Res (Devil-Fish-Schalter) bleibt bei
 *  jeder Reglerstellung hörbar aggressiver als normal. */
const RES_FEEDBACK_MAX_NORMAL = 0.9;
const RES_FEEDBACK_MAX_HIRES = 1.4;

/** Tiefe des Filter-FM-Pfads in Hz je Regler-Einheit (0..1) -- der
 *  Oszillator (Einheitsamplitude ±1) wird direkt auf die frequency-
 *  AudioParams der 4 Filterstufen addiert, s. buildAudio(). */
const FM_DEPTH_HZ = 2500;

function resonanceToFeedbackGain(resonance, hiRes) {
  const max = hiRes ? RES_FEEDBACK_MAX_HIRES : RES_FEEDBACK_MAX_NORMAL;
  return Math.max(0, Math.min(1, resonance)) * max;
}

/** Fixer weicher Clipper in der Rückkopplungsschleife -- s. Dateikopf,
 *  doppelte Rolle (Dioden-Charakter + Selbstschwing-Sicherheitsnetz).
 *  Härte (k) bewusst konstant: nur der Rückkopplungs-GAIN (oben) ändert
 *  sich mit dem Resonanz-Regler, nicht die Kurvenform selbst -- entspricht
 *  dem realen Schaltungsverhalten (die Dioden sitzen fest in der
 *  Schleife, nur der Rückkopplungspegel wird vom Resonanz-Poti bestimmt). */
function makeDiodeClipCurve() {
  const n = 1024;
  const curve = new Float32Array(n);
  const k = 2.5;
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / (n - 1) - 1;
    curve[i] = Math.tanh(x * k) / norm;
  }
  return curve;
}

/** Devil-Fish-"Overdrive": übersteuert das Signal VOR dem Filter (mehr
 *  Pegel "unter Stress" in die Kaskade schicken, s. Handbuch) -- anders
 *  als der feste Schleifen-Clipper oben muss diese Kurve bei jeder
 *  Reglerbewegung neu gebaut werden (0 = praktisch unverändert, 1 =
 *  starke Sättigung). */
function makeOverdriveCurve(amount) {
  const n = 1024;
  const curve = new Float32Array(n);
  const drive = 1 + amount * 12;
  const norm = Math.tanh(drive);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / (n - 1) - 1;
    curve[i] = Math.tanh(x * drive) / norm;
  }
  return curve;
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
      volume: 0.7,
    };

    this.patterns = [this.emptyPattern(), this.emptyPattern(), this.emptyPattern(), this.emptyPattern()];
    this.patternIndex = 0;
    this.pattern = this.patterns[0];

    const ctx = engine.ctx;

    /** @type {number|null} letzte gespielte Tonhöhe -- Slide braucht eine
     *  Referenz, "wovon" geglitten wird; null direkt nach dem Bau/Laden
     *  (noch nie getriggert) behandelt eine als "slide" markierte erste
     *  Note einfach wie einen normalen harten Trigger. */
    this.lastMidi = null;

    this.osc = ctx.createOscillator();
    this.osc.type = this.params.waveform === 'square' ? 'square' : 'sawtooth';
    this.osc.frequency.value = midiToHz(this.constructor.DEFAULT_MIDI);
    this.osc.start();

    this.driveShaper = ctx.createWaveShaper();
    this.driveShaper.curve = makeOverdriveCurve(this.params.overdrive);
    this.driveShaper.oversample = '2x';

    // Filter-Eingangssumme: Trocken-Signal + Rückkopplung treffen sich hier.
    this.filterSum = ctx.createGain();

    this.stages = [0, 1, 2, 3].map(() => {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.Q.value = 0.55; // sanft je Stufe -- die eigentliche Resonanz kommt aus der Rückkopplung unten
      f.frequency.value = this.params.cutoff;
      return f;
    });

    this.feedbackGain = ctx.createGain();
    this.feedbackGain.gain.value = resonanceToFeedbackGain(this.params.resonance, this.params.hiRes);
    this.feedbackShaper = ctx.createWaveShaper();
    this.feedbackShaper.curve = makeDiodeClipCurve();
    // Minimales Delay -- Web Audio verlangt mindestens eins in jeder
    // Rückkopplungsschleife (echte Zero-Delay-Feedback ist mit reinen
    // nativen Nodes nicht möglich, s. Chat/Architektur-Entscheidung "Variante
    // A"); 1 Sample ist so kurz wie darstellbar, verschiebt die Resonanz-
    // Spitze bei sehr hohem Cutoff nur minimal.
    this.feedbackDelay = ctx.createDelay(0.01);
    this.feedbackDelay.delayTime.value = 1 / ctx.sampleRate;

    // Devil-Fish-Filter-FM: der Oszillator selbst (Audioraten-Signal)
    // moduliert die Cutoff-Frequenz aller 4 Stufen direkt -- entspricht dem
    // Audio-FM-Eingang der echten Mod (dort von aussen gepatcht, hier intern
    // fest verdrahtet und über einen Tiefen-Regler dosiert).
    this.fmGain = ctx.createGain();
    this.fmGain.gain.value = 0;

    this.ampEnv = ctx.createGain();
    this.ampEnv.gain.value = 0;

    this.osc.connect(this.driveShaper);
    this.driveShaper.connect(this.filterSum);
    this.filterSum.connect(this.stages[0]);
    this.stages[0].connect(this.stages[1]);
    this.stages[1].connect(this.stages[2]);
    this.stages[2].connect(this.stages[3]);

    this.stages[3].connect(this.feedbackGain);
    this.feedbackGain.connect(this.feedbackShaper);
    this.feedbackShaper.connect(this.feedbackDelay);
    this.feedbackDelay.connect(this.filterSum);

    this.osc.connect(this.fmGain);
    for (const s of this.stages) this.fmGain.connect(s.frequency);

    this.stages[3].connect(this.ampEnv);
    this.ampEnv.connect(this.output);
    this.output.gain.value = this.params.volume;
  }

  /* ---------- Kernauslösung: harter Trigger ODER Slide ---------- */
  trigger(midi, time, accent, slide) {
    this.pulse(time);
    const p = this.params;
    const freq = midiToHz(midi + p.tune);
    const isSlide = slide && this.lastMidi != null;

    this.osc.frequency.cancelScheduledValues(time);
    if (isSlide) {
      // Nur die Tonhöhe gleitet -- Amp-/Filterhüllkurve bleiben unangetastet,
      // die klingende Note "rutscht" einfach zur neuen Tonhöhe (Legato).
      this.osc.frequency.setTargetAtTime(freq, time, Math.max(0.005, p.slideTime) / 3);
    } else {
      this.osc.frequency.setValueAtTime(freq, time);

      const decayTime = accent ? p.accentDecay : p.decay;
      const ampPeak = Math.min(1, VOICE_HEADROOM * (1 + (accent ? p.accent * ACCENT_AMP_BOOST : 0)));
      this.ampEnv.gain.cancelScheduledValues(time);
      this.ampEnv.gain.setValueAtTime(0, time);
      this.ampEnv.gain.linearRampToValueAtTime(ampPeak, time + AMP_ATTACK);
      this.ampEnv.gain.exponentialRampToValueAtTime(0.001, time + AMP_ATTACK + decayTime);
      this.ampEnv.gain.linearRampToValueAtTime(0, time + AMP_ATTACK + decayTime + AMP_RELEASE);

      const envAmt = Math.min(1, p.envMod + (accent ? p.accent * ACCENT_ENV_BOOST : 0));
      for (const stage of this.stages) {
        applyFilterEnv(stage, time, { cutoff: p.cutoff, envAmt, fDecay: decayTime });
      }
    }
    this.lastMidi = midi;
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
    this.osc.stop();
    this.osc.disconnect();
    this.driveShaper.disconnect();
    this.filterSum.disconnect();
    for (const s of this.stages) s.disconnect();
    this.feedbackGain.disconnect();
    this.feedbackShaper.disconnect();
    this.feedbackDelay.disconnect();
    this.fmGain.disconnect();
    this.ampEnv.disconnect();
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

    this.osc.type = this.params.waveform === 'square' ? 'square' : 'sawtooth';
    this.driveShaper.curve = makeOverdriveCurve(this.params.overdrive);
    this.feedbackGain.gain.value = resonanceToFeedbackGain(this.params.resonance, this.params.hiRes);
    this.fmGain.gain.value = this.params.filterFM * FM_DEPTH_HZ;
    for (const s of this.stages) s.frequency.value = this.params.cutoff;
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
      this.osc.type = btn.dataset.wave === 'square' ? 'square' : 'sawtooth';
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
      <button type="button" class="m-btn acidbass__hires${this.params.hiRes ? ' is-active' : ''}" data-hires>Hi-Res</button>
    `;
    modRow.querySelector('[data-hires]').addEventListener('click', (e) => {
      this.params.hiRes = !this.params.hiRes;
      e.target.classList.toggle('is-active', this.params.hiRes);
      this.feedbackGain.gain.setTargetAtTime(
        resonanceToFeedbackGain(this.params.resonance, this.params.hiRes), engine.now, 0.01);
    });
    container.appendChild(modRow);

    let driveTimer = null;
    [row, modRow].forEach((r) => r.addEventListener('input', (e) => {
      const key = e.target.dataset?.p;
      if (!key) return;
      const val = e.detail.value;
      this.params[key] = val;
      const t = engine.now;
      if (key === 'cutoff') {
        // Nur die BASIS aktualisieren -- die Hüllkurve (applyFilterEnv,
        // s. trigger()) legt bei jedem Trigger neu auf, ohne live gehaltene
        // Stimme (monophon, kein "gehaltener Akkord") gibt es hier keinen
        // laufenden Ton, den man sofort nachziehen müsste.
        for (const s of this.stages) s.frequency.setTargetAtTime(val, t, 0.01);
      } else if (key === 'resonance') {
        this.feedbackGain.gain.setTargetAtTime(resonanceToFeedbackGain(val, this.params.hiRes), t, 0.01);
      } else if (key === 'overdrive') {
        clearTimeout(driveTimer);
        driveTimer = setTimeout(() => { this.driveShaper.curve = makeOverdriveCurve(val); }, 60);
      } else if (key === 'filterFM') {
        this.fmGain.gain.setTargetAtTime(val * FM_DEPTH_HZ, t, 0.01);
      } else if (key === 'volume') {
        this.setLevel(val);
      }
    }));

    this.buildPatternControls(container, { accentSlide: true });

    container.appendChild(createKeybed({
      baseMidi: 36,
      onNoteOn: (midi) => this.trigger(midi, engine.ctx.currentTime, false, false),
    }));
  }
}
