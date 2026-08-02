/**
 * modular.js — freie Patch-Umgebung (wie Caustics "Modular"): einzelne
 * Klangbausteine (Oszillator, Filter, Hüllkurve, …), die der Nutzer per
 * virtuellem Kabel beliebig miteinander verbindet, statt eine feste
 * Signalkette wie bei jeder anderen Maschine zu bekommen.
 *
 * Zwei Ebenen, wie inserts.js:
 *   - MODULE_DEFS: ein `build(ctx, params)` pro Modultyp, baut den echten
 *     Web-Audio-Teilgraphen und liefert { inputs, outputs, trigger?,
 *     setParam, dispose }. `inputs`/`outputs` sind benannte Ports --
 *     `inputs` kann AudioParams (CV-Ziel, z. B. Filter-Cutoff) ODER
 *     AudioNodes (Signal-Eingang, z. B. Filter-Audioeingang) enthalten,
 *     `outputs` sind immer AudioNodes.
 *   - ModularPatch: verwaltet Modul-Instanzen + Kabel-Liste, verbindet sie
 *     wirklich per connect()/disconnect().
 *
 * Sicherheit: JEDER Modul-Ausgang läuft durch denselben Weichbegrenzer
 * (tanh, wie beim Filter-Delay/Resonator/Master-Delay) -- eine frei
 * patchbare Umgebung kann der Nutzer in eine Rückkopplungsschleife
 * verkabeln, die wir nicht vorhersehen können (s. Chat: Rückkopplung
 * bleibt bewusst ERLAUBT, das ist eine der beliebtesten Modular-Techniken
 * überhaupt -- nur pauschal amplitudenbegrenzt statt topologisch verboten).
 *
 * CV-Eingänge (AudioParams) folgen der üblichen Konvention frei patchbarer
 * Software-Modularsysteme: Web Audio ADDIERT jede angeschlossene Quelle auf
 * den eingestellten Regler-Wert des Parameters -- für die meisten CV-Fälle
 * (z. B. Hüllkurve auf VCA-Gain) will man aber, dass das PATCH-KABEL allein
 * den Wert bestimmt, nicht Regler+Kabel zusammen. Deshalb: sobald ein Kabel
 * an einem CV-Eingang hängt, wird dessen Regler-Basiswert auf 0 gesetzt
 * (der Regler bleibt in der UI sichtbar, wirkt aber erst wieder, sobald das
 * letzte Kabel dort entfernt wird) -- s. ModularPatch#connect/disconnect.
 */
import { engine } from './audio-engine.js';
import { noise, midiToHz } from './dsp.js';
import { makeFeedbackClipCurve, makeDriveCurve } from './inserts.js';

let sharedClipCurve = null;
function clipCurve() {
  if (!sharedClipCurve) sharedClipCurve = makeFeedbackClipCurve();
  return sharedClipCurve;
}

/** Ein einziges Sample Verzögerung (1/sampleRate) -- unhörbar, aber
 *  entscheidend: die Web-Audio-Spezifikation MUTET jeden Zyklus, der KEINEN
 *  DelayNode enthält, automatisch komplett (Chromium tatsächlich beobachtet:
 *  ein Modul, das direkt oder über andere Module in seinen eigenen Eingang
 *  zurückgeführt wird, blieb sonst komplett stumm -- nicht etwa laut/instabil,
 *  sondern gar kein Signal). Da JEDER Modul-Ausgang durch safeOutput() läuft,
 *  reicht ein einzelner Mini-Delay HIER, um wirklich JEDEN möglichen Zyklus
 *  patchbar zu machen, egal welche Module ihn bilden. */
function microDelay(ctx) {
  const d = ctx.createDelay(1);
  d.delayTime.value = 1 / ctx.sampleRate;
  return d;
}

/** Hängt Mini-Delay + tanh-Weichbegrenzer HINTER einen rohen Ausgangsknoten
 *  und gibt den letzten Knoten der Kette zurück -- das ist es, was Kabel
 *  tatsächlich abgreifen (s. Dateikopf-Kommentar). Bei kleinen (CV-
 *  typischen) Pegeln ist der Begrenzer praktisch identisch zur Identität
 *  (tanh(x)≈x nahe 0), also auch für Steuerspannungs-Ausgänge unauffällig --
 *  deshalb pauschal auf ALLE Ausgänge angewendet statt nur auf Audio-Ports.
 *
 *  `scale` (Default 1, für alle Module ausser util unverändert): der
 *  WaveShaper bildet seine curve IMMER über den FESTEN Eingabebereich
 *  -1..1 ab -- jeder Wert ausserhalb wird laut Spezifikation auf den
 *  jeweiligen Rand-Wert der Kurve GEKAPPT, unabhängig davon, wie die Kurve
 *  selbst aussieht (per Reproduktion gefunden: util#build mit stark
 *  vergrössertem amount-Bereich, s. dort, erzeugte trotzdem nie mehr als
 *  ±0.76 am Ausgang -- der Begrenzer klemmte lange VOR jeder hörbaren
 *  Filter-Cutoff-Modulation). scale skaliert das Signal vor der Kurve
 *  herunter und danach wieder hoch (derselbe tanh-Verlauf, nur auf einen
 *  vielfachen Wertebereich gestreckt) -- bei util reicht das bis weit über
 *  den eigentlich nutzbaren Amount/Offset-Bereich hinaus transparent,
 *  schützt aber weiterhin vor einem unbegrenzten Aufschaukeln, falls
 *  jemand utils eigenen Ausgang in seinen eigenen Eingang zurückpatcht. */
function safeOutput(ctx, rawNode, scale = 1) {
  const delay = microDelay(ctx);
  rawNode.connect(delay);
  const chain = [delay];
  let node = delay;
  if (scale !== 1) {
    const pre = ctx.createGain();
    pre.gain.value = 1 / scale;
    node.connect(pre);
    node = pre;
    chain.push(pre);
  }
  const shaper = ctx.createWaveShaper();
  shaper.curve = clipCurve();
  node.connect(shaper);
  node = shaper;
  chain.push(shaper);
  if (scale !== 1) {
    const post = ctx.createGain();
    post.gain.value = scale;
    node.connect(post);
    node = post;
    chain.push(post);
  }
  node.__disposeChain = chain; // s. disposeOutput()
  return node;
}

/** Gegenstück zu safeOutput() -- trennt die GESAMTE interne Kette (Mini-
 *  Delay, evtl. Vor-/Nachverstärkung bei scale!==1, Weichbegrenzer) wieder
 *  ab, nicht nur den zurückgegebenen letzten Knoten. Jedes Modul ruft das
 *  statt eines blossen `output.disconnect()` in seinem eigenen dispose()
 *  auf. */
function disposeOutput(output) {
  for (const node of output.__disposeChain ?? []) node.disconnect();
  output.disconnect();
}

/* Reihenfolge der Objekt-Einträge bestimmt die "+ Add Module"-Liste (s.
 * MODULE_TYPES = Object.keys(MODULE_DEFS) unten) -- bewusst nach
 * Sounddesign-Rolle gruppiert statt in wilder Entstehungsreihenfolge
 * (Nutzer-Feedback: "die Modulauswahl ist nicht passend"), orientiert an
 * Caustics Modular-Palette und daran, was für Techno/House-Sounddesign
 * tatsächlich gebraucht wird: Klangquellen -> Klangformung -> Modulation
 * -> Utility -> Output. */
const MODULE_DEFS = {
  /* ---------- Klangquellen ---------- */
  oscillator: {
    name: 'Oscillator',
    defaults: { wave: 'sawtooth', coarse: 0, fine: 0 },
    build(ctx, p) {
      const osc = ctx.createOscillator();
      osc.type = p.wave;
      // Zurückgesetzt auf C4 (s. Chat: ein 1Hz-Default -- Versuch, das
      // Kaltstart-Problem beim allerersten Trigger unhörbar zu machen --
      // machte die Sache SCHLIMMER statt besser, deutlich hörbar). Das ist
      // ein wichtiger Hinweis auf den tatsächlichen Mechanismus: was auf
      // dem betroffenen Gerät beim allerersten je geplanten
      // setValueAtTime()-Aufruf passiert, ist offenbar kein sauberer
      // Sprung, sondern etwas wie ein Gleiten/Glide -- dessen Hörbarkeit
      // mit dem Frequenz-ABSTAND zwischen Startwert und Zielnote wächst.
      // Ein Startwert nahe C4 (wie hier) hält diesen Abstand für die
      // allermeisten Noten in einem für eine kurze Sequenzer-Note kaum
      // wahrnehmbaren Rahmen; ein Startwert bei 1Hz macht denselben Effekt
      // über mehrere Oktaven hinweg brutal hörbar. Der zugrunde liegende
      // Bug ist damit NICHT gelöst, nur nicht mehr verschlimmert.
      osc.frequency.value = midiToHz(60);
      osc.start();
      const output = safeOutput(ctx, osc);
      return {
        inputs: { pitch: osc.frequency, fine: osc.detune },
        outputs: { audio: output },
        // Vom Sequenzer aufgerufen (s. machines/modular.js#playNote) -- setzt
        // die Grundtonhöhe. Ein evtl. an `pitch`/`fine` gepatchtes CV-Signal
        // (LFO fürs Vibrato, Hüllkurve fürs Pitch-Envelope, …) ADDIERT sich
        // laut Web-Audio-Spezifikation automatisch darüber, braucht hier
        // keinen Sonderfall.
        trigger(t, _dur, midi) {
          osc.frequency.setValueAtTime(midiToHz(midi + p.coarse), t);
        },
        setParam(key, v) {
          if (key === 'wave') osc.type = v;
          else if (key === 'coarse') p.coarse = v;
          // Fine (Cent) sitzt auf DERSELBEN AudioParam (osc.detune) wie der
          // patchbare "fine"-CV-Eingang oben -- Regler-Wert und ein evtl.
          // gepatchtes Signal (Vibrato-LFO, …) addieren sich automatisch,
          // dieselbe Konvention wie überall sonst im Modular (s. Dateikopf-
          // Kommentar). setTargetAtTime statt direktem .value= aus demselben
          // Grund wie beim Filter-Cutoff: eine Regler-Zieh-Geste feuert viele
          // 'input'-Events, ein harter Sprung wäre als Knacksen hörbar.
          else if (key === 'fine') { p.fine = v; osc.detune.setTargetAtTime(v, engine.now, 0.01); }
        },
        dispose() { osc.stop(); osc.disconnect(); disposeOutput(output); },
      };
    },
  },

  noise: {
    name: 'Noise',
    defaults: {},
    build(ctx) {
      const src = ctx.createBufferSource();
      src.buffer = noise(ctx);
      src.loop = true;
      src.start();
      const output = safeOutput(ctx, src);
      return {
        inputs: {},
        outputs: { audio: output },
        setParam() {},
        dispose() { src.stop(); src.disconnect(); disposeOutput(output); },
      };
    },
  },

  /* ---------- Klangformung ---------- */
  filter: {
    name: 'Filter',
    defaults: { type: 'lowpass', cutoff: 2000, resonance: 0.707 },
    build(ctx, p) {
      const input = ctx.createGain();
      const filter = ctx.createBiquadFilter();
      filter.type = p.type;
      filter.frequency.value = p.cutoff;
      filter.Q.value = p.resonance;
      input.connect(filter);
      const output = safeOutput(ctx, filter);
      return {
        inputs: { audio: input, cutoff: filter.frequency },
        outputs: { audio: output },
        setParam(key, v) {
          if (key === 'type') filter.type = v;
          // Anders als beim VCA-Pegel (s. dort) ist additiv hier genau
          // richtig: der Regler setzt die Basisfrequenz, ein gepatchtes
          // LFO/Hüllkurven-Signal schwingt/verschiebt sie zusätzlich --
          // dieselbe Konvention wie bei echten Analogfiltern (Cutoff-Knopf
          // + CV-Eingang addieren sich).
          //
          // setTargetAtTime statt direktem .value= (Chat: "das Knacksen
          // kommt erst wenn ich den Filter (LP) zudrehe"): eine Regler-
          // Zieh-Geste feuert viele 'input'-Events hintereinander, jedes
          // ein SPRUNGHAFTES .value= auf die frequency-AudioParam -- bei
          // einem resonanten Biquad-Filter reisst so ein harter Sprung das
          // Filter kurz zum Klingeln/Überschwingen (per Reproduktion
          // bestätigt: ein Sprung von +0.59 auf den Clip-Deckel -0.76
          // innerhalb weniger Samples beim schnellen Runterdrehen). Eine
          // kurze setTargetAtTime-Glättung (10ms Zeitkonstante -- spürbar
          // sofort, aber ohne den harten Sprung) behebt das, ohne die
          // Reaktionsfreudigkeit des Reglers merklich zu verändern.
          else if (key === 'cutoff') { p.cutoff = v; filter.frequency.setTargetAtTime(v, engine.now, 0.01); }
          else if (key === 'resonance') filter.Q.setTargetAtTime(v, engine.now, 0.01);
        },
        dispose() { input.disconnect(); filter.disconnect(); disposeOutput(output); },
      };
    },
  },

  /** Distortion -- Waveshaper-Sättigung, DER zentrale Baustein für Acid-
   *  Filter-Sweeps und aggressive, kaputte Bässe/Percussion (Nutzer-
   *  Feedback: fehlte komplett, obwohl Caustics Modular sowas hat und es
   *  für Techno/House-Sounddesign eine der meistgenutzten Techniken ist --
   *  z. B. Filter -> Distortion -> VCA für einen 303-artigen Squelch).
   *  Bewusst NUR ein Drive-Regler, kein Tone/Mix/Base wie beim vollen
   *  Drive-Insert (inserts.js) -- Tonformung VOR/NACH der Sättigung erledigt
   *  im Patch ohnehin schon das Filter-Modul, ein zweites eingebautes Filter
   *  hier wäre nur Redundanz. Nutzt dieselbe Kurve wie der Drive-Insert
   *  (makeDriveCurve, s. inserts.js) -- dasselbe kuratierte Sättigungs-
   *  Verhalten, keine zweite, potenziell abweichende DSP-Implementierung
   *  für denselben Klangeffekt. */
  distortion: {
    name: 'Distortion',
    defaults: { drive: 0.4 },
    build(ctx, p) {
      const input = ctx.createGain();
      const shaper = ctx.createWaveShaper();
      shaper.oversample = '4x';
      shaper.curve = makeDriveCurve(p.drive);
      input.connect(shaper);
      const output = safeOutput(ctx, shaper);
      // Kurve neu bauen ist teuer (1024 Sample-tanh() + Reassignment an den
      // Audio-Thread, das zudem bei aktivem Signal hörbar knackst) -- der
      // Regler feuert aber auf jeden pointermove, beim Ziehen bis zu 60x/s.
      // Gleiches Entprellen wie beim Drive-Insert (s. dort).
      let driveTimer = null;
      return {
        inputs: { audio: input },
        outputs: { audio: output },
        setParam(key, v) {
          if (key === 'drive') {
            p.drive = v;
            clearTimeout(driveTimer);
            driveTimer = setTimeout(() => { shaper.curve = makeDriveCurve(v); }, 60);
          }
        },
        dispose() { clearTimeout(driveTimer); input.disconnect(); shaper.disconnect(); disposeOutput(output); },
      };
    },
  },

  /** VCA -- steuerbarer Verstärker, das Standard-"Ausgang dosieren"-Modul
   *  jedes Modularsystems. ZWEI in Serie geschaltete Gain-Stufen statt
   *  einer einzigen, damit sich Regler und Kabel nie gegenseitig
   *  überschreiben können (beide Bugs, die genau daran lagen: erst "Regler
   *  dreht Ton schlagartig konstant" (der Regler überschrieb live den
   *  Wert, den das Kabel gerade steuerte), dann nach dem ersten Fix
   *  "Regler hat gar keinen Einfluss mehr" (der Regler durfte nur noch den
   *  Basiswert merken, der aber erst beim Trennen des Kabels wieder
   *  einrastet -- solange die Hüllkurve angeschlossen bleibt, war der
   *  Regler dauerhaft wirkungslos)):
   *   - `level` (Regler) steuert AUSSCHLIESSLICH levelGain -- nie von
   *     einem Kabel berührt, wirkt also IMMER, patched oder nicht.
   *   - `gain` (CV-Port) steuert AUSSCHLIESSLICH cvGain -- ruht bei 1
   *     (transparent) ohne Kabel, wird von ModularPatch#connect auf 0
   *     gesetzt, sobald ein Kabel hängt (dieselbe Konvention wie immer),
   *     und multipliziert sich (weil in Serie geschaltet statt addiert)
   *     mit levelGain statt sich mit ihm zu addieren -- so bleibt der
   *     Regler ein echter Lautstärke-Trimmer FÜR die Hüllkurve, statt mit
   *     ihr um denselben Wert zu konkurrieren. */
  vca: {
    name: 'VCA',
    defaults: { level: 1 },
    build(ctx, p) {
      const input = ctx.createGain();
      const levelGain = ctx.createGain();
      levelGain.gain.value = p.level;
      const cvGain = ctx.createGain();
      cvGain.gain.value = 1;
      cvGain.gain.__cvExclusive = true; // s. ModularPatch#connect/disconnect
      input.connect(levelGain);
      levelGain.connect(cvGain);
      const output = safeOutput(ctx, cvGain);
      return {
        inputs: { audio: input, gain: cvGain.gain },
        outputs: { audio: output },
        setParam(key, v) {
          if (key === 'level') { p.level = v; levelGain.gain.value = v; }
        },
        dispose() { input.disconnect(); levelGain.disconnect(); cvGain.disconnect(); disposeOutput(output); },
      };
    },
  },

  /* ---------- Modulation ---------- */
  /**
   * Hüllkurve als PERSISTENTE Steuerspannungsquelle (ConstantSourceNode),
   * nicht wie dsp.js#env() ein pro Anschlag frisch erzeugter/wegwerfbarer
   * Gain-Node -- ein Patch-Kabel verbindet feste Modul-Instanzen, keine
   * Einwegknoten. Volles ADSR statt nur Attack/Release (Nutzer-Feedback:
   * für Basslines/Plucks/gehaltene Pads fehlt strukturell eine eigene
   * Sustain-Stufe -- ohne sie klingt jede gehaltene Note entweder komplett
   * offen oder komplett zu, nie irgendwo dazwischen). Ablauf: Attack rampt
   * auf 1, Decay rampt von dort auf `sustain`, dort HALTEN bis Notenende
   * (t+dur), dann Release linear auf 0.
   *
   * Ursprünglich cancelAndHoldAtTime() statt cancelScheduledValues()+
   * setValueAtTime(0.0001, t): weil dieselbe Instanz für JEDE Note
   * wiederverwendet wird (s. oben), kann eine neue Note feuern, WÄHREND
   * die vorige noch mitten im (evtl. langen) Release ist --
   * cancelScheduledValues() allein bricht die laufende Rampe an ihrem
   * AKTUELLEN Wert ab (z. B. 0.6 bei halb durchlaufenem Release), das
   * direkt folgende setValueAtTime(0.0001, t) sprang von dort aber HART
   * auf nahe Null, bevor die neue Attack-Rampe wieder hochlief -- ein
   * hörbares Klicken (Chat: "klicken bei langen Release-Zeiten bevor die
   * nächste Note spielt", per Reproduktion bestätigt: ein Sprung von ~0.6
   * auf ~0 und zurück auf 1 innerhalb von unter 10ms).
   *
   * cancelAndHoldAtTime() ist in Firefox jedoch nicht implementiert --
   * ruft dort bei JEDEM Trigger eine TypeError hervor, die die gesamte
   * Scheduler-Schleife des Transports aus der Bahn wirft (Nutzer-
   * Bugreport: "in Firefox bleibt der Sequencer hängen und es kommt kein
   * Ton" -- erklärt zugleich, warum ausschliesslich Modular betroffen ist:
   * cancelAndHoldAtTime() wird sonst nirgends im Code verwendet). Ersetzt
   * durch denselben Effekt von Hand, nur mit den beiden ältesten,
   * universell unterstützten AudioParam-Methoden gebaut: den aktuellen
   * (spec-konform gerade klingenden) Wert lesen und per
   * cancelScheduledValues()+setValueAtTime() exakt dort neu verankern --
   * dieselbe Rampen-Fortsetzung ohne Sprung wie zuvor, jetzt auch in
   * Firefox.
   *
   * `valueAtNoteEnd` verallgemeinert die alte Attack-Kappungs-Logik auf
   * Attack+Decay: statt beim Notenende hart auf 1 (bzw. jetzt `sustain`)
   * zu springen, falls die Rampe(n) dort noch nicht fertig sind, wird
   * exakt der Wert berechnet, den Attack/Decay zu diesem Zeitpunkt
   * rechnerisch hätten (linear interpoliert) -- der Release setzt
   * nahtlos von DORT aus fort. Ist Attack+Decay dagegen schon fertig
   * (der Normalfall bei kurzer Attack/Decay-Zeit und längerer Note),
   * bleibt das Verhalten exakt wie erwartet: auf `sustain` halten bis
   * zum Notenende. */
  envelope: {
    name: 'Envelope',
    defaults: { attack: 0.002, decay: 0.1, sustain: 0.7, release: 0.05 },
    build(ctx, p) {
      const src = ctx.createConstantSource();
      src.offset.value = 0;
      src.start();
      const output = safeOutput(ctx, src);
      return {
        inputs: {},
        outputs: { cv: output },
        trigger(t, dur) {
          const attack = Math.max(0.0001, p.attack);
          const decay = Math.max(0.0001, p.decay);
          const sustain = Math.min(1, Math.max(0, p.sustain));
          const release = Math.max(0.005, p.release);
          const holdValue = src.offset.value;
          src.offset.cancelScheduledValues(t);
          src.offset.setValueAtTime(holdValue, t);
          src.offset.linearRampToValueAtTime(1, t + attack);
          src.offset.linearRampToValueAtTime(sustain, t + attack + decay);
          let valueAtNoteEnd;
          if (dur >= attack + decay) valueAtNoteEnd = sustain;
          else if (dur <= attack) valueAtNoteEnd = dur / attack;
          else valueAtNoteEnd = 1 - (1 - sustain) * (dur - attack) / decay;
          src.offset.setValueAtTime(valueAtNoteEnd, t + dur);
          src.offset.linearRampToValueAtTime(0, t + dur + release);
        },
        setParam(key, v) { p[key] = v; },
        dispose() { src.stop(); src.disconnect(); disposeOutput(output); },
      };
    },
  },

  lfo: {
    name: 'LFO',
    defaults: { wave: 'sine', rateHz: 4, depth: 1 },
    build(ctx, p) {
      const osc = ctx.createOscillator();
      osc.type = p.wave;
      osc.frequency.value = p.rateHz;
      const depth = ctx.createGain();
      depth.gain.value = p.depth;
      osc.connect(depth);
      osc.start();
      const output = safeOutput(ctx, depth);
      return {
        inputs: {},
        outputs: { cv: output },
        setParam(key, v) {
          if (key === 'wave') osc.type = v;
          else if (key === 'rateHz') osc.frequency.value = v;
          else if (key === 'depth') depth.gain.value = v;
        },
        dispose() { osc.stop(); osc.disconnect(); depth.disconnect(); disposeOutput(output); },
      };
    },
  },

  /** Sample & Hold -- tastet den `signal`-Eingang bei jedem Notenanschlag
   *  ab und hält den Wert bis zum nächsten (klassisch: zufällige Tonhöhen-/
   *  Filtersprünge, z. B. Noise -> S&H -> Oszillator-Pitch). Anders als ein
   *  frei patchbarer Audiorate-Trigger (bräuchte einen eigenen
   *  AudioWorklet-DSP-Kern, s. acidbass-worklet.js für den Aufwand, der
   *  dafür nötig wäre) hier bewusst am NOTENANSCHLAG getaktet -- passt
   *  genau in dieses sequenzergetriebene Environment (jede Note kann einen
   *  neuen Zufallswert ziehen) und bleibt synchron aufbaubar wie jedes
   *  andere Modul. Liest den Eingang über einen AnalyserNode aus (dieselbe
   *  Technik, mit der auch die Offline-Tests dieser Datei Signale
   *  auslesen) -- eine echte, tatsächlich anliegende Momentaufnahme, keine
   *  Schätzung. */
  samplehold: {
    name: 'S&H',
    defaults: {},
    build(ctx) {
      const input = ctx.createGain();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 32; // kleinstmöglich -- nur eine Momentaufnahme nötig, keine Spektralanalyse
      input.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      const held = ctx.createConstantSource();
      held.offset.value = 0;
      held.start();
      // Priming, s. Oscillator#build für die ausführliche Begründung.
      held.offset.setValueAtTime(0, ctx.currentTime);
      const output = safeOutput(ctx, held);
      return {
        inputs: { signal: input },
        outputs: { cv: output },
        trigger(t) {
          analyser.getFloatTimeDomainData(buf);
          held.offset.setValueAtTime(buf[buf.length - 1], t);
        },
        setParam() {},
        dispose() { input.disconnect(); analyser.disconnect(); held.stop(); held.disconnect(); disposeOutput(output); },
      };
    },
  },

  /** Slew Limiter (Glide) -- glättet abrupte CV-/Audiosprünge zu sanften
   *  Übergängen, meist hinter Sample & Hold oder für Portamento auf
   *  Oszillator-Pitch. Technisch dieselbe Schaltung wie ein echtes
   *  analoges Glide-Circuit: ein simples RC-Tiefpassglied -- hier ein
   *  Tiefpassfilter, dessen Grenzfrequenz aus der gewünschten Gleitzeit
   *  berechnet wird (klassische RC-Zeitkonstante 1/(2π·t)), keine
   *  "angenäherte" Lösung, sondern dieselbe Physik wie das Original. */
  slew: {
    name: 'Slew',
    defaults: { time: 0.1 },
    build(ctx, p) {
      const timeToHz = (t) => Math.min(2000, Math.max(0.3, 1 / (2 * Math.PI * Math.max(0.001, t))));
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.Q.value = 0.707; // Butterworth-neutral, kein Überschwingen im Glide
      filter.frequency.value = timeToHz(p.time);
      const output = safeOutput(ctx, filter);
      return {
        inputs: { in: filter },
        outputs: { audio: output },
        setParam(key, v) {
          if (key === 'time') { p.time = v; filter.frequency.value = timeToHz(v); }
        },
        dispose() { filter.disconnect(); disposeOutput(output); },
      };
    },
  },

  /* ---------- Utility ---------- */
  /** Mono-Summierer für mehrere Audioquellen (z. B. mehrere Oszillatoren),
   *  je ein eigener Pegel pro Eingang -- wie ein kleiner Modular-Mixer
   *  (Doepfer A-138, Intellijel Mixup), nicht wie ein grosser Performance-
   *  Mixer mit Stereo-Bus: KEIN Pan, das passiert schon eine Ebene höher
   *  am Maschinen-Ausgang (jede Maschine hat ihren eigenen StereoPanner,
   *  s. machines/machine.js). Nötig geworden erst durch die exklusiven
   *  Eingänge (s. ModularPatch#connect): zwei Oszillatoren liessen sich
   *  vorher direkt in denselben Filter-/VCA-Eingang stecken (Web Audio
   *  summiert automatisch alle Verbindungen an einem Ziel) -- seit jeder
   *  Eingang nur noch EIN Kabel annimmt, geht das nicht mehr, ein
   *  dediziertes Mix-Modul mit VIER eigenen Eingängen schon (Chat: "ich
   *  brauche im modular einen mixer für die oszilatoren"). */
  mixer: {
    name: 'Mixer',
    defaults: { level1: 1, level2: 1, level3: 1, level4: 1 },
    build(ctx, p) {
      const sum = ctx.createGain();
      const makeInput = (level) => {
        const g = ctx.createGain();
        g.gain.value = level;
        g.connect(sum);
        return g;
      };
      const in1 = makeInput(p.level1);
      const in2 = makeInput(p.level2);
      const in3 = makeInput(p.level3);
      const in4 = makeInput(p.level4);
      const output = safeOutput(ctx, sum);
      return {
        inputs: { in1, in2, in3, in4 },
        outputs: { audio: output },
        setParam(key, v) {
          if (key === 'level1') { p.level1 = v; in1.gain.value = v; }
          else if (key === 'level2') { p.level2 = v; in2.gain.value = v; }
          else if (key === 'level3') { p.level3 = v; in3.gain.value = v; }
          else if (key === 'level4') { p.level4 = v; in4.gain.value = v; }
        },
        dispose() {
          in1.disconnect(); in2.disconnect(); in3.disconnect(); in4.disconnect();
          sum.disconnect();
          disposeOutput(output);
        },
      };
    },
  },

  /** Ringmodulator -- multipliziert zwei Audiosignale (A * B), klassische
   *  metallische/glockenartige Klänge. Der übliche Web-Audio-Trick dafür
   *  (kein natives "Multiply"-Node nötig): B hängt direkt an der
   *  gain-AudioParam eines GainNode statt an dessen Signal-Eingang, dessen
   *  eigener Grundpegel bleibt bei 0 -- der Knoten liefert dann rein
   *  A(t) * (0 + B(t)) = A(t) * B(t), keine additive Grundlautstärke wie
   *  bei normaler Amplitudenmodulation. */
  ringmod: {
    name: 'Ring Mod',
    defaults: {},
    build(ctx) {
      const ring = ctx.createGain();
      ring.gain.value = 0; // rein multiplikativ, s. Kommentar oben
      const inA = ctx.createGain(); // eigener Knoten für A, damit B exklusiv die gain-AudioParam bekommt
      inA.connect(ring);
      const output = safeOutput(ctx, ring);
      return {
        inputs: { a: inA, b: ring.gain },
        outputs: { audio: output },
        setParam() {},
        dispose() { inA.disconnect(); ring.disconnect(); disposeOutput(output); },
      };
    },
  },

  /** Utility -- Dämpfen/Verstärken UND Invertieren (Attenuverter) plus
   *  Offset eines CV-/Audiosignals, das kleine "Schweizer Taschenmesser"-
   *  Werkzeug jedes Modularsystems (z. B. Doepfer A-183-1). Fehlte bisher
   *  komplett: keines der anderen Module kann ein Signal umkehren oder
   *  einen konstanten Versatz draufaddieren.
   *
   *  Amount/Offset gehen bis ±3000 (nicht nur ±1, wie ein reiner
   *  Abschwächer/Invertierer bräuchte) -- Cutoff- und alle anderen CV-Ziele
   *  im Modular sind additiv gebaut (Reglerwert + Kabel, s. Kommentar bei
   *  filter#build): Envelope/LFO liefern aber nur 0..1 bzw. ±1, was auf
   *  einen Cutoff im Hundert-/Tausender-Hz-Bereich addiert schlicht nicht
   *  hörbar ist. Dieses Modul ist deshalb zugleich der einzige Weg, ein
   *  CV-Signal erst auf eine für sein Ziel sinnvolle Grössenordnung hoch-
   *  zuskalieren (Envelope -> Utility (Amount hoch) -> Filter Cutoff),
   *  bevor es dort ankommt -- genau der Weg, den ein echtes Modularsystem
   *  dafür vorsieht (Nutzer-Feedback: Envelope modulierte den Cutoff
   *  technisch, aber unhörbar wenig).
   *
   *  UTIL_OUTPUT_SCALE (s. safeOutput()): amount+offset können sich im
   *  ungünstigsten Fall auf bis zu ±6000 aufaddieren -- ohne die skalierte
   *  Variante würde der geteilte Weichbegrenzer (fest auf ±1 Eingabebereich
   *  ausgelegt, s. safeOutput()-Kommentar) ALLES darüber auf ~±0.76 kappen
   *  und die grosszügigeren Wertebereiche oben komplett wirkungslos
   *  machen. */
  util: {
    name: 'Utility',
    defaults: { amount: 1, offset: 0 },
    build(ctx, p) {
      const scale = ctx.createGain();
      scale.gain.value = p.amount;
      const offsetSrc = ctx.createConstantSource();
      offsetSrc.offset.value = p.offset;
      offsetSrc.start();
      const sum = ctx.createGain();
      scale.connect(sum);
      offsetSrc.connect(sum);
      const UTIL_OUTPUT_SCALE = 6000;
      const output = safeOutput(ctx, sum, UTIL_OUTPUT_SCALE);
      return {
        inputs: { in: scale },
        outputs: { audio: output },
        setParam(key, v) {
          // setTargetAtTime statt direktem .value= -- derselbe Grund wie
          // beim Filter-Cutoff (s. dort): eine Regler-Zieh-Geste feuert
          // viele 'input'-Events, ein harter Sprung wäre bei den jetzt
          // deutlich grösseren Wertebereichen (bis ±5000, s. Kommentar
          // oben) hörbar als Klick/Knacksen, sobald ein Audiosignal (statt
          // langsamer CV) durch dieses Modul läuft.
          if (key === 'amount') { p.amount = v; scale.gain.setTargetAtTime(v, engine.now, 0.01); }
          else if (key === 'offset') { p.offset = v; offsetSrc.offset.setTargetAtTime(v, engine.now, 0.01); }
        },
        dispose() { scale.disconnect(); offsetSrc.stop(); offsetSrc.disconnect(); sum.disconnect(); disposeOutput(output); },
      };
    },
  },

  /** Delay/Echo -- eigene patchbare Verzögerung mit Rückkopplung, getrennt
   *  vom Insert-Chain-Delay (das sitzt hinter der ganzen Maschine, nicht
   *  INNERHALB eines Patches). Die Rückkopplungsschleife läuft durch
   *  denselben geteilten Weichbegrenzer wie safeOutput() (clipCurve()),
   *  damit hohe Feedback-Werte nicht aufschaukeln -- zusätzlich zur
   *  Feedback-Obergrenze (0.9) im Regler selbst. Ausgang ist trocken +
   *  verzögert gemischt (klassisches Echo-Modul), kein separater Dry/Wet-
   *  Regler nötig, da der trockene Anteil ohnehin schon durchläuft. */
  delay: {
    name: 'Delay',
    defaults: { time: 0.3, feedback: 0.3 },
    build(ctx, p) {
      const input = ctx.createGain();
      const delayNode = ctx.createDelay(2);
      delayNode.delayTime.value = p.time;
      const fbShaper = ctx.createWaveShaper();
      fbShaper.curve = clipCurve();
      const fbGain = ctx.createGain();
      fbGain.gain.value = Math.min(0.9, p.feedback);
      input.connect(delayNode);
      delayNode.connect(fbShaper);
      fbShaper.connect(fbGain);
      fbGain.connect(delayNode);
      const mix = ctx.createGain();
      input.connect(mix);
      delayNode.connect(mix);
      const output = safeOutput(ctx, mix);
      return {
        inputs: { audio: input },
        outputs: { audio: output },
        setParam(key, v) {
          if (key === 'time') { p.time = v; delayNode.delayTime.setTargetAtTime(v, engine.now, 0.02); }
          else if (key === 'feedback') { p.feedback = Math.min(0.9, v); fbGain.gain.value = p.feedback; }
        },
        dispose() {
          input.disconnect(); delayNode.disconnect(); fbShaper.disconnect(); fbGain.disconnect(); mix.disconnect();
          disposeOutput(output);
        },
      };
    },
  },

  /** Fester Endpunkt jedes Patches -- die Modular-Maschine verbindet dessen
   *  Ausgang einmalig, dauerhaft an ihren eigenen this.output (s.
   *  machines/modular.js). Reine Durchleitung, kein eigener Regler. */
  output: {
    name: 'Output',
    defaults: {},
    build(ctx) {
      const gain = ctx.createGain();
      return {
        inputs: { audio: gain },
        outputs: { audio: gain },
        setParam() {},
        dispose() { gain.disconnect(); },
      };
    },
  },
};

export const MODULE_TYPES = Object.keys(MODULE_DEFS);
export function moduleMeta(type) {
  return { name: MODULE_DEFS[type].name, defaults: { ...MODULE_DEFS[type].defaults } };
}

/** Port-Beschriftungen je Modultyp fürs Kabel-UI (ui/modular-view.js) --
 *  müssen manuell mit den `inputs`/`outputs`-Schlüsseln der jeweiligen
 *  build()-Funktion oben übereinstimmen (dasselbe Muster wie DEFS/UI_PARAMS
 *  in inserts.js: von Hand synchron gehalten statt automatisch abgeleitet). */
export const MODULE_PORTS = {
  oscillator: { inputs: [{ key: 'pitch', label: 'Pitch' }, { key: 'fine', label: 'Fine' }], outputs: [{ key: 'audio', label: 'Out' }] },
  noise: { inputs: [], outputs: [{ key: 'audio', label: 'Out' }] },
  mixer: {
    inputs: [{ key: 'in1', label: 'In 1' }, { key: 'in2', label: 'In 2' }, { key: 'in3', label: 'In 3' }, { key: 'in4', label: 'In 4' }],
    outputs: [{ key: 'audio', label: 'Out' }],
  },
  filter: { inputs: [{ key: 'audio', label: 'In' }, { key: 'cutoff', label: 'Cutoff' }], outputs: [{ key: 'audio', label: 'Out' }] },
  distortion: { inputs: [{ key: 'audio', label: 'In' }], outputs: [{ key: 'audio', label: 'Out' }] },
  envelope: { inputs: [], outputs: [{ key: 'cv', label: 'CV' }] },
  lfo: { inputs: [], outputs: [{ key: 'cv', label: 'CV' }] },
  vca: { inputs: [{ key: 'audio', label: 'In' }, { key: 'gain', label: 'Gain' }], outputs: [{ key: 'audio', label: 'Out' }] },
  ringmod: { inputs: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }], outputs: [{ key: 'audio', label: 'Out' }] },
  samplehold: { inputs: [{ key: 'signal', label: 'Signal' }], outputs: [{ key: 'cv', label: 'CV' }] },
  slew: { inputs: [{ key: 'in', label: 'In' }], outputs: [{ key: 'audio', label: 'Out' }] },
  util: { inputs: [{ key: 'in', label: 'In' }], outputs: [{ key: 'audio', label: 'Out' }] },
  delay: { inputs: [{ key: 'audio', label: 'In' }], outputs: [{ key: 'audio', label: 'Out' }] },
  output: { inputs: [{ key: 'audio', label: 'In' }], outputs: [] },
};

/** Regler-Metadaten (Label/Bereich/Kurve/Einheit) je Modultyp -- getrennt
 *  von den DSP-Defaults, wie UI_PARAMS in inserts.js. Enum-Parameter (Wave-
 *  Form, Filtertyp) laufen über eigene Segment-Buttons, s.
 *  OSCILLATOR_WAVES/LFO_WAVES/FILTER_TYPES statt hier. */
export const MODULE_UI_PARAMS = {
  oscillator: [
    { key: 'coarse', label: 'Coarse', min: -24, max: 24, step: 1, unit: 'st' },
    { key: 'fine', label: 'Fine', min: -100, max: 100, unit: 'ct' },
  ],
  noise: [],
  mixer: [
    { key: 'level1', label: 'In 1', min: 0, max: 1, unit: '' },
    { key: 'level2', label: 'In 2', min: 0, max: 1, unit: '' },
    { key: 'level3', label: 'In 3', min: 0, max: 1, unit: '' },
    { key: 'level4', label: 'In 4', min: 0, max: 1, unit: '' },
  ],
  filter: [
    { key: 'cutoff', label: 'Cutoff', min: 40, max: 12000, curve: 'log', unit: 'Hz' },
    { key: 'resonance', label: 'Reso', min: 0.1, max: 15, curve: 'log', unit: '' },
  ],
  distortion: [{ key: 'drive', label: 'Drive', min: 0, max: 1, unit: '' }],
  envelope: [
    { key: 'attack', label: 'Attack', min: 0.002, max: 10, curve: 'log', unit: 's' },
    { key: 'decay', label: 'Decay', min: 0.002, max: 10, curve: 'log', unit: 's' },
    { key: 'sustain', label: 'Sustain', min: 0, max: 1, unit: '' },
    { key: 'release', label: 'Release', min: 0.01, max: 10, curve: 'log', unit: 's' },
  ],
  lfo: [
    { key: 'rateHz', label: 'Rate', min: 0.05, max: 20, curve: 'log', unit: 'Hz' },
    { key: 'depth', label: 'Depth', min: 0, max: 1, unit: '' },
  ],
  vca: [{ key: 'level', label: 'Level', min: 0, max: 1, unit: '' }],
  ringmod: [],
  samplehold: [],
  slew: [{ key: 'time', label: 'Time', min: 0.001, max: 2, curve: 'log', unit: 's' }],
  util: [
    { key: 'amount', label: 'Amount', min: -3000, max: 3000, unit: '' },
    { key: 'offset', label: 'Offset', min: -3000, max: 3000, unit: '' },
  ],
  delay: [
    { key: 'time', label: 'Time', min: 0.02, max: 1.5, curve: 'log', unit: 's' },
    { key: 'feedback', label: 'Feedback', min: 0, max: 0.9, unit: '' },
  ],
  output: [],
};

export const OSCILLATOR_WAVES = [
  { value: 'sine', label: 'Sine' },
  { value: 'triangle', label: 'Tri' },
  { value: 'sawtooth', label: 'Saw' },
  { value: 'square', label: 'Sqr' },
];
export const FILTER_TYPES = [
  { value: 'lowpass', label: 'LP' },
  { value: 'highpass', label: 'HP' },
  { value: 'bandpass', label: 'BP' },
  { value: 'notch', label: 'Notch' },
];

let nextModuleId = 1;
let nextCableId = 1;

/** Grobe Kachel-Grösse NUR für die Kollisionsprüfung unten -- muss nicht
 *  exakt mit der tatsächlich gerenderten Grösse übereinstimmen (die hängt
 *  von der Portanzahl ab), reicht als Daumenregel, um ein neues Modul
 *  nicht exakt auf ein bestehendes zu setzen. */
const AUTO_POS_BOX_W = 160;
const AUTO_POS_BOX_H = 110;

/** Raster-Fallback-Position für ein neues Modul, das (noch) keine eigene
 *  x/y mitbringt -- brandneu per "+ Add Module"/Duplizieren hinzugefügt,
 *  oder ein älteres gespeichertes Projekt von vor dieser Funktion (s.
 *  serialize() unten). Sucht die erste Raster-Position, die kein
 *  bestehendes Modul überlappt -- ein reiner Index-basiertes Raster (0.,
 *  1., 2. Modul, ...) würde z. B. ein neu hinzugefügtes 5. Modul exakt auf
 *  die manuell platzierte Hüllkurve des Standard-Patches setzen (s.
 *  machines/modular.js#buildDefaultPatch), das dann komplett dahinter
 *  verschwindet. Der Nutzer zieht das Modul auf der frei verschiebbaren
 *  Steckfläche (ui/modular-view.js) ohnehin dorthin, wo er es tatsächlich
 *  haben will -- hier reicht "irgendwo frei", nicht "hübsch". */
function autoPosition(existing) {
  const others = [...existing.values()];
  for (let i = 0; ; i++) {
    const cand = { x: 20 + (i % 4) * 170, y: 20 + Math.floor(i / 4) * 150 };
    const overlaps = others.some((m) => Math.abs(cand.x - m.x) < AUTO_POS_BOX_W && Math.abs(cand.y - m.y) < AUTO_POS_BOX_H);
    if (!overlaps) return cand;
  }
}

export class ModularPatch {
  constructor() {
    /** @type {Map<number, {type:string, params:object, instance:object, x:number, y:number, label:?string}>} */
    this.modules = new Map();
    /** @type {Array<{id:number, fromId:number, fromPort:string, toId:number, toPort:string}>} */
    this.cables = [];
  }

  /** Reiner Rechenname "Typname N" -- N ist die Position dieses Moduls
   *  unter ALLEN Modulen DESSELBEN Typs (1-indiziert, Map-Reihenfolge,
   *  dieselbe, die auch die Vorderseiten-Liste bestimmt). IGNORIERT eine
   *  evtl. gesetzte eigene Beschriftung, anders als displayName() --
   *  gebraucht als Reset-Vorschau im Umbenennen-Popup (s.
   *  ui/modular-view.js) und als Basis für displayName() selbst. Läuft
   *  immer mit (auch bei genau einem Modul dieses Typs), statt erst ab
   *  einer zweiten Instanz einzublenden: sonst würde das Hinzufügen eines
   *  zweiten Oszillators die Beschriftung des ERSTEN rückwirkend ändern
   *  (von "Oscillator" auf "Oscillator 1") -- mit fester Nummerierung von
   *  Anfang an bleibt ein bereits vorhandenes Modul immer gleich benannt,
   *  ein neu hinzugefügtes bekommt einfach die nächste freie Nummer
   *  (Chat: "wird schnell unübersichtlich" bei mehreren Oszillatoren im
   *  selben Patch). */
  autoName(id) {
    const m = this.modules.get(id);
    if (!m) return '';
    const sameType = [...this.modules.keys()].filter((k) => this.modules.get(k).type === m.type);
    return `${moduleMeta(m.type).name} ${sameType.indexOf(id) + 1}`;
  }

  /** Angezeigter Name: eigene Beschriftung (falls per renameModule()
   *  gesetzt), sonst der automatisch nummerierte Name (s. autoName()). */
  displayName(id) {
    const m = this.modules.get(id);
    if (!m) return '';
    return m.label || this.autoName(id);
  }

  /** Eigene Beschriftung setzen/löschen (leerer String oder nur
   *  Leerzeichen -> zurück auf den automatisch nummerierten Namen) --
   *  dieselbe Konvention wie Machine#setLabel (s. machines/machine.js). */
  renameModule(id, label) {
    const m = this.modules.get(id);
    if (!m) return;
    m.label = label?.trim() || null;
  }

  /** @param {{id?:number, params?:object, x?:number, y?:number, label?:string}} [saved] */
  addModule(type, saved = null) {
    const def = MODULE_DEFS[type];
    if (!def) throw new Error(`Unbekannter Modul-Typ: ${type}`);
    const params = { ...def.defaults, ...saved?.params };
    const id = saved?.id ?? nextModuleId++;
    if (saved?.id != null) nextModuleId = Math.max(nextModuleId, saved.id + 1);
    const instance = def.build(engine.ctx, params);
    const pos = saved?.x != null && saved?.y != null ? { x: saved.x, y: saved.y } : autoPosition(this.modules);
    this.modules.set(id, { type, params, instance, x: pos.x, y: pos.y, label: saved?.label ?? null });
    return id;
  }

  /** Ein Modul in der Rack-Reihenfolge nach oben (-1) oder unten (+1)
   *  verschieben -- die Map-Einfügereihenfolge IST die Rack-Reihenfolge
   *  (durchgezogen bis in serialize()), also einfach neu befüllen statt
   *  eine separate Sortier-Struktur mitzuführen. Dieselbe Reihenfolge
   *  bestimmt auch die Steckplatz-Positionen auf der Rückseite (s.
   *  ui/modular-view.js) -- Vorder- und Rückansicht zeigen bewusst
   *  dieselbe Liste, keine zwei unabhängigen Sortierungen. */
  moveModule(id, dir) {
    const ids = [...this.modules.keys()];
    const i = ids.indexOf(id);
    const j = i + dir;
    if (i === -1 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    const reordered = new Map();
    for (const k of ids) reordered.set(k, this.modules.get(k));
    this.modules = reordered;
  }

  /** Position eines Moduls auf der frei verschiebbaren Steckfläche
   *  (Rückseite, ui/modular-view.js) setzen -- unabhängig von der Rack-
   *  Reihenfolge oben, die weiterhin nur die Vorderseiten-Liste sortiert. */
  moveModuleTo(id, x, y) {
    const m = this.modules.get(id);
    if (!m) return;
    m.x = x;
    m.y = y;
  }

  removeModule(id) {
    // Alle Kabel entfernen, die dieses Modul berühren -- sonst blieben
    // Verweise auf eine bereits entsorgte Instanz stehen (s. connect()/
    // disconnect() unten, die live auf instance.outputs/inputs zugreifen).
    for (const cable of [...this.cables]) {
      if (cable.fromId === id || cable.toId === id) this.disconnect(cable.id);
    }
    this.modules.get(id)?.instance.dispose();
    this.modules.delete(id);
  }

  #portCountOnTarget(toId, toPort) {
    return this.cables.filter((c) => c.toId === toId && c.toPort === toPort).length;
  }

  connect(fromId, fromPort, toId, toPort) {
    const from = this.modules.get(fromId)?.instance.outputs[fromPort];
    const toModule = this.modules.get(toId);
    const to = toModule?.instance.inputs[toPort];
    if (!from || !to) return null;
    // Ein Eingang ist wie eine echte Buchse -- nimmt immer nur EIN Kabel
    // auf. Ein neues Kabel dorthin ersetzt ein evtl. schon vorhandenes,
    // statt sich zusätzlich draufzustecken (zwei Kabel am selben Eingang
    // würden das Signal einfach doppelt addieren, kein harmloses Duplikat
    // wie man vielleicht erwarten würde). Ausgänge dürfen dagegen frei auf
    // mehrere Eingänge gemultet werden (Standard-Modular-Technik, bleibt
    // unverändert erlaubt) -- nur Eingänge sind exklusiv.
    const existing = this.cables.find((c) => c.toId === toId && c.toPort === toPort);
    if (existing) this.disconnect(existing.id);
    from.connect(to);
    // Erstes Kabel an einem CV-Ziel, das das ausdrücklich will (s.
    // __cvExclusive/Dateikopf-Kommentar) -- Regler-Basiswert merken und auf
    // 0 setzen, damit das Kabel ALLEIN bestimmt, was ankommt. Die meisten
    // CV-Ports (Filter-Cutoff, Oszillator-Pitch, ...) wollen das GERADE
    // NICHT: dort soll sich das Kabel zum Reglerwert/aktuellen Ton ADDIEREN
    // (Standard-Konvention echter Analogsysteme), nur der VCA-Pegel
    // braucht eine dedizierte, vom Regler unabhängige Stufe (s. dort).
    if (to instanceof AudioParam && to.__cvExclusive && this.#portCountOnTarget(toId, toPort) === 0) {
      to.__patchBaseValue = to.value;
      to.setValueAtTime(0, engine.now);
    }
    const id = nextCableId++;
    this.cables.push({ id, fromId, fromPort, toId, toPort });
    return id;
  }

  disconnect(cableId) {
    const cable = this.cables.find((c) => c.id === cableId);
    if (!cable) return;
    const from = this.modules.get(cable.fromId)?.instance.outputs[cable.fromPort];
    const toModule = this.modules.get(cable.toId);
    const to = toModule?.instance.inputs[cable.toPort];
    this.cables = this.cables.filter((c) => c.id !== cableId);
    if (from && to) {
      try { from.disconnect(to); } catch { /* schon getrennt (z. B. Modul gerade entfernt) */ }
      // Letztes Kabel an diesem CV-Ziel entfernt -- Regler-Basiswert
      // wiederherstellen (s. connect() oben) und __patchBaseValue wieder
      // löschen (sonst bliebe es für immer gesetzt, sobald hier je ein
      // Kabel hing -- s. connect()-Kommentar).
      if (to instanceof AudioParam && to.__cvExclusive && this.#portCountOnTarget(cable.toId, cable.toPort) === 0) {
        to.setValueAtTime(to.__patchBaseValue ?? 0, engine.now);
        delete to.__patchBaseValue;
      }
    }
  }

  setModuleParam(id, key, v) {
    const m = this.modules.get(id);
    if (!m) return;
    m.params[key] = v;
    m.instance.setParam(key, v);
  }

  /** An JEDES Modul mit eigenem trigger() weiterreichen (Oszillator setzt
   *  seine Tonhöhe, Hüllkurve rampt ihre Kurve) -- vom Sequenzer aus
   *  aufgerufen (s. machines/modular.js#playNote), ein Anschlag betrifft
   *  immer den GANZEN Patch, nicht ein einzelnes Modul. */
  triggerAll(time, dur, midi) {
    for (const { instance } of this.modules.values()) instance.trigger?.(time, dur, midi);
  }

  dispose() {
    for (const id of [...this.modules.keys()]) this.removeModule(id);
  }

  /** Rack-Reihenfolge (Vorderseite) kommt allein aus der Map-Einfüge-
   *  reihenfolge (s. moveModule()) -- rebuildPatchFrom() (machines/
   *  modular.js) fügt beim Laden in genau dieser Array-Reihenfolge wieder
   *  ein. x/y sind eine DAVON unabhängige zweite Eigenschaft: die Position
   *  auf der frei verschiebbaren Steckfläche (Rückseite) -- ein Modul nach
   *  oben/unten in der Vorderseiten-Liste zu schieben verändert NICHT, wo
   *  es auf der Steckfläche steht, und umgekehrt. */
  serialize() {
    return {
      modules: [...this.modules.entries()].map(([id, m]) => ({ id, type: m.type, params: { ...m.params }, x: m.x, y: m.y, label: m.label })),
      cables: this.cables.map((c) => ({ fromId: c.fromId, fromPort: c.fromPort, toId: c.toId, toPort: c.toPort })),
    };
  }
}
