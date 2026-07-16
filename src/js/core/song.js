/**
 * song — freie Timeline-Aufnahme („Song-Modus").
 *
 * Idee: Statt Blöcke von Hand anzuordnen, spielst du den Song LIVE ein.
 * Aufnahme scharf → Play → du schaltest live die Patterns der Maschinen
 * um; jeder Wechsel wird mit seinem absoluten Step mitgeschnitten. Beim
 * Abspielen fährt der Transport von vorn und die aufgezeichneten Wechsel
 * werden zur richtigen Zeit wieder ausgelöst — der Song loopt in seiner
 * Länge.
 *
 * v1 schneidet Pattern-Wechsel mit (das Song-Gerüst). Live-Reglerfahrten
 * und gespielte Noten folgen als nächste Ausbaustufe.
 *
 * Reihenfolge wichtig: song hängt sich VOR den Maschinen als Transport-
 * Listener ein (Konstruktor läuft beim Modul-Laden, vor dem Boot), damit
 * ein Pattern-Wechsel angewandt ist, bevor die Maschinen im selben Step
 * ihr Pattern lesen.
 */
import { transport } from './transport.js';

const STEPS_PER_BAR = 16;

class Song {
  constructor() {
    /** @type {{step:number, m:number, index:number}[]} Events, nach step
     *  sortiert. `m` = Position der Maschine im Rack (stabil über Speichern/
     *  Laden — IDs werden beim Laden neu vergeben, die Reihenfolge nicht). */
    this.events = [];
    this.lengthBars = 0;
    this.recording = false;
    this.playing = false;
    this.rack = null;
    this.onchange = null;    // () => void  — UI neu zeichnen
    this.onplayhead = null;  // (songStep|null) => void

    this.#startStep = 0;
    this.#snapped = false;
    transport.addListener(this);
  }

  #startStep;
  #snapped;

  get lengthSteps() { return this.lengthBars * STEPS_PER_BAR; }
  get empty() { return this.events.length === 0; }

  bind(rack) { this.rack = rack; }

  arm(on) {
    this.recording = on;
    this.#snapped = false;
    this.onchange?.();
  }

  clear() {
    this.events = [];
    this.lengthBars = 0;
    this.#snapped = false;
    this.onchange?.();
  }

  /* ---------- Aufnahme ---------- */
  onTransport(ev) {
    if (ev === 'play' && this.recording && !this.#snapped) this.#snapshotInitial();
    if (ev === 'stop') {
      if (this.playing) { this.playing = false; this.onplayhead?.(null); }
      this.recording = false;   // Aufnahme endet mit dem Transport-Stopp
      this.onchange?.();
    }
  }

  /** Ausgangszustand aller Maschinen als Step-0-Events — so startet und
   *  loopt der Song sauber vom definierten Anfang. */
  #snapshotInitial() {
    this.#snapped = true;
    this.#startStep = transport.currentStep;
    (this.rack?.machines ?? []).forEach((m, idx) => {
      if (m.patternIndex != null) this.#put(0, idx, m.patternIndex);
    });
    this.#growTo(0);
    this.onchange?.();
  }

  /** Live-Pattern-Wechsel mitschneiden (Maschine ruft das beim Umschalten). */
  recordPattern(machineId, index) {
    if (!this.recording || !transport.isPlaying || this.playing) return;
    const m = this.rack?.machines.findIndex((x) => x.id === machineId);
    if (m == null || m < 0) return;
    if (!this.#snapped) this.#snapshotInitial();
    const step = Math.max(0, transport.currentStep - this.#startStep);
    this.#put(step, m, index);
    this.#growTo(step);
    this.onchange?.();
  }

  #put(step, m, index) {
    this.events = this.events.filter((e) => !(e.step === step && e.m === m));
    this.events.push({ step, m, index });
    this.events.sort((a, b) => a.step - b.step || a.m - b.m);
  }
  #growTo(step) {
    this.lengthBars = Math.max(this.lengthBars, Math.ceil((step + 1) / STEPS_PER_BAR));
  }

  /** Song-Länge manuell setzen (Takte), mind. so lang wie das letzte Event. */
  setLengthBars(bars) {
    const last = this.events.reduce((m, e) => Math.max(m, e.step), 0);
    this.lengthBars = Math.max(Math.ceil((last + 1) / STEPS_PER_BAR), Math.max(1, bars));
    this.onchange?.();
  }

  /* ---------- Wiedergabe ---------- */
  play() {
    if (this.empty || !this.rack) return;
    this.recording = false;
    this.playing = true;
    transport.stop();
    transport.play();                       // Start bei Step 0
    this.#startStep = transport.currentStep;
    this.onchange?.();
  }
  stop() {
    this.playing = false;
    transport.stop();
    this.onplayhead?.(null);
    this.onchange?.();
  }

  onStep(step) {
    if (!this.playing || !this.lengthSteps) return;
    const len = this.lengthSteps;
    const songStep = (((step - this.#startStep) % len) + len) % len;
    for (const e of this.events) if (e.step === songStep) this.#apply(e);
    this.onplayhead?.(songStep);
  }

  #apply(e) {
    this.rack?.machines[e.m]?.setPatternIndex?.(e.index);
  }

  /* ---------- Persistenz ---------- */
  serialize() {
    return { lengthBars: this.lengthBars, events: this.events.map((e) => ({ ...e })) };
  }
  deserialize(data) {
    this.events = (data?.events ?? []).map((e) => ({ ...e }));
    this.lengthBars = data?.lengthBars ?? 0;
    this.playing = false;
    this.#snapped = false;
    this.onchange?.();
  }
}

export const song = new Song();
