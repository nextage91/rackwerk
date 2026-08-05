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
import { midiToHz, makeFmVoice, applyFilterEnv } from '../core/dsp.js';

/** Headroom pro Stimme -- wie SubSynth/PolySynth (dort ausführlich gegen
 *  den Rest des Kits austariert): eine gehaltene Note braucht Kopfraum,
 *  weil sie (anders als ein perkussiver Klang) die ganze Haltedauer nahe
 *  der Spitzenlautstärke bleibt statt abzuklingen. */
const VOICE_HEADROOM = 0.55;

/** Deckel für gleichzeitig gehaltene Stimmen -- s. subsynth.js#MAX_VOICES. */
const MAX_VOICES = 16;
/** Fester, sehr kurzer Release beim Stimmen-Diebstahl -- s.
 *  subsynth.js#STEAL_RELEASE_S. */
const STEAL_RELEASE_S = 0.015;

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
      filterType: 'lowpass', // 'lowpass' | 'highpass' | 'bandpass', s. subsynth.js#filterType
      cutoff: 8000,
      resonance: 0.7,
      envAmt: 0.3,          // Filterhüllkurve: 0..1 ≙ 0..+4 Oktaven über Cutoff, s. dsp.js#applyFilterEnv
      fDecay: 0.2,          // s — Abklingzeit der Filterhüllkurve
      attack: 0.005,
      release: 0.4,
      volume: 0.7,
    };
    /** aktive Stimmen: midi → {fm, filter, ampEnv} */
    this.voices = new Map();
    // Wiederverwendungs-Pool für fm-voice-Instanzen (s. #acquireFmVoice/
    // #releaseFmVoice unten) -- vermeidet, für JEDE Note einen neuen
    // AudioWorkletNode+5 ConstantSourceNodes zu bauen. Das war der
    // eigentliche Grund für hörbares Knacksen speziell bei Sequenzer-
    // Triggerung (playNote()): der Lookahead-Planer (s. transport.js,
    // SCHEDULE_AHEAD=0.1s) kann bei Timer-Nachzüglern mehrere Steps in
    // EINEM synchronen JS-Tick nachholen, was mehrere Worklet-Knoten-
    // Konstruktionen bündelt -- beim Tastenspiel (von Hand, ein Anschlag
    // nach dem anderen) kommt das nie in dieser Dichte vor. Ein
    // wiederverwendeter Worklet-Knoten kostet dagegen nur ein günstiges
    // .connect()/.disconnect(), keine neue Konstruktion.
    this.fmPool = [];
    this.output.gain.value = this.params.volume;

    /** 4 leere Pattern-Slots (A/B/C/D) — neu hinzugefügte Maschinen starten
     *  ohne vorprogrammierte Steps. */
    this.patterns = [this.emptyPattern(), this.emptyPattern(), this.emptyPattern(), this.emptyPattern()];
    this.patternIndex = 0;
    this.pattern = this.patterns[0];
  }

  /** Holt eine wiederverwendbare fm-voice aus dem Pool oder baut eine neue,
   *  falls keine frei ist (z. B. beim allerersten Anschlag) -- s.
   *  Kommentar bei `this.fmPool` in buildAudio() fürs "Warum". Die
   *  zurückgegebene Instanz läuft bereits (nie gestoppt, s.
   *  #releaseFmVoice), ihre Parameter tragen aber noch Werte/laufende
   *  Automation der VORHERIGEN Note -- `cancelScheduledValues` + frische
   *  `.value`-Zuweisungen räumen das in #buildVoice/#applyFmEnv auf. */
  #acquireFmVoice(ctx) {
    return this.fmPool.pop() ?? makeFmVoice(ctx);
  }

  /** Gegenstück zu #acquireFmVoice -- trennt die fm-voice vom alten
   *  Filter/Hüllkurven-Pfad der zu Ende gegangenen Note und legt sie für
   *  die nächste Note zurück in den Pool. BEWUSST kein `fm.stop()`: ein
   *  einmal gestopptes ConstantSourceNode (die AudioParam-Träger hinter
   *  `.carrierFreq`/`.modFreq`/... , s. core/dsp.js#makeFmVoice) lässt sich
   *  nicht neu starten -- die Stimme muss für Wiederverwendung dauerhaft
   *  weiterlaufen, exakt lautlos ist sie ohnehin nur durch die AUSSEN
   *  liegende Amp-Hüllkurve, nicht durch eigenes Schweigen. */
  #releaseFmVoice(fm) {
    fm.output.disconnect();
    this.fmPool.push(fm);
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

    // Überabgetastete FM-Stimme (Carrier+Modulator+Feedback in EINEM
    // Worklet-Knoten, s. core/dsp.js#makeFmVoice) statt der früheren zwei
    // nativen OscillatorNodes -- vermeidet das per Messung bestätigte
    // Aliasing bei hohem Modulationsindex (s. tools/dsp-tests/
    // fm-aliasing-measurement.mjs). Aus dem Pool statt frisch gebaut, s.
    // #acquireFmVoice -- kann noch Automation/Werte der vorherigen Note
    // tragen, deshalb cancelScheduledValues VOR den neuen Werten.
    const fm = this.#acquireFmVoice(ctx);
    fm.carrierFreq.cancelScheduledValues(t);
    fm.carrierFreq.value = carrierFreq;
    fm.modFreq.cancelScheduledValues(t);
    fm.modFreq.value = Math.max(0.01, modFreq);
    // Feedback: der Modulator wirkt zusätzlich auf SEINE EIGENE Frequenz
    // zurück (fester Wert, keine eigene Hüllkurve -- Feedback ist ein
    // Klangfarbe-Regler, kein Anschlags-Element).
    fm.feedback.cancelScheduledValues(t);
    fm.feedback.value = p.feedback * FEEDBACK_SCALE;
    fm.detune.cancelScheduledValues(t);
    fm.detune.value = 0; // FMSynth nutzt kein Detune, aber defensiv zurücksetzen (Pool-Wiederverwendung)

    // Filterhüllkurve (wie SubSynth/PolySynth, s. dsp.js#applyFilterEnv):
    // öffnet beim Anschlag zusätzlich über den statischen Cutoff hinaus und
    // fällt dann zurück -- verstärkt genau das FM-eigene "beim Anschlag
    // heller, dann dunkler"-Verhalten (s. Dateikopf-Kommentar zu FM Env)
    // auch im Filter selbst, statt nur im Modulationsindex. Bislang fest
    // auf Lowpass/statischen Cutoff, klang dadurch spürbar statischer als
    // SubSynth/PolySynth (Chat: "die filter... klingen zu clean").
    const filter = ctx.createBiquadFilter();
    filter.type = p.filterType;
    filter.Q.value = p.resonance;
    applyFilterEnv(filter, t, p);
    fm.output.connect(filter);

    return { fm, filter, carrierFreq, modFreq };
  }

  /** FM-Index-Hüllkurve: startet bei (fmAmount+fmEnv), fällt exponentiell
   *  auf den Sustain-Wert fmAmount zurück -- derselbe Peak->Sustain-Ansatz
   *  wie dsp.js#applyFilterEnv, nur auf den Modulationsindex statt eine
   *  Filterfrequenz angewandt (s. Dateikopf-Kommentar fürs "Warum"). */
  #applyFmEnv(fm, modFreq, t) {
    const p = this.params;
    const peak = (p.fmAmount + p.fmEnv) * FM_INDEX_SCALE * modFreq;
    const sustain = p.fmAmount * FM_INDEX_SCALE * modFreq;
    // cancelScheduledValues: eine aus dem Pool wiederverwendete Stimme (s.
    // #acquireFmVoice) kann noch eine laufende Abkling-Automation der
    // VORHERIGEN Note tragen -- ohne das würde die alte Kurve mit der
    // neuen verschmelzen statt sauber beim neuen Anschlag neu zu beginnen.
    fm.fmIndex.cancelScheduledValues(t);
    fm.fmIndex.setValueAtTime(peak, t);
    fm.fmIndex.setTargetAtTime(sustain, t, Math.max(0.01, p.fmDecay) / 3);
  }

  /** Setzt die fm-voice der zu Ende gehenden Note nach `stopAt` zurück in
   *  den Pool statt sie zu stoppen/verwerfen (s. #releaseFmVoice). Ein
   *  `setTimeout` statt eines sample-genauen `onended`-Callbacks reicht
   *  hier völlig: die Amp-Hüllkurve hat das Signal zu diesem Zeitpunkt
   *  längst unhörbar gemacht, es geht nur noch darum, WANN der Knoten
   *  gefahrlos für die nächste Note wiederverwendet werden darf -- ein
   *  paar Millisekunden Ungenauigkeit dabei sind unhörbar. Prüft
   *  `this.#disposed`, falls die ganze Maschine inzwischen abgebaut wurde
   *  (s. disposeAudio) -- dann landet die Stimme NICHT mehr im (dann
   *  schon geleerten) Pool, sondern wird selbst sauber entsorgt. */
  #scheduleRelease(fm, filter, ampEnv, stopAt) {
    const delayMs = Math.max(0, (stopAt - engine.ctx.currentTime) * 1000);
    setTimeout(() => {
      filter.disconnect();
      ampEnv.disconnect();
      if (this.#disposed) fm.dispose();
      else this.#releaseFmVoice(fm);
    }, delayMs);
  }

  /** Fire-and-forget-Stimme für den Sequenzer. */
  playNote(midi, time, dur, vel = 1) {
    time = engine.quantizeTime(time);
    this.pulse(time);
    const p = this.params;
    const { fm, filter, modFreq } = this.#buildVoice(midi, time);
    this.#applyFmEnv(fm, modFreq, time);

    const ampEnv = engine.ctx.createGain();
    // ampEnv.gain.value = 0 SOFORT (nicht erst per setValueAtTime(0, time)):
    // `time` liegt beim Sequenzer bis zu SCHEDULE_AHEAD=0.1s in der Zukunft
    // (s. transport.js), ein frisches GainNode steht bis zum ERSTEN
    // Automations-Event aber auf seinem Default-Gain 1 -- und die (aus dem
    // Pool wiederverwendete, nie gestoppte, s. #acquireFmVoice) fm-voice
    // wird bereits JETZT (nicht erst bei `time`) in die Filter/Amp-Kette
    // verbunden. Ohne dieses sofortige `.value = 0` lief das alte/neue
    // Signal bis zu 100ms lang unhüllt auf voller Lautstärke durch, bevor
    // die Hüllkurve bei `time` abrupt auf 0 sprang und wieder hochfuhr --
    // genau das hörbare Knacksen NUR bei Sequenzer-, nie bei Tastentriggerung
    // (dort ist `time` == `currentTime`, die Lücke praktisch null).
    ampEnv.gain.value = 0;
    // KEIN Math.min(p.attack, dur*0.5) mehr -- s. subsynth.js#playNote
    // für die Begründung (dieselbe Kappe, derselbe unnötige Effekt).
    ampEnv.gain.setValueAtTime(0, time);
    ampEnv.gain.linearRampToValueAtTime(VOICE_HEADROOM * vel, time + p.attack);
    ampEnv.gain.setTargetAtTime(0, time + dur, p.release / 4);
    filter.connect(ampEnv).connect(this.output);

    const stopAt = time + dur + p.release + 0.1;
    this.#scheduleRelease(fm, filter, ampEnv, stopAt);
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
    const { fm, filter, modFreq } = this.#buildVoice(midi, t);
    this.#applyFmEnv(fm, modFreq, t);

    const ampEnv = engine.ctx.createGain();
    ampEnv.gain.setValueAtTime(0, t);
    ampEnv.gain.linearRampToValueAtTime(VOICE_HEADROOM, t + p.attack);
    filter.connect(ampEnv).connect(this.output);

    this.voices.set(midi, { fm, filter, ampEnv, modFreq });
  }

  /** `steal`: true nur beim Verdrängen durch MAX_VOICES (s. noteOn oben). */
  noteOff(midi, steal = false) {
    const v = this.voices.get(midi);
    if (!v) return;
    this.voices.delete(midi);

    const t = engine.ctx.currentTime;
    const rel = steal ? STEAL_RELEASE_S : this.params.release;
    v.ampEnv.gain.cancelScheduledValues(t);
    v.ampEnv.gain.setTargetAtTime(0, t, rel / 4);
    const stopAt = t + rel + 0.1;
    this.#scheduleRelease(v.fm, v.filter, v.ampEnv, stopAt);
  }

  allNotesOff() {
    for (const midi of [...this.voices.keys()]) this.noteOff(midi);
  }

  /** true nach disposeAudio() -- s. #scheduleRelease: eine bereits
   *  geplante Rückgabe an den Pool muss davon wissen, dass der Pool selbst
   *  inzwischen geleert/entsorgt wurde. */
  #disposed = false;

  disposeAudio() {
    this.allNotesOff();
    this.#disposed = true;
    for (const fm of this.fmPool) fm.dispose();
    this.fmPool = [];
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
        for (const v of this.voices.values()) v.fm.feedback.setTargetAtTime(val * FEEDBACK_SCALE, t, 0.01);
      }
    });
    container.appendChild(opRow);

    // Filtertyp: LP/HP/BP -- identisches Muster zu subsynth.js#filterType,
    // wirkt sofort auch auf klingende (gehaltene) Stimmen.
    const filterSeg = document.createElement('div');
    filterSeg.className = 'seg';
    filterSeg.innerHTML = `
      <span class="seg__label">Filter</span>
      <button class="seg__btn" data-ft="lowpass">LP</button>
      <button class="seg__btn" data-ft="highpass">HP</button>
      <button class="seg__btn" data-ft="bandpass">BP</button>
    `;
    filterSeg.querySelectorAll('.seg__btn').forEach((b) =>
      b.classList.toggle('is-active', b.dataset.ft === this.params.filterType));
    filterSeg.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-ft]');
      if (!btn) return;
      this.params.filterType = btn.dataset.ft;
      filterSeg.querySelectorAll('.seg__btn').forEach((b) => b.classList.toggle('is-active', b === btn));
      for (const v of this.voices.values()) v.filter.type = btn.dataset.ft;
    });
    container.appendChild(filterSeg);

    const ampRow = document.createElement('div');
    ampRow.className = 'machine__row';
    ampRow.innerHTML = `
      <x-knob label="Cutoff"  min="200" max="16000" value="8000" curve="log" unit="Hz" data-p="cutoff" data-auto></x-knob>
      <x-knob label="Reso"    min="0.5" max="12" value="0.7" data-p="resonance" data-auto></x-knob>
      <x-knob label="Env Amt" min="0" max="1" value="0.3" data-p="envAmt" data-auto></x-knob>
      <x-knob label="F.Decay" min="0.03" max="1.5" value="0.2" curve="log" unit="s" data-p="fDecay" data-auto></x-knob>
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
      // envAmt/fDecay wirken bewusst NICHT rückwirkend -- wie FM Amount/
      // Env/Decay oben, s. dortigen Kommentar (beim Anschlag fest eingeplant).
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
