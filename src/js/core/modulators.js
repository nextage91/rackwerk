/**
 * modulators.js — die Modulations-Kette: LFO und Arpeggiator.
 *
 * Anders als die Insert-Kette (inserts.js, verändert das Audiosignal) sitzt
 * diese Kette VOR den maschinen-eigenen Reglern (s. machine.js#render()) und
 * steuert stattdessen PARAMETER (LFO) oder NOTEN (Arpeggiator) -- deshalb
 * ein eigenes, kleineres Geschwistermodul statt eine Erweiterung von
 * inserts.js. Ein Modulator braucht (anders als ein Insert) Zugriff auf
 * seine Maschine (`owner`), nicht nur auf den AudioContext:
 *   - LFO schreibt über automation.js auf einen der automatisierbaren
 *     Knobs der Maschine (owner.laneKeyPrefix + Zielname).
 *   - Arpeggiator ruft owner.noteOn(midi)/owner.noteOff(midi) direkt auf --
 *     dieselben Methoden, die sonst das Keybed aufruft (s. subsynth.js/
 *     polysynth.js/fmsynth.js, die bei aktivem Arp ihr Keybed stattdessen
 *     hierher umleiten).
 *
 * createModulator(type, saved, owner) baut EIN Objekt, das Daten (params,
 * bypassed, serialize) UND Verhalten (Ticker/Notenlogik) vereint -- gleiches
 * Muster wie inserts.js#createInsert, nur mit `owner` statt `ctx`.
 */
import { engine } from './audio-engine.js';
import { transport } from './transport.js';
import { automation } from './automation.js';

const TICK_MS = 30;

/** Wie lange der LFO nach einer erkannten Handbedienung (s. tick() unten)
 *  stumm bleibt, bevor er den Regler wieder übernimmt -- lang genug, dass
 *  eine laufende Zieh-Geste (Panel-Knob, Jam-Fader, Makro-Knob, X/Y-Pad --
 *  s. Dateikopf/Chat) nicht zwischen zwei Fremdänderungen schon wieder
 *  überschrieben wird, kurz genug, dass der LFO nach dem Loslassen zügig
 *  weiterläuft statt spürbar "auszusetzen". */
const LFO_HAND_OVERRIDE_MS = 250;

/** Modulierte Waveforms (0..1, unipolar -- LFO-Tiefe skaliert davon
 *  ausgehend den tatsächlich bestrichenen Reglerbereich, s. paramValueAt). */
function waveValue(wave, phase, sh) {
  if (wave === 'triangle') return phase < 0.5 ? phase * 2 : (1 - phase) * 2;
  if (wave === 'square') return phase < 0.5 ? 0 : 1;
  if (wave === 'random') return sh.value;
  return (1 - Math.cos(phase * Math.PI * 2)) / 2; // sine
}

/** Reglerwert für einen 0..1-Fortschritt -- respektiert die log-Kurve
 *  mancher Knobs (Cutoff, Zeiten, …) genau wie automation.js' Trim-Modus
 *  (s. dort, gleiche Idee: curve="log" heisst multiplikativ statt additiv
 *  interpolieren, sonst verbringt eine LFO-Fahrt fast ihre ganze Zeit im
 *  oberen Bereich eines log-Reglers). */
function paramValueAt(knob, t01) {
  const lo = Number(knob.min), hi = Number(knob.max);
  if (knob.getAttribute('curve') === 'log' && lo > 0) return lo * (hi / lo) ** t01;
  return lo + t01 * (hi - lo);
}

export const LFO_WAVES = [
  { value: 'sine', label: 'Sine' },
  { value: 'triangle', label: 'Triangle' },
  { value: 'square', label: 'Square' },
  { value: 'random', label: 'Random' },
];

/** Tempo-Sync-Buttons für den LFO -- 'free' schaltet auf den Rate-Knob
 *  (Hz) um, alle anderen Werte sind Takt-Bruchteile/-Vielfache und werden
 *  direkt an transport.phaseOver() durchgereicht (0..1 Phase pro Zyklus,
 *  braucht anders als der Filter Delay keine Sekunden-Umrechnung). Reicht
 *  bewusst von schnell (Vibrato-Tempo) bis langsam (mehrtaktige Sweeps) --
 *  ein LFO wird typischerweise langsamer eingesetzt als ein Delay. */
export const LFO_SYNC_BUTTONS = [
  { value: 'free', label: 'Free' },
  { value: '0.0625', label: '1/16' },
  { value: '0.125', label: '1/8' },
  { value: '0.25', label: '1/4' },
  { value: '0.5', label: '1/2' },
  { value: '1', label: '1 Bar' },
  { value: '2', label: '2 Bars' },
  { value: '4', label: '4 Bars' },
  { value: '8', label: '8 Bars' },
];

export const ARP_MODES = [
  { value: 'up', label: 'Up' },
  { value: 'down', label: 'Down' },
  { value: 'updown', label: 'Up-Down' },
  { value: 'random', label: 'Random' },
];

/** Tempo-Sync-Buttons des Arpeggiators, bewusst OHNE 'free': ein Arp ohne
 *  Songtempo-Bezug ergibt musikalisch keinen Sinn (anders als ein LFO, der
 *  auch als freie Hz-Modulation Sinn ergibt, z. B. Vibrato unabhängig vom
 *  Sequencer-Tempo). Nur glatte 16tel-Vielfache (kein Triolen-/Punktierungs-
 *  Angebot wie beim Filter Delay) -- der Arp feuert exakt auf den globalen
 *  16tel-Schritten des Transports (s. ARP_DIVISION_STEPS/build() unten),
 *  damit gehaltene Noten bei aktiver Live-Aufnahme sauber aufs Pattern-
 *  Raster treffen; Triolen liessen sich auf diesem 16tel-Raster gar nicht
 *  exakt abbilden. */
export const ARP_SYNC_BUTTONS = [
  { value: '1/16', label: '1/16' },
  { value: '1/8', label: '1/8' },
  { value: '1/4', label: '1/4' },
  { value: '1/2', label: '1/2' },
  { value: '1', label: '1 Bar' },
];

/** Notenwert -> Anzahl 16tel-Schritte (STEPS_PER_BAR=16 pro Takt, s.
 *  transport.js). Rein lokal (anders als beim Filter Delay keine
 *  Sekunden-Umrechnung nötig): der Arp vergleicht direkt gegen
 *  transport.currentStep, s. build() unten. */
const ARP_DIVISION_STEPS = { '1/16': 1, '1/8': 2, '1/4': 4, '1/2': 8, '1': 16 };

const MOD_DEFS = {
  lfo: {
    name: 'LFO',
    defaults: { target: '', wave: 'sine', division: '1', rateHz: 2, depth: 1, offset: 0 },
    build(owner, p) {
      let timer = null;
      let phaseAcc = 0;
      let lastT = engine.now;
      let lastPhase = 0;
      const sh = { value: Math.random() };
      let trackedTarget = p.target;
      let bypassedFlag = false;

      // Erkennt Handbedienung DESSELBEN Reglers, den der LFO gerade steuert
      // -- egal auf welchem Weg (echter Panel-Knob, Jam-Fader, Makro-Knob,
      // X/Y-Pad: alle landen am Ende auf demselben target.knob, s. Chat-
      // Bugreport "Fader in der Jam-Ansicht hat keinen Effekt mehr, sobald
      // Volume vom LFO moduliert wird"). automation.js kennt "Hand schlägt
      // Automation" bereits für aufgenommene Lanes (s. dortiges #tick()),
      // aber der LFO lief bisher komplett unabhängig davon einfach weiter
      // und schrieb jeden Tick unbedingt über jede Handbewegung drüber --
      // hier derselbe Vorrang, nur wertbasiert erkannt statt über eigene
      // grab/release-Events (die der Jam-Fader/die Makro-Knobs gar nicht
      // feuern, s. dort). lastKey/lastAppliedValue werden zurückgesetzt,
      // sobald sich das aufgelöste Lane-Ziel ändert -- über den SCHLÜSSEL,
      // nicht über target.knob: pro-Sound-Ziele (Sampler/Drum-Machine-Pads)
      // teilen sich alle denselben physischen Knob (nur das gerade
      // gewählte Pad wird angezeigt), zwei verschiedene Pad-Ziele könnten
      // also identisches target.knob haben und der alte Vergleich hätte
      // beim Umschalten zwischen ihnen fälschlich NICHT zurückgesetzt.
      let lastKey = null;
      let lastAppliedValue = null;
      let handOverrideUntil = 0;

      const muteKey = (target) => (target ? `${owner.laneKeyPrefix}:${target}` : null);
      const setMute = (target, active) => {
        const k = muteKey(target);
        if (k) automation.setLfoActive(k, active);
      };

      const tick = () => {
        const k = muteKey(p.target);
        if (!k) return;
        const target = automation.getTarget(k);
        if (!target) return;

        if (k !== lastKey) {
          lastKey = k;
          lastAppliedValue = null;
          handOverrideUntil = 0;
        }

        let phase;
        if (p.division === 'free') {
          const now = engine.now;
          phaseAcc = (phaseAcc + (now - lastT) * p.rateHz) % 1;
          lastT = now;
          phase = phaseAcc;
        } else {
          phase = transport.phaseOver(Number(p.division));
        }
        if (p.wave === 'random' && phase < lastPhase) sh.value = Math.random();
        lastPhase = phase;

        // Depth verkleinert den Ausschlag, ist dabei aber IMMER am unteren
        // Reglerende verankert (Ausschlag reicht von 0 bis depth, s.
        // waveValue()-Kommentar oben) -- verkleinert man depth, wandert die
        // Modulation also nicht "in die Mitte", sondern bleibt am unteren
        // Ende hängen. Offset schiebt genau diesen (ggf. verkleinerten)
        // Bereich zusätzlich additiv nach oben -- Depth bestimmt die
        // GRÖSSE des bestrichenen Bereichs, Offset dessen LAGE (s. Chat:
        // "verkleinerten Bereich verschieben"). Bewusst additiv+clamp statt
        // z. B. eine bipolare Zentrierung um Offset: bleibt bei offset=0
        // exakt das alte Verhalten (Default, rückwärtskompatibel zu vor
        // diesem Feature gespeicherten LFOs).
        const t01raw = Math.min(1, Math.max(0, p.offset)) +
          waveValue(p.wave, phase, sh) * Math.min(1, Math.max(0, p.depth));
        const applied = paramValueAt(target.knob, Math.min(1, Math.max(0, t01raw)));

        // Hat sich der Regler seit unserem letzten Schreiben verändert, OHNE
        // dass wir es waren -> gerade in Handbedienung, Gnadenfrist neu
        // anstossen (s. LFO_HAND_OVERRIDE_MS oben). Bewusst ein Werte-
        // Vergleich statt eigener grab/release-Events: so greift der
        // Vorrang auf JEDEM Weg, der am Ende denselben Knob schreibt, ganz
        // ohne dass Jam-Fader/Makro-Knobs/X/Y-Pad extra etwas melden müssen.
        // Ziele mit skipHandOverride (s. automation.js#register, aktuell nur
        // "Volume") schreiben gar nicht auf knob.value -- der Vergleich
        // würde dort nie zutreffen und den LFO fälschlich für immer stumm
        // halten, deshalb hier übersprungen (dort gibt's ohnehin keine
        // Konkurrenz ums selbe Ziel mehr, die einen Vorrang bräuchte). Über
        // target.getValue() statt target.knob.value gelesen: pro-Sound-Ziele
        // (Sampler/Drum-Machine-Pads) teilen sich einen Knob, der nur das
        // gerade GEWÄHLTE Pad anzeigt -- getValue() liest stattdessen immer
        // den echten Wert DIESES Ziels, egal welches Pad im UI offen ist.
        if (!target.skipHandOverride) {
          const now = engine.now;
          const liveValue = target.getValue?.() ?? target.knob.value;
          if (lastAppliedValue != null && Math.abs(liveValue - lastAppliedValue) > 1e-6) {
            handOverrideUntil = now + LFO_HAND_OVERRIDE_MS / 1000;
          }
          if (now < handOverrideUntil) {
            lastAppliedValue = liveValue;
            return;
          }
        }
        target.apply(applied);
        lastAppliedValue = applied;
      };

      return {
        onParam(key) {
          if (key === 'target') {
            setMute(trackedTarget, false);
            trackedTarget = p.target;
            if (!bypassedFlag) setMute(trackedTarget, true);
          }
        },
        onBypass(v) {
          bypassedFlag = v;
          if (v) { clearInterval(timer); timer = null; setMute(trackedTarget, false); }
          else { setMute(trackedTarget, true); if (!timer) timer = setInterval(tick, TICK_MS); }
        },
        dispose() {
          clearInterval(timer);
          setMute(trackedTarget, false);
        },
      };
    },
  },

  arp: {
    name: 'Arpeggiator',
    defaults: { mode: 'up', octaves: 1, division: '1/16' },
    // Phase-gekoppelt an transport.currentStep statt an einen eigenen, ab
    // Tastendruck frei laufenden Timer -- zwei Gründe: (1) sonst driftet
    // der Arp gegenüber dem Rest des Mixes auseinander, je nachdem wann
    // genau gedrückt wurde; (2) NUR so landen die einzelnen Arp-Töne bei
    // aktiver Live-Aufnahme (REC scharf + Transport läuft, s. machine.js#
    // isLiveRecording) exakt auf dem 16tel-Raster, das owner.noteOn() beim
    // Schreiben ins Pattern verwendet (transport.currentStep) -- eine
    // gehaltene Note lässt sich dadurch als fertig ausgeschriebener
    // Arpeggio ins Pattern aufnehmen, statt nur live hörbar zu sein.
    // Läuft der Transport NICHT (freies Spiel ohne Pattern-Bezug), fällt
    // der Arp auf eine eigene, sofort reagierende Zeitbasis zurück (kein
    // Sequencer-Raster zum Andocken vorhanden).
    build(owner, p) {
      let held = [];
      let pollTimer = null;
      let stepIdx = 0;
      let sounding = null;
      let bypassedFlag = false;
      let lastFiredStep = null; // transport.currentStep, gegen Doppel-Trigger
      let nextFreeFireAt = 0;   // engine.now-Zeitpunkt, nur im Nicht-Playing-Fall

      const divisionSteps = () => ARP_DIVISION_STEPS[p.division] ?? 1;

      const sequence = () => {
        if (!held.length) return [];
        const base = [...held].sort((a, b) => a - b);
        const stack = [];
        for (let o = 0; o < p.octaves; o++) for (const n of base) stack.push(n + o * 12);
        if (p.mode === 'down') return stack.reverse();
        if (p.mode === 'updown' && stack.length > 2) return stack.concat(stack.slice(1, -1).reverse());
        return stack;
      };

      const fire = () => {
        if (sounding != null) { owner.noteOff(sounding); sounding = null; }
        const seq = sequence();
        if (!seq.length) return;
        sounding = p.mode === 'random' ? seq[Math.floor(Math.random() * seq.length)] : seq[stepIdx++ % seq.length];
        owner.noteOn(sounding);
      };

      const poll = () => {
        if (!held.length || bypassedFlag) return;
        if (transport.isPlaying) {
          const step = transport.currentStep;
          const n = divisionSteps();
          if (step % n === 0 && step !== lastFiredStep) {
            lastFiredStep = step;
            fire();
          }
        } else if (engine.now >= nextFreeFireAt) {
          nextFreeFireAt = engine.now + transport.stepDuration * divisionSteps();
          fire();
        }
      };

      // 15ms-Poll fein genug, um kein 16tel bei 300 BPM zu verpassen (kürzester
      // Schritt dort ~50ms) -- schneller als automation.js' 22ms-Ticker, weil
      // hier zusätzlich ein Raster-Treffer (nicht nur ein Wert) nicht verpasst
      // werden darf.
      const start = () => {
        if (pollTimer) return;
        lastFiredStep = null;
        nextFreeFireAt = 0;
        pollTimer = setInterval(poll, 15);
        poll();
      };
      const stop = () => {
        clearInterval(pollTimer);
        pollTimer = null;
        if (sounding != null) { owner.noteOff(sounding); sounding = null; }
        stepIdx = 0;
      };

      return {
        // Vom Keybed der 3 Maschinen mit gehaltenen Stimmen aufgerufen
        // (s. subsynth.js/polysynth.js/fmsynth.js), solange dieser Arp
        // aktiv (nicht bypassed) ist -- ersetzt für diese Noten direkt
        // owner.noteOn/noteOff.
        noteOn(midi) {
          if (!held.includes(midi)) held.push(midi);
          if (!bypassedFlag) start();
        },
        noteOff(midi) {
          held = held.filter((m) => m !== midi);
          if (!held.length) stop();
        },
        onBypass(v) {
          bypassedFlag = v;
          if (v) stop();
          else if (held.length) start();
        },
        dispose() { stop(); },
      };
    },
  },
};

export const MODULATOR_TYPES = Object.keys(MOD_DEFS);

export const MOD_DISPLAY = {
  lfo: { name: 'LFO', badge: 'MOD-LFO' },
  arp: { name: 'Arpeggiator', badge: 'MOD-ARP' },
};

export const MOD_COLORS = {
  lfo: '#c98fe0',
  arp: '#e0a24a',
};

let nextModId = 1;

/**
 * Baut einen Modulator. `saved` (optional) = { id, params, bypassed } aus
 * einem gespeicherten Projekt. `owner` ist die Maschine, auf der er sitzt
 * (Automations-Präfix bzw. Noten-Ziel, s. Dateikopf-Kommentar).
 */
export function createModulator(type, saved, owner) {
  const def = MOD_DEFS[type];
  if (!def) throw new Error(`Unbekannter Modulator-Typ: ${type}`);
  const params = structuredClone({ ...def.defaults, ...saved?.params });
  const id = saved?.id ?? nextModId++;
  if (saved?.id != null) nextModId = Math.max(nextModId, saved.id + 1);

  const runtime = def.build(owner, params);
  const mod = {
    id,
    type,
    name: def.name,
    params,
    bypassed: saved?.bypassed ?? false,
    setParam(key, v) {
      params[key] = v;
      runtime.onParam?.(key, v);
    },
    setBypass(v) {
      mod.bypassed = v;
      runtime.onBypass?.(v);
    },
    serialize() {
      return { id, type, params: { ...params }, bypassed: mod.bypassed };
    },
    dispose() {
      runtime.dispose?.();
    },
    // Nur vom Arpeggiator belegt -- s. subsynth.js/polysynth.js/fmsynth.js
    noteOn: runtime.noteOn,
    noteOff: runtime.noteOff,
  };
  runtime.onBypass?.(mod.bypassed);
  return mod;
}
