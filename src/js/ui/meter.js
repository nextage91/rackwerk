/**
 * <x-meter> — Pegelanzeige mit dBFS-Skala, Peak-Hold und Clip-Latch.
 *
 * Anders als <x-knob>/<x-fader> hat <x-meter> keinen eigenen Wert und
 * pollt nichts selbst -- der Aufrufer bringt seinen eigenen (schon
 * etablierten) rAF-Ticker mit und ruft pro Frame update(rmsDb, peakDb)
 * auf (s. computeLevels() unten für die RMS/Peak-Berechnung aus einem
 * AnalyserNode). Segmentfarben/-tokens identisch zur bisherigen
 * VU-Kette (.vu/.vu__seg) -- LED-Anzahl bewusst fest auf 12 (die
 * Farbstaffelung in CSS ist positionsbasiert, s. dort).
 *
 * Attribute (beim Mount gelesen, nicht live änderbar):
 *  - compact: keine Zahlen-Skala daneben (Maschinen-Kopfzeile/Insert-
 *    Zeile, wenig Platz)
 *  - vertical: LEDs gestapelt statt in einer Reihe (Mixer-Kanalzug, neben
 *    dem vertikalen Fader)
 *
 * Peak-Hold: der lauteste in den letzten PEAK_HOLD_MS gemessene Pegel
 * bleibt als eigenes, helleres Segment stehen und klingt danach linear
 * ab -- klassisches Meter-Verhalten, damit kurze Transienten nicht
 * einfach zwischen zwei Frames verschwinden.
 *
 * Clip-Latch: sobald peakDb >= CLIP_DB, bleibt die separate Clip-LED an,
 * bis man die Anzeige antippt (Standard-Metering-UX, wie an echten
 * Pulten) -- kein Warten auf einen automatischen Reset nötig, gerade
 * WEIL man eine kurze Übersteuerung sonst leicht verpasst.
 *
 * Wichtige Einschränkung: das ist der reale Sample-Peak aus
 * AnalyserNode.getFloatTimeDomainData(), kein True-Peak/Oversampling
 * (das misst z. B. ffmpegs loudnorm-Filter beim Export) -- für
 * Echtzeit-Feedback beim Mischen ist das der richtige Kompromiss, kann
 * aber in Grenzfällen grün stehen, während ein Export-Tool minimal
 * Inter-Sample-Clipping meldet. Dieselbe Einschränkung hat praktisch
 * jedes DAW-Meter ohne dedizierten True-Peak-Modus.
 */
const SEG_COUNT = 12;
const FLOOR_DB = -45;
const CLIP_DB = -0.3;
const PEAK_HOLD_MS = 1200;
const PEAK_DECAY_DB_PER_SEC = 20;

/** RMS + Peak (beide in dBFS) aus einem AnalyserNode -- `buf` ist ein
 *  wiederverwendeter Float32Array(analyser.fftSize), damit der Aufrufer
 *  pro Tick keine neue Allokation macht (gleiche Konvention wie die
 *  bisherigen VU-Meter in main.js/fx.js). */
export function computeLevels(analyser, buf) {
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < buf.length; i++) {
    const s = buf[i];
    sum += s * s;
    const abs = Math.abs(s);
    if (abs > peak) peak = abs;
  }
  const rms = Math.sqrt(sum / buf.length);
  return {
    rmsDb: 20 * Math.log10(Math.max(1e-6, rms)),
    peakDb: 20 * Math.log10(Math.max(1e-6, peak)),
  };
}

export class XMeter extends HTMLElement {
  connectedCallback() {
    if (this.#built) return;
    this.#built = true;

    this.compact = this.hasAttribute('compact');
    this.vertical = this.hasAttribute('vertical');
    this.classList.toggle('is-vertical', this.vertical);
    this.classList.toggle('is-compact', this.compact);

    const segs = Array.from({ length: SEG_COUNT }, () => '<span class="x-meter__seg"></span>').join('');
    this.innerHTML = `
      ${this.compact ? '' : `
      <div class="x-meter__scale">
        <span>0</span><span>−6</span><span>−12</span><span>−24</span><span>−45</span>
      </div>`}
      <div class="x-meter__leds">${segs}<span class="x-meter__clip"></span></div>
    `;
    this.#segs = this.querySelectorAll('.x-meter__seg');
    this.#clipEl = this.querySelector('.x-meter__clip');
    this.title = 'Clip — antippen zum Zurücksetzen';
    this.addEventListener('click', this.#resetClip);
  }

  #built = false;
  #segs = null;
  #clipEl = null;
  #lastLit = -1;
  #lastPeakSeg = -1;
  #peakHold = -Infinity;
  #peakHoldUntil = 0;
  #lastTick = 0;
  #clipped = false;

  #resetClip = () => {
    if (!this.#clipped) return;
    this.#clipped = false;
    this.#clipEl?.classList.remove('is-lit');
  };

  /** Vom Aufrufer aus dessen eigenem Ticker gerufen -- <x-meter> selbst
   *  pollt nichts (s. Dateikopf-Kommentar). */
  update(rmsDb, peakDb) {
    if (!this.#built) return;
    const now = performance.now();
    const dt = this.#lastTick ? now - this.#lastTick : 16;
    this.#lastTick = now;

    if (peakDb >= this.#peakHold) {
      this.#peakHold = peakDb;
      this.#peakHoldUntil = now + PEAK_HOLD_MS;
    } else if (now > this.#peakHoldUntil) {
      this.#peakHold = Math.max(peakDb, this.#peakHold - (PEAK_DECAY_DB_PER_SEC * dt) / 1000);
    }
    if (peakDb >= CLIP_DB) this.#clipped = true;

    const lit = Math.round(((Math.max(FLOOR_DB, Math.min(0, rmsDb)) - FLOOR_DB) / -FLOOR_DB) * SEG_COUNT);
    if (lit !== this.#lastLit) {
      this.#segs.forEach((s, i) => s.classList.toggle('is-lit', i < lit));
      this.#lastLit = lit;
    }

    const peakLit = Math.round(((Math.max(FLOOR_DB, Math.min(0, this.#peakHold)) - FLOOR_DB) / -FLOOR_DB) * SEG_COUNT);
    const peakSeg = Math.min(SEG_COUNT - 1, Math.max(0, peakLit - 1));
    if (peakSeg !== this.#lastPeakSeg) {
      this.#segs.forEach((s, i) => s.classList.toggle('is-peak', i === peakSeg));
      this.#lastPeakSeg = peakSeg;
    }

    this.#clipEl?.classList.toggle('is-lit', this.#clipped);
  }
}

customElements.define('x-meter', XMeter);
