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
import { createInsert, INSERT_TYPES, insertMeta, UI_PARAMS, EQ_TYPES, FILTER_DELAY_TYPES, RESONATOR_INTERVALS, INSERT_COLORS, RATIO_MODE_BUTTONS } from '../core/inserts.js';
import { masterFX } from '../core/fx.js';
import { undo } from '../core/undo.js';

/** Anzeigename + Typenschild je Insert-Typ fürs Rack-Modul-Faceplate —
 *  getrennt vom kurzen DSP-Namen (insertMeta().name), der bleibt für den
 *  Picker-Sheet-Eintrag ("Compressor") kurz und knapp. */
const INSERT_DISPLAY = {
  comp: { name: '1176-Style Compressor', badge: 'FET-COMP' },
  eq: { name: 'Parametric EQ', badge: 'RACK-EQ' },
  drive: { name: 'Drive / Saturation', badge: 'TUBE-DRIVE' },
  filterDelay: { name: 'Filter Delay', badge: 'FLT-DELAY' },
  reverb: { name: 'Algorithmic Reverb', badge: 'FDN-VERB' },
  resonator: { name: 'Resonator', badge: 'RESO-BANK' },
  eq8: { name: '8-Band EQ', badge: 'EQ8-TOUCH' },
};

/** Dieselbe Farbvarianten-Mathematik wie Machine.render() fürs Faceplate
 *  der äusseren Maschine — hier fürs Insert-Modul, eigene Akzentfarbe je
 *  Effekt-Typ (INSERT_COLORS), damit jedes Modul auf einen Blick als
 *  eigenes Gerät erkennbar ist. */
function insertColorVars(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `--m-color:${hex}; --m-color-dim:rgba(${r},${g},${b},.22); `
    + `--m-color-glow:rgba(${r},${g},${b},.45); --m-color-tint:rgba(${r},${g},${b},.08);`;
}

/** Kleine reaktive Kurve fürs EQ-Modul — keine echte Frequenzantwort-
 *  Berechnung, nur eine plausible Silhouette (Shelf/Peak-Form, Position
 *  nach Frequenz, Auslenkung nach Gain, Breite nach Q), aber sie reagiert
 *  live auf alle vier Parameter statt nur zu dekorieren. */
function eqCurvePath(type, freq, gain, q) {
  const w = 120, h = 36, midY = h / 2;
  const freqNorm = Math.log(freq / 20) / Math.log(20000 / 20);
  const x = Math.max(4, Math.min(w - 4, freqNorm * w));
  const gainNorm = Math.max(-1, Math.min(1, gain / 24));
  const amp = gainNorm * (h / 2 - 5);
  const f1 = (n) => n.toFixed(1);
  if (type === 'lowshelf') {
    const kx = Math.min(w, x + 26);
    return `M0,${f1(midY - amp)} L${f1(x)},${f1(midY - amp)} Q${f1(x + 13)},${f1(midY)} ${f1(kx)},${f1(midY)} L${w},${f1(midY)}`;
  }
  if (type === 'highshelf') {
    const kx = Math.max(0, x - 26);
    return `M0,${f1(midY)} L${f1(kx)},${f1(midY)} Q${f1(x - 13)},${f1(midY)} ${f1(x)},${f1(midY - amp)} L${w},${f1(midY - amp)}`;
  }
  const width = Math.max(6, Math.min(40, 46 / Math.max(0.1, q)));
  const x0 = Math.max(0, x - width), x1 = Math.min(w, x + width);
  return `M0,${f1(midY)} L${f1(x0)},${f1(midY)} Q${f1(x)},${f1(midY - amp)} ${f1(x1)},${f1(midY)} L${w},${f1(midY)}`;
}

/* ---------- 8-Band-EQ: Koordinaten + echte Kurve ----------
 * Anders als eqCurvePath() oben ist das hier keine Silhouette: die X/Y-
 * Umrechnungen sind fest (log-Frequenzachse, lineare dB-Achse) und werden
 * BEIDSEITIG genutzt -- zum Zeichnen der Knoten/Kurve UND zum Zurückrechnen
 * von Zeigerkoordinaten auf Freq/Gain beim Ziehen (s. setupEq8Graph). */
const EQ8_FREQ_MIN = 20, EQ8_FREQ_MAX = 20000;
const EQ8_GAIN_RANGE = 24; // dB, symmetrisch +/- -- wie UI_PARAMS.eq.gain
const EQ8_Q_MIN = 0.1, EQ8_Q_MAX = 10; // wie UI_PARAMS.eq.q
const EQ8_W = 300, EQ8_H = 150, EQ8_MIDY = EQ8_H / 2;

function eq8FreqToX(freq) {
  const n = Math.log(freq / EQ8_FREQ_MIN) / Math.log(EQ8_FREQ_MAX / EQ8_FREQ_MIN);
  return Math.max(0, Math.min(EQ8_W, n * EQ8_W));
}
function eq8XToFreq(x) {
  const n = Math.max(0, Math.min(1, x / EQ8_W));
  return EQ8_FREQ_MIN * (EQ8_FREQ_MAX / EQ8_FREQ_MIN) ** n;
}
function eq8GainToY(gain) {
  const n = Math.max(-EQ8_GAIN_RANGE, Math.min(EQ8_GAIN_RANGE, gain)) / EQ8_GAIN_RANGE;
  return EQ8_MIDY - n * (EQ8_MIDY - 8);
}
function eq8YToGain(y) {
  const n = (EQ8_MIDY - y) / (EQ8_MIDY - 8);
  return Math.max(-EQ8_GAIN_RANGE, Math.min(EQ8_GAIN_RANGE, n * EQ8_GAIN_RANGE));
}

/** Skalen-Hilfslinien wie bei Ableton EQ8/FabFilter Pro-Q: viele feine,
 *  unbeschriftete Frequenz-Gitterlinien, aber nur ein paar wenige BESCHRIFTETE
 *  Zehnerpotenzen -- auf Handybreite (~300-350px) wäre jede Terz beschriftet
 *  völlig überladen. dB-Linien alle 6dB, komplett beschriftet (nur 7 Werte). */
const EQ8_FREQ_GRID = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const EQ8_FREQ_TICKS = [
  { hz: 100, label: '100' },
  { hz: 1000, label: '1k' },
  { hz: 10000, label: '10k' },
];
const EQ8_DB_TICKS = [-18, -12, -6, 0, 6, 12, 18];

/** Feste, log-verteilte Stützstellen für getFrequencyResponse() -- einmal
 *  berechnet (modulweit, unabhängig von einzelnen Insert-Instanzen, da rein
 *  von der X-Achse abhängig), bei jedem Redraw wiederverwendet. */
let eq8FreqSamples = null;
function getEq8FreqSamples() {
  if (eq8FreqSamples) return eq8FreqSamples;
  const N = 120;
  eq8FreqSamples = new Float32Array(N);
  for (let i = 0; i < N; i++) eq8FreqSamples[i] = eq8XToFreq((i / (N - 1)) * EQ8_W);
  return eq8FreqSamples;
}

/** Echte Summenkurve über alle aktiven Bänder (s. inserts.js#getEq8Response) --
 *  im Gegensatz zu eqCurvePath() oben keine geschätzte Form. */
function eq8CurvePath(insert) {
  const freqs = getEq8FreqSamples();
  const db = insert.getEq8Response?.(freqs);
  if (!db) return `M0,${EQ8_MIDY} L${EQ8_W},${EQ8_MIDY}`;
  let d = '';
  for (let i = 0; i < freqs.length; i++) {
    const x = (i / (freqs.length - 1)) * EQ8_W;
    const y = eq8GainToY(db[i]);
    d += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)} `;
  }
  return d.trim();
}

/** GR-Meter des Compressor-Moduls: pollt den echten `reduction`-Wert des
 *  nativen DynamicsCompressorNode (Web Audio liefert ihn direkt, kein
 *  zusätzliches Analyser-Tapping nötig). Selbstbeendend: sobald die Zeile
 *  aus dem DOM verschwindet (Re-Render bei add/remove/move/bypass),
 *  bricht die Schleife am isConnected-Check ab — kein Leak, kein
 *  expliziter Teardown nötig. */
function startCompMeter(row, insert) {
  const segs = row.querySelectorAll('.comp-meter__vu .vu__seg');
  if (!segs.length) return;
  const RANGE_DB = 24;
  // reduction pendelt sich auch bei echter digitaler Stille nicht zwingend
  // exakt bei 0dB ein (browserabhängiges Implementierungsdetail der
  // nativen Envelope-Nachlaufkurve — gemessen: über 2s stabil bei einem
  // konstanten, aber je nach Kontext unterschiedlichen Ruhewert, während
  // der tatsächliche Master-Ausgang nachweislich still bleibt). Statt
  // einer geraten festen Dead-Zone verfolgt restBaseline den NIEDRIGSTEN
  // je beobachteten Wert und zieht ihn ab — passt sich also automatisch
  // an den tatsächlichen Ruhewert an, egal wie hoch der ausfällt.
  let restBaseline = Infinity;
  const tick = () => {
    if (!row.isConnected) return;
    const raw = Math.abs(insert.getReductionDb?.() ?? 0);
    if (raw < restBaseline) restBaseline = raw;
    const gr = Math.max(0, raw - restBaseline);
    const lit = Math.round(Math.min(1, gr / RANGE_DB) * segs.length);
    segs.forEach((s, i) => s.classList.toggle('is-lit', i < lit));
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/* ---------- 8-Band-EQ: Halten-Menü (Typ/Entfernen) ----------
 * Ein einzelnes, modulweites Popup -- gleiches Muster wie padMenu/
 * openSampleEditor in sampler.js (nie mehr als eines gleichzeitig offen). */
let eq8Menu = null;
const dismissEq8Menu = () => {
  eq8Menu?.remove();
  eq8Menu = null;
  document.removeEventListener('pointerdown', onOutsideEq8Menu, true);
};
const onOutsideEq8Menu = (e) => { if (eq8Menu && !eq8Menu.contains(e.target)) dismissEq8Menu(); };

function openEq8Menu(insert, i, clientX, clientY, onChange) {
  dismissEq8Menu();
  const b = insert.params.bands[i];
  eq8Menu = document.createElement('div');
  eq8Menu.className = 'pat-chip';

  for (const t of EQ_TYPES) {
    const btn = document.createElement('button');
    btn.className = `pat-chip__btn${b.type === t.value ? ' is-active' : ''}`;
    btn.textContent = t.label;
    btn.addEventListener('click', () => {
      b.type = t.value;
      insert.setBand(i, 'type');
      onChange();
      dismissEq8Menu();
    });
    eq8Menu.appendChild(btn);
  }

  const removeBtn = document.createElement('button');
  removeBtn.className = 'pat-chip__btn pat-chip__btn--danger';
  removeBtn.textContent = '🗑 Remove';
  removeBtn.addEventListener('click', () => {
    b.active = false;
    insert.setBand(i, 'active');
    onChange();
    dismissEq8Menu();
  });
  eq8Menu.appendChild(removeBtn);

  document.body.appendChild(eq8Menu);
  const left = Math.max(8, Math.min(window.innerWidth - eq8Menu.offsetWidth - 8, clientX - eq8Menu.offsetWidth / 2));
  eq8Menu.style.left = `${left}px`;
  eq8Menu.style.top = `${Math.max(8, clientY - eq8Menu.offsetHeight - 16)}px`;
  setTimeout(() => document.addEventListener('pointerdown', onOutsideEq8Menu, true), 0);
  clearTimeout(eq8Menu.dismissTimer);
  eq8Menu.dismissTimer = setTimeout(dismissEq8Menu, 6000);
}

/**
 * Touch-Interaktion des 8-Band-EQ-Graphen: EIN Satz Zeiger-Listener auf dem
 * Graph-CONTAINER statt auf jedem einzelnen Knoten-Element (erster Entwurf
 * war pro Knoten -- verworfen: bei einer echten Zwei-Finger-Geste landet der
 * zweite Finger fast nie exakt auf dem kleinen Knoten, sondern daneben auf
 * dem Hintergrund, dessen "leere Fläche antippen fügt Band hinzu"-Handler
 * dann fälschlich ausgelöst hätte). Zeiger werden per pointerId in einer Map
 * verfolgt, die Geste (Tap/Drag/Pinch-Q/Halten) wird aus activePointers.size
 * plus Distanz zum nächsten Knoten hergeleitet -- gleiches Idiom wie die
 * Trim-Handle-Erkennung im Sample-Editor (sampler.js#setupWaveformEditor).
 */
function setupEq8Graph(row, insert, machine) {
  const graph = row.querySelector('[data-eq8-graph]');
  if (!graph) return;
  const svg = graph.querySelector('.eq8__svg');
  const curvePath = graph.querySelector('[data-eq8-curve]');
  const HOLD_MS = 500;
  const TAP_TOLERANCE = 6; // Viewbox-Einheiten

  const toViewBox = (clientX, clientY) => {
    const rect = graph.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / rect.width) * EQ8_W,
      y: ((clientY - rect.top) / rect.height) * EQ8_H,
    };
  };

  // Nur AKTIVE Bänder zählen als "vorhandener Knoten" -- inaktive Bänder
  // haben (noch) keinen sichtbaren Punkt (s. redraw()) und teilen sich
  // ausserdem alle denselben Default (freq 1000/gain 0). Würden sie hier
  // mitgezählt, fände ein Tap auf eine LEERE Stelle nahe dieser Default-
  // Position fälschlich "es gibt hier schon ein Band" statt ein neues
  // anzulegen -- und ein Halten dort hätte am eh schon inaktiven Band
  // nichts sichtbar zu entfernen (genau der gemeldete "Punkt lässt sich
  // nicht wegmachen"-Bug).
  const findNodeNear = (x, y, maxDist = 22) => {
    let best = -1, bestDist = maxDist;
    insert.params.bands.forEach((b, i) => {
      if (!b.active) return;
      const d = Math.hypot(eq8FreqToX(b.freq) - x, eq8GainToY(b.gain) - y);
      if (d < bestDist) { bestDist = d; best = i; }
    });
    return best;
  };

  // Hält die <circle>-Elemente 1:1 mit den AKTIVEN Bändern synchron --
  // erzeugt/entfernt Knoten statt (wie zuvor) alle 8 fix zu rendern, damit
  // inaktive Bänder gar nicht erst als Punkt auftauchen können.
  const syncNodes = () => {
    const existing = new Map();
    graph.querySelectorAll('[data-eq8-node]').forEach((el) => {
      existing.set(parseInt(el.dataset.eq8Node, 10), el);
    });
    insert.params.bands.forEach((b, i) => {
      let el = existing.get(i);
      if (b.active) {
        if (!el) {
          el = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
          el.setAttribute('class', 'eq8__node is-active');
          el.setAttribute('data-eq8-node', i);
          el.setAttribute('r', 7);
          svg.appendChild(el);
        }
        el.setAttribute('cx', eq8FreqToX(b.freq));
        el.setAttribute('cy', eq8GainToY(b.gain));
      } else if (el) {
        el.remove();
      }
    });
  };

  const redraw = () => {
    curvePath.setAttribute('d', eq8CurvePath(insert));
    syncNodes();
  };
  // setBand() ramp die echten Audio-Parameter sanft an (setTargetAtTime,
  // Klick-Vermeidung bei schnellen Touch-Änderungen) -- die Kurve liest
  // aber den ECHTEN, gerade noch mitten im Ramp befindlichen Filterwert
  // (s. getEq8Response/getFrequencyResponse), zeigt direkt nach einer
  // einzelnen, diskreten Änderung (Tap-Add, Loslassen, Typ-Wechsel im
  // Halten-Menü) also kurz einen noch nicht eingeschwungenen Zwischenwert.
  // Während eines Drags gleicht sich das von selbst aus (redraw() läuft ja
  // bei jedem weiteren pointermove erneut) -- nur nach der LETZTEN Änderung
  // braucht es einen verzögerten Nachzieh-Redraw, der den eingeschwungenen
  // Endwert nachträglich einfängt.
  let settleTimer = null;
  const redrawSettled = () => {
    redraw();
    clearTimeout(settleTimer);
    settleTimer = setTimeout(redraw, 80);
  };

  const activePointers = new Map(); // pointerId -> {x, y} in Viewbox-Koordinaten
  let dragNode = -1, qNode = -1;
  let qStartDist = 0, qStartQ = 1;
  let downPos = null, downClient = null, moved = false, holdTimer = null;
  const clearHold = () => { if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; } };

  graph.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const pos = toViewBox(e.clientX, e.clientY);
    activePointers.set(e.pointerId, pos);

    if (activePointers.size === 1) {
      moved = false;
      downPos = pos;
      downClient = { x: e.clientX, y: e.clientY };
      dragNode = findNodeNear(pos.x, pos.y);
      if (dragNode >= 0) {
        clearHold();
        holdTimer = setTimeout(() => {
          if (!moved) openEq8Menu(insert, dragNode, downClient.x, downClient.y, redrawSettled);
        }, HOLD_MS);
      }
    } else if (activePointers.size === 2) {
      clearHold();
      const pts = [...activePointers.values()];
      const midX = (pts[0].x + pts[1].x) / 2, midY = (pts[0].y + pts[1].y) / 2;
      qNode = dragNode >= 0 ? dragNode : findNodeNear(midX, midY, 40);
      dragNode = -1;
      if (qNode >= 0) {
        qStartDist = Math.max(1, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y));
        qStartQ = insert.params.bands[qNode].q;
      }
    }
  });

  graph.addEventListener('pointermove', (e) => {
    if (!activePointers.has(e.pointerId)) return;
    const pos = toViewBox(e.clientX, e.clientY);
    activePointers.set(e.pointerId, pos);

    if (activePointers.size === 1 && dragNode >= 0) {
      if (!moved && Math.hypot(pos.x - downPos.x, pos.y - downPos.y) > TAP_TOLERANCE) {
        moved = true;
        clearHold();
      }
      if (moved) {
        const b = insert.params.bands[dragNode];
        b.freq = eq8XToFreq(pos.x);
        b.gain = eq8YToGain(pos.y);
        insert.setBand(dragNode, 'freq');
        insert.setBand(dragNode, 'gain');
        redrawSettled();
      }
    } else if (activePointers.size === 2 && qNode >= 0) {
      const pts = [...activePointers.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const q = Math.max(EQ8_Q_MIN, Math.min(EQ8_Q_MAX, qStartQ * (dist / qStartDist)));
      insert.params.bands[qNode].q = q;
      insert.setBand(qNode, 'q');
      redrawSettled();
    }
  });

  const onUp = (e) => {
    activePointers.delete(e.pointerId);
    clearHold();
    if (activePointers.size === 0) {
      if (dragNode < 0 && qNode < 0 && !moved && downPos) {
        // Tap auf leere Fläche -- erstes noch inaktives Band an dieser
        // Stelle aktivieren (alle 8 Bänder existieren fest, s. inserts.js).
        const emptyIdx = insert.params.bands.findIndex((b) => !b.active);
        if (emptyIdx >= 0) {
          const b = insert.params.bands[emptyIdx];
          b.freq = eq8XToFreq(downPos.x);
          b.gain = eq8YToGain(downPos.y);
          b.active = true;
          insert.setBand(emptyIdx, 'active');
          insert.setBand(emptyIdx, 'freq');
          insert.setBand(emptyIdx, 'gain');
          redrawSettled();
        }
      }
      dragNode = -1;
      qNode = -1;
      moved = false;
      downPos = null;
    } else if (activePointers.size === 1) {
      // Von zwei auf einen Finger zurück -- Q-Geste beenden, mit dem
      // verbliebenen Finger direkt als Freq/Gain-Drag weitermachen (kein
      // neuer Tap, kein erneutes Hold-Menü).
      qNode = -1;
      const [remaining] = activePointers.values();
      dragNode = findNodeNear(remaining.x, remaining.y);
      downPos = remaining;
      moved = true;
    }
  };
  graph.addEventListener('pointerup', onUp);
  graph.addEventListener('pointercancel', onUp);
}

let nextId = 1;
let nextClipId = 1;

/** Alle lebenden Maschinen — für die Solo-Koordination über das ganze Rack. */
const machines = new Set();

/** Eine einzige, wiederverwendete Sheet-Instanz für "+ Insert Effect" —
 *  jede Maschine bräuchte sonst ihr eigenes Picker-Markup, dabei kann
 *  ohnehin nie mehr als eines gleichzeitig offen sein (modal). */
let insertPickerEl = null;
function openInsertPicker(onPick) {
  if (!insertPickerEl) {
    insertPickerEl = document.createElement('div');
    insertPickerEl.className = 'sheet sheet--insert-picker';
    insertPickerEl.hidden = true;
    insertPickerEl.innerHTML = `
      <div class="sheet__backdrop" data-close></div>
      <div class="sheet__panel" role="dialog" aria-label="Insert effect">
        <div class="sheet__grip"></div>
        <h2 class="sheet__title">Insert Effect</h2>
        <div class="sheet__list">
          ${INSERT_TYPES.map((type) => `
            <button type="button" class="sheet__item" data-type="${type}">
              <span class="sheet__name">${insertMeta(type).name}</span>
            </button>
          `).join('')}
        </div>
      </div>
    `;
    document.body.appendChild(insertPickerEl);
    insertPickerEl.querySelector('[data-close]').addEventListener('click', () => {
      insertPickerEl.hidden = true;
    });
    insertPickerEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-type]');
      if (!btn) return;
      insertPickerEl.hidden = true;
      insertPickerEl._onPick?.(btn.dataset.type);
    });
  }
  insertPickerEl._onPick = onPick;
  insertPickerEl.hidden = false;
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

export class Machine {
  static meta = { type: 'machine', name: 'Machine', desc: '', color: '#888' };

  constructor() {
    this.id = nextId++;
    this.muted = false;
    this.soloed = false;
    /** Von der Jam-Ansicht gesetzt (s. setJamGate) — unabhängig von Mute/
     *  Solo. Default offen: solange niemand jammt, keine Einschränkung. */
    this.jamGateOpen = true;

    /** @type {GainNode} Alles, was die Maschine erzeugt, läuft hier durch
     *  (Volume-Regler schreiben hierauf). */
    this.output = engine.ctx.createGain();
    /** @type {StereoPannerNode} Panorama — sitzt direkt hinterm Fader, wie
     *  am echten Kanalzug. Die Sends (Delay/Reverb) hängen hinter dem Gate,
     *  tragen die Stereo-Position also mit. */
    this.pan = 0;
    this.panner = engine.ctx.createStereoPanner();
    /** @type {GainNode} Mute/Solo-Gate — getrennt vom Volume, damit
     *  Entmuten nicht die Reglerstellung überschreibt. */
    this.gate = engine.ctx.createGain();
    this.panner.connect(this.gate);
    this.gate.connect(engine.masterBus);

    /** @type {Array<ReturnType<typeof createInsert>>} Insert-FX-Kette
     *  zwischen Output und Panner — frei bestückbar (0..n Instanzen,
     *  beliebige Reihenfolge). Leer verbindet #rewireInsertChain()
     *  Output direkt an den Panner. */
    this.inserts = [];
    this.#rewireInsertChain();

    /** @type {Array<{id:number, name:string, shape:string, data:*}>}
     *  Jam-Clips — benannte Pattern-Schnappschüsse, s. addClip(). */
    this.clips = [];

    /** Post-Fader-Sends zu den Master-Effekten — hinter dem Gate,
     *  damit Mute/Solo die Effekt-Fahnen mitnimmt. */
    this.sends = { delay: 0, reverb: 0 };
    this.sendDelay = engine.ctx.createGain();
    this.sendDelay.gain.value = 0;
    this.sendReverb = engine.ctx.createGain();
    this.sendReverb.gain.value = 0;
    this.gate.connect(this.sendDelay);
    this.sendDelay.connect(engine.delayBus);
    this.gate.connect(this.sendReverb);
    this.sendReverb.connect(engine.reverbBus);

    machines.add(this);
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
   * Analyser für das Kanalzug-VU-Meter im Mixer — hinter dem Mute/Solo-Gate
   * abgegriffen, zeigt also genau das, was hörbar ist (still bei Mute).
   * Lazy angelegt: kostet nichts, solange kein Mixer-Kanalzug ihn abfragt.
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

  /** Verbindet Output -> insert[0] -> insert[1] -> ... -> Panner neu.
   *  output/insert-outputs haben immer nur EIN Ziel, disconnect() ohne
   *  Argument trennt also genau die eine bestehende Verbindung. */
  #rewireInsertChain() {
    this.output.disconnect();
    for (const insert of this.inserts) insert.output.disconnect();
    let prev = this.output;
    for (const insert of this.inserts) {
      prev.connect(insert.input);
      prev = insert.output;
    }
    prev.connect(this.panner);
  }

  addInsert(type) {
    const insert = createInsert(type);
    this.inserts.push(insert);
    this.#rewireInsertChain();
    this.#renderInserts();
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

    const label = INSERT_DISPLAY[insert.type]?.name ?? insert.name;
    undo.offer(`${label} removed`, () => {
      const restored = createInsert(savedInsert.type, savedInsert);
      this.inserts.splice(insertIndex, 0, restored);
      this.#rewireInsertChain();
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
    this.#rewireInsertChain();
    this.#renderInserts();
  }

  setInsertBypass(id, bypassed) {
    this.inserts.find((i) => i.id === id)?.setBypass(bypassed);
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
  }

  /* ---------- Jam-Clips ----------
   * Ein Clip ist ein benannter Schnappschuss eines Pattern-Slot-Inhalts
   * (`data`, aus pattern-bank.js' getSlot() — dieselbe Kopie, die auch
   * Copy/Paste nutzt), plus `shape` ('drums'|'notes'), damit spätere
   * Wiedergabe weiss, wie er anzuwenden ist. Klips leben NEBEN den vier
   * A/B/C/D-Pattern-Slots, nicht als fünfter Slot — Hinzufügen ändert
   * `this.patterns`/`this.patternIndex` nicht.
   */
  addClip({ name, shape, data }) {
    const clip = { id: nextClipId++, name, shape, data };
    this.clips.push(clip);
    return clip;
  }

  removeClip(id) {
    this.clips = this.clips.filter((c) => c.id !== id);
  }

  /** Für project.js — analog zu `sends`/`inserts`, als Sibling-Feld. */
  serializeClips() {
    return this.clips.map((c) => ({ name: c.name, shape: c.shape, data: c.data }));
  }

  deserializeClips(list) {
    this.clips = (list ?? []).map((c) => ({ id: nextClipId++, ...c }));
  }

  /* ---------- Faceplate ---------- */
  render() {
    const { name, type, color, model = 'RW-00' } = this.constructor.meta;

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
            <div class="machine__name">${name}</div>
            <div class="machine__type">${model} · #${this.id}<span class="machine__led" data-led></span></div>
          </span>
        </div>
        <div class="machine__head-actions">
          <button class="m-btn m-btn--solo" data-solo>SOLO</button>
          <button class="m-btn m-btn--mute" data-mute>MUTE</button>
          <button class="m-btn m-btn--remove" data-remove aria-label="Hold to remove machine">✕</button>
        </div>
      </header>
      <div class="machine__body"></div>
    `;

    // Panel einklappen (nur Header sichtbar) — reduziert Scroll-Distanz bei
    // mehreren Maschinen im Rack. Rein visuell, kein Datenzustand, deshalb
    // bewusst nicht in serialize()/deserialize() (wie das Mixer-Pendant
    // .mixer-group__toggle, das ebenfalls nicht persistiert wird).
    el.querySelector('[data-collapse-toggle]').addEventListener('click', () => {
      el.classList.toggle('is-collapsed');
    });

    this.headMuteBtn = el.querySelector('[data-mute]');
    this.headSoloBtn = el.querySelector('[data-solo]');
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
          clips: this.serializeClips(),
          lanes: automation.exportLanes(this.id),
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

    // Knob-Stellungen mit dem (ggf. geladenen) Zustand synchronisieren —
    // die value-Attribute im Markup sind nur die Werks-Defaults
    for (const knob of el.querySelectorAll('x-knob[data-p]')) {
      const v = this.getParamForKnob(knob.dataset.p);
      if (v !== undefined) knob.value = v;
    }

    // Alle Knobs mit data-auto bei der Automation anmelden. apply() nutzt
    // dieselbe input-Leitung wie eine Handbewegung — Maschinen brauchen
    // für Automation keinen Extra-Code.
    for (const knob of el.querySelectorAll('x-knob[data-auto]')) {
      const key = `${this.id}:${knob.dataset.p}`;
      automation.register(key, knob, (v) => {
        knob.value = v;
        knob.dispatchEvent(new CustomEvent('input', {
          detail: { value: v },
          bubbles: true,
        }));
      });
    }

    this.el = el;
    this.ledEl = el.querySelector('[data-led]');
    return el;
  }

  /** Baut die komplette Insert-Liste neu aus this.inserts — jeder Insert
   *  ein eigenes Rack-Modul (dieselbe .machine-Faceplate wie die äussere
   *  Maschine: Schrauben, gebürstetes Metall, Farbstreifen — nur mit der
   *  Akzentfarbe seines Effekt-Typs). Einfacher als gezieltes DOM-Patchen
   *  und unkritisch, weil nur bei add/remove/move/bypass/Typ-Wechsel
   *  aufgerufen wird (Knob-Ziehen selbst löst KEIN Re-Render aus, bleibt
   *  also während des Drags ungestört — dafür patchen eq/drive gezielt
   *  ihre reaktiven Bits direkt bei jedem Knob-input, s.u.). */
  #renderInserts() {
    if (!this.insertsListEl) return;
    this.insertsListEl.innerHTML = this.inserts.map((insert, idx) => {
      const paramDefs = UI_PARAMS[insert.type] ?? [];
      const knobsHtml = paramDefs.map((def) => `
        <x-knob label="${def.label}" min="${def.min}" max="${def.max}"
          value="${insert.params[def.key]}"
          ${def.curve ? `curve="${def.curve}"` : ''}
          ${def.unit ? `unit="${def.unit}"` : ''}
          data-insert-id="${insert.id}" data-insert-param="${def.key}"></x-knob>
      `).join('');

      let bodyHtml;
      if (insert.type === 'comp') {
        bodyHtml = `
          <div class="comp-meter">
            <span class="comp-meter__label">GR</span>
            <div class="vu comp-meter__vu">
              ${Array.from({ length: 12 }, () => '<span class="vu__seg"></span>').join('')}
            </div>
          </div>
          <div class="insert-row__params">${knobsHtml}</div>
          <div class="seg comp-ratio">
            <span class="seg__label">Ratio</span>
            ${RATIO_MODE_BUTTONS.map((m) => `
              <button type="button" class="seg__btn${insert.params.ratioMode === m.value ? ' is-active' : ''}" data-ratio-mode="${m.value}">${m.label}</button>
            `).join('')}
          </div>
        `;
      } else if (insert.type === 'eq') {
        bodyHtml = `
          <div class="eq-curve" data-eq-curve>
            <svg viewBox="0 0 120 36" class="eq-curve__svg" preserveAspectRatio="none">
              <line x1="0" y1="18" x2="120" y2="18" class="eq-curve__zero"></line>
              <path class="eq-curve__path" d="${eqCurvePath(insert.params.type, insert.params.freq, insert.params.gain, insert.params.q)}"></path>
            </svg>
          </div>
          <div class="seg">
            ${EQ_TYPES.map((t) => `
              <button type="button" class="seg__btn${insert.params.type === t.value ? ' is-active' : ''}" data-eq-type="${t.value}">${t.label}</button>
            `).join('')}
          </div>
          <div class="insert-row__params">${knobsHtml}</div>
        `;
      } else if (insert.type === 'drive') {
        bodyHtml = `
          <div class="drive-heat">
            <span class="drive-heat__led" data-drive-heat style="opacity:${0.25 + insert.params.drive * 0.75}"></span>
            <span class="drive-heat__label">Heat</span>
          </div>
          <div class="insert-row__params">${knobsHtml}</div>
        `;
      } else if (insert.type === 'filterDelay') {
        bodyHtml = `
          <div class="seg">
            ${FILTER_DELAY_TYPES.map((t) => `
              <button type="button" class="seg__btn${insert.params.filterType === t.value ? ' is-active' : ''}" data-filterdelay-type="${t.value}">${t.label}</button>
            `).join('')}
          </div>
          <div class="insert-row__params">${knobsHtml}</div>
        `;
      } else if (insert.type === 'resonator') {
        bodyHtml = `
          <div class="seg">
            ${RESONATOR_INTERVALS.map((t) => `
              <button type="button" class="seg__btn${insert.params.interval === t.value ? ' is-active' : ''}" data-resonator-interval="${t.value}">${t.label}</button>
            `).join('')}
          </div>
          <div class="insert-row__params">${knobsHtml}</div>
        `;
      } else if (insert.type === 'eq8') {
        // Kein knobsHtml (UI_PARAMS.eq8 gibt es bewusst nicht) -- der Graph
        // wird nach dem Rendern von setupEq8Graph() imperativ bespielt,
        // damit ein Drag NICHT bei jedem Frame ein komplettes innerHTML-
        // Neubauen auslöst (s. Kommentar über #renderInserts()).
        bodyHtml = `
          <div class="eq8__graph" data-eq8-graph>
            <svg viewBox="0 0 ${EQ8_W} ${EQ8_H}" class="eq8__svg" preserveAspectRatio="none">
              ${EQ8_FREQ_GRID.map((f) => `<line x1="${eq8FreqToX(f).toFixed(1)}" y1="0" x2="${eq8FreqToX(f).toFixed(1)}" y2="${EQ8_H}" class="eq8__grid"></line>`).join('')}
              ${EQ8_DB_TICKS.map((db) => `<line x1="0" y1="${eq8GainToY(db).toFixed(1)}" x2="${EQ8_W}" y2="${eq8GainToY(db).toFixed(1)}" class="eq8__grid${db === 0 ? ' eq8__grid--zero' : ''}"></line>`).join('')}
              <path class="eq8__curve" data-eq8-curve d="${eq8CurvePath(insert)}"></path>
              ${insert.params.bands.map((b, i) => (b.active ? `
                <circle class="eq8__node is-active" data-eq8-node="${i}"
                  cx="${eq8FreqToX(b.freq)}" cy="${eq8GainToY(b.gain)}" r="7"></circle>
              ` : '')).join('')}
            </svg>
            <div class="eq8__labels" aria-hidden="true">
              ${EQ8_FREQ_TICKS.map((t) => `<span class="eq8__label eq8__label--x" style="left:${(eq8FreqToX(t.hz) / EQ8_W * 100).toFixed(2)}%">${t.label}</span>`).join('')}
              ${EQ8_DB_TICKS.map((db) => `<span class="eq8__label eq8__label--y" style="top:${(eq8GainToY(db) / EQ8_H * 100).toFixed(2)}%">${db > 0 ? `+${db}` : db}</span>`).join('')}
            </div>
          </div>
          <p class="eq8__hint">Tap: add band · Drag: freq/gain · Two fingers: Q · Hold: type/remove</p>
        `;
      } else {
        bodyHtml = `<div class="insert-row__params">${knobsHtml}</div>`;
      }

      const { name, badge } = INSERT_DISPLAY[insert.type];
      return `
        <section class="machine insert-module${insert.bypassed ? ' is-bypassed' : ''}"
          data-insert-id="${insert.id}" style="${insertColorVars(INSERT_COLORS[insert.type])}">
          <header class="machine__head">
            <span class="machine__stripe"></span>
            <div class="machine__title">
              <span>
                <div class="machine__name">${name}</div>
                <div class="machine__type">${badge} · #${insert.id}</div>
              </span>
            </div>
            <div class="machine__head-actions">
              <button type="button" class="m-btn insert-row__move" data-move="-1" aria-label="Move up" ${idx === 0 ? 'disabled' : ''}>▲</button>
              <button type="button" class="m-btn insert-row__move" data-move="1" aria-label="Move down" ${idx === this.inserts.length - 1 ? 'disabled' : ''}>▼</button>
              <button type="button" class="m-btn insert-row__bypass${insert.bypassed ? ' is-active' : ''}" data-bypass>BYP</button>
              <button type="button" class="m-btn insert-row__remove" data-remove aria-label="Remove insert">✕</button>
            </div>
          </header>
          <div class="machine__body">${bodyHtml}</div>
        </section>
      `;
    }).join('');

    for (const row of this.insertsListEl.querySelectorAll('.insert-module')) {
      const id = parseInt(row.dataset.insertId, 10);
      const insert = this.inserts.find((i) => i.id === id);
      row.querySelector('[data-move="-1"]')?.addEventListener('click', () => this.moveInsert(id, -1));
      row.querySelector('[data-move="1"]')?.addEventListener('click', () => this.moveInsert(id, 1));
      row.querySelector('[data-bypass]').addEventListener('click', () => {
        this.setInsertBypass(id, !insert.bypassed);
        this.#renderInserts();
      });
      row.querySelector('[data-remove]').addEventListener('click', () => this.removeInsert(id));
      for (const knob of row.querySelectorAll('x-knob[data-insert-param]')) {
        knob.addEventListener('input', (e) => {
          this.setInsertParam(id, knob.dataset.insertParam, e.detail.value);
          if (insert.type === 'eq') {
            row.querySelector('.eq-curve__path')?.setAttribute('d',
              eqCurvePath(insert.params.type, insert.params.freq, insert.params.gain, insert.params.q));
          } else if (insert.type === 'drive' && knob.dataset.insertParam === 'drive') {
            const led = row.querySelector('[data-drive-heat]');
            if (led) led.style.opacity = 0.25 + insert.params.drive * 0.75;
          }
        });
        // Automatisierbar wie jeder Maschinen-Knob (s. render()s data-auto-
        // Schleife) -- eigener Weg statt data-auto, weil Insert-Module bei
        // JEDEM add/remove/move/bypass komplett neu gerendert werden
        // (#renderInserts() setzt innerHTML neu): der Knoten selbst ist
        // hier NIE stabil, register() muss deshalb bei jedem Rendern erneut
        // auf das jeweils aktuelle Element gebunden werden. Der Lane-
        // Schlüssel (insert.id-basiert, s. inserts.js#createInsert) bleibt
        // dabei über Reordering UND Neuladen hinweg stabil -- nur SO
        // überlebt eine aufgenommene Fahrt einen Insert-Umbau oder ein
        // Speichern/Laden.
        const autoKey = `${this.id}:insert:${id}:${knob.dataset.insertParam}`;
        automation.register(autoKey, knob, (v) => {
          knob.value = v;
          knob.dispatchEvent(new CustomEvent('input', { detail: { value: v }, bubbles: true }));
        });
        knob.classList.toggle('has-auto', automation.hasLane(autoKey));
      }
      for (const btn of row.querySelectorAll('[data-eq-type]')) {
        btn.addEventListener('click', () => {
          this.setInsertParam(id, 'type', btn.dataset.eqType);
          this.#renderInserts();
        });
      }
      for (const btn of row.querySelectorAll('[data-filterdelay-type]')) {
        btn.addEventListener('click', () => {
          this.setInsertParam(id, 'filterType', btn.dataset.filterdelayType);
          this.#renderInserts();
        });
      }
      for (const btn of row.querySelectorAll('[data-resonator-interval]')) {
        btn.addEventListener('click', () => {
          const oldIdx = RESONATOR_INTERVALS.findIndex((t) => t.value === insert.params.interval);
          this.setInsertParam(id, 'interval', btn.dataset.resonatorInterval);
          const newIdx = RESONATOR_INTERVALS.findIndex((t) => t.value === btn.dataset.resonatorInterval);
          automation.recordSwitch(`${this.id}:insert:${id}:interval`, oldIdx, newIdx);
          this.#renderInserts();
        });
      }
      if (insert.type === 'resonator') {
        // Automatisierbar wie der Chord-Typ beim PolySynth (registerSwitch/
        // recordSwitch, s. automation.js) -- die apply()-Rückgabe der
        // Wiedergabe darf hier bewusst NICHT #renderInserts() aufrufen (das
        // würde bei jedem der ~45 Ticks/Sekunde die komplette Insert-Liste
        // neu bauen), deshalb ein leichtgewichtiger Direkt-Abgleich der
        // is-active-Klassen statt eines vollen Rerenders.
        const seg = row.querySelector('.seg');
        const autoKey = `${this.id}:insert:${id}:interval`;
        automation.registerSwitch(autoKey, seg, (v) => {
          const idx = Math.max(0, Math.min(RESONATOR_INTERVALS.length - 1, Math.round(v)));
          const value = RESONATOR_INTERVALS[idx].value;
          this.setInsertParam(id, 'interval', value);
          for (const b of seg.querySelectorAll('[data-resonator-interval]')) {
            b.classList.toggle('is-active', b.dataset.resonatorInterval === value);
          }
        });
        seg.classList.toggle('has-auto', automation.hasLane(autoKey));
      }
      for (const btn of row.querySelectorAll('[data-ratio-mode]')) {
        btn.addEventListener('click', () => {
          this.setInsertParam(id, 'ratioMode', btn.dataset.ratioMode);
          this.#renderInserts();
        });
      }
      if (insert.type === 'comp') startCompMeter(row, insert);
      if (insert.type === 'eq8') setupEq8Graph(row, insert, this);
    }
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

  /* ---------- Aufräumen ---------- */
  dispose() {
    transport.removeListener(this);
    automation.unregisterMachine(this.id);
    machines.delete(this);
    refreshGates(); // falls die einzige Solo-Maschine entfernt wurde
    this.disposeAudio();
    // Fade-out, dann trennen — vermeidet Klicks beim Entfernen
    const t = engine.now;
    this.gate.gain.setTargetAtTime(0, t, 0.02);
    setTimeout(() => {
      this.output.disconnect();
      this.panner.disconnect();
      this.gate.disconnect();
      this.sendDelay.disconnect();
      this.sendReverb.disconnect();
      this.#meterAnalyser?.disconnect();
      for (const insert of this.inserts) insert.dispose();
    }, 120);
    this.el?.remove();
  }
}
