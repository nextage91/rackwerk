/**
 * TrackedDrumMachine — gemeinsames Chassis für mehrspurige, synthetisierte
 * Drum-Machines mit Pad-Auswahl, gemeinsamem 16-Step-Grid und A/B/C/D-
 * Pattern-Bank (BeatBox, AnalogKit). Unterklassen liefern nur noch:
 *   static meta       — Registry/Faceplate-Angaben (type/name/desc/color/model)
 *   static TRACK_DEFS — [{ name, synth(ctx,t,dest,params), snap? }, ...]
 * plus ihre eigenen Klangerzeuger-Funktionen (kick/snare/… bzw. bd/sd/…)
 * und optional seedDemo() (nur BeatBox nutzt das für die Startbesetzung,
 * s. project.js#newProject — AnalogKit startet immer leer).
 *
 * Der komplette Rest — Bind/Serialize/Sequenzer/Automation/UI — hängt
 * nicht vom konkreten Klangcharakter ab und war zuvor 1:1 zwischen
 * BeatBox und AnalogKit dupliziert.
 */
import { Machine } from './machine.js';
import { engine } from '../core/audio-engine.js';
import { transport } from '../core/transport.js';
import { StepSeq, resizePattern } from '../ui/step-seq.js';
import { createPatternBank } from '../ui/pattern-bank.js';
import { automation } from '../core/automation.js';
import { song } from '../core/song.js';

export class TrackedDrumMachine extends Machine {
  getParamForKnob(key) {
    // volume liegt hier nicht in params — alles andere (z. B. die
    // FX-Sends) beantwortet die Basisklasse
    return key === 'volume' ? this.volume : super.getParamForKnob(key);
  }

  buildAudio() {
    this.volume = 0.8;
    this.output.gain.value = this.volume;
    this.selected = 0;
    /** Index der solo geschalteten Spur, oder null */
    this.soloTrack = null;

    // Spuren tragen die Klang-Parameter (nicht pattern-abhängig). Jede Spur
    // bekommt eine eigene StereoPannerNode — anders als bei Level (steckt
    // als Multiplikator in der Hüllkurve, siehe Drum-Synthese der Unter-
    // klasse) gibt es für Panorama keine "Stelle im Code", an der man
    // ansetzen könnte, ohne echte Audio-Nodes: jeder Trigger muss durch
    // die Spur-eigene Node. Jede Spur bekommt zusätzlich ihre eigenen
    // Send-Gains zu Delay/Reverb — parallel zum trockenen Pfad (panner ->
    // this.output), nicht dahinter. Dadurch bleiben Spur-Sends unabhängig
    // von MUTE der Maschine (bewusst: ein gemuteter Kit-Bus soll trotzdem
    // noch in den Effekt "nachklingen" können, wie bei einem Send-Only-
    // Trick am echten Pult) -- SOLO einer anderen Maschine klemmt sie
    // trotzdem zusätzlich ab, s. setSoloShadowed() unten: Solo soll
    // "nur dieses Instrument" bedeuten, nicht "dieses plus alle
    // Effekt-Sends der anderen".
    this.tracks = this.constructor.TRACK_DEFS.map((def) => {
      const panner = engine.ctx.createStereoPanner();
      panner.connect(this.output);
      const sendDelayNode = engine.ctx.createGain();
      sendDelayNode.gain.value = 0;
      panner.connect(sendDelayNode);
      sendDelayNode.connect(engine.delayBus);
      const sendReverbNode = engine.ctx.createGain();
      sendReverbNode.gain.value = 0;
      panner.connect(sendReverbNode);
      sendReverbNode.connect(engine.reverbBus);
      return {
        ...def, tune: 1, decay: 1, level: 0.9, attack: 0, release: 0.05, pan: 0, panner,
        sendDelay: 0, sendReverb: 0, sendDelayNode, sendReverbNode,
      };
    });

    // 4 leere Pattern-Slots (A/B/C/D), je ein Slot pro TRACK_DEFS-Eintrag.
    // Die Spuren zeigen per steps-Referenz aufs aktive Slot. Ein Start-
    // Groove kommt nicht von hier, sondern optional über seedDemo() der
    // Unterklasse.
    this.patterns = [this.emptySlot(), this.emptySlot(), this.emptySlot(), this.emptySlot()];
    this.patternIndex = 0;
    // Binden hier inline: buildAudio läuft aus dem Basis-Konstruktor, private
    // Methoden der Unterklasse sind da noch nicht verfügbar.
    this.patterns[0].forEach((steps, ti) => { this.tracks[ti].steps = steps; });
  }

  /** Leeres Pattern-Slot: eine leere 16-Step-Spur je TRACK_DEFS-Eintrag.
   *  Bewusst KEIN privates Feld (kein #): buildAudio() ruft das aus dem
   *  Konstruktor der Basisklasse Machine heraus auf, bevor die privaten
   *  Elemente DIESER Zwischenklasse (TrackedDrumMachine) initialisiert
   *  sind -- das passiert laut Spec erst, nachdem der super()-Aufruf
   *  dieser Klasse zurückgekehrt ist, also NACH Machine's Konstruktor.
   *  Ein #privates emptySlot() wirft an der Stelle "Receiver must be an
   *  instance of class TrackedDrumMachine" (real reproduziert). */
  emptySlot() {
    return this.constructor.TRACK_DEFS.map(() => Array.from({ length: 16 }, () => ({ on: false })));
  }

  /* ---------- Pattern-Bank (A/B/C/D) ---------- */
  /** Die steps-Referenzen der Spuren auf beliebige Daten zeigen lassen
   *  (nicht zwingend this.patterns — auch von bindClipData genutzt). */
  #bindData(slot) {
    this.tracks.forEach((tr, ti) => { tr.steps = slot[ti]; });
  }
  #bindSlot() {
    this.#bindData(this.patterns[this.patternIndex]);
  }
  /** Aktives Pattern setzen (auch von der Song-Wiedergabe). */
  setPatternIndex(i) {
    this.patternIndex = i;
    this.#bindSlot();
    this.patternBank?.setActive(i);
    this.seq?.setPattern(this.tracks[this.selected].steps);
    automation.setBars(this.id, this.seq?.bars ?? 1);
    // Loser Hook fürs Rack (kompakte Zeile zeigt den aktiven Pattern-
    // Buchstaben) -- analog zu onMixerChange fürs Mute/Solo-Sync.
    this.onPatternChange?.();
  }
  #cloneSlot(i) {
    return this.patterns[i].map((steps) => steps.map((s) => ({ on: s.on })));
  }

  /** Für Jam-Clip-Wiedergabe: Live-Sequenzer-Zustand direkt auf beliebige
   *  Daten binden, OHNE this.patterns/patternIndex zu berühren — ein Clip
   *  ist kein fünfter A/B/C/D-Slot, sondern läuft daneben. */
  bindClipData(data) {
    this.#bindData(data);
    this.seq?.setPattern(this.tracks[this.selected].steps);
    automation.setBars(this.id, this.seq?.bars ?? 1);
  }

  /** Ob Pattern-Slot i überhaupt einen Treffer enthält (irgendeine Spur) —
   *  für die Jam-Proto-Clip-Kacheln (jam-view.js), die leere Slots blass
   *  darstellen. */
  hasPatternContent(i) {
    return this.patterns[i].some((steps) => steps.some((s) => s.on));
  }

  /** Pattern-Slot i direkt als neuen Jam-Clip anlegen — dieselbe Kopie wie
   *  über den Halten-Chip im Rack (s. buildControls#onAddClip), nur ohne
   *  den Umweg dorthin (Jam-Proto-Clips, s. jam-view.js). */
  addClipFromPattern(i) {
    return this.addClip({ name: `Pattern ${'ABCD'[i]}`, shape: 'drums', data: this.#cloneSlot(i) });
  }

  /* ---------- Sequenzer ---------- */
  onStep(step, time) {
    const idx = step % this.tracks[0].steps.length; // alle Spuren gleich lang
    const delayMs = (time - engine.now) * 1000;
    this.seq?.flashStep(idx, delayMs, transport.stepDuration * 900);

    for (let i = 0; i < this.tracks.length; i++) {
      if (this.soloTrack != null && i !== this.soloTrack) continue;
      const tr = this.tracks[i];
      if (tr.steps[idx].on) this.#trigger(tr, time);
    }
  }

  serialize() {
    return {
      volume: this.volume,
      // Spur-Parameter (pattern-übergreifend)
      tracks: this.tracks.map((tr) => ({
        tune: tr.tune, decay: tr.decay, level: tr.level, attack: tr.attack, release: tr.release,
        snap: tr.snap, oscMix: tr.oscMix, noiseMix: tr.noiseMix, pan: tr.pan,
        sendDelay: tr.sendDelay, sendReverb: tr.sendReverb,
      })),
      // 4 Pattern-Slots (nur Steps)
      patterns: this.patterns.map((slot) => slot.map((steps) => steps.map((s) => ({ on: s.on })))),
      patternIndex: this.patternIndex,
      pan: this.pan,
    };
  }

  deserialize(state) {
    this.volume = state.volume ?? 0.8;
    this.output.gain.value = this.volume;
    state.tracks?.forEach((saved, i) => {
      const tr = this.tracks[i];
      if (!tr) return;
      tr.tune = saved.tune ?? tr.tune;
      tr.decay = saved.decay ?? tr.decay;
      tr.level = saved.level ?? tr.level;
      tr.attack = saved.attack ?? tr.attack;
      tr.release = saved.release ?? tr.release;
      if (saved.snap !== undefined) tr.snap = saved.snap;
      if (saved.oscMix !== undefined) tr.oscMix = saved.oscMix;
      if (saved.noiseMix !== undefined) tr.noiseMix = saved.noiseMix;
      this.setTrackPan(i, saved.pan ?? 0);
      // this.knobs existiert beim Laden noch nicht (deserialize läuft vor
      // buildControls) — direkt an Feld + Gain-Node schreiben statt über
      // setTrackSend, das erst nach dem Rendern sicher aufrufbar ist.
      tr.sendDelay = saved.sendDelay ?? 0;
      tr.sendDelayNode.gain.setTargetAtTime(tr.sendDelay, engine.now, 0.01);
      tr.sendReverb = saved.sendReverb ?? 0;
      tr.sendReverbNode.gain.setTargetAtTime(tr.sendReverb, engine.now, 0.01);
    });
    if (state.patterns) {
      this.patterns = state.patterns.map((slot) => slot.map((steps) => steps.map((s) => ({ on: !!s.on }))));
      this.patternIndex = state.patternIndex ?? 0;
    } else if (state.tracks?.some((t) => t.steps)) {
      // Altes Format: Steps lagen in tracks[].steps → Slot A, B–D leer
      const slotA = state.tracks.map((saved) => (saved.steps ?? []).map((s) => ({ on: !!s.on })));
      this.patterns = [slotA, this.emptySlot(), this.emptySlot(), this.emptySlot()];
      this.patternIndex = 0;
    }
    while (this.patterns.length < 4) this.patterns.push(this.emptySlot());
    this.patternIndex = Math.min(this.patternIndex ?? 0, 3);
    this.#bindSlot();
    this.setPan(state.pan ?? 0);
  }

  /* ---------- Mixer: Pegel (Volume separat, nicht in params) ---------- */
  get level() { return this.volume; }
  setLevel(v) {
    v = Math.min(1, Math.max(0, v));
    this.volume = v;
    this.output.gain.setTargetAtTime(v, engine.now, 0.01);
    const knob = this.el?.querySelector('x-knob[data-p="volume"]');
    if (knob) knob.value = v;
  }

  onTransport(event) {
    if (event === 'stop') this.seq?.clearPlayhead();
  }

  /** Basisklasse kennt die Spur-Panner nicht — selbst aufräumen. */
  disposeAudio() {
    for (const tr of this.tracks) {
      tr.panner.disconnect();
      tr.meterAnalyser?.disconnect();
      tr.sendDelayNode.disconnect();
      tr.sendReverbNode.disconnect();
    }
  }

  /** Die Spur-Sends laufen bewusst an `this.gate` vorbei (s. buildAudio())
   *  — Mute soll sie unberührt lassen. Solo (eine ANDERE Maschine ist
   *  solo) bzw. ein geschlossenes Jam-Gate sollen aber wirklich NUR das
   *  gewählte Instrument übrig lassen, also hier zusätzlich stumm. Der
   *  gespeicherte Spur-Send-Wert (tr.sendDelay/tr.sendReverb) bleibt dabei
   *  unangetastet — beim Aufheben des Solo kommt exakt der alte Wert
   *  zurück, kein manuelles Nachstellen der Send-Knobs nötig. */
  setSoloShadowed(shadowed) {
    // Machine's Konstruktor ruft refreshGates() bereits VOR buildAudio()
    // auf (s. dort) -- this.tracks existiert dann noch nicht.
    if (!this.tracks) return;
    for (const tr of this.tracks) {
      tr.sendDelayNode.gain.setTargetAtTime(shadowed ? 0 : tr.sendDelay, engine.now, 0.015);
      tr.sendReverbNode.gain.setTargetAtTime(shadowed ? 0 : tr.sendReverb, engine.now, 0.015);
    }
  }

  /** Analyser fürs Kanalzug-VU-Meter einer einzelnen Drum-Spur im Mixer
   *  (Pendant zu Machine.getMeterAnalyser, hier hinter dem Spur-Panner). */
  getTrackMeterAnalyser(i) {
    const tr = this.tracks[i];
    if (!tr.meterAnalyser) {
      tr.meterAnalyser = engine.ctx.createAnalyser();
      tr.meterAnalyser.fftSize = 512;
      tr.panner.connect(tr.meterAnalyser);
    }
    return tr.meterAnalyser;
  }

  #trigger(tr, time) {
    this.pulse(time);
    // Auf die Render-Quantum-Grenze ausrichten → jeder Anschlag ist
    // identisch im Audio-Block positioniert (siehe engine.quantizeTime).
    // Ziel ist die Spur-eigene Panner-Node (nicht direkt this.output),
    // damit jede Drum-Spur ihre eigene Stereo-Position hat.
    tr.synth(engine.ctx, engine.quantizeTime(time), tr.panner, tr);
  }

  /* ---------- Mixer: Pegel & Panorama pro Spur ---------- */
  /** Hält den Panel-Level-Knob synchron, falls diese Spur gerade angezeigt wird. */
  setTrackLevel(i, v) {
    const tr = this.tracks[i];
    if (!tr) return;
    tr.level = Math.min(1, Math.max(0, v));
    if (i === this.selected) this.knobs.level.value = tr.level;
  }
  setTrackPan(i, v) {
    const tr = this.tracks[i];
    if (!tr) return;
    tr.pan = Math.min(1, Math.max(-1, v));
    tr.panner.pan.setTargetAtTime(tr.pan, engine.now, 0.01);
  }

  /** which: 'delay' | 'reverb' — eigener Send je Drum-Spur, unabhängig vom
   *  Kit-weiten Send der Maschine (Machine.setSend). */
  setTrackSend(i, which, v) {
    const tr = this.tracks[i];
    if (!tr) return;
    v = Math.min(1, Math.max(0, v));
    const key = which === 'delay' ? 'sendDelay' : 'sendReverb';
    const node = which === 'delay' ? tr.sendDelayNode : tr.sendReverbNode;
    tr[key] = v;
    node.gain.setTargetAtTime(v, engine.now, 0.01);
    if (i === this.selected) this.knobs[key].value = v;
  }

  /* ---------- UI ---------- */
  buildControls(container) {
    // Spur-Parameter (Tune/Decay/Level/Snap/Sends) in einer eigenen,
    // eingefärbten Reihe MIT Spurname — sonst nicht erkennbar, dass diese
    // Regler nur die aktuell gewählte Spur betreffen und nicht das ganze
    // Kit. Maschinen-Volume bewusst in einer eigenen, neutralen Reihe.
    const row = document.createElement('div');
    row.className = 'machine__row machine__row--track';
    row.innerHTML = `
      <span class="track-row__label" data-track-label></span>
      <x-knob label="Tune"  min="0.5" max="2" value="1"   default="1" curve="log" data-p="tune"></x-knob>
      <x-knob label="Decay" min="0.25" max="3" value="1"  default="1" curve="log" data-p="decay"></x-knob>
      <x-knob label="Level" min="0" max="1" value="0.9"   data-p="level"></x-knob>
      <x-knob label="Attack" min="0" max="0.3" value="0" default="0" data-p="attack"></x-knob>
      <x-knob label="Release" min="0.005" max="1" value="0.05" default="0.05" curve="log" data-p="release"></x-knob>
      <x-knob label="Snap"  min="0" max="1" value="0.5"   data-p="snap"></x-knob>
      <x-knob label="Tone" min="0" max="2" value="1" default="1" data-p="oscMix"></x-knob>
      <x-knob label="Noise" min="0" max="2" value="1" default="1" data-p="noiseMix"></x-knob>
      <x-knob label="Send D" min="0" max="1" value="0" data-p="trackSendDelay"></x-knob>
      <x-knob label="Send R" min="0" max="1" value="0" data-p="trackSendReverb"></x-knob>
    `;
    row.addEventListener('input', (e) => {
      const key = e.target.dataset?.p;
      if (!key) return;
      const val = e.detail.value;
      if (key === 'trackSendDelay' || key === 'trackSendReverb') {
        // eigene Setter (ramp den Send-Gain) statt Rohwert-Zuweisung — sonst
        // bewegt sich der Regler, aber der Effekt bleibt stumm. Eigener
        // data-p-Name (nicht "sendDelay"/"sendReverb") -- die Basisklasse
        // hat unter genau diesen Schlüsseln schon den Kit-weiten FX-Send,
        // sonst würden sich Panel-Sync-Läufe (Machine.render/getParamForKnob)
        // gegenseitig überschreiben.
        this.setTrackSend(this.selected, key === 'trackSendDelay' ? 'delay' : 'reverb', val);
      } else {
        this.tracks[this.selected][key] = val;
      }
    });
    container.appendChild(row);
    this.trackLabelEl = row.querySelector('[data-track-label]');
    this.knobs = {
      tune: row.querySelector('[data-p="tune"]'),
      decay: row.querySelector('[data-p="decay"]'),
      level: row.querySelector('[data-p="level"]'),
      attack: row.querySelector('[data-p="attack"]'),
      release: row.querySelector('[data-p="release"]'),
      snap: row.querySelector('[data-p="snap"]'),
      oscMix: row.querySelector('[data-p="oscMix"]'),
      noiseMix: row.querySelector('[data-p="noiseMix"]'),
      sendDelay: row.querySelector('[data-p="trackSendDelay"]'),
      sendReverb: row.querySelector('[data-p="trackSendReverb"]'),
    };

    // Maschinen-weite Lautstärke — eigene Reihe, damit sie nicht mit den
    // Spur-Reglern oben verwechselt wird.
    const volRow = document.createElement('div');
    volRow.className = 'machine__row';
    volRow.innerHTML = `<x-knob label="Kit Volume" min="0" max="1" value="0.8" data-p="volume" data-auto></x-knob>`;
    volRow.addEventListener('input', (e) => {
      if (e.target.dataset?.p === 'volume') this.setLevel(e.detail.value); // eine Quelle der Wahrheit, auch für den Mixer
    });
    container.appendChild(volRow);

    // Per-Spur-Automation: Der Lane-Schlüssel entsteht beim Anfassen aus
    // der gerade gewählten Spur — jede Drum-Spur hat eigene Fahrten.
    // Playback schreibt direkt in die Spur-Parameter; der Knob bewegt
    // sich nur mit, wenn seine Spur gerade ausgewählt ist.
    for (const param of ['tune', 'decay', 'level', 'attack', 'release', 'snap', 'oscMix', 'noiseMix']) {
      const applyForKey = (key, value) => {
        const trIdx = parseInt(key.split(':')[1], 10);
        if (this.tracks[trIdx][param] === undefined) return; // Spur ohne diesen Param
        this.tracks[trIdx][param] = value;
        if (trIdx === this.selected) this.knobs[param].value = value;
      };
      automation.registerDynamic(
        this.knobs[param],
        () => `${this.id}:${this.selected}:${param}`,
        applyForKey,
      );
      // Alle Spur-Ziele vorregistrieren, damit GELADENE Lanes sofort
      // abspielen (ohne dass der Knob erst angefasst werden muss)
      for (let ti = 0; ti < this.tracks.length; ti++) {
        const key = `${this.id}:${ti}:${param}`;
        automation.ensureTarget(key, this.knobs[param], (v) => applyForKey(key, v));
      }
    }

    // Spur-Sends genauso automatisierbar wie Tune/Decay/Level/Snap — eigener
    // Apply-Pfad über setTrackSend() statt Rohwert-Zuweisung, damit der
    // Send-Gain-Node beim Abspielen einer Lane auch wirklich rampt (reiner
    // Feld-Schreibzugriff wie bei tune/decay würde den Regler bewegen, aber
    // der Effekt bliebe stumm).
    for (const [param, which] of [['sendDelay', 'delay'], ['sendReverb', 'reverb']]) {
      const applyForKey = (key, value) => {
        const trIdx = parseInt(key.split(':')[1], 10);
        this.setTrackSend(trIdx, which, value);
      };
      automation.registerDynamic(
        this.knobs[param],
        () => `${this.id}:${this.selected}:${param}`,
        applyForKey,
      );
      for (let ti = 0; ti < this.tracks.length; ti++) {
        const key = `${this.id}:${ti}:${param}`;
        automation.ensureTarget(key, this.knobs[param], (v) => applyForKey(key, v));
      }
    }

    // Pads: anspielen + Spur wählen
    const pads = document.createElement('div');
    pads.className = 'pads';
    this.padEls = this.tracks.map((tr, i) => {
      const pad = document.createElement('button');
      pad.className = 'pad';
      pad.textContent = tr.name;
      pad.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        if (this.isLiveRecording) {
          tr.steps[this.liveStepIndex(tr.steps.length)].on = true;
        }
        this.#trigger(tr, engine.ctx.currentTime);
        this.#selectTrack(i); // rendert das Grid neu — zeigt den frischen Step gleich mit
      });
      pads.appendChild(pad);
      return pad;
    });
    container.appendChild(pads);

    this.patternBank = createPatternBank({
      index: this.patternIndex,
      shape: 'drums',
      onSwitch: (i) => { this.setPatternIndex(i); song.recordPattern(this.id, i); },
      getSlot: (i) => this.#cloneSlot(i),
      putSlot: (i, data) => {
        this.patterns[i] = data.map((steps) => steps.map((s) => ({ on: !!s.on })));
        this.setPatternIndex(i);
      },
      onAddClip: (i) => this.addClipFromPattern(i),
    });
    container.appendChild(this.patternBank.el);

    // Ein Grid für alle Spuren — zeigt immer die gewählte
    this.seq = new StepSeq(this.tracks[0].steps, {
      pitch: false,
      onLengthChange: (bars) => {
        for (const tr of this.tracks) resizePattern(tr.steps, bars);
        this.seq.setPattern(this.tracks[this.selected].steps);
        automation.setBars(this.id, bars, { resize: true }); // Spur-Lanes mitwachsen lassen
      },
    });
    container.appendChild(this.seq.el);
    // Automations-Lanes an die (ggf. geladene) Pattern-Länge koppeln
    automation.setBars(this.id, this.seq.bars);

    // Solo-Button für die gewählte Spur in die Grid-Kopfzeile einhängen
    const ctrl = this.seq.el.querySelector('.stepseq__ctrl');
    this.soloBtn = document.createElement('button');
    this.soloBtn.className = 'm-btn m-btn--solo';
    this.soloBtn.textContent = 'SOLO';
    this.soloBtn.addEventListener('click', () => {
      this.soloTrack = this.soloTrack === this.selected ? null : this.selected;
      this.#refreshSoloUI();
    });
    ctrl.insertBefore(this.soloBtn, ctrl.querySelector('[data-clear]'));

    this.#selectTrack(0);
  }

  #selectTrack(i) {
    this.selected = i;
    const tr = this.tracks[i];
    this.padEls.forEach((p, j) => p.classList.toggle('is-selected', j === i));
    this.trackLabelEl.textContent = tr.name;
    this.seq.setPattern(tr.steps);
    this.knobs.tune.value = tr.tune;
    this.knobs.decay.value = tr.decay;
    this.knobs.level.value = tr.level;
    this.knobs.attack.value = tr.attack;
    this.knobs.release.value = tr.release;
    this.knobs.snap.style.display = tr.snap === undefined ? 'none' : '';
    if (tr.snap !== undefined) this.knobs.snap.value = tr.snap;
    this.knobs.oscMix.style.display = tr.oscMix === undefined ? 'none' : '';
    if (tr.oscMix !== undefined) this.knobs.oscMix.value = tr.oscMix;
    this.knobs.noiseMix.style.display = tr.noiseMix === undefined ? 'none' : '';
    if (tr.noiseMix !== undefined) this.knobs.noiseMix.value = tr.noiseMix;
    this.knobs.sendDelay.value = tr.sendDelay;
    this.knobs.sendReverb.value = tr.sendReverb;
    for (const param of ['tune', 'decay', 'level', 'attack', 'release', 'snap', 'oscMix', 'noiseMix', 'sendDelay', 'sendReverb']) {
      this.knobs[param].classList.toggle('has-auto',
        automation.hasLane(`${this.id}:${i}:${param}`));
    }
    this.seq.el.querySelector('.stepseq__title').textContent = tr.name;
    this.#refreshSoloUI();
  }

  /** Nach dem Laden eines Projekts: LEDs an die gewählte Spur anpassen.
   *  super.onLanesImported() holt dasselbe für die Insert-FX-Knobs nach
   *  (s. Machine#onLanesImported). */
  onLanesImported() {
    super.onLanesImported();
    this.#selectTrack(this.selected);
  }

  #refreshSoloUI() {
    this.soloBtn.classList.toggle('is-active', this.soloTrack === this.selected);
    this.padEls.forEach((p, j) => p.classList.toggle('is-solo', j === this.soloTrack));
  }
}
