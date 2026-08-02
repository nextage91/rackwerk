/**
 * Machine — Basisklasse für alle Rack-Maschinen.
 *
 * Vertrag für Unterklassen:
 *   static meta = { type, name, desc, color }   → für Registry & Faceplate
 *   buildAudio()   → eigenen Audiographen bauen und an this.output hängen
 *   buildControls(container) → Bedienelemente in den Body rendern
 *   onStep(step, time)       → optional, vom Transport aufgerufen
 *   disposeAudio() → optional, eigene Nodes aufräumen
 *
 * Die Basisklasse übernimmt: Output-Gain + Mute, Faceplate-DOM
 * (Kopfzeile mit Farbstreifen, Mute, Entfernen) und Lifecycle.
 */
import { engine } from '../core/audio-engine.js';
import { transport } from '../core/transport.js';
import { automation } from '../core/automation.js';
import { createInsert, insertChainLatencySec } from '../core/inserts.js';
import { renderInsertChain, openInsertPicker, INSERT_DISPLAY } from '../ui/insert-chain.js';
import { createModulator, MOD_DISPLAY } from '../core/modulators.js';
import { renderModulationChain, openModulatorPicker } from '../ui/modulation-chain.js';
import { masterFX } from '../core/fx.js';
import { undo } from '../core/undo.js';
import { computeLevels } from '../ui/meter.js';

let nextId = 1;
let nextClipId = 1;

/** Alle lebenden Maschinen — für die Solo-Koordination über das ganze Rack. */
const machines = new Set();

/* ---------- Spuren/Instrumente umbenennen ----------
 * Ein einzelnes, modulweites Popup (wie insertPickerEl oben, eq8Menu/
 * padMenu in sampler.js) -- erreichbar über Antippen des Namens im
 * Vollbild-Editor (s. render()) UND über Halten der Rack-Zeile
 * (s. rack.js#mount). Anders als die reinen Auswahl-Popups trägt dieses
 * hier ein Textfeld -- "woanders hintippen" soll den gerade getippten
 * Namen deshalb SPEICHERN statt verwerfen (wie ein normales Formularfeld
 * beim Blur), nur Escape verwirft explizit. */
let renamePop = null;
const dismissRenamePop = (commit = true) => {
  if (!renamePop) return;
  if (commit) renamePop._machine.setLabel(renamePop._input.value);
  renamePop.remove();
  renamePop = null;
  document.removeEventListener('pointerdown', onOutsideRenamePop, true);
};
const onOutsideRenamePop = (e) => { if (renamePop && !renamePop.contains(e.target)) dismissRenamePop(true); };

export function openRenamePopup(machine, anchorEl) {
  dismissRenamePop(); // vorheriges Popup (falls offen) zuerst übernehmen

  renamePop = document.createElement('div');
  renamePop.className = 'rename-pop';
  renamePop._machine = machine;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rename-pop__input';
  input.maxLength = 30;
  input.placeholder = machine.constructor.meta.name;
  input.value = machine.label ?? '';
  renamePop._input = input;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); dismissRenamePop(true); }
    else if (e.key === 'Escape') { e.preventDefault(); dismissRenamePop(false); }
  });
  renamePop.appendChild(input);

  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'rename-pop__reset';
  resetBtn.textContent = '↺';
  resetBtn.setAttribute('aria-label', 'Reset to default name');
  resetBtn.addEventListener('click', () => { input.value = ''; dismissRenamePop(true); });
  renamePop.appendChild(resetBtn);

  document.body.appendChild(renamePop);
  const r = anchorEl.getBoundingClientRect();
  const left = Math.max(8, Math.min(window.innerWidth - renamePop.offsetWidth - 8, r.left));
  renamePop.style.left = `${left}px`;
  renamePop.style.top = `${Math.max(8, r.top - renamePop.offsetHeight - 8)}px`;
  input.focus();
  input.select();
  setTimeout(() => document.addEventListener('pointerdown', onOutsideRenamePop, true), 0);
}

/** Zuletzt hörbare Maschinen — Vergleichsbasis, um zu erkennen, ob ein
 *  Mute/Solo-Wechsel die hörbare Menge SCHRUMPFEN lässt (s. refreshGates). */
let lastAudible = new Set();

/**
 * Öffnet/schließt die Gates aller Maschinen: Ist irgendeine Maschine solo,
 * sind alle nicht-solo Maschinen stumm. Mute gewinnt immer. Zusätzlich
 * fließt `m.jamGateOpen` ein (s. setJamGate) — von der Jam-Ansicht
 * gesetzt, unabhängig von Mute/Solo, damit "nur Spuren mit aktivem Clip
 * klingen" sich genau wie ein weiterer, automatischer Mute-Grund verhält
 * (inklusive Sends/Tail-Handling unten).
 *
 * Schließt zusätzlich die gemeinsame Master-FX-Rückführung (masterFX.
 * setReturnAudible), sobald KEINE Maschine mehr hörbar ist — sonst bliebe
 * ein bereits angeregter Delay-/Reverb-Schwanz weiterspielen, obwohl schon
 * alles gemutet (bzw. nichts soloed) ist.
 *
 * Schrumpft die hörbare Menge nur (z. B. eine von mehreren spielenden
 * Maschinen wird soloed, ohne dass am Ende NIEMAND mehr hörbar ist —
 * setReturnAudible allein greift dann nicht), flusht flushTails() Delay
 * und Reverb komplett: sonst hört man beim Soloen weiter den Nachhall
 * der gerade stumm gewordenen Spuren mit ("solo in place"). Wächst die
 * Menge nur (z. B. Entmuten), ist nichts Störendes drin — kein Flush,
 * das würde nur einen gerade legitim ausklingenden Nachhall unnötig
 * unterbrechen.
 *
 * `setSoloShadowed()`: TrackedDrumMachine (BeatBox/AnalogKit) hat pro
 * Spur EIGENE Delay-/Reverb-Sends, die absichtlich parallel zum trockenen
 * Pfad hängen (VOR `this.gate`, s. deren buildAudio()) — ein gemuteter
 * Kit-Bus soll so im Effekt nachklingen dürfen. Genau das ist aber der
 * gemeldete Bug: soloed man eine ANDERE Maschine, blieben diese Spur-
 * Sends bisher unangetastet und speisten den Master-Effekt munter weiter.
 * Solo (anders als Mute) soll "nur dieses Instrument" bedeuten, also
 * werden Spur-Sends hier zusätzlich abgeklemmt, sobald `soloActive` ist
 * und DIESE Maschine nicht die soloed ist — Mute allein lässt sie weiter
 * unberührt (der Send-Only-Trick bleibt erhalten). Maschinen ohne eigene
 * Spur-Sends (die Basisklasse) tun bei diesem Aufruf nichts.
 */
function refreshGates() {
  const soloActive = [...machines].some((m) => m.soloed);
  const t = engine.now;
  let anyAudible = false;
  const audibleNow = new Set();
  for (const m of machines) {
    const open = !m.muted && (!soloActive || m.soloed) && m.jamGateOpen;
    if (open) { anyAudible = true; audibleNow.add(m); }
    m.gate.gain.cancelScheduledValues(t);
    m.gate.gain.setTargetAtTime(open ? 1 : 0, t, 0.015);
    m.setSoloShadowed((soloActive && !m.soloed) || !m.jamGateOpen);
  }
  masterFX.setReturnAudible(anyAudible);
  const shrank = [...lastAudible].some((m) => !audibleNow.has(m));
  if (shrank) masterFX.flushTails();
  lastAudible = audibleNow;
}

/**
 * Latenz-Ausgleich (Plugin Delay Compensation) über alle Maschinen: manche
 * Insert-Effekte bringen eine kleine, aber feste Zusatzlatenz mit (Kompressor/
 * Opto/Limiter/Resonator ~6ms, Drive ~4ms, Tape Machine ~5.5ms -- s. inserts.js#
 * insertChainLatencySec), weil sie intern einen DynamicsCompressorNode- oder
 * WaveShaperNode(oversample:'4x')-Lookahead nutzen. Ohne Ausgleich läuft eine
 * Maschine mit z. B. Tape Machine in der Kette hörbar HINTER dem Rest des
 * Racks her, sobald der Effekt eingesetzt wird -- gemeldet als "der Groove
 * fällt auseinander". Fix: jede Maschine bekommt permanent ein `pdcDelay`
 * hinter ihrem Gate (s. Konstruktor); dessen Zeit wird hier auf die Differenz
 * zwischen der eigenen Insert-Latenz und der grössten aktuell im Rack
 * vorkommenden gesetzt, sodass alle Maschinen wieder synchron am Master-Bus
 * (und den Sends, die ebenfalls hinter `pdcDelay` abzweigen) ankommen. Muss
 * bei jeder Änderung der Insert-Zusammensetzung/des Bypass-Status irgendeiner
 * Maschine sowie beim Hinzufügen/Entfernen einer ganzen Maschine neu
 * berechnet werden (s. Aufrufstellen). Master-FX-eigene Insert-Latenz bleibt
 * bewusst aussen vor -- sie liegt für JEDE Maschine gleichermassen an,
 * verschiebt also nichts relativ zueinander (kein Groove-Problem).
 */
function refreshLatencyCompensation() {
  const t = engine.now;
  let maxLatency = 0;
  for (const m of machines) maxLatency = Math.max(maxLatency, insertChainLatencySec(m.inserts));
  for (const m of machines) {
    m.pdcDelay.delayTime.setTargetAtTime(maxLatency - insertChainLatencySec(m.inserts), t, 0.01);
  }
}

/* ---------- Kopfzeilen-Pegelanzeige (alle Maschinen) ----------
 * Ein einziger geteilter rAF-Ticker für ALLE gemounteten Maschinen-Panels
 * -- läuft unabhängig davon, ob gerade Mixer/Jam/Song offen ist (die
 * Rack-Ansicht ist die Standardansicht, "überall" mitmonitoren können war
 * die explizite Nutzer-Anfrage), analog zum selbstständigen
 * Master-Meter-Ticker in fx.js#startVU. Iteriert die bereits vorhandene
 * app-weite `machines`-Registry statt einer eigenen Anmeldeliste -- eine
 * Maschine ohne gerendertes Panel (headMeterEl noch nicht gesetzt) wird
 * einfach übersprungen, kein Fehlerfall, kein separates Auf-/Abmelden
 * beim Entfernen nötig (dispose() entfernt die Maschine schon aus
 * `machines`). Ein fixer, wiederverwendeter Buffer reicht für alle
 * Maschinen -- getMeterAnalyser() setzt fftSize immer auf 512. */
const HEAD_METER_BUF = new Float32Array(512);
(function tickHeadMeters() {
  for (const m of machines) {
    if (!m.headMeterEl) continue;
    const { rmsDb, peakDb } = computeLevels(m.getMeterAnalyser(), HEAD_METER_BUF);
    m.headMeterEl.update(rmsDb, peakDb);
  }
  requestAnimationFrame(tickHeadMeters);
})();

export class Machine {
  static meta = { type: 'machine', name: 'Machine', desc: '', color: '#888' };

  constructor() {
    this.id = nextId++;
    this.muted = false;
    this.soloed = false;
    /** Nutzer-Label statt des Typ-Namens, s. displayName/setLabel unten. */
    this.label = null;
    /** Von der Jam-Ansicht gesetzt (s. setJamGate) — unabhängig von Mute/
     *  Solo. Default offen: solange niemand jammt, keine Einschränkung. */
    this.jamGateOpen = true;

    /** Verschiebt die Schritt-Zählung für sequenzergetriebene Unterklassen
     *  (StepSequencedSynth/AcidBass/TrackedDrumMachine/Sampler, s. deren
     *  onStep(): `idx = (globalerSchritt - stepOffset) % PatternLänge`).
     *  Default 0 -- deckt sich exakt mit dem alten, festen `idx = Schritt %
     *  Länge` (normale Rack-Pattern-Wiedergabe/A-B-C-D-Umschalten bleibt
     *  unangetastet). Ausschliesslich von der Jam-Ansicht gesetzt (s. dort
     *  promoteQueuedClip()/queueStopChange()/revertToPattern()), sobald ein
     *  Clip neu gebunden oder eine Spur wieder hörbar wird -- macht daraus
     *  den eigenen Takt-1 des Patterns/Clips, statt irgendwo mitten im
     *  globalen Takt einzusteigen (Nutzer-Bugreport: "Gate startet mitten
     *  im Clip/Takt", weil bisher JEDE Maschine ausschliesslich über den
     *  einen geteilten globalen Schrittzähler lief, ganz ohne eigenen,
     *  zurücksetzbaren Bezugspunkt). */
    this.stepOffset = 0;

    /** @type {GainNode} Alles, was die Maschine erzeugt, läuft hier durch
     *  (Volume-Regler schreiben hierauf). */
    this.output = engine.ctx.createGain();
    /** @type {GainNode} Multiplikator HINTER this.output, standardmässig 1
     *  (kein Effekt) -- ausschliesslich für LFO/Automation auf "Volume"
     *  reserviert (s. render()#Sonderfall unten). Ohne diesen zweiten Gain
     *  würde eine LFO-Fahrt auf "Volume" denselben this.output.gain
     *  ABSOLUT überschreiben, den auch der Fader/Volume-Knob setzt --
     *  Ergebnis (Nutzer-Bugreport): der Jam-Fader wirkt nur, solange man
     *  ihn bewegt, das Signal "kommt gleich wieder", weil der nächste LFO-
     *  Tick den gerade gesetzten Fader-Wert wieder verwirft. Multiplikativ
     *  getrennt bleibt der Fader IMMER die vom Nutzer gewählte Zimmerdecke,
     *  der LFO moduliert relativ dazu (Tremolo), statt gegen ihn zu
     *  konkurrieren. */
    this.volumeMod = engine.ctx.createGain();
    this.output.connect(this.volumeMod);
    /** @type {StereoPannerNode} Panorama — sitzt direkt hinterm Fader, wie
     *  am echten Kanalzug. Die Sends (Delay/Reverb) hängen hinter dem Gate,
     *  tragen die Stereo-Position also mit. */
    this.pan = 0;
    this.panner = engine.ctx.createStereoPanner();
    /** @type {GainNode} Mute/Solo-Gate — getrennt vom Volume, damit
     *  Entmuten nicht die Reglerstellung überschreibt. */
    this.gate = engine.ctx.createGain();
    this.panner.connect(this.gate);
    /** @type {DelayNode} Latenz-Ausgleich (PDC) gegenüber dem Rest des Racks
     *  — sitzt hinterm Gate, VOR Master-Bus UND Sends (beide zweigen erst
     *  danach ab, s. unten), gleicht also beide Pfade gemeinsam aus. Zeit
     *  wird ausschliesslich von refreshLatencyCompensation() gepflegt (s.
     *  dortigen Kommentar) -- hier nur mit 0 initialisiert (frisch erzeugte
     *  Maschine hat noch keine Inserts). 0.5s Maximalpuffer ist grosszügig
     *  bemessen (selbst mehrere gestapelte Tape-Machine/Kompressor-Inserts
     *  blieben weit darunter), kostet aber nur einen einzelnen kleinen Node. */
    this.pdcDelay = engine.ctx.createDelay(0.5);
    this.gate.connect(this.pdcDelay);
    this.pdcDelay.connect(engine.masterBus);

    /** @type {Array<ReturnType<typeof createInsert>>} Insert-FX-Kette
     *  zwischen Output und Panner — frei bestückbar (0..n Instanzen,
     *  beliebige Reihenfolge). Leer verbindet #rewireInsertChain()
     *  Output direkt an den Panner. */
    this.inserts = [];
    this.#rewireInsertChain();

    /** @type {Array<ReturnType<typeof createModulator>>} Modulations-Kette
     *  (LFO/Arpeggiator) — anders als die Insert-Kette kein Teil des
     *  Audiographen, sondern steuert Parameter/Noten dieser Maschine. Sitzt
     *  im Panel bewusst OBERHALB der eigenen Regler (s. render()), während
     *  Inserts unterhalb sitzen — macht "wirkt auf die Maschine, bevor sie
     *  klingt" vs. "wirkt aufs bereits erzeugte Signal" auch im Layout
     *  sichtbar. */
    this.modulators = [];

    /** @type {Array<{id:number, name:string, shape:string, data:*}>}
     *  Jam-Clips — benannte Pattern-Schnappschüsse, s. addClip(). */
    this.clips = [];

    /** Auto-Return-Schalter des Jam-X/Y-Pads (s. jam-view.js#buildXYPad,
     *  .xy-spring-btn) — ein Sibling-Feld wie sends/inserts/clips, weil
     *  Nutzer diesen Schalter bewusst dauerhaft so lassen wollen, wie sie
     *  ihn eingestellt haben, statt bei jedem Neuladen wieder auf den
     *  Default zurückzufallen. */
    this.xySpring = false;

    /** @type {{x:Array<{key:string,from:number,to:number,centered?:boolean}>,
     *  y:Array<{key:string,from:number,to:number,centered?:boolean}>}|null}
     *  Welche Regler auf der X/Y-Achse des Jam-Pads liegen (s. jam-view.js
     *  #xyStateFor/#buildXYPad) — genau wie xySpring ein Sibling-Feld
     *  (Nutzer-Anfrage: eine mühsam eingestellte Pad-Zuordnung soll ein
     *  Neuladen/Speichern überleben, nicht auf den Delay/Reverb-Default
     *  zurückfallen). Bleibt hier `null` (statt schon mit dem Default
     *  belegt) -- jam-view.js#xyStateFor() legt ihn beim ersten Zugriff an,
     *  dieselbe Lazy-Init wie zuvor über eine private WeakMap, nur jetzt
     *  direkt auf der Maschine statt daneben, damit er serialisierbar ist. */
    this.xyMap = null;

    /** Post-Fader-Sends zu den Master-Effekten — hinter Gate UND pdcDelay,
     *  damit Mute/Solo UND der Latenz-Ausgleich die Effekt-Fahnen mitnehmen
     *  (sonst käme der Reverb-/Delay-Anteil einer Maschine mit latenten
     *  Inserts wie Tape Machine zeitlich vor ihrem eigenen Trockensignal an). */
    this.sends = { delay: 0, reverb: 0 };
    this.sendDelay = engine.ctx.createGain();
    this.sendDelay.gain.value = 0;
    this.sendReverb = engine.ctx.createGain();
    this.sendReverb.gain.value = 0;
    this.pdcDelay.connect(this.sendDelay);
    this.sendDelay.connect(engine.delayBus);
    this.pdcDelay.connect(this.sendReverb);
    this.sendReverb.connect(engine.reverbBus);

    machines.add(this);
    refreshLatencyCompensation();
    // Reicht die neue Maschine die hörbare Menge wieder von "niemand" auf
    // "jemand" (z. B. New Session direkt nach dem letzten dispose(), das
    // die Master-FX-Rückführung geschlossen hat) -- sonst bliebe sie ohne
    // einen manuellen Mute/Solo-Klick für immer stumm geschaltet.
    refreshGates();

    /** @type {HTMLElement|null} */
    this.el = null;

    this.buildAudio();
    transport.addListener(this);
  }

  /* ---------- Von Unterklassen zu implementieren ---------- */
  buildAudio() {}
  buildControls(_container) {}
  disposeAudio() {}
  serialize() { return {}; }
  deserialize(_state) {}
  /** Von refreshGates() gerufen, sobald eine ANDERE Maschine solo ist
   *  (oder der Jam-Gate diese hier schließt). Nur für Unterklassen mit
   *  Sends, die absichtlich am eigenen `this.gate` vorbeilaufen (s. dort);
   *  die Basisklasse hat keine, also nichts zu tun. */
  setSoloShadowed(_shadowed) {}
  /** Wert für einen Knob (data-p) — Basis: Sends, sonst aus this.params. */
  getParamForKnob(key) {
    if (key === 'sendDelay') return this.sends.delay;
    if (key === 'sendReverb') return this.sends.reverb;
    return this.params?.[key];
  }

  /* ---------- Mixer: Pegel & Panorama ---------- */

  /**
   * Pegel (0..1) — Basis liest/schreibt `this.params.volume`, passend für
   * SubSynth/PercSynth. BeatBox überschreibt (führt die Lautstärke separat
   * als `this.volume`). Sowohl der eigene Volume-Knob im Maschinen-Body als
   * auch der Mixer greifen auf DIESELBE Methode zu — eine Quelle der
   * Wahrheit, kein zweiter, widersprüchlicher Pegel-Regler.
   */
  get level() { return this.params?.volume ?? 1; }
  setLevel(v) {
    v = Math.min(1, Math.max(0, v));
    if (this.params) this.params.volume = v;
    this.output.gain.setTargetAtTime(v, engine.now, 0.01);
    const knob = this.el?.querySelector('x-knob[data-p="volume"]');
    if (knob) knob.value = v;
  }

  /** Panorama (-1..1). Neu, ohne Legacy-Regler — nur der Mixer zeigt ihn. */
  setPan(v) {
    this.pan = Math.min(1, Math.max(-1, v));
    this.panner.pan.setTargetAtTime(this.pan, engine.now, 0.01);
  }

  /** @type {AnalyserNode|null} */
  #meterAnalyser = null;
  /**
   * Analyser fürs VU-Meter dieser Maschine -- im Mixer-Kanalzug UND in der
   * eigenen Panel-Kopfzeile (s. headMeterEl/tickHeadMeters oben) genutzt,
   * beide Male hinter dem Mute/Solo-Gate abgegriffen, zeigt also genau das,
   * was hörbar ist (still bei Mute). Lazy angelegt: kostet nichts, bevor
   * der erste Abrufer (Mixer-Kanalzug oder der Kopfzeilen-Ticker) ihn
   * abfragt.
   */
  getMeterAnalyser() {
    if (!this.#meterAnalyser) {
      this.#meterAnalyser = engine.ctx.createAnalyser();
      this.#meterAnalyser.fftSize = 512;
      this.gate.connect(this.#meterAnalyser);
    }
    return this.#meterAnalyser;
  }

  /* ---------- Master-FX-Sends ---------- */
  setSend(which, value) {
    this.sends[which] = value;
    const node = which === 'delay' ? this.sendDelay : this.sendReverb;
    node.gain.setTargetAtTime(value, engine.now, 0.01);
    // Panel-Knob synchron halten — eine Quelle der Wahrheit, egal ob der
    // Mixer oder das eigene Maschinen-Panel gerade gezogen wird.
    const paramKey = which === 'delay' ? 'sendDelay' : 'sendReverb';
    const knob = this.el?.querySelector(`x-knob[data-p="${paramKey}"]`);
    if (knob) knob.value = value;
  }

  /** Beim Projekt-Laden: Werte setzen UND Knob-Stellungen nachziehen
   *  (das Laden passiert nach render, der Sync-Lauf dort ist schon durch). */
  setSends({ delay = 0, reverb = 0 } = {}) {
    this.setSend('delay', delay);
    this.setSend('reverb', reverb);
    const dk = this.el?.querySelector('x-knob[data-p="sendDelay"]');
    const rk = this.el?.querySelector('x-knob[data-p="sendReverb"]');
    if (dk) dk.value = delay;
    if (rk) rk.value = reverb;
  }

  /* ---------- Insert-FX ---------- */

  /** Für insert-chain.js#renderInsertChain (Automation-Lane-Präfix) — bei
   *  Maschinen einfach die eigene id, wie die Lane-Schlüssel es schon immer
   *  waren; MasterFX (fx.js) setzt hier stattdessen den festen String
   *  'master'. */
  get laneKeyPrefix() { return String(this.id); }

  /** Merkt sich pro Knoten, an welchen Nachfolger er in der KETTE gerade
   *  angeschlossen ist -- #rewireInsertChain() braucht das, um beim Neu-
   *  Verbinden gezielt NUR diese eine Verbindung zu trennen
   *  (node.disconnect(target)) statt node.disconnect() ohne Ziel.
   *  Ein zielloser disconnect() kappt ALLE ausgehenden Verbindungen eines
   *  Knotens -- auch den parallelen Pegel-Meter-Tap (s. core/inserts.js#
   *  getMeterAnalyser, output.connect(analyser)), der gar nicht Teil der
   *  Kette ist. Genau das war ein gemeldeter Bug: nach jedem Verschieben/
   *  Hinzufügen/Entfernen eines Inserts verstummten die VU-Meter der
   *  GESAMTEN Kette dauerhaft -- #rewireInsertChain() riss bei jedem
   *  Aufruf erneut alle Meter-Taps mit ab, ohne sie je wieder anzu-
   *  schliessen (getMeterAnalyser() legt den Analyser nur EINMAL an und
   *  verbindet ihn dabei auch nur EINMAL; ein späterer erneuter Aufruf
   *  liefert einfach den längst verwaisten, nie wieder verbundenen
   *  Analyser zurück). */
  #chainTarget = new WeakMap();

  /** Verbindet Output -> insert[0] -> insert[1] -> ... -> Panner neu. */
  #rewireInsertChain() {
    const disconnectChainEdge = (node) => {
      const target = this.#chainTarget.get(node);
      if (target) node.disconnect(target);
    };
    // this.output -> this.volumeMod ist eine feste 1:1-Verbindung (s.
    // Konstruktor), die Kette baut deshalb ab volumeMod neu, nicht ab
    // output selbst.
    disconnectChainEdge(this.volumeMod);
    for (const insert of this.inserts) disconnectChainEdge(insert.output);

    let prev = this.volumeMod;
    for (const insert of this.inserts) {
      prev.connect(insert.input);
      this.#chainTarget.set(prev, insert.input);
      prev = insert.output;
    }
    prev.connect(this.panner);
    this.#chainTarget.set(prev, this.panner);
  }

  addInsert(type) {
    const insert = createInsert(type);
    this.inserts.push(insert);
    this.#rewireInsertChain();
    this.#renderInserts();
    refreshLatencyCompensation();
    return insert;
  }

  /**
   * Insert entfernen -- war bisher der einzige sofortige UND nicht rück-
   * holbare Lösch-Weg der App (jede andere Löschaktion: Maschine, Pattern,
   * Clip, hat ein Undo-Angebot), direkt neben dem genauso erreichbaren
   * BYP-Button. Bekommt hier denselben Undo-Toast wie alle anderen (s.
   * UI-Review) -- Params/Bypass UND aufgenommene Automation-Fahrten
   * werden vor dem Verwerfen gesichert und beim Undo unter demselben
   * Insert (gleiche id, createInsert() übernimmt saved.id) wiederhergestellt.
   */
  removeInsert(id) {
    const idx = this.inserts.findIndex((i) => i.id === id);
    if (idx === -1) return;
    const [insert] = this.inserts.splice(idx, 1);
    this.#rewireInsertChain();

    const savedInsert = insert.serialize();
    const lanePrefix = `${this.id}:insert:${id}:`;
    const savedLanes = automation.exportLanesWithPrefix(lanePrefix);
    const insertIndex = idx;

    insert.dispose();
    // Automation-Lanes des entfernten Inserts mit aufräumen -- ohne das
    // blieben sie als unerreichbare Leichen in automation.lanes stehen
    // (insert.id wird nie wiederverwendet, s. inserts.js#createInsert,
    // also auch kein Kollisionsrisiko, nur unnötiger Ballast).
    automation.clearLanesWithPrefix(lanePrefix);
    this.#renderInserts();
    refreshLatencyCompensation();

    const label = INSERT_DISPLAY[insert.type]?.name ?? insert.name;
    undo.offer(`${label} removed`, () => {
      const restored = createInsert(savedInsert.type, savedInsert);
      this.inserts.splice(insertIndex, 0, restored);
      this.#rewireInsertChain();
      automation.importLanesWithPrefix(lanePrefix, savedLanes);
      this.#renderInserts();
      refreshLatencyCompensation();
    });
  }

  moveInsert(id, dir) {
    const idx = this.inserts.findIndex((i) => i.id === id);
    if (idx === -1) return;
    const j = idx + dir;
    if (j < 0 || j >= this.inserts.length) return;
    [this.inserts[idx], this.inserts[j]] = [this.inserts[j], this.inserts[idx]];
    this.#rewireInsertChain();
    this.#renderInserts();
  }

  setInsertBypass(id, bypassed) {
    this.inserts.find((i) => i.id === id)?.setBypass(bypassed);
    refreshLatencyCompensation();
  }

  setInsertParam(id, key, value) {
    this.inserts.find((i) => i.id === id)?.setParam(key, value);
  }

  /** Für project.js — analog zu `sends`, als Sibling-Feld serialisiert,
   *  nicht Teil der Unterklassen-eigenen serialize()/deserialize(). */
  serializeInserts() {
    return this.inserts.map((i) => i.serialize());
  }

  deserializeInserts(list) {
    for (const insert of this.inserts) insert.dispose();
    this.inserts = (list ?? []).map((saved) => createInsert(saved.type, saved));
    this.#rewireInsertChain();
    this.#renderInserts();
    refreshLatencyCompensation();
  }

  /** Nach dem Laden eines Projekts (project.js#loadProject/importMachines):
   *  deserializeInserts() läuft VOR automation.importLanes(), das erste
   *  #renderInserts() sieht die geladenen Lanes also noch nicht -- has-auto
   *  auf den Insert-Knobs stünde sonst falsch (fehlend) bis zum nächsten
   *  Rendern. Ein zweiter Durchlauf hier holt das nach. Unterklassen mit
   *  eigenen automatisierbaren Regeln (z. B. TrackedDrumMachine für die
   *  Spur-Knobs) überschreiben das und rufen super.onLanesImported() mit. */
  onLanesImported() {
    this.#renderInserts();
    this.#rerenderModulators();
  }

  /* ---------- Modulations-FX (LFO/Arpeggiator) ----------
   * Eigene, kleinere Geschwister-Kette zur Insert-Kette oben (s. deren
   * Kommentare für die generellen Add/Move/Remove/Undo-Muster, hier 1:1
   * übernommen) -- Details/Owner-Interface s. modulation-chain.js. */

  /** Welche Modulator-Typen diese Maschine anbietet -- Default: nur LFO
   *  (funktioniert auf jedem automatisierbaren Regler jeder Maschine).
   *  SubSynth/PolySynth/FMSynth (gehaltene Keybed-Stimmen) überschreiben
   *  das um 'arp': ein Arpeggiator ohne gehaltene Noten (Drum-/Sampler-
   *  Maschinen, PercSynths reines Fire-and-Forget) hätte nichts zum
   *  Arpeggieren. */
  get modulatorTypes() { return ['lfo']; }

  #rerenderModulators() {
    renderModulationChain(this.modulatorsListEl, this);
  }

  addModulator(type) {
    const mod = createModulator(type, null, this);
    this.modulators.push(mod);
    this.#rerenderModulators();
    return mod;
  }

  /** Entfernen mit Undo-Angebot, gleiches Muster wie removeInsert() oben
   *  (Params/Bypass UND aufgenommene Automations-Fahrten der Modulator-
   *  eigenen Regler werden gesichert und unter derselben id wiederhergestellt). */
  removeModulator(id) {
    const idx = this.modulators.findIndex((m) => m.id === id);
    if (idx === -1) return;
    const [mod] = this.modulators.splice(idx, 1);

    const savedMod = mod.serialize();
    const lanePrefix = `${this.id}:mod:${id}:`;
    const savedLanes = automation.exportLanesWithPrefix(lanePrefix);
    const modIndex = idx;

    mod.dispose();
    automation.clearLanesWithPrefix(lanePrefix);
    this.#rerenderModulators();

    const label = MOD_DISPLAY[mod.type]?.name ?? mod.name;
    undo.offer(`${label} removed`, () => {
      const restored = createModulator(savedMod.type, savedMod, this);
      this.modulators.splice(modIndex, 0, restored);
      automation.importLanesWithPrefix(lanePrefix, savedLanes);
      this.#rerenderModulators();
    });
  }

  moveModulator(id, dir) {
    const idx = this.modulators.findIndex((m) => m.id === id);
    if (idx === -1) return;
    const j = idx + dir;
    if (j < 0 || j >= this.modulators.length) return;
    [this.modulators[idx], this.modulators[j]] = [this.modulators[j], this.modulators[idx]];
    this.#rerenderModulators();
  }

  setModulatorBypass(id, bypassed) {
    this.modulators.find((m) => m.id === id)?.setBypass(bypassed);
  }

  setModulatorParam(id, key, value) {
    this.modulators.find((m) => m.id === id)?.setParam(key, value);
  }

  /** Erster nicht-bypasste Modulator eines Typs -- vom Keybed der Synths
   *  mit gehaltenen Stimmen abgefragt (s. subsynth.js/polysynth.js/
   *  fmsynth.js), um noteOn/noteOff bei aktivem Arp dorthin statt an die
   *  eigene Stimmenverwaltung umzuleiten. */
  getActiveModulator(type) {
    return this.modulators.find((m) => m.type === type && !m.bypassed);
  }

  serializeModulators() {
    return this.modulators.map((m) => m.serialize());
  }

  deserializeModulators(list) {
    for (const m of this.modulators) m.dispose();
    this.modulators = (list ?? []).map((saved) => createModulator(saved.type, saved, this));
    this.#rerenderModulators();
  }

  /* ---------- Jam-Clips ----------
   * Ein Clip ist ein benannter Schnappschuss eines Pattern-Slot-Inhalts
   * (`data`, aus pattern-bank.js' getSlot() — dieselbe Kopie, die auch
   * Copy/Paste nutzt), plus `shape` ('drums'|'notes'), damit spätere
   * Wiedergabe weiss, wie er anzuwenden ist. Klips leben NEBEN den vier
   * A/B/C/D-Pattern-Slots, nicht als fünfter Slot — Hinzufügen ändert
   * `this.patterns`/`this.patternIndex` nicht.
   * `sourceSlot` (optional, nur von addClipFromPattern() gesetzt) merkt
   * sich, aus welchem A/B/C/D-Slot der Clip kam — jam-view.js nutzt das,
   * um die Jam-Proto-Clip-Kacheln nach dem Hinzufügen um genau diesen
   * Buchstaben zu verkürzen (s. dort).
   */
  addClip({ name, shape, data, sourceSlot }) {
    const clip = { id: nextClipId++, name, shape, data, sourceSlot };
    this.clips.push(clip);
    return clip;
  }

  removeClip(id) {
    this.clips = this.clips.filter((c) => c.id !== id);
  }

  /** Für project.js — analog zu `sends`/`inserts`, als Sibling-Feld. */
  serializeClips() {
    return this.clips.map((c) => ({ name: c.name, shape: c.shape, data: c.data, sourceSlot: c.sourceSlot }));
  }

  deserializeClips(list) {
    this.clips = (list ?? []).map((c) => ({ id: nextClipId++, ...c }));
  }

  /* ---------- Faceplate ---------- */
  render() {
    const { type, color, model = 'RW-00' } = this.constructor.meta;

    const el = document.createElement('section');
    el.className = 'machine';
    // Farbvarianten hier berechnen statt per CSS color-mix() —
    // funktioniert damit auch in älteren WebViews zuverlässig
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
    el.style.setProperty('--m-color', color);
    el.style.setProperty('--m-color-dim', `rgba(${r},${g},${b},.22)`);
    el.style.setProperty('--m-color-glow', `rgba(${r},${g},${b},.45)`);
    el.style.setProperty('--m-color-tint', `rgba(${r},${g},${b},.08)`);
    el.innerHTML = `
      <header class="machine__head">
        <span class="machine__stripe"></span>
        <div class="machine__title" data-collapse-toggle>
          <span class="machine__chevron" aria-hidden="true">▾</span>
          <span>
            <div class="machine__name" data-rename title="Tap to rename"><span data-name-text>${this.displayName}</span><span class="machine__rename-hint" aria-hidden="true">✎</span></div>
            <div class="machine__type">${model} · #${this.id}<span class="machine__led" data-led></span></div>
          </span>
        </div>
        <x-meter compact data-head-meter></x-meter>
        <div class="machine__head-actions">
          <button class="m-btn m-btn--solo" data-solo>SOLO</button>
          <button class="m-btn m-btn--mute" data-mute>MUTE</button>
          <button class="m-btn m-btn--remove" data-remove aria-label="Hold to remove machine">✕</button>
        </div>
      </header>
      <div class="machine__body"></div>
    `;
    // Früh setzen (nicht erst am Ende von render()) -- die Modulations-
    // Kette braucht this.el schon MITTEN in render(), um beim Befüllen
    // ihrer LFO-Zielauswahl die inzwischen von buildControls() angelegten
    // data-auto-Knobs zu finden (s. modulation-chain.js#targetOptions).
    this.el = el;

    // Panel einklappen (nur Header sichtbar) — reduziert Scroll-Distanz bei
    // mehreren Maschinen im Rack. Rein visuell, kein Datenzustand, deshalb
    // bewusst nicht in serialize()/deserialize() (wie das Mixer-Pendant
    // .mixer-group__toggle, das ebenfalls nicht persistiert wird).
    el.querySelector('[data-collapse-toggle]').addEventListener('click', () => {
      el.classList.toggle('is-collapsed');
    });

    // Name antippen -> umbenennen, statt (wie der Rest der Kopfzeile) das
    // Panel ein-/auszuklappen -- stopPropagation, sonst würde derselbe Klick
    // AUCH is-collapsed umschalten (der Name sitzt innerhalb des Toggle-Bereichs).
    const nameEl = el.querySelector('[data-rename]');
    nameEl.addEventListener('click', (e) => {
      e.stopPropagation();
      openRenamePopup(this, nameEl);
    });

    this.headMuteBtn = el.querySelector('[data-mute]');
    this.headSoloBtn = el.querySelector('[data-solo]');
    this.headMeterEl = el.querySelector('[data-head-meter]');
    this.headMuteBtn.addEventListener('click', () => this.setMuted(!this.muted));
    this.headSoloBtn.addEventListener('click', () => this.setSoloed(!this.soloed));

    // Löschen erst nach kurzem Halten (nicht bei einzelnem Tap) — verse-
    // hentliches Löschen war der Auslöser für den Undo-Button; ein Hold
    // mit sichtbarem Füllfortschritt verhindert das schon an der Wurzel.
    const removeBtn = el.querySelector('[data-remove]');
    const REMOVE_HOLD_MS = 550;
    let removeTimer = null;
    const cancelRemoveHold = () => {
      clearTimeout(removeTimer);
      removeTimer = null;
      removeBtn.classList.remove('is-holding');
    };
    removeBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      removeBtn.classList.add('is-holding');
      removeTimer = setTimeout(() => {
        removeTimer = null;
        removeBtn.classList.remove('is-holding');
        // Vollständiges Bundle vor dispose() sichern — für Undo. Nicht nur
        // this.serialize() (Unterklassen-State): Inserts/Sends/Clips/
        // Automation-Lanes sind Sibling-Felder (wie im Projekt-Format, s.
        // project.js) und dispose() löscht die Lanes unwiderruflich
        // (automation.unregisterMachine). Ohne dieses Bundle käme "Undo"
        // eine Maschine ohne Effektkette und ohne aufgenommene Fahrten
        // zurück — stiller Datenverlust hinter dem Feature, das genau
        // davor schützen soll.
        const state = {
          state: this.serialize(),
          sends: { ...this.sends },
          inserts: this.serializeInserts(),
          modulators: this.serializeModulators(),
          clips: this.serializeClips(),
          xySpring: this.xySpring,
          xyMap: this.xyMap,
          lanes: automation.exportLanes(this.id),
          label: this.label,
        };
        // Event VOR dispose() feuern: dispose() hängt el aus dem DOM aus,
        // ein bubbling Event auf einem bereits entfernten Knoten erreicht
        // keine Vorfahren mehr (also auch nicht Racks Listener).
        el.dispatchEvent(new CustomEvent('machine:removed', {
          detail: { machine: this, state },
          bubbles: true,
        }));
        this.dispose();
      }, REMOVE_HOLD_MS);
    });
    removeBtn.addEventListener('pointerup', cancelRemoveHold);
    removeBtn.addEventListener('pointerleave', cancelRemoveHold);
    removeBtn.addEventListener('pointercancel', cancelRemoveHold);

    // Modulations-Kette (LFO/Arpeggiator) -- VOR buildControls() angehängt,
    // damit sie im Panel OBERHALB der maschinen-eigenen Regler sitzt
    // (Insert-FX sitzen unterhalb, s. weiter unten): "wirkt, bevor die
    // Maschine klingt" vs. "wirkt aufs bereits erzeugte Signal" wird so
    // auch im Layout sichtbar, wie gewünscht.
    const modSection = document.createElement('div');
    modSection.className = 'machine__row machine__row--modulators';
    modSection.innerHTML = `
      <div class="modulators" data-modulators></div>
      <button type="button" class="rack__add modulators__add" data-add-modulator>+  Add Modulator</button>
    `;
    modSection.querySelector('[data-add-modulator]').addEventListener('click', () => {
      openModulatorPicker((type) => { this.addModulator(type); }, this.modulatorTypes);
    });
    el.querySelector('.machine__body').appendChild(modSection);
    this.modulatorsListEl = modSection.querySelector('[data-modulators]');
    // Erst NACH buildControls() befüllen (s. unten) -- die LFO-Zielauswahl
    // liest die data-auto-Knobs der Maschine aus dem DOM (s. modulation-
    // chain.js#targetOptions), die buildControls() erst gleich anlegt.
    // Nur die Platzierung im Baum (oberhalb) muss schon jetzt feststehen.

    this.buildControls(el.querySelector('.machine__body'));

    // Send-Regler zu den Master-Effekten — einheitlich unter jeder Maschine
    const sendsRow = document.createElement('div');
    sendsRow.className = 'machine__row machine__row--sends';
    sendsRow.innerHTML = `
      <span class="sends__label">FX</span>
      <x-knob label="Delay" min="0" max="1" value="0" data-p="sendDelay" data-auto></x-knob>
      <x-knob label="Reverb" min="0" max="1" value="0" data-p="sendReverb" data-auto></x-knob>
    `;
    sendsRow.addEventListener('input', (e) => {
      const key = e.target.dataset?.p;
      if (key === 'sendDelay') this.setSend('delay', e.detail.value);
      else if (key === 'sendReverb') this.setSend('reverb', e.detail.value);
    });
    el.querySelector('.machine__body').appendChild(sendsRow);

    // Insert-FX — frei bestückbare Effektkette zwischen Output und Panner,
    // gilt automatisch für jede Maschine (generisch in der Basisklasse).
    const insertsSection = document.createElement('div');
    insertsSection.className = 'machine__row machine__row--inserts';
    insertsSection.innerHTML = `
      <div class="inserts" data-inserts></div>
      <button type="button" class="rack__add inserts__add" data-add-insert>+  Add Effect</button>
    `;
    insertsSection.querySelector('[data-add-insert]').addEventListener('click', () => {
      openInsertPicker((type) => {
        this.addInsert(type);
      });
    });
    el.querySelector('.machine__body').appendChild(insertsSection);
    this.insertsListEl = insertsSection.querySelector('[data-inserts]');
    this.#renderInserts();

    // Jetzt erst befüllen (s. Kommentar bei modSection oben) -- alle
    // data-auto-Knobs (eigene Regler UND die beiden Sends) stehen jetzt
    // im DOM, die LFO-Zielauswahl sieht die vollständige Liste.
    this.#rerenderModulators();

    // Knob-Stellungen mit dem (ggf. geladenen) Zustand synchronisieren —
    // die value-Attribute im Markup sind nur die Werks-Defaults
    for (const knob of el.querySelectorAll('x-knob[data-p]')) {
      const v = this.getParamForKnob(knob.dataset.p);
      if (v !== undefined) knob.value = v;
    }

    // Alle Knobs mit data-auto bei der Automation anmelden. apply() nutzt
    // dieselbe input-Leitung wie eine Handbewegung — Maschinen brauchen
    // für Automation keinen Extra-Code.
    //
    // Sonderfall "Volume": schreibt NICHT über die normale input-Leitung
    // (die am Ende setLevel() aufruft, also denselben output.gain, den
    // auch der Fader/Volume-Knob setzt) -- sonst überschreibt eine LFO-/
    // Automations-Fahrt auf Volume den Fader absolut, und der Fader "hat
    // keinen Effekt mehr" (Nutzer-Bugreport), sobald der nächste LFO-Tick
    // den gerade gesetzten Fader-Wert wieder verwirft. Stattdessen direkt
    // auf volumeMod.gain (s. Konstruktor) -- ein Multiplikator HINTER dem
    // Fader, macht die Modulation zum Tremolo relativ zur Fader-Stellung
    // statt zur Konkurrenz um denselben Gain-Wert. onLfoOff federt das
    // Abschalten ab: ohne das bliebe volumeMod nach Entfernen/Bypassen des
    // LFOs für immer auf seinem letzten Modulationswert hängen.
    for (const knob of el.querySelectorAll('x-knob[data-auto]')) {
      const key = `${this.id}:${knob.dataset.p}`;
      if (knob.dataset.p === 'volume') {
        automation.register(key, knob, (v) => {
          this.volumeMod.gain.setTargetAtTime(v, engine.now, 0.01);
        }, {
          onLfoOff: () => this.volumeMod.gain.setTargetAtTime(1, engine.now, 0.05),
          // s. automation.js#register für die ausführliche Begründung:
          // Fader und LFO landen für "Volume" nie mehr auf demselben Gain,
          // die Hand-Vorrang-Erkennung (die knob.value beobachtet) würde
          // hier nur fälschlich anschlagen, weil apply() knob.value gar
          // nicht mehr schreibt.
          skipHandOverride: true,
        });
        continue;
      }
      automation.register(key, knob, (v) => {
        knob.value = v;
        knob.dispatchEvent(new CustomEvent('input', {
          detail: { value: v },
          bubbles: true,
        }));
      });
    }

    this.ledEl = el.querySelector('[data-led]');
    return el;
  }

  /** Baut die komplette Insert-Liste neu aus this.inserts — delegiert an
   *  insert-chain.js#renderInsertChain (herausgelöst, damit MasterFX
   *  dieselbe Logik nutzen kann, s. dortigen Dateikopf-Kommentar). Bleibt
   *  als private Methode bestehen, damit alle bisherigen this.#renderInserts()-
   *  Aufrufer in dieser Klasse unverändert funktionieren. */
  #renderInserts() {
    renderInsertChain(this.insertsListEl, this);
  }

  #ledTimer;

  /**
   * Aktivitäts-LED kurz aufblitzen lassen — Maschinen rufen das bei jedem
   * Trigger. `time` ist die geplante Audio-Zeit, damit die LED synchron
   * zum hörbaren Klang blinkt (nicht zum Planungs-Zeitpunkt).
   */
  pulse(time = 0) {
    // Zwei LEDs möglich: das eigene Faceplate-LED (nur sichtbar im offenen
    // Vollbild-Editor) UND das Pendant in der kompakten Rack-Zeile
    // (rack.js#mount setzt rowLedEl) -- beide blitzen synchron, damit das
    // Rack auch ohne geöffneten Editor eine Live-Aktivitätsanzeige hat.
    if (!this.ledEl && !this.rowLedEl) return;
    const delay = Math.max(0, (time - engine.now) * 1000);
    setTimeout(() => {
      this.ledEl?.classList.add('is-on');
      this.rowLedEl?.classList.add('is-on');
      clearTimeout(this.#ledTimer);
      this.#ledTimer = setTimeout(() => {
        this.ledEl?.classList.remove('is-on');
        this.rowLedEl?.classList.remove('is-on');
      }, 90);
    }, delay);
  }

  /**
   * Live-Aufnahme ins Step-Pattern: Sind REC scharf und der Transport am
   * Laufen, während live gespielt wird (Keybed-Note, Drum-Pad), schreiben
   * Unterklassen den Treffer direkt in den aktuell aktiven Pattern-Slot.
   * Dieselbe REC-Taste löst sonst die Regler-Automation aus — ein Knopf
   * für beides, wie bei klassischen Grooveboxen ("Step-Rec").
   *
   * `liveStepIndex(length)` liefert den Ziel-Step (auf den nächsten 16tel
   * gerundet, über den absoluten Transport-Step — bleibt so auch bei
   * polymetrischen Patterns unterschiedlicher Länge konsistent zum
   * Sequenzer-Playback, das genauso `step % length` rechnet).
   */
  get isLiveRecording() {
    return automation.armed && transport.isPlaying;
  }
  liveStepIndex(length) {
    return transport.currentStep % length;
  }

  setMuted(muted) {
    this.muted = muted;
    this.headMuteBtn?.classList.toggle('is-active', muted);
    this.onMixerChange?.(); // Mixer-Sheet hält seine Buttons synchron, falls offen
    refreshGates();
  }

  setSoloed(soloed) {
    this.soloed = soloed;
    this.headSoloBtn?.classList.toggle('is-active', soloed);
    this.onMixerChange?.();
    refreshGates();
  }

  /** Von der Jam-Ansicht aufgerufen (jam-view.js#refreshJamGates) — eine
   *  zusätzliche, unabhängige Gate-Bedingung neben Mute/Solo. Bewusst KEIN
   *  eigenes UI/keine eigene Persistenz: kein neuer Nutzer-sichtbarer
   *  Zustand, nur eine automatische Folge davon, ob irgendwo ein Clip
   *  läuft (s. dortigen Kommentar für die genaue Regel). */
  setJamGate(open) {
    if (this.jamGateOpen === open) return;
    this.jamGateOpen = open;
    refreshGates();
  }

  /** Nutzer-Label ("Kick", "Bassline", ...) statt des festen Typ-Namens
   *  (this.constructor.meta.name) -- überall dort angezeigt, wo bisher der
   *  Typ-Name stand (Rack-Zeile, Vollbild-Kopfzeile, Mixer/Jam/Song). Diese
   *  beiden UI-Stellen bleiben dauerhaft im DOM (anders als Mixer/Jam/Song,
   *  die bei jedem Öffnen komplett neu gerendert werden, s. deren render()-
   *  Kommentare) -- deshalb hier direkt patchen statt auf ein Neu-Rendern
   *  zu warten. */
  get displayName() { return this.label || this.constructor.meta.name; }

  setLabel(v) {
    const trimmed = (v ?? '').trim().slice(0, 30);
    this.label = trimmed || null;
    // Nur den Text-Kindknoten patchen, nie den ganzen Container -- der
    // trägt noch das LED-/Stift-Icon-Geschwisterelement (s. render()/
    // rack.js#mount), ein textContent-Reset auf dem Container würde die
    // mitreissen.
    const nameTextEl = this.el?.querySelector('.machine__name [data-name-text]');
    if (nameTextEl) nameTextEl.textContent = this.displayName;
    if (this.rowNameEl) this.rowNameEl.textContent = this.displayName;
  }

  /* ---------- Aufräumen ---------- */
  dispose() {
    transport.removeListener(this);
    automation.unregisterMachine(this.id);
    machines.delete(this);
    refreshGates(); // falls die einzige Solo-Maschine entfernt wurde
    refreshLatencyCompensation(); // falls die Maschine mit der grössten Insert-Latenz entfernt wurde
    this.disposeAudio();
    // Fade-out, dann trennen — vermeidet Klicks beim Entfernen
    const t = engine.now;
    this.gate.gain.setTargetAtTime(0, t, 0.02);
    setTimeout(() => {
      this.output.disconnect();
      this.volumeMod.disconnect();
      this.panner.disconnect();
      this.gate.disconnect();
      this.pdcDelay.disconnect();
      this.sendDelay.disconnect();
      this.sendReverb.disconnect();
      this.#meterAnalyser?.disconnect();
      for (const insert of this.inserts) insert.dispose();
    }, 120);
    this.el?.remove();
  }
}
