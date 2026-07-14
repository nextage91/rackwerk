/**
 * Automation — Echtzeit-Aufnahme und Loop-Playback von Parameterfahrten.
 *
 * Modell (bewusst einfach, Caustic-artig):
 * - Eine Lane pro Parameter: Float32Array mit 128 Slots über den 1-Takt-Loop
 * - Aufnahme: REC scharf + Transport läuft + Knob angefasst → der aktuelle
 *   Knob-Wert wird fortlaufend an die Playhead-Position geschrieben.
 *   Lücken zwischen zwei Ticks werden aufgefüllt (kein Löcher-Pattern).
 * - Neue Lanes werden komplett mit dem Ausgangswert vorbefüllt, damit der
 *   Rest des Takts definiert ist.
 * - Playback: ~45 Hz-Ticker liest die Lane (linear interpoliert), bewegt den
 *   Knob und feuert dessen input-Event — die Parameter laufen also durch
 *   exakt dieselbe Leitung wie eine Handbewegung. Angefasste Knobs werden
 *   übersprungen (Hand schlägt Automation).
 * - Löschen: bei scharfem REC löscht Doppeltipp auf den Knob dessen Lane.
 *
 * Maschinen melden ihre Knobs über register(); der Schlüssel ist
 * `${machineId}:${paramName}`, unregisterMachine() räumt beim Entfernen auf.
 */
import { transport } from './transport.js';

const RESOLUTION = 128;   // Slots pro Takt
const TICK_MS = 22;       // ~45 Hz UI-/Playback-Rate

class Automation {
  constructor() {
    this.armed = false;
    /** @type {Map<string,{knob:HTMLElement, apply:Function}>} */
    this.targets = new Map();
    /** @type {Map<string,Float32Array>} */
    this.lanes = new Map();
    /** @type {Map<string,{lastIdx:number|null}>} aktuell angefasste Knobs */
    this.grabbed = new Map();
    this.timer = null;

    transport.addListener(this);
  }

  setArmed(armed) {
    this.armed = armed;
  }

  register(key, knob, apply) {
    this.targets.set(key, { knob, apply });

    knob.addEventListener('knob-grab', () => {
      // Ausgangswert sofort festhalten — nicht erst beim nächsten Tick,
      // sonst geht bei schnellen Bewegungen der Referenzwert verloren
      this.grabbed.set(key, { lastIdx: null, startValue: knob.value });
    });
    knob.addEventListener('knob-release', () => {
      this.grabbed.delete(key);
    });
    this.#attachGestures(knob, () => key);
  }

  /**
   * Für Knobs, deren Ziel sich zur Laufzeit ändert (z. B. die Spur-Knobs
   * der BeatBox, die immer auf die gewählte Drum-Spur zeigen):
   * Der Lane-Schlüssel wird erst beim Anfassen über resolveKey() gebildet —
   * so bekommt jede Spur ihre eigenen Fahrten, obwohl alle denselben
   * physischen Knob teilen.
   */
  registerDynamic(knob, resolveKey, applyForKey) {
    knob.addEventListener('knob-grab', () => {
      const key = resolveKey();
      if (!this.targets.has(key)) {
        this.targets.set(key, { knob, apply: (v) => applyForKey(key, v) });
      }
      this.grabbed.set(key, { lastIdx: null, startValue: knob.value });
    });
    knob.addEventListener('knob-release', () => {
      this.grabbed.delete(resolveKey());
    });
    this.#attachGestures(knob, resolveKey);
  }

  /* ---------- Trim-Modus & Löschen (für beide Register-Pfade) ---------- */

  /**
   * Trim: Wird ein Knob mit Automation gedreht, ohne dass gerade
   * aufgenommen wird, verschiebt sich die GANZE Lane relativ mit —
   * die Form der Fahrt bleibt erhalten. Lineare Knobs verschieben
   * additiv, logarithmische (Cutoff, Tune …) multiplikativ, damit
   * die Kurve auch im Log-Bereich ihre Gestalt behält.
   *
   * Long-Press (550 ms still halten) zeigt den Lösch-Button für die
   * Lane des Knobs — unabhängig vom REC-Status.
   */
  #attachGestures(knob, resolveKey) {
    let trim = null;

    knob.addEventListener('knob-grab', () => {
      const key = resolveKey();
      const lane = this.lanes.get(key);
      const recording = this.armed && transport.isPlaying;
      trim = (lane && !recording)
        ? { key, start: knob.value, snapshot: lane.slice(),
            log: knob.getAttribute('curve') === 'log' }
        : null;
    });

    knob.addEventListener('input', () => {
      if (!trim) return;
      const lane = this.lanes.get(trim.key);
      if (!lane) { trim = null; return; }
      const v = knob.value;
      const lo = knob.min, hi = knob.max;
      if (trim.log) {
        const factor = v / trim.start;
        for (let i = 0; i < lane.length; i++) {
          lane[i] = Math.min(hi, Math.max(lo, trim.snapshot[i] * factor));
        }
      } else {
        const delta = v - trim.start;
        for (let i = 0; i < lane.length; i++) {
          lane[i] = Math.min(hi, Math.max(lo, trim.snapshot[i] + delta));
        }
      }
    });

    knob.addEventListener('knob-release', () => { trim = null; });

    knob.addEventListener('knob-longpress', () => {
      this.#offerDelete(resolveKey(), knob);
    });
  }

  #toast = null;

  /** Kurzer Hinweis unten im Bild, sobald eine neue Lane entsteht. */
  #announce(knob) {
    const label = knob.getAttribute('label') ?? 'Parameter';
    this.#toast?.remove();
    const el = document.createElement('div');
    el.className = 'auto-toast';
    el.textContent = `● Automation aufgenommen: ${label}`;
    document.body.appendChild(el);
    this.#toast = el;
    setTimeout(() => {
      el.remove();
      if (this.#toast === el) this.#toast = null;
    }, 1800);
  }

  #chip = null;

  #offerDelete(key, knob) {
    if (!this.lanes.has(key)) return;
    this.#dismissChip();

    const chip = document.createElement('button');
    chip.className = 'auto-chip';
    chip.textContent = '✕ Automation löschen';
    document.body.appendChild(chip);

    // über dem Knob positionieren, am Bildschirmrand einklemmen
    const r = knob.getBoundingClientRect();
    const left = Math.max(8, Math.min(
      window.innerWidth - chip.offsetWidth - 8,
      r.left + r.width / 2 - chip.offsetWidth / 2,
    ));
    chip.style.left = `${left}px`;
    chip.style.top = `${Math.max(8, r.top - 48)}px`;

    chip.addEventListener('click', () => {
      this.clearLane(key);
      this.#dismissChip();
    });

    this.#chip = chip;
    this.#chipDismissTimer = setTimeout(() => this.#dismissChip(), 4000);
    document.addEventListener('pointerdown', this.#onOutside);
  }

  #chipDismissTimer = null;

  #onOutside = (e) => {
    if (this.#chip && !this.#chip.contains(e.target)) this.#dismissChip();
  };

  #dismissChip() {
    clearTimeout(this.#chipDismissTimer);
    document.removeEventListener('pointerdown', this.#onOutside);
    this.#chip?.remove();
    this.#chip = null;
  }

  /** Existiert für diesen Schlüssel eine aufgezeichnete Lane? */
  hasLane(key) {
    return this.lanes.has(key);
  }

  /** Applier vorregistrieren, ohne Events zu binden (z. B. damit geladene
   *  Per-Spur-Lanes sofort abspielen, bevor der Knob je angefasst wurde). */
  ensureTarget(key, knob, apply) {
    if (!this.targets.has(key)) this.targets.set(key, { knob, apply });
  }

  /* ---------- Persistenz ---------- */
  /** Alle Lanes einer Maschine, Schlüssel ohne Maschinen-ID-Prefix. */
  exportLanes(machineId) {
    const prefix = `${machineId}:`;
    const out = {};
    for (const [key, lane] of this.lanes) {
      if (key.startsWith(prefix)) out[key.slice(prefix.length)] = Array.from(lane);
    }
    return out;
  }

  importLanes(machineId, lanes) {
    if (!lanes) return;
    for (const [suffix, values] of Object.entries(lanes)) {
      const key = `${machineId}:${suffix}`;
      this.lanes.set(key, Float32Array.from(values));
      // LED nur für statische (maschinenweite) Knobs direkt setzen —
      // Per-Spur-Knobs aktualisiert die Maschine über onLanesImported()
      if (!suffix.includes(':')) {
        this.targets.get(key)?.knob.classList.add('has-auto');
      }
    }
  }

  unregisterMachine(machineId) {
    this.#dismissChip();
    const prefix = `${machineId}:`;
    for (const key of [...this.targets.keys()]) {
      if (key.startsWith(prefix)) {
        this.targets.delete(key);
        this.lanes.delete(key);
        this.grabbed.delete(key);
      }
    }
  }

  clearLane(key) {
    this.lanes.delete(key);
    this.targets.get(key)?.knob.classList.remove('has-auto');
  }

  /* ---------- Ticker läuft nur bei laufendem Transport ---------- */
  onTransport(event) {
    if (event === 'play' && !this.timer) {
      this.timer = setInterval(() => this.#tick(), TICK_MS);
    }
    if (event === 'stop') {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  #ensureLane(key, baseValue) {
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = new Float32Array(RESOLUTION).fill(baseValue);
      this.lanes.set(key, lane);
      this.targets.get(key)?.knob.classList.add('has-auto');
    }
    return lane;
  }

  #tick() {
    const exact = transport.phase * RESOLUTION;
    const idx = Math.floor(exact) % RESOLUTION;

    // ---- Aufnahme: alle angefassten Knobs bei scharfem REC ----
    if (this.armed) {
      for (const [key, state] of this.grabbed) {
        const target = this.targets.get(key);
        if (!target) continue;
        const value = target.knob.value;

        // Bloßes Antippen darf keine Lane anlegen: Aufnahme startet erst,
        // wenn sich der Wert gegenüber dem Anfassen wirklich geändert hat.
        let lane = this.lanes.get(key);
        if (!lane) {
          if (state.startValue == null) state.startValue = value;
          if (value === state.startValue) { state.lastIdx = idx; continue; }
          lane = this.#ensureLane(key, state.startValue);
          this.#announce(target.knob);
        }

        // vom letzten Schreibpunkt bis heute füllen (wrap-sicher)
        let i = state.lastIdx == null ? idx : (state.lastIdx + 1) % RESOLUTION;
        for (let n = 0; n < RESOLUTION; n++) {
          lane[i] = value;
          if (i === idx) break;
          i = (i + 1) % RESOLUTION;
        }
        state.lastIdx = idx;
      }
    }

    // ---- Playback: interpoliert, angefasste Knobs auslassen ----
    const frac = exact - Math.floor(exact);
    const i1 = (idx + 1) % RESOLUTION;
    for (const [key, lane] of this.lanes) {
      if (this.grabbed.has(key)) continue;
      const target = this.targets.get(key);
      if (!target) continue;
      target.apply(lane[idx] + (lane[i1] - lane[idx]) * frac);
    }
  }
}

export const automation = new Automation();
