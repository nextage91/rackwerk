/**
 * masterFX — Delay + Reverb als Send-Effekte auf dem Master.
 *
 * Signalfluss (Post-Fader-Sends, Mute/Solo nimmt die Sends mit):
 *   machine.gate ─(sendDelay)──▶ engine.delayBus  ─▶ Delay-Kette ─┐
 *               └─(sendReverb)─▶ engine.reverbBus ─▶ Convolver   ─┴▶ returnGate ─▶ masterBus
 *
 * returnGate schließt die GEMEINSAME Rückführung, sobald refreshGates()
 * (machine.js) feststellt, dass KEINE Maschine mehr hörbar ist (alles
 * gemutet, oder solo aktiv und nichts soloed) — sonst bliebe ein bereits
 * angeregter Delay-/Reverb-Schwanz auch dann noch hörbar, wenn längst
 * nichts mehr neu in den Bus einspeist.
 *
 * Das reicht aber NICHT für "solo in place": schrumpft die hörbare Menge
 * nur (z. B. eine von mehreren spielenden Maschinen wird soloed, die
 * anderen dadurch stumm), bleibt returnGate offen — der Delay/Reverb
 * enthält aber noch den bereits gespeicherten Nachhall der jetzt stummen
 * Spuren, den kein Gate (weder an den Sends noch an der Rückführung)
 * nachträglich entfernen kann. Einzige Möglichkeit über die Web-Audio-API:
 * flushTails() baut Delay- und Reverb-Kette komplett neu (verwirft ihren
 * inneren Zustand), von refreshGates() aufgerufen, sobald die hörbare
 * Menge schrumpft.
 *
 * Entscheidungen:
 * - Delay ist tempo-synchron (Notenwerte statt Millisekunden). Die Zeit
 *   folgt BPM-Änderungen automatisch — auch im Jam, wo der Host das Tempo
 *   stellt. Der Wechsel läuft über setTargetAtTime: kurzes „Tape-Wobbeln"
 *   statt Knacksen.
 * - Reverb: derselbe Dattorro-Algorithmus (Figure-8-Tank, s. DEFS.reverb in
 *   inserts.js) wie bei den Insert-Reverbs auf den einzelnen Maschinen --
 *   vorher eine Faltung mit einem zur Laufzeit erzeugten Rausch-Impuls,
 *   jetzt derselbe echte, algorithmische Hall über createInsert('reverb', ...).
 *   Läuft hier komplett trocken-frei (mix fest auf 1 -- der Send/Return-Bus
 *   IST bereits der reine Effektweg, das "Dry"-Signal geht separat direkt
 *   zum Master), revLevel bleibt ein externer Ausgangspegel wie zuvor. Echt-
 *   zeit-Regler statt der alten 180ms-IR-Neuberechnung -- ein AudioParam-
 *   Ramp ist billig, eine Impulsantwort neu zu rechnen war es nicht.
 */
import { engine } from './audio-engine.js';
import { transport } from './transport.js';
import { createInsert, makeFeedbackClipCurve } from './inserts.js';
import { automation } from './automation.js';
import { undo } from './undo.js';
import { renderInsertChain, openInsertPicker, INSERT_DISPLAY } from '../ui/insert-chain.js';
import { computeLevels } from '../ui/meter.js';

/** Delay-Notenwerte: Anzahl 16tel-Steps ↔ Beschriftung. */
const DIVISIONS = [
  { steps: 1, label: '1/16' },
  { steps: 2, label: '1/8' },
  { steps: 3, label: '1/8·' },
  { steps: 4, label: '1/4' },
  { steps: 8, label: '1/2' },
];

// Decay/Damping teilen sich die exakt selben, per Stresstest ermittelten
// sicheren Grenzen wie DEFS.reverb in inserts.js (s. UI_PARAMS.reverb dort
// für die vollständige Herleitung) -- die Dattorro-Tank-Topologie hat KEINE
// orthogonale Mischmatrix wie das alte FDN, ab decay>0.4 kann sich bei
// manchen Damping-Werten ein hörbares Dröhnen aufbauen.
const REV_DECAY_MAX = 0.4;
const REV_DAMPING_MIN = 500;
const REV_DAMPING_MAX = 15000;

const FX_DEFAULTS = {
  delaySteps: 3,     // 16tel-Steps → 1/8 punktiert (klassisches Dub-Delay)
  feedback: 0.45,
  tone: 4500,        // Hz — Tiefpass in der Feedback-Schleife
  delayLevel: 0.5,
  swing: 50,         // 50 = gerade (kein Effekt), bis 75 -- wie shuffleTime()/UI_PARAMS.filterDelay
  revSize: 1.0,      // Dattorro "size" -- Raumgrösse/Echodichte
  revDecay: 0.3,     // Dattorro "decay" (0..REV_DECAY_MAX), s. Grenzen oben
  revDamp: 6000,     // Hz -- Dattorro "damping" (REV_DAMPING_MIN..MAX)
  revLevel: 0.4,
};

class MasterFX {
  constructor() {
    this.params = { ...FX_DEFAULTS };
    this.el = null;
    // Letzter von setReturnAudible() gesetzter Sollzustand -- flushTails()
    // muss NACH dem Neuaufbau genau dorthin zurückkehren, nicht blind auf
    // 1 (sonst hebelt ein Flush, der GENAU WEIL "niemand mehr hörbar"
    // ausgelöst wurde, dieses Schließen sofort wieder auf).
    this.#audible = true;

    /** @type {Array<ReturnType<typeof createInsert>>} Frei bestückbare
     *  Insert-Kette auf dem Master-Bus -- dieselbe Mechanik wie bei jeder
     *  Maschine (s. machine.js), nur zwischen engine.masterChainIn/-Out
     *  statt zwischen output/panner verdrahtet (s. #rewireMasterInsertChain).
     *  Sitzt VOR dem Limiter (masterChainOut->limiter, s. audio-engine.js) --
     *  bewusst so: der Limiter bleibt reines Sicherheitsnetz, die Inserts
     *  sind der kreative Bearbeitungsweg des Gesamtmixes davor. */
    this.inserts = [];

    // X/Y-Pad-Zustand für den Master-Kanal in der Jam-Ansicht (s.
    // jam-view.js#buildMasterColumn) -- exakt dieselben zwei Sibling-Felder
    // wie Machine#xySpring/#xyMap (machine.js), hier direkt auf dem
    // MasterFX-Singleton statt einer Maschinen-Instanz: buildXYPad()/
    // xyStateFor() in jam-view.js sind bereits generisch genug (nur auf
    // .el/.xySpring/.xyMap angewiesen, s. dortige Kommentare), keine
    // Sonderbehandlung für "Master ist keine echte Machine" nötig.
    this.xySpring = false;
    this.xyMap = null;
  }

  /** Für insert-chain.js#renderInsertChain (Automation-Lane-Präfix) — fest
   *  'master' statt einer Maschinen-id, s. dortigen Dateikopf-Kommentar. */
  get laneKeyPrefix() { return 'master'; }

  /** Auf Werkseinstellung zurück (für „Neue Session"). */
  reset() {
    this.deserialize({ ...FX_DEFAULTS });
    this.deserializeInserts([]);
    // rack.clear() räumt beim Neustart die Lanes JEDER Maschine auf (s.
    // automation.js#unregisterMachine), das 'master:'-Präfix gehört aber
    // keiner Maschine -- ohne diesen Aufruf blieben Master-Insert-Lanes
    // einer vorherigen Session als unerreichbare Leichen stehen.
    automation.clearLanesWithPrefix('master:');
  }

  #audible;

  /** Nach engine.unlock() aufrufen — baut die Effekt-Ketten an die Busse. */
  init() {
    const ctx = engine.ctx;
    if (!ctx || this.delayA) return;

    // Gemeinsame Rückführung beider Effekte — schließt bei "niemand hörbar"
    // (s. Kommentar oben), sonst identisch zu einer direkten Verbindung.
    this.returnGate = ctx.createGain();
    this.returnGate.connect(engine.masterBus);

    this.#buildDelayChain(ctx);
    this.#buildReverbChain(ctx);
    this.#rewireMasterInsertChain(); // übernimmt die Identitäts-Verbindung aus audio-engine.js

    // Delay-Zeit folgt dem Tempo (auch bei BPM vom Jam-Host) — einmalig
    // registriert, überlebt spätere flushTails()-Neuaufbauten unverändert
    // (liest bei jedem Aufruf die JEWEILS aktuellen this.delayA/-B).
    transport.addListener({
      onTransport: (ev) => { if (ev === 'bpm') this.#applyDelayTime(); },
    });
  }

  /**
   * Delay: Bus → delayA → Filter A ─┬→ Level → Return
   *                                 └→ Feedback → delayB → Filter B ─┬→ Level → Return
   *                                                                  └→ Feedback → delayA → …
   * Zwei Verzögerungsleitungen im Kreuz-Feedback statt einer einzelnen --
   * exakt dieselbe Topologie wie DEFS.filterDelay in inserts.js (s. dortiger
   * Kommentar für die ausführliche Herleitung/den Äquivalenzbeweis). Bei
   * swing=50 (Default) sind beide Zeiten identisch, mathematisch GENAU das
   * alte Einzelleitungs-Delay (jedes Echo durchläuft dieselbe Anzahl Filter-/
   * Feedback-Stufen wie zuvor, nur auf zwei Knoten verteilt) -- erst ein
   * Swing-Wert über 50 versetzt delayB gegenüber delayA, wodurch sich die
   * Abstände aufeinanderfolgender Wiederholungen automatisch abwechseln,
   * ganz ohne eigenes Scheduling. Weichbegrenzer (wie beim Filter Delay)
   * neu dazugekommen, weil die Kreuz-Feedback-Topologie anders reagiert als
   * die alte Einzelschleife -- ohne ihn wäre das bisher unbegrenzt sichere
   * Feedback von bis zu 0.85 hier nicht mehr automatisch garantiert sicher.
   */
  #buildDelayChain(ctx) {
    this.delayA = ctx.createDelay(4); // reicht bis 1/2 bei 40 BPM (3 s)
    this.delayB = ctx.createDelay(4);
    this.filterA = ctx.createBiquadFilter();
    this.filterB = ctx.createBiquadFilter();
    for (const f of [this.filterA, this.filterB]) {
      f.type = 'lowpass';
      f.frequency.value = this.params.tone;
    }
    this.fbA = ctx.createGain();
    this.fbB = ctx.createGain();
    this.fbA.gain.value = this.params.feedback;
    this.fbB.gain.value = this.params.feedback;
    this.clipA = ctx.createWaveShaper();
    this.clipB = ctx.createWaveShaper();
    const clipCurve = makeFeedbackClipCurve();
    this.clipA.curve = clipCurve;
    this.clipB.curve = clipCurve;
    this.clipA.oversample = '2x';
    this.clipB.oversample = '2x';
    this.delayOut = ctx.createGain();
    this.delayOut.gain.value = this.params.delayLevel;

    engine.delayBus.connect(this.delayA);
    this.delayA.connect(this.filterA);
    this.filterA.connect(this.delayOut);
    this.filterA.connect(this.fbA).connect(this.clipA).connect(this.delayB);
    this.delayB.connect(this.filterB);
    this.filterB.connect(this.delayOut);
    this.filterB.connect(this.fbB).connect(this.clipB).connect(this.delayA);
    this.delayOut.connect(this.returnGate);
    this.#applyDelayTime();
  }

  /** Reverb: Bus → Dattorro-Insert (mix fest 1, reiner Effektweg) → Level → Return */
  #buildReverbChain(ctx) {
    this.reverbInsert = createInsert('reverb', {
      params: {
        size: this.params.revSize,
        decay: Math.min(REV_DECAY_MAX, Math.max(0, this.params.revDecay)),
        damping: Math.min(REV_DAMPING_MAX, Math.max(REV_DAMPING_MIN, this.params.revDamp)),
        mix: 1,
      },
    });
    this.revOut = ctx.createGain();
    this.revOut.gain.value = this.params.revLevel;
    engine.reverbBus.connect(this.reverbInsert.input);
    this.reverbInsert.output.connect(this.revOut);
    this.revOut.connect(this.returnGate);
  }

  #flushTimer = null;

  /**
   * Baut Delay- und Reverb-Kette komplett neu — der einzige Weg, einen
   * bereits angeregten Feedback-/Hall-Schwanz über die Web-Audio-API
   * wirklich zu löschen (ein Gate stoppt nur NEUE Energie, der gespeicherte
   * Zustand in DelayNode/dem Reverb-Tank bleibt sonst unberührt). Ein
   * kurzes Ducken übers returnGate maskiert den Node-Wechsel klickfrei.
   * clearTimeout() am Anfang macht schnelles Hintereinander-Toggeln sicher:
   * nur der jeweils letzte Aufruf baut tatsächlich neu, kein doppeltes
   * disconnect() auf bereits ersetzten Knoten.
   */
  flushTails() {
    if (!this.delayA) return; // init() noch nicht gelaufen
    const ctx = engine.ctx;
    clearTimeout(this.#flushTimer);
    this.returnGate.gain.cancelScheduledValues(engine.now);
    this.returnGate.gain.setTargetAtTime(0, engine.now, 0.008);
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      this.delayA.disconnect(); this.delayB.disconnect();
      this.filterA.disconnect(); this.filterB.disconnect();
      this.fbA.disconnect(); this.fbB.disconnect();
      this.clipA.disconnect(); this.clipB.disconnect();
      this.delayOut.disconnect();
      engine.delayBus.disconnect(this.delayA);
      engine.reverbBus.disconnect(this.reverbInsert.input);
      this.reverbInsert.dispose(); this.revOut.disconnect();
      this.#buildDelayChain(ctx);
      this.#buildReverbChain(ctx);
      // Zurück auf den AKTUELLEN Sollzustand, nicht blind auf 1 -- sonst
      // hebelt ein Flush, der gerade WEIL "niemand mehr hörbar" ausgelöst
      // wurde (s. machine.js#refreshGates), das Schließen sofort wieder aus.
      this.returnGate.gain.setTargetAtTime(this.#audible ? 1 : 0, engine.now, 0.008);
    }, 60);
  }

  /** delayA bleibt auf der geraden, taktbezogenen Zeit; delayB bekommt bei
   *  swing>50 zusätzlich einen festen Versatz (dieselbe Formel wie
   *  shuffleTime()/DEFS.filterDelay) -- s. Kommentar bei #buildDelayChain
   *  für die Herleitung, wieso das automatisch alternierende Wieder-
   *  holungsabstände ergibt. */
  #applyDelayTime() {
    if (!this.delayA) return;
    const straight = Math.min(4, transport.stepDuration * this.params.delaySteps);
    const shift = this.params.swing > 50 ? (this.params.swing - 50) / 50 * transport.stepDuration : 0;
    this.delayA.delayTime.setTargetAtTime(straight, engine.now, 0.03);
    this.delayB.delayTime.setTargetAtTime(Math.min(4, straight + shift), engine.now, 0.03);
  }

  /* ---------- Insert-FX (Master-Bus) ---------- */

  /** s. Machine#rewireInsertChain()s #chainTarget-Kommentar für die
   *  ausführliche Begründung -- exakt derselbe Bug (ein zielloser
   *  disconnect() riss bei jedem Verschieben/Hinzufügen/Entfernen eines
   *  Master-Inserts auch den parallelen Pegel-Meter-Tap ab, dauerhaft,
   *  für die GESAMTE Kette) traf hier identisch zu. */
  #chainTarget = new WeakMap();

  /** Verbindet masterChainIn -> insert[0] -> ... -> insert[n] -> masterChainOut
   *  neu -- exaktes Gegenstück zu Machine#rewireInsertChain(), nur mit den
   *  festen Anker-Gains aus audio-engine.js statt output/panner. */
  #rewireMasterInsertChain() {
    const disconnectChainEdge = (node) => {
      const target = this.#chainTarget.get(node);
      if (target) node.disconnect(target);
    };
    disconnectChainEdge(engine.masterChainIn);
    for (const insert of this.inserts) disconnectChainEdge(insert.output);

    let prev = engine.masterChainIn;
    for (const insert of this.inserts) {
      prev.connect(insert.input);
      this.#chainTarget.set(prev, insert.input);
      prev = insert.output;
    }
    prev.connect(engine.masterChainOut);
    this.#chainTarget.set(prev, engine.masterChainOut);
  }

  addInsert(type) {
    const insert = createInsert(type);
    this.inserts.push(insert);
    this.#rewireMasterInsertChain();
    this.#renderInserts();
    return insert;
  }

  /** Wie Machine#removeInsert() -- gleicher Undo-Toast, gleiche
   *  Lane-Rettung/-Wiederherstellung, nur mit dem festen 'master'-Präfix
   *  statt einer Maschinen-id. */
  removeInsert(id) {
    const idx = this.inserts.findIndex((i) => i.id === id);
    if (idx === -1) return;
    const [insert] = this.inserts.splice(idx, 1);
    this.#rewireMasterInsertChain();

    const savedInsert = insert.serialize();
    const lanePrefix = `${this.laneKeyPrefix}:insert:${id}:`;
    const savedLanes = automation.exportLanesWithPrefix(lanePrefix);
    const insertIndex = idx;

    insert.dispose();
    automation.clearLanesWithPrefix(lanePrefix);
    this.#renderInserts();

    const label = INSERT_DISPLAY[insert.type]?.name ?? insert.name;
    undo.offer(`${label} removed`, () => {
      const restored = createInsert(savedInsert.type, savedInsert);
      this.inserts.splice(insertIndex, 0, restored);
      this.#rewireMasterInsertChain();
      automation.importLanesWithPrefix(lanePrefix, savedLanes);
      this.#renderInserts();
    });
  }

  moveInsert(id, dir) {
    const idx = this.inserts.findIndex((i) => i.id === id);
    if (idx === -1) return;
    const j = idx + dir;
    if (j < 0 || j >= this.inserts.length) return;
    [this.inserts[idx], this.inserts[j]] = [this.inserts[j], this.inserts[idx]];
    this.#rewireMasterInsertChain();
    this.#renderInserts();
  }

  setInsertBypass(id, bypassed) {
    this.inserts.find((i) => i.id === id)?.setBypass(bypassed);
  }

  setInsertParam(id, key, value) {
    this.inserts.find((i) => i.id === id)?.setParam(key, value);
  }

  /** Für project.js — analog zu Machine#serializeInserts(), Sibling-Feld
   *  neben `fx`/`song` statt Teil von serialize()/deserialize(). */
  serializeInserts() {
    return this.inserts.map((i) => i.serialize());
  }

  deserializeInserts(list) {
    for (const insert of this.inserts) insert.dispose();
    this.inserts = (list ?? []).map((saved) => createInsert(saved.type, saved));
    this.#rewireMasterInsertChain();
    this.#renderInserts();
  }

  /** Wie Machine#onLanesImported() — zweiter Render-Durchlauf nach
   *  automation.importLanes(), damit has-auto auf den Insert-Knobs stimmt. */
  onLanesImported() {
    this.#renderInserts();
  }

  #renderInserts() {
    renderInsertChain(this.insertsListEl, this);
  }

  /** Von machine.js' refreshGates() bei jeder Mute/Solo-Änderung aufgerufen
   *  — schließt die Rückführung, sobald keine Maschine mehr hörbar ist. */
  setReturnAudible(audible) {
    this.#audible = audible;
    this.returnGate?.gain.setTargetAtTime(audible ? 1 : 0, engine.now, 0.02);
  }

  setParam(key, val) {
    this.params[key] = val;
    const t = engine.now;
    switch (key) {
      case 'delaySteps': this.#applyDelayTime(); break;
      case 'swing':      this.#applyDelayTime(); break;
      case 'feedback':
        this.fbA?.gain.setTargetAtTime(val, t, 0.02);
        this.fbB?.gain.setTargetAtTime(val, t, 0.02);
        break;
      case 'tone':
        this.filterA?.frequency.setTargetAtTime(val, t, 0.02);
        this.filterB?.frequency.setTargetAtTime(val, t, 0.02);
        break;
      case 'delayLevel': this.delayOut?.gain.setTargetAtTime(val, t, 0.02); break;
      case 'revLevel':   this.revOut?.gain.setTargetAtTime(val, t, 0.02); break;
      case 'revSize':    this.reverbInsert?.setParam('size', val); break;
      case 'revDecay':   this.reverbInsert?.setParam('decay', Math.min(REV_DECAY_MAX, Math.max(0, val))); break;
      case 'revDamp':    this.reverbInsert?.setParam('damping', Math.min(REV_DAMPING_MAX, Math.max(REV_DAMPING_MIN, val))); break;
    }
  }

  /** xySpring/xyMap sitzen als eigene Felder neben den FX-Params (nicht IN
   *  this.params gemischt -- das würde #syncUI()s knob.dataset.p-Lookup
   *  zwar nicht kaputt machen, aber this.params bliebe kein reiner
   *  Parameter-Datensatz mehr). Gleiches Konzept wie Machine#xySpring/
   *  #xyMap in project.js, hier nur innerhalb DIESER EINEN serialize()/
   *  deserialize()-Methode statt als Geschwisterfeld im Projekt-Schema --
   *  project.js selbst bleibt unverändert (masterFX.serialize() liefert
   *  bereits das komplette fx-Objekt). */
  serialize() { return { ...this.params, xySpring: this.xySpring, xyMap: this.xyMap }; }

  deserialize(state) {
    if (!state) return;
    const { xySpring, xyMap, ...fxParams } = state;
    this.xySpring = !!xySpring;
    this.xyMap = xyMap ?? null;
    Object.assign(this.params, fxParams);
    if (this.delayA) {
      this.#applyDelayTime();
      this.fbA.gain.value = this.params.feedback;
      this.fbB.gain.value = this.params.feedback;
      this.filterA.frequency.value = this.params.tone;
      this.filterB.frequency.value = this.params.tone;
      this.delayOut.gain.value = this.params.delayLevel;
      this.revOut.gain.value = this.params.revLevel;
      // Geklemmt statt direkt übernommen -- ein VOR diesem Umbau gespeichertes
      // Projekt kennt revDecay/revDamp noch in der alten Bedeutung (Sekunden/
      // 0..1) und könnte sonst weit ausserhalb der für den Dattorro-Tank
      // sicheren Bereiche landen (s. REV_DECAY_MAX/REV_DAMPING_* oben).
      this.reverbInsert.setParam('size', this.params.revSize);
      this.reverbInsert.setParam('decay', Math.min(REV_DECAY_MAX, Math.max(0, this.params.revDecay)));
      this.reverbInsert.setParam('damping', Math.min(REV_DAMPING_MAX, Math.max(REV_DAMPING_MIN, this.params.revDamp)));
    }
    this.#syncUI();
  }

  /* ---------- Panel (fester Slot am Rack-Ende) ---------- */
  render() {
    const el = document.createElement('section');
    el.className = 'machine machine--master';
    el.id = 'master-fx';
    const color = '#d8c9a3';
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
    el.style.setProperty('--m-color', color);
    el.style.setProperty('--m-color-dim', `rgba(${r},${g},${b},.22)`);
    el.style.setProperty('--m-color-glow', `rgba(${r},${g},${b},.45)`);
    el.style.setProperty('--m-color-tint', `rgba(${r},${g},${b},.08)`);
    el.innerHTML = `
      <header class="machine__head">
        <span class="machine__stripe"></span>
        <div>
          <div class="machine__name">Master FX</div>
          <div class="machine__type">RW-MX · delay + reverb</div>
        </div>
        <x-meter class="fx__meter" aria-label="Master level"></x-meter>
      </header>
      <div class="machine__body">
        <div class="machine__row fx__row">
          <div class="seg">
            <span class="seg__label">Delay</span>
            ${DIVISIONS.map((d) =>
              `<button class="seg__btn" data-div="${d.steps}">${d.label}</button>`).join('')}
          </div>
          <x-knob label="Feedb." min="0" max="0.85" value="0.45" data-p="feedback"></x-knob>
          <x-knob label="Tone" min="500" max="12000" value="4500" curve="log" unit="Hz" data-p="tone"></x-knob>
          <x-knob label="Level" min="0" max="1" value="0.5" data-p="delayLevel"></x-knob>
          <x-knob label="Swing" min="50" max="75" value="50" unit="%" data-p="swing"></x-knob>
        </div>
        <div class="machine__row fx__row">
          <span class="seg__label fx__revlabel">Reverb</span>
          <x-knob label="Size" min="0.3" max="3" value="1.0" curve="log" data-p="revSize"></x-knob>
          <x-knob label="Decay" min="0" max="0.4" value="0.3" data-p="revDecay"></x-knob>
          <x-knob label="Damp." min="500" max="15000" value="6000" curve="log" unit="Hz" data-p="revDamp"></x-knob>
          <x-knob label="Level" min="0" max="1" value="0.4" data-p="revLevel"></x-knob>
        </div>
        <div class="machine__row machine__row--inserts">
          <div class="inserts" data-inserts></div>
          <button type="button" class="rack__add inserts__add" data-add-insert>+  Add Effect</button>
        </div>
      </div>
    `;

    el.addEventListener('input', (e) => {
      const key = e.target.dataset?.p;
      if (key) this.setParam(key, e.detail.value);
    });
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-div]');
      if (!btn) return;
      this.setParam('delaySteps', Number(btn.dataset.div));
      this.#syncUI();
    });
    el.querySelector('[data-add-insert]').addEventListener('click', () => {
      openInsertPicker((type) => {
        this.addInsert(type);
      });
    });

    this.el = el;
    this.insertsListEl = el.querySelector('[data-inserts]');
    this.#renderInserts();
    this.#syncUI();
    this.#startVU();
    return el;
  }

  /* ---------- Pegelanzeige (dBFS-Skala + Peak-Hold + Clip-Latch, am
   * Limiter-Ausgang, s. audio-engine.js#analyser) ---------- */
  #vuBuf;

  #startVU() {
    const analyser = engine.analyser;
    const meterEl = this.el?.querySelector('x-meter');
    if (!analyser || !meterEl || typeof analyser.getFloatTimeDomainData !== 'function') return;
    this.#vuBuf = new Float32Array(analyser.fftSize);

    const tick = () => {
      const { rmsDb, peakDb } = computeLevels(analyser, this.#vuBuf);
      meterEl.update(rmsDb, peakDb);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /** Regler und Notenwert-Buttons auf this.params stellen. */
  #syncUI() {
    if (!this.el) return;
    for (const knob of this.el.querySelectorAll('x-knob[data-p]')) {
      const v = this.params[knob.dataset.p];
      if (v !== undefined) knob.value = v;
    }
    for (const btn of this.el.querySelectorAll('[data-div]')) {
      btn.classList.toggle('is-active',
        Number(btn.dataset.div) === this.params.delaySteps);
    }
  }
}

/** App-weites Singleton */
export const masterFX = new MasterFX();
