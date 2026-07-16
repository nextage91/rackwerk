/**
 * Transport — der Takt-Motor der App.
 *
 * Nutzt das bewährte Lookahead-Pattern für Web Audio:
 * Ein setInterval-Timer (ungenau) plant Events ein Stück in die Zukunft
 * auf der sample-genauen AudioContext-Uhr. So bleibt das Timing stabil,
 * auch wenn der JS-Main-Thread kurz hakt — wichtig auf Mobilgeräten.
 *
 * Maschinen registrieren sich als Listener und bekommen pro 16tel-Step:
 *   onStep(stepIndex, audioTime)  → hier planen sie ihre Noten ein.
 */
import { engine } from './audio-engine.js';

const LOOKAHEAD_MS = 25;     // wie oft der Planer aufwacht
const SCHEDULE_AHEAD = 0.1;  // wie weit (s) im Voraus geplant wird
const STEPS_PER_BAR = 16;    // 16tel-Raster, wie in klassischen Grooveboxen

class Transport {
  constructor() {
    this.bpm = 120;
    this.isPlaying = false;

    this.#step = 0;
    this.#nextStepTime = 0;
    this.#timerId = null;

    /** @type {Set<{onStep?:Function,onTransport?:Function}>} */
    this.listeners = new Set();
  }

  #step;
  #nextStepTime;
  #timerId;

  /** Dauer eines 16tel-Steps in Sekunden. */
  get stepDuration() {
    return 60 / this.bpm / 4;
  }

  setBpm(bpm) {
    this.bpm = Math.min(300, Math.max(40, bpm));
    this.#notify('bpm');
  }

  play() {
    if (this.isPlaying || !engine.ctx) return;
    this.isPlaying = true;
    this.#step = 0;
    // kleiner Vorlauf, damit der erste Step sicher in der Zukunft liegt
    this.#nextStepTime = engine.now + 0.06;
    this.#timerId = setInterval(() => this.#schedule(), LOOKAHEAD_MS);
    this.#notify('play');
  }

  stop() {
    if (!this.isPlaying) return;
    this.isPlaying = false;
    clearInterval(this.#timerId);
    this.#timerId = null;
    this.#notify('stop');
  }

  toggle() {
    this.isPlaying ? this.stop() : this.play();
  }

  /**
   * Plant alle Steps ein, die ins Lookahead-Fenster fallen.
   * Der Step-Zähler läuft absolut (0, 1, 2, …) — jede Maschine loopt ihr
   * Pattern selbst via `step % patternLänge`. So können Maschinen
   * unterschiedliche Pattern-Längen fahren (1–8 Takte, polymetrisch).
   */
  #schedule() {
    while (this.#nextStepTime < engine.now + SCHEDULE_AHEAD) {
      for (const l of this.listeners) {
        l.onStep?.(this.#step, this.#nextStepTime);
      }
      this.#nextStepTime += this.stepDuration;
      this.#step = this.#step + 1;
    }
  }

  /**
   * Position 0..1 über einen Loop von `bars` Takten — Grundlage der
   * Automation. Rechnet aus dem absoluten Step-Zähler auf der Audio-Uhr
   * (konsistent auch nach einem Jam-Sync-Sprung, und für Lanes, die
   * mehrere Takte lang sind).
   */
  phaseOver(bars = 1) {
    if (!this.isPlaying) return 0;
    const total = STEPS_PER_BAR * bars;
    const stepFloat = this.#step - (this.#nextStepTime - engine.now) / this.stepDuration;
    return (((stepFloat % total) + total) % total) / total;
  }

  /** Aktuelle Position im 1-Takt-Loop (0..1). */
  get phase() { return this.phaseOver(1); }

  /** Position als "Takt.Viertel" fürs LCD (grob, UI-Zwecke). */
  get positionLabel() {
    const bar = Math.floor(this.#step / STEPS_PER_BAR) + 1;
    const beat = Math.floor((this.#step % STEPS_PER_BAR) / 4) + 1;
    return `${bar}.${beat}`;
  }

  /* ---------- Jam-Sync: Snapshot liefern & sich einem Master anpassen ---------- */

  /** Anker für die Clock-Übertragung: nächster Step + seine Audio-Zeit. */
  syncSnapshot() {
    return {
      bpm: this.bpm,
      playing: this.isPlaying,
      step: this.#step,
      audioTime: this.#nextStepTime,
    };
  }

  /**
   * Dem Master folgen. `audioTime` ist bereits in UNSERE Audio-Uhr
   * umgerechnet. Kleine Abweichungen werden mit max. ±6 ms pro Update
   * nachgezogen (unhörbar); ist der Versatz größer als ein Step,
   * wird hart neu aufgesetzt.
   */
  syncTo({ bpm, playing, step, audioTime }) {
    if (Math.abs(bpm - this.bpm) > 0.01) this.setBpm(bpm);

    if (!playing) {
      if (this.isPlaying) this.stop();
      return;
    }

    const d = this.stepDuration;
    // Anker sicher in die Zukunft schieben
    const minTime = engine.now + 0.05;
    if (audioTime < minTime) {
      const n = Math.ceil((minTime - audioTime) / d);
      step += n;
      audioTime += n * d;
    }

    if (!this.isPlaying) {
      this.isPlaying = true;
      this.#step = step;
      this.#nextStepTime = audioTime;
      this.#timerId = setInterval(() => this.#schedule(), LOOKAHEAD_MS);
      this.#notify('play');
      return;
    }

    const expected = this.#nextStepTime + (step - this.#step) * d;
    const drift = audioTime - expected;
    if (Math.abs(drift) > d) {
      this.#step = step;                    // komplett daneben → hart setzen
      this.#nextStepTime = audioTime;
    } else if (Math.abs(drift) > 0.002) {
      this.#nextStepTime += Math.max(-0.006, Math.min(0.006, drift));
    }
  }

  addListener(l) { this.listeners.add(l); }
  removeListener(l) { this.listeners.delete(l); }

  #notify(event) {
    for (const l of this.listeners) l.onTransport?.(event, this);
  }
}

export const transport = new Transport();
export { STEPS_PER_BAR };
