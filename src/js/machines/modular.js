/**
 * Modular — frei patchbare Synth-Stimme (wie Caustics "Modular"): statt
 * einer festen Klangkette baut sich der Nutzer seine eigene aus einzelnen
 * Bausteinen (core/modular.js#MODULE_DEFS), verbunden über virtuelle Kabel
 * im Patch-Editor (ui/modular-view.js#openModularEditor).
 *
 * Erbt Pattern-Bank/Step-Grid/Jam-Clip-Bindung unverändert von
 * StepSequencedSynth (wie SubSynth) -- monophon, sequenzergetrieben, kein
 * Keybed in dieser ersten Version (s. Chat: schrittweise Auslieferung,
 * gehaltene Stimmen wären ein eigener, grösserer Posten).
 */
import { StepSequencedSynth } from './step-sequenced-synth.js';
import { engine } from '../core/audio-engine.js';
import { ModularPatch } from '../core/modular.js';
import { openModularEditor } from '../ui/modular-view.js';

export class Modular extends StepSequencedSynth {
  static meta = {
    type: 'modular',
    name: 'Modular',
    desc: 'Freely patchable synth voice',
    color: '#8f9bb3',
    model: 'RW-11',
  };

  buildAudio() {
    this.params = { volume: 0.7 };
    this.output.gain.value = this.params.volume;

    this.patch = new ModularPatch();
    this.buildDefaultPatch();
    this.connectOutputs();

    this.patterns = [this.emptyPattern(), this.emptyPattern(), this.emptyPattern(), this.emptyPattern()];
    this.patternIndex = 0;
    this.pattern = this.patterns[0];
  }

  /** Startbesetzung für eine brandneue Maschine (kein gespeicherter Patch) --
   *  das klassische Minimal-Patch (Oszillator -> VCA -> Ausgang, Hüllkurve
   *  auf den VCA-Pegel), damit sofort ein Ton da ist statt einer leeren
   *  Fläche. Genau dieselbe Bausteinauswahl wie in der Chat-Vorschau.
   *  Bewusst KEIN privates Feld (kein #): buildAudio() ruft das aus dem
   *  Konstruktor der Basisklasse Machine heraus auf, bevor private Elemente
   *  DIESER Klasse initialisiert sind (dieselbe Falle wie bei
   *  StepSequencedSynth#emptyPattern, real reproduziert: "Receiver must be
   *  an instance of class Modular"). */
  buildDefaultPatch() {
    const oscId = this.patch.addModule('oscillator', { x: 20, y: 20 });
    const vcaId = this.patch.addModule('vca', { x: 140, y: 20 });
    const envId = this.patch.addModule('envelope', { x: 140, y: 140 });
    const outId = this.patch.addModule('output', { x: 260, y: 20 });
    this.patch.connect(oscId, 'audio', vcaId, 'audio');
    this.patch.connect(vcaId, 'audio', outId, 'audio');
    this.patch.connect(envId, 'cv', vcaId, 'gain');
  }

  /** Jedes "Output"-Modul im Patch fest an this.output anschliessen -- der
   *  einzige Übergang vom frei patchbaren Innenleben zur Basisklasse
   *  (Fader/Pan/Mute/Inserts/Sends laufen danach wie bei jeder Maschine
   *  unverändert weiter). Über ALLE Output-Module iteriert statt nur "das
   *  eine" anzunehmen -- der Editor verhindert zwar das Löschen des letzten,
   *  ein gespeicherter Patch könnte aber (durch älteres/fremdes Bearbeiten)
   *  auch mal keines oder mehrere enthalten; beide Fälle bleiben so sicher
   *  (stumm bzw. summiert), statt abzustürzen. */
  connectOutputs() {
    for (const m of this.patch.modules.values()) {
      if (m.type === 'output') m.instance.outputs.audio.connect(this.output);
    }
  }

  rebuildPatchFrom(saved) {
    this.patch.dispose();
    this.patch = new ModularPatch();
    if (saved?.modules?.length) {
      for (const m of saved.modules) this.patch.addModule(m.type, m);
      for (const c of saved.cables ?? []) this.patch.connect(c.fromId, c.fromPort, c.toId, c.toPort);
    } else {
      this.buildDefaultPatch();
    }
    this.connectOutputs();
  }

  /** Vom Sequenzer aufgerufen (s. StepSequencedSynth#onStep) -- ein
   *  Anschlag betrifft den GESAMTEN Patch (s. ModularPatch#triggerAll),
   *  nicht ein einzelnes Modul: der Oszillator setzt seine Tonhöhe, jede
   *  Hüllkurve rampt ihre Kurve, beides gleichzeitig für denselben Ton. */
  playNote(midi, time, dur) {
    time = engine.quantizeTime(time);
    this.pulse(time);
    this.patch.triggerAll(time, dur, midi);
  }

  buildControls(container) {
    const row = document.createElement('div');
    row.className = 'machine__row';
    row.innerHTML = '<button type="button" class="m-btn m-btn--wide" data-open-patch>🔌 Open Patch Editor</button>';
    row.querySelector('[data-open-patch]').addEventListener('click', () => openModularEditor(this));
    container.appendChild(row);
    this.buildPatternControls(container);
  }

  serialize() {
    return { ...super.serialize(), patch: this.patch.serialize() };
  }

  deserialize(state) {
    super.deserialize(state);
    this.rebuildPatchFrom(state.patch);
  }

  disposeAudio() {
    this.patch.dispose();
  }
}
