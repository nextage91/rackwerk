/**
 * masterFX — Delay + Reverb als Send-Effekte auf dem Master.
 *
 * Signalfluss (Post-Fader-Sends, Mute/Solo nimmt die Sends mit):
 *   machine.gate ─(sendDelay)──▶ engine.delayBus  ─▶ Delay-Kette ─▶ masterBus
 *               └─(sendReverb)─▶ engine.reverbBus ─▶ Convolver   ─▶ masterBus
 *
 * Entscheidungen:
 * - Delay ist tempo-synchron (Notenwerte statt Millisekunden). Die Zeit
 *   folgt BPM-Änderungen automatisch — auch im Jam, wo der Host das Tempo
 *   stellt. Der Wechsel läuft über setTargetAtTime: kurzes „Tape-Wobbeln"
 *   statt Knacksen.
 * - Reverb per Faltung mit einem zur Laufzeit erzeugten Impuls (Null-Assets-
 *   Prinzip): deterministisches Pseudo-Rauschen (xorshift, feste Seeds pro
 *   Kanal → stereo, aber reproduzierbar) mit exponentiellem Ausklang;
 *   Dämpfung als One-Pole-Tiefpass direkt im Impuls. Der Impuls wird auf
 *   konstante Energie normiert, damit der Level-Regler bei jeder Größe
 *   vergleichbar laut ist. Neu rechnen ist teuer → entprellt (180 ms).
 */
import { engine } from './audio-engine.js';
import { transport } from './transport.js';

/** Delay-Notenwerte: Anzahl 16tel-Steps ↔ Beschriftung. */
const DIVISIONS = [
  { steps: 1, label: '1/16' },
  { steps: 2, label: '1/8' },
  { steps: 3, label: '1/8·' },
  { steps: 4, label: '1/4' },
  { steps: 8, label: '1/2' },
];

class MasterFX {
  constructor() {
    this.params = {
      delaySteps: 3,     // 16tel-Steps → 1/8 punktiert (klassisches Dub-Delay)
      feedback: 0.45,
      tone: 4500,        // Hz — Tiefpass in der Feedback-Schleife
      delayLevel: 0.5,
      revDecay: 1.8,     // s — Länge des Impulses
      revDamp: 0.5,      // 0..1 — Höhendämpfung im Impuls
      revLevel: 0.4,
    };
    this.el = null;
    this.#irTimer = null;
  }

  #irTimer;

  /** Nach engine.unlock() aufrufen — baut die Effekt-Ketten an die Busse. */
  init() {
    const ctx = engine.ctx;
    if (!ctx || this.delay) return;

    // Delay: Bus → Delay → Ton-Filter → (Feedback zurück | Level → Master)
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
    this.delayOut.connect(engine.masterBus);

    // Reverb: Bus → Convolver → Level → Master
    this.convolver = ctx.createConvolver();
    this.revOut = ctx.createGain();
    this.revOut.gain.value = this.params.revLevel;
    engine.reverbBus.connect(this.convolver);
    this.convolver.connect(this.revOut);
    this.revOut.connect(engine.masterBus);

    this.#applyDelayTime();
    this.#buildIR();

    // Delay-Zeit folgt dem Tempo (auch bei BPM vom Jam-Host)
    transport.addListener({
      onTransport: (ev) => { if (ev === 'bpm') this.#applyDelayTime(); },
    });
  }

  #applyDelayTime() {
    if (!this.delay) return;
    const t = transport.stepDuration * this.params.delaySteps;
    this.delay.delayTime.setTargetAtTime(Math.min(4, t), engine.now, 0.03);
  }

  /** Impulsantwort neu erzeugen (deterministisch, energie-normiert). */
  #buildIR() {
    const ctx = engine.ctx;
    if (!ctx) return;
    const sr = ctx.sampleRate;
    const len = Math.max(sr / 10, Math.floor(sr * this.params.revDecay));
    const buf = ctx.createBuffer(2, len, sr);

    // Dämpfung 0..1 → One-Pole-Koeffizient (höher = dunkler)
    const a = 0.05 + this.params.revDamp * 0.85;
    let energy = 0;

    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      let seed = ch === 0 ? 0x9e3779b9 : 0x71c67a3d; // feste Seeds → stereo, reproduzierbar
      let lp = 0;
      for (let i = 0; i < len; i++) {
        // xorshift32 → Rauschen in [-1, 1)
        seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
        const noise = ((seed >>> 0) / 0x80000000) - 1;
        lp += (noise - lp) * (1 - a);
        const env = Math.pow(10, (-3 * i) / len); // −60 dB am Ende
        const v = lp * env;
        data[i] = v;
        energy += v * v;
      }
    }

    // Energie normieren: Level-Regler klingt bei jeder Raumgröße gleich laut
    const scale = 2.4 / Math.sqrt(Math.max(1e-9, energy));
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) data[i] *= scale;
    }
    this.convolver.buffer = buf;
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
      case 'revDecay':
      case 'revDamp':
        // Impuls neu rechnen ist teuer → erst wenn der Regler kurz ruht
        clearTimeout(this.#irTimer);
        this.#irTimer = setTimeout(() => this.#buildIR(), 180);
        break;
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
      this.#buildIR();
    }
    this.#syncUI();
  }

  /* ---------- Panel (fester Slot am Rack-Ende) ---------- */
  render() {
    const el = document.createElement('section');
    el.className = 'machine machine--master';
    el.id = 'master-fx';
    const color = '#8fd3ff';
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
    el.style.setProperty('--m-color', color);
    el.style.setProperty('--m-color-dim', `rgba(${r},${g},${b},.22)`);
    el.style.setProperty('--m-color-glow', `rgba(${r},${g},${b},.45)`);
    el.style.setProperty('--m-color-tint', `rgba(${r},${g},${b},.05)`);
    el.innerHTML = `
      <header class="machine__head">
        <span class="machine__stripe"></span>
        <div>
          <div class="machine__name">Master FX</div>
          <div class="machine__type">RW-MX · delay + reverb</div>
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
          <x-knob label="Ton" min="500" max="12000" value="4500" curve="log" unit="Hz" data-p="tone"></x-knob>
          <x-knob label="Level" min="0" max="1" value="0.5" data-p="delayLevel"></x-knob>
        </div>
        <div class="machine__row fx__row">
          <span class="seg__label fx__revlabel">Reverb</span>
          <x-knob label="Größe" min="0.3" max="6" value="1.8" curve="log" unit="s" data-p="revDecay"></x-knob>
          <x-knob label="Dämpf." min="0" max="1" value="0.5" data-p="revDamp"></x-knob>
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
    return el;
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
