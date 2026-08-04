/**
 * KickSynth — dedizierter Kick-Drum-Designer im Stil von Sonic Academy
 * KICK 2: ein einzelner, tief abgestimmter Sinus-Body mit steiler
 * Pitch-Hüllkurve (der "Klick"->"Boom"-Sweep, der einen Kick von einem
 * blossen Sinuston unterscheidet), dazu Sättigung für Punch/Härte und ein
 * separater Rausch-Klick-Layer für den Beater-Transienten -- bewusst eine
 * EINFACHE Erstversion (s. Chat: "machen wir mal eine einfache Version"):
 * ein Body-Oszillator statt mehrerer Layer, ein Klick-Layer statt Kick 2s
 * volles Transient-Design, keine Multiband-Sättigung. Erweiterbar, falls
 * gewünscht.
 *
 * Unterschied zu AnalogKits bd() (909-Style-Kick): dort ist die Hüllkurve/
 * Sättigung/Klick FEST verdrahteter Stimmcharakter (kein Nutzerregler,
 * s. dortigen Kommentar) -- hier ist genau das der Sinn der Maschine: alle
 * vier Kick-2-typischen Formparameter (Pitch Env, Pitch Decay, Drive,
 * Click) sind eigene Regler, um den Sound frei zu gestalten statt einen
 * einzelnen 909-Kick nachzubilden.
 *
 * Fire-and-forget wie PercSynth (kein noteOff/gehaltene Stimmen) -- Pattern-
 * Bank/Step-Grid/Jam-Clip-Bindung sitzen in StepSequencedSynth. Notenwert
 * pro Step bestimmt (zusammen mit Tune) die Ziel-/Endfrequenz des Sweeps;
 * DEFAULT_MIDI liegt tief (wie AcidBass) für einen klassischen Kick-Bereich.
 */
import { StepSequencedSynth } from './step-sequenced-synth.js';
import { engine } from '../core/audio-engine.js';
import { noise, autoStop, midiToHz } from '../core/dsp.js';
import { createKeybed } from '../ui/keybed.js';

/** Drive-Kurve: Blend Identität<->Tanh-Sättigung über `amount`, wie
 *  makeDriveCurve() in inserts.js -- bei amount=0 exakte Identität (sauberer
 *  Sinus), bei amount=1 volle Sättigung. Anders als beim Tape-Machine-Insert
 *  (s. dortigen Chat/Fix: soll dezent bandsättigen) darf ein Kick-Drive
 *  ruhig kräftig zupacken -- das ist hier der gewünschte "Punch"-Regler,
 *  kein subtiler Wärme-Effekt -- deshalb bewusst höheres K als dort. */
function makeKickDriveCurve(amount) {
  const n = 512;
  const curve = new Float32Array(n);
  const K = 6;
  const norm = Math.tanh(K);
  for (let i = 0; i < n; i++) {
    // (n - 1), NICHT n -- s. makeSatCurve() in analogkit.js für die
    // ausführliche Begründung (sonst hörbarer DC-Klick bei Eingang 0).
    const x = (i * 2) / (n - 1) - 1;
    const shaped = Math.tanh(K * x) / norm;
    curve[i] = (1 - amount) * x + amount * shaped;
  }
  return curve;
}

export class KickSynth extends StepSequencedSynth {
  static DEFAULT_MIDI = 36; // ~65Hz, klassischer Kick-Grundton (wie AcidBass)

  static meta = {
    type: 'kicksynth',
    name: 'KickSynth',
    desc: 'Dedicated kick drum designer — pitch envelope, drive, click',
    color: '#e2543f',
    model: 'RW-09',
  };

  buildAudio() {
    this.params = {
      tune: 0,        // st — Feinstimmung um die Step-/Keybed-Note
      pitchEnv: 24,   // st — Sweep-Hub über der Endfrequenz (der "Klick"-Anteil)
      pitchDecay: 0.05, // s — wie schnell der Sweep auf die Endfrequenz fällt
      decay: 0.4,     // s — Länge der Amp-Hüllkurve (der "Boom"-Anteil)
      drive: 0.3,     // 0..1 — Sättigung/Punch
      click: 0.3,     // 0..1 — Rausch-Transient am Anschlag
      volume: 0.85,
    };
    this.output.gain.value = this.params.volume;

    this.patterns = [this.emptyPattern(), this.emptyPattern(), this.emptyPattern(), this.emptyPattern()];
    this.patternIndex = 0;
    this.pattern = this.patterns[0];
  }

  /* ---------- Stimme (fire-and-forget) ---------- */
  playNote(midi, time, _dur, vel = 1) {
    time = engine.quantizeTime(time); // konsistente Block-Ausrichtung
    this.pulse(time);
    const ctx = engine.ctx;
    const p = this.params;
    const baseFreq = midiToHz(midi + p.tune);
    const startFreq = baseFreq * 2 ** (p.pitchEnv / 12);
    const dur = Math.max(0.05, p.decay);
    const TAIL = 0.05;

    // Pitch-Hüllkurve: startet pitchEnv Halbtöne über der Endfrequenz und
    // fällt exponentiell dorthin zurück -- der eigentliche Kick-2-Charakter.
    // /3 wie applyFilterEnv() in dsp.js: setTargetAtTime() erreicht sein
    // Ziel erst nach ~3 Zeitkonstanten, /3 macht aus dem Regler-Wert also
    // wieder die tatsächlich wahrgenommene Sweep-Dauer.
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(startFreq, time);
    osc.frequency.setTargetAtTime(baseFreq, time, Math.max(0.01, p.pitchDecay) / 3);

    const shaper = ctx.createWaveShaper();
    shaper.curve = makeKickDriveCurve(p.drive);

    // Amp-Hüllkurve. Letzter linearer Schritt auf echte 0 GENAU im
    // TAIL-Fenster vor autoStop()s stop() -- ohne den bliebe die Gain bis
    // zum harten stop() bei 0.001 hängen und spränge dann abrupt auf 0
    // (hörbares Klicken, s. dsp.js#env/PercSynth).
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(vel, time);
    amp.gain.exponentialRampToValueAtTime(0.001, time + dur);
    amp.gain.linearRampToValueAtTime(0, time + dur + TAIL);

    osc.connect(shaper).connect(amp).connect(this.output);
    autoStop(osc, time, dur + TAIL, [shaper, amp]);

    // Klick-Layer: sehr kurzer, hochpassgefilterter Rauschimpuls für den
    // Beater-Transienten -- getrennt von der Pitch-/Amp-Hüllkurve des
    // Body-Oszillators, damit Klick-Länge nicht an Decay hängt.
    if (p.click > 0.01) {
      const n = ctx.createBufferSource();
      n.buffer = noise(ctx);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 1200;
      const ng = ctx.createGain();
      const clickDur = 0.006;
      ng.gain.setValueAtTime(p.click * vel, time);
      ng.gain.exponentialRampToValueAtTime(0.001, time + clickDur);
      ng.gain.linearRampToValueAtTime(0, time + clickDur + TAIL);
      n.connect(hp).connect(ng).connect(this.output);
      autoStop(n, time, clickDur + TAIL, [hp, ng]);
    }
  }

  /* ---------- UI ---------- */
  buildControls(container) {
    const row = document.createElement('div');
    row.className = 'machine__row';
    row.innerHTML = `
      <x-knob label="Tune" min="-12" max="12" value="0" step="1" unit="st" data-p="tune" data-auto></x-knob>
      <x-knob label="Pitch Env" min="0" max="48" value="24" step="1" unit="st" data-p="pitchEnv" data-auto></x-knob>
      <x-knob label="Pitch Decay" min="0.01" max="0.5" value="0.05" curve="log" unit="s" data-p="pitchDecay" data-auto></x-knob>
      <x-knob label="Decay" min="0.05" max="2" value="0.4" curve="log" unit="s" data-p="decay" data-auto></x-knob>
      <x-knob label="Drive" min="0" max="1" value="0.3" data-p="drive" data-auto></x-knob>
      <x-knob label="Click" min="0" max="1" value="0.3" data-p="click" data-auto></x-knob>
      <x-knob label="Volume" min="0" max="1" value="0.85" data-p="volume" data-auto></x-knob>
    `;
    row.addEventListener('input', (e) => {
      const key = e.target.dataset?.p;
      if (!key) return;
      const val = e.detail.value;
      this.params[key] = val;
      if (key === 'volume') {
        this.setLevel(val); // eine Quelle der Wahrheit, auch für den Mixer
      }
    });
    container.appendChild(row);

    // Kein Roll-Modus: die Hüllkurve hängt rein am eigenen Decay-Regler
    // (dur aus der Sequenzer-Notenlänge wird in playNote() ignoriert, s.
    // dort) -- eine im Roll gezeichnete Notenlänge hätte keine hörbare
    // Wirkung.
    this.buildPatternControls(container, { roll: false });

    // Keybed tief angesetzt -- Kicks leben in den unteren Oktaven, anders
    // als PercSynths eine Oktave höher gesetztes Keybed.
    container.appendChild(createKeybed({
      baseMidi: 24,
      onNoteOn: (midi) => {
        if (this.isLiveRecording) {
          const idx = this.liveStepIndex(this.pattern.length);
          this.pattern[idx] = { on: true, midi };
          this.seq?.refreshStep(idx);
        }
        this.playNote(midi, engine.ctx.currentTime);
      },
    }));
  }
}
