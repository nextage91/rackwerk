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
import { createInsert } from './inserts.js';

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
  }

  /** Auf Werkseinstellung zurück (für „Neue Session"). */
  reset() {
    this.deserialize({ ...FX_DEFAULTS });
  }

  #audible;

  /** Nach engine.unlock() aufrufen — baut die Effekt-Ketten an die Busse. */
  init() {
    const ctx = engine.ctx;
    if (!ctx || this.delay) return;

    // Gemeinsame Rückführung beider Effekte — schließt bei "niemand hörbar"
    // (s. Kommentar oben), sonst identisch zu einer direkten Verbindung.
    this.returnGate = ctx.createGain();
    this.returnGate.connect(engine.masterBus);

    this.#buildDelayChain(ctx);
    this.#buildReverbChain(ctx);

    // Delay-Zeit folgt dem Tempo (auch bei BPM vom Jam-Host) — einmalig
    // registriert, überlebt spätere flushTails()-Neuaufbauten unverändert
    // (liest bei jedem Aufruf das JEWEILS aktuelle this.delay).
    transport.addListener({
      onTransport: (ev) => { if (ev === 'bpm') this.#applyDelayTime(); },
    });
  }

  /** Delay: Bus → Delay → Ton-Filter → (Feedback zurück | Level → Return) */
  #buildDelayChain(ctx) {
    this.delay = ctx.createDelay(4); // reicht bis 1/2 bei 40 BPM (3 s)
    this.toneFilter = ctx.createBiquadFilter();
    this.toneFilter.type = 'lowpass';
    this.toneFilter.frequency.value = this.params.tone;
    this.fb = ctx.createGain();
    this.fb.gain.value = this.params.feedback;
    this.delayOut = ctx.createGain();
    this.delayOut.gain.value = this.params.delayLevel;

    engine.delayBus.connect(this.delay);
    this.delay.connect(this.toneFilter);
    this.toneFilter.connect(this.fb);
    this.fb.connect(this.delay);
    this.toneFilter.connect(this.delayOut);
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
    if (!this.delay) return; // init() noch nicht gelaufen
    const ctx = engine.ctx;
    clearTimeout(this.#flushTimer);
    this.returnGate.gain.cancelScheduledValues(engine.now);
    this.returnGate.gain.setTargetAtTime(0, engine.now, 0.008);
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      this.delay.disconnect(); this.toneFilter.disconnect();
      this.fb.disconnect(); this.delayOut.disconnect();
      engine.delayBus.disconnect(this.delay);
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

  #applyDelayTime() {
    if (!this.delay) return;
    const t = transport.stepDuration * this.params.delaySteps;
    this.delay.delayTime.setTargetAtTime(Math.min(4, t), engine.now, 0.03);
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
      case 'feedback':   this.fb?.gain.setTargetAtTime(val, t, 0.02); break;
      case 'tone':       this.toneFilter?.frequency.setTargetAtTime(val, t, 0.02); break;
      case 'delayLevel': this.delayOut?.gain.setTargetAtTime(val, t, 0.02); break;
      case 'revLevel':   this.revOut?.gain.setTargetAtTime(val, t, 0.02); break;
      case 'revSize':    this.reverbInsert?.setParam('size', val); break;
      case 'revDecay':   this.reverbInsert?.setParam('decay', Math.min(REV_DECAY_MAX, Math.max(0, val))); break;
      case 'revDamp':    this.reverbInsert?.setParam('damping', Math.min(REV_DAMPING_MAX, Math.max(REV_DAMPING_MIN, val))); break;
    }
  }

  serialize() { return { ...this.params }; }

  deserialize(state) {
    if (!state) return;
    Object.assign(this.params, state);
    if (this.delay) {
      this.#applyDelayTime();
      this.fb.gain.value = this.params.feedback;
      this.toneFilter.frequency.value = this.params.tone;
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
        <div class="vu" data-vu aria-label="Master level">
          ${Array.from({ length: 12 }, () => '<span class="vu__seg"></span>').join('')}
        </div>
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
        </div>
        <div class="machine__row fx__row">
          <span class="seg__label fx__revlabel">Reverb</span>
          <x-knob label="Size" min="0.3" max="3" value="1.0" curve="log" data-p="revSize"></x-knob>
          <x-knob label="Decay" min="0" max="0.4" value="0.3" data-p="revDecay"></x-knob>
          <x-knob label="Damp." min="500" max="15000" value="6000" curve="log" unit="Hz" data-p="revDamp"></x-knob>
          <x-knob label="Level" min="0" max="1" value="0.4" data-p="revLevel"></x-knob>
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

    this.el = el;
    this.#syncUI();
    this.#startVU();
    return el;
  }

  /* ---------- VU-Meter (LED-Kette am Limiter-Ausgang) ---------- */
  #vuBuf;
  #vuLit = -1;

  #startVU() {
    const analyser = engine.analyser;
    const segs = this.el?.querySelectorAll('.vu__seg');
    if (!analyser || !segs?.length || typeof analyser.getFloatTimeDomainData !== 'function') return;
    this.#vuBuf = new Float32Array(analyser.fftSize);

    const FLOOR_DB = -45; // Anzeigebereich: −45 dB … 0 dB
    const tick = () => {
      analyser.getFloatTimeDomainData(this.#vuBuf);
      let sum = 0;
      for (let i = 0; i < this.#vuBuf.length; i++) sum += this.#vuBuf[i] ** 2;
      const rms = Math.sqrt(sum / this.#vuBuf.length);
      const db = 20 * Math.log10(Math.max(1e-6, rms));
      const lit = Math.round(((Math.max(FLOOR_DB, Math.min(0, db)) - FLOOR_DB) / -FLOOR_DB) * segs.length);

      if (lit !== this.#vuLit) { // DOM nur anfassen, wenn sich etwas ändert
        segs.forEach((s, i) => s.classList.toggle('is-lit', i < lit));
        this.#vuLit = lit;
      }
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
