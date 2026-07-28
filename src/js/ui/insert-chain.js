/**
 * insert-chain.js — die Insert-Effekt-Kette als eigenständiges UI-Modul,
 * herausgelöst aus machine.js (dort ursprünglich als private Methoden der
 * Machine-Klasse gebaut). Grund: der Master-Bus (fx.js) soll dieselbe
 * frei bestückbare Insert-Kette bekommen wie jede Maschine -- MasterFX ist
 * aber keine Machine-Unterklasse (kein eigener Audio-Ausgang/Panner/Gate,
 * sondern der App-weite Summen-Bus). Statt die komplette Render-/
 * Interaktionslogik zu duplizieren (EQ8-Graph-Touch-Gesten, Compressor-GR-
 * Meter, Filter-Delay-Sync-Buttons, Resonator-Tune-Regler, …), nimmt
 * renderInsertChain() einen generischen "owner" entgegen, den sowohl
 * Machine-Instanzen als auch MasterFX erfüllen:
 *   owner.inserts          — Array der aktuellen Insert-Objekte
 *   owner.laneKeyPrefix    — String für Automation-Lane-Schlüssel
 *                             (Maschine: ihre numerische id; Master: 'master')
 *   owner.setInsertParam(id, key, value)
 *   owner.setInsertBypass(id, bool)
 *   owner.moveInsert(id, dir)
 *   owner.removeInsert(id)
 */
import { automation } from '../core/automation.js';
import { INSERT_TYPES, insertMeta, UI_PARAMS, EQ_TYPES, FILTER_DELAY_TYPES, DELAY_SYNC_BUTTONS, RESONATOR_INTERVALS, INSERT_COLORS, RATIO_MODE_BUTTONS, OPTO_MODE_BUTTONS, GEQ_FREQS } from '../core/inserts.js';

/** Anzeigename + Typenschild je Insert-Typ fürs Rack-Modul-Faceplate —
 *  getrennt vom kurzen DSP-Namen (insertMeta().name), der bleibt für den
 *  Picker-Sheet-Eintrag ("Compressor") kurz und knapp. */
export const INSERT_DISPLAY = {
  comp: { name: '1176-Style Compressor', badge: 'FET-COMP' },
  eq: { name: 'Parametric EQ', badge: 'RACK-EQ' },
  drive: { name: 'Drive / Saturation', badge: 'TUBE-DRIVE' },
  filterDelay: { name: 'Filter Delay', badge: 'FLT-DELAY' },
  reverb: { name: 'Algorithmic Reverb', badge: 'FDN-VERB' },
  resonator: { name: 'Resonator', badge: 'RESO-BANK' },
  eq8: { name: '8-Band EQ', badge: 'EQ8-TOUCH' },
  opto: { name: 'Opto Compressor', badge: 'OPTO-COMP' },
  tape: { name: 'Tape Machine', badge: 'TAPE-SAT' },
  geq: { name: 'Graphic EQ', badge: 'GEQ-10' },
  limiter: { name: 'Limiter', badge: 'BRICKWALL' },
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
 *
 * Q per Zwei-Finger-Geste war ursprünglich an die Fingerposition GEBUNDEN
 * (zweiter Finger musste nah am Knoten oder dessen Mittelpunkt landen) --
 * bei mehreren, eng benachbarten Bändern in der Praxis fummelig (Nutzer-
 * Feedback). Jetzt entkoppelt über eine explizite Auswahl (selectedBand):
 * ein Band antippen SELEKTIERT es (Ring-Hervorhebung), danach stellt eine
 * Zwei-Finger-Geste IRGENDWO auf dem Graphen dessen Q ein -- die Finger
 * müssen den Knoten selbst nicht mehr treffen. Ziehen mit einem Finger auf
 * dem Knoten bleibt der direkte Weg für Freq/Gain und setzt die Auswahl
 * gleich mit.
 */
function setupEq8Graph(row, insert) {
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

  let selectedBand = -1;

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
          svg.appendChild(el);
        }
        el.setAttribute('cx', eq8FreqToX(b.freq));
        el.setAttribute('cy', eq8GainToY(b.gain));
        el.setAttribute('r', i === selectedBand ? 9 : 7);
        el.classList.toggle('is-selected', i === selectedBand);
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
  let downPos = null, downClient = null, moved = false, holdTimer = null, holdFired = false;
  const clearHold = () => { if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; } };

  // Doppel-Tipp auf ein bestehendes Band löscht es direkt -- schnellerer Weg
  // für ein versehentlich erstelltes Band als erst das Halten-Menü zu öffnen
  // (s. Chat-Feedback). Dieselbe Zeitschwelle wie das Löschen an anderen
  // Stellen der App wäre hier zu lang/kurz -- 350ms ist der übliche Wert für
  // einen echten Doppeltipp (deutlich unter der 500ms-Halten-Schwelle oben,
  // damit sich beide Gesten nicht überschneiden).
  const DOUBLE_TAP_MS = 350;
  let lastTapNode = -1, lastTapTime = 0;

  // Live-Frequenz/Gain-Anzeige über dem Finger während des Ziehens -- ohne
  // die feinen Gitterlinien allein war kaum ablesbar, bei welchem Wert man
  // gerade steht (s. Chat-Feedback). Eigenes, fixed-positioniertes Element
  // (wie eq8Menu), nicht Teil des SVG -- muss über dem Finger schweben,
  // unabhängig vom Graph-Ausschnitt.
  let readoutEl = null;
  const fmtFreq = (hz) => (hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 1 : 2)} kHz` : `${Math.round(hz)} Hz`);
  const fmtGain = (db) => `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
  const showReadout = (clientX, clientY, freq, gain) => {
    if (!readoutEl) {
      readoutEl = document.createElement('div');
      readoutEl.className = 'eq8__readout';
      document.body.appendChild(readoutEl);
    }
    readoutEl.textContent = `${fmtFreq(freq)} · ${fmtGain(gain)}`;
    const left = Math.max(8, Math.min(window.innerWidth - readoutEl.offsetWidth - 8, clientX - readoutEl.offsetWidth / 2));
    readoutEl.style.left = `${left}px`;
    readoutEl.style.top = `${Math.max(8, clientY - 40)}px`;
  };
  const hideReadout = () => { readoutEl?.remove(); readoutEl = null; };

  graph.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    // Pointer-Capture: hält pointermove/pointerup am Graphen fest, auch
    // wenn ein Finger beim Auseinanderziehen (Q-Geste, jetzt bewusst
    // "irgendwo auf dem Graphen" statt nah am Knoten) über dessen kleinen
    // Rand hinauswandert -- ohne das bliebe der Finger sonst "verloren"
    // (kein weiteres pointermove/pointerup mehr für ihn), sobald er ein
    // Nachbarelement überquert. try/catch: manche Testumgebungen lösen für
    // synthetisch erzeugte PointerEvents keinen "aktiven Zeiger" aus (dann
    // wirft dies NotFoundError) -- auf echten Touch-Geräten greift es immer.
    try { graph.setPointerCapture(e.pointerId); } catch { /* s. oben */ }
    const pos = toViewBox(e.clientX, e.clientY);
    activePointers.set(e.pointerId, pos);

    if (activePointers.size === 1) {
      moved = false;
      holdFired = false;
      downPos = pos;
      downClient = { x: e.clientX, y: e.clientY };
      dragNode = findNodeNear(pos.x, pos.y);
      if (dragNode >= 0) {
        clearHold();
        holdTimer = setTimeout(() => {
          if (!moved) {
            holdFired = true;
            openEq8Menu(insert, dragNode, downClient.x, downClient.y, redrawSettled);
          }
        }, HOLD_MS);
      }
    } else if (activePointers.size === 2) {
      clearHold();
      // An die AUSWAHL gebunden statt an die Fingerposition -- die Finger
      // müssen den (oft winzigen) Knoten nicht mehr treffen. Wird gerade
      // mit einem Finger gezogen, hat das Vorrang (dragNode), sonst zählt
      // die zuletzt per Tap/Drag gesetzte Auswahl.
      qNode = dragNode >= 0 ? dragNode : selectedBand;
      dragNode = -1;
      if (qNode >= 0) {
        const pts = [...activePointers.values()];
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
        selectedBand = dragNode;
      }
      if (moved) {
        const b = insert.params.bands[dragNode];
        b.freq = eq8XToFreq(pos.x);
        b.gain = eq8YToGain(pos.y);
        insert.setBand(dragNode, 'freq');
        insert.setBand(dragNode, 'gain');
        redrawSettled();
        showReadout(e.clientX, e.clientY, b.freq, b.gain);
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
    hideReadout();
    if (activePointers.size === 0) {
      if (!moved && !holdFired) {
        if (dragNode >= 0) {
          const now = performance.now();
          if (dragNode === lastTapNode && now - lastTapTime < DOUBLE_TAP_MS) {
            // Doppel-Tipp auf dasselbe Band -- direkt löschen, kein Umweg
            // übers Halten-Menü (s. Kommentar bei DOUBLE_TAP_MS oben).
            const b = insert.params.bands[dragNode];
            b.active = false;
            insert.setBand(dragNode, 'active');
            if (selectedBand === dragNode) selectedBand = -1;
            lastTapNode = -1;
            redraw();
          } else {
            // Tap auf ein bestehendes Band -- selektieren (erneutes Tippen
            // auf das schon selektierte Band hebt die Auswahl wieder auf).
            selectedBand = selectedBand === dragNode ? -1 : dragNode;
            redraw();
            lastTapNode = dragNode;
            lastTapTime = now;
          }
        } else if (qNode < 0 && downPos) {
          // Tap auf leere Fläche -- erstes noch inaktives Band an dieser
          // Stelle aktivieren (alle 8 Bänder existieren fest, s. inserts.js)
          // und gleich selektieren (direkt per Zwei-Finger-Geste die Q
          // einstellen können, ohne erst extra antippen zu müssen).
          const emptyIdx = insert.params.bands.findIndex((b) => !b.active);
          if (emptyIdx >= 0) {
            const b = insert.params.bands[emptyIdx];
            b.freq = eq8XToFreq(downPos.x);
            b.gain = eq8YToGain(downPos.y);
            b.active = true;
            insert.setBand(emptyIdx, 'active');
            insert.setBand(emptyIdx, 'freq');
            insert.setBand(emptyIdx, 'gain');
            selectedBand = emptyIdx;
            redrawSettled();
          }
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

/** Eine einzige, wiederverwendete Sheet-Instanz für "+ Insert Effect" —
 *  jeder Aufrufer (Maschine ODER der Master-Bus) bräuchte sonst sein
 *  eigenes Picker-Markup, dabei kann ohnehin nie mehr als eines
 *  gleichzeitig offen sein (modal). */
let insertPickerEl = null;
export function openInsertPicker(onPick) {
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

/**
 * Rendert die komplette Insert-Kette von `owner` in `listEl` -- generisch
 * für Maschinen UND den Master-Bus (s. Dateikopf-Kommentar fürs Owner-
 * Interface). Ersetzt machine.js' vormals privates #renderInserts().
 */
export function renderInsertChain(listEl, owner) {
  if (!listEl) return;
  listEl.innerHTML = owner.inserts.map((insert, idx) => {
    const paramDefs = UI_PARAMS[insert.type] ?? [];
    const knobHtml = (def) => `
      <x-knob label="${def.label}" min="${def.min}" max="${def.max}"
        value="${insert.params[def.key]}"
        ${def.curve ? `curve="${def.curve}"` : ''}
        ${def.unit ? `unit="${def.unit}"` : ''}
        data-insert-id="${insert.id}" data-insert-param="${def.key}"></x-knob>
    `;
    const knobsHtml = paramDefs.map(knobHtml).join('');

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
      // Bei Tempo-Sync ist der Time-Regler (freie Sekunden) irreführend --
      // die tatsächliche Zeit kommt dann aus BPM+Notenwert, nicht aus dem
      // Regler. Statt ihn nur zu deaktivieren (könnte man trotzdem ziehen,
      // ohne dass es wirkt), blendet ihn eine gefilterte Knob-Liste
      // komplett aus, solange division nicht "free" ist.
      const synced = insert.params.division !== 'free';
      const delayKnobsHtml = paramDefs.filter((d) => d.key !== 'time' || !synced).map(knobHtml).join('');
      bodyHtml = `
        <div class="seg">
          ${DELAY_SYNC_BUTTONS.map((s) => `
            <button type="button" class="seg__btn${insert.params.division === s.value ? ' is-active' : ''}" data-filterdelay-sync="${s.value}">${s.label}</button>
          `).join('')}
        </div>
        <div class="seg">
          ${FILTER_DELAY_TYPES.map((t) => `
            <button type="button" class="seg__btn${insert.params.filterType === t.value ? ' is-active' : ''}" data-filterdelay-type="${t.value}">${t.label}</button>
          `).join('')}
          <button type="button" class="seg__btn${insert.params.pingPong ? ' is-active' : ''}" data-filterdelay-pingpong>Ping-Pong</button>
        </div>
        <div class="insert-row__params">${delayKnobsHtml}</div>
      `;
    } else if (insert.type === 'resonator') {
      // Preset-Knöpfe befüllen alle 5 Tune-Regler auf einen Schlag (s.
      // inserts.js#RESONATOR_PRESET_SEMITONES) -- danach lässt sich jedes
      // Band EINZELN weiterverstellen (wie Abletons Resonators: Tune pro
      // Resonator statt nur fixer Akkord-Auswahl), kein knobsHtml/
      // UI_PARAMS-Eintrag dafür (Array statt Einzelwert, gleiches Muster
      // wie eq8s bands).
      bodyHtml = `
        <div class="seg">
          ${RESONATOR_INTERVALS.map((t) => `
            <button type="button" class="seg__btn${insert.params.interval === t.value ? ' is-active' : ''}" data-resonator-interval="${t.value}">${t.label}</button>
          `).join('')}
        </div>
        <div class="resonator-tune">
          ${insert.params.tune.map((v, i) => `
            <x-knob label="${i + 1}" min="-36" max="48" value="${v}" unit="st"
              data-resonator-tune="${i}"></x-knob>
          `).join('')}
        </div>
        <div class="insert-row__params">${knobsHtml}</div>
      `;
    } else if (insert.type === 'opto') {
      bodyHtml = `
        <div class="comp-meter">
          <span class="comp-meter__label">GR</span>
          <div class="vu comp-meter__vu">
            ${Array.from({ length: 12 }, () => '<span class="vu__seg"></span>').join('')}
          </div>
        </div>
        <div class="insert-row__params">${knobsHtml}</div>
        <div class="seg comp-ratio">
          ${OPTO_MODE_BUTTONS.map((m) => `
            <button type="button" class="seg__btn${insert.params.mode === m.value ? ' is-active' : ''}" data-opto-mode="${m.value}">${m.label}</button>
          `).join('')}
        </div>
      `;
    } else if (insert.type === 'limiter') {
      bodyHtml = `
        <div class="comp-meter">
          <span class="comp-meter__label">GR</span>
          <div class="vu comp-meter__vu">
            ${Array.from({ length: 12 }, () => '<span class="vu__seg"></span>').join('')}
          </div>
        </div>
        <div class="insert-row__params">${knobsHtml}</div>
      `;
    } else if (insert.type === 'geq') {
      // Kein knobsHtml (UI_PARAMS.geq gibt es bewusst nicht, wie bei eq8) --
      // ein Mini-Schieberegler pro festem Band (x-fader im Linear-Modus,
      // s. fader.js), wie an klassischer Graphic-EQ-Hardware, statt Dreh-
      // reglern. Gleiches Grundmuster wie resonators Tune-Regler (Array-
      // Parameter statt Einzelwert).
      bodyHtml = `
        <div class="geq-bands">
          ${GEQ_FREQS.map((freq, i) => `
            <x-fader label="${freq >= 1000 ? `${freq / 1000}k` : freq}" min="-12" max="12" value="${insert.params.bands[i]}" default="0" unit="dB"
              data-geq-band="${i}"></x-fader>
          `).join('')}
        </div>
      `;
    } else if (insert.type === 'eq8') {
      // Kein knobsHtml (UI_PARAMS.eq8 gibt es bewusst nicht) -- der Graph
      // wird nach dem Rendern von setupEq8Graph() imperativ bespielt,
      // damit ein Drag NICHT bei jedem Frame ein komplettes innerHTML-
      // Neubauen auslöst (s. Kommentar über renderInsertChain()).
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
        <p class="eq8__hint">Tap: select/add band · Drag: freq/gain · Two fingers anywhere: Q · Hold: type/remove</p>
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
            <button type="button" class="m-btn insert-row__move" data-move="1" aria-label="Move down" ${idx === owner.inserts.length - 1 ? 'disabled' : ''}>▼</button>
            <button type="button" class="m-btn insert-row__bypass${insert.bypassed ? ' is-active' : ''}" data-bypass>BYP</button>
            <button type="button" class="m-btn insert-row__remove" data-remove aria-label="Remove insert">✕</button>
          </div>
        </header>
        <div class="machine__body">${bodyHtml}</div>
      </section>
    `;
  }).join('');

  for (const row of listEl.querySelectorAll('.insert-module')) {
    const id = parseInt(row.dataset.insertId, 10);
    const insert = owner.inserts.find((i) => i.id === id);
    row.querySelector('[data-move="-1"]')?.addEventListener('click', () => owner.moveInsert(id, -1));
    row.querySelector('[data-move="1"]')?.addEventListener('click', () => owner.moveInsert(id, 1));
    row.querySelector('[data-bypass]').addEventListener('click', () => {
      owner.setInsertBypass(id, !insert.bypassed);
      renderInsertChain(listEl, owner);
    });
    row.querySelector('[data-remove]').addEventListener('click', () => owner.removeInsert(id));
    for (const knob of row.querySelectorAll('x-knob[data-insert-param]')) {
      knob.addEventListener('input', (e) => {
        owner.setInsertParam(id, knob.dataset.insertParam, e.detail.value);
        if (insert.type === 'eq') {
          row.querySelector('.eq-curve__path')?.setAttribute('d',
            eqCurvePath(insert.params.type, insert.params.freq, insert.params.gain, insert.params.q));
        } else if (insert.type === 'drive' && knob.dataset.insertParam === 'drive') {
          const led = row.querySelector('[data-drive-heat]');
          if (led) led.style.opacity = 0.25 + insert.params.drive * 0.75;
        }
      });
      // Automatisierbar wie jeder Maschinen-Knob (s. Machine#render()s data-
      // auto-Schleife) -- eigener Weg statt data-auto, weil Insert-Module
      // bei JEDEM add/remove/move/bypass komplett neu gerendert werden
      // (renderInsertChain() setzt innerHTML neu): der Knoten selbst ist
      // hier NIE stabil, register() muss deshalb bei jedem Rendern erneut
      // auf das jeweils aktuelle Element gebunden werden. Der Lane-
      // Schlüssel (insert.id-basiert, s. inserts.js#createInsert, PLUS
      // owner.laneKeyPrefix -- Maschine oder 'master') bleibt dabei über
      // Reordering UND Neuladen hinweg stabil -- nur SO überlebt eine
      // aufgenommene Fahrt einen Insert-Umbau oder ein Speichern/Laden.
      const autoKey = `${owner.laneKeyPrefix}:insert:${id}:${knob.dataset.insertParam}`;
      automation.register(autoKey, knob, (v) => {
        knob.value = v;
        knob.dispatchEvent(new CustomEvent('input', { detail: { value: v }, bubbles: true }));
      });
      knob.classList.toggle('has-auto', automation.hasLane(autoKey));
    }
    for (const btn of row.querySelectorAll('[data-eq-type]')) {
      btn.addEventListener('click', () => {
        owner.setInsertParam(id, 'type', btn.dataset.eqType);
        renderInsertChain(listEl, owner);
      });
    }
    for (const btn of row.querySelectorAll('[data-filterdelay-type]')) {
      btn.addEventListener('click', () => {
        owner.setInsertParam(id, 'filterType', btn.dataset.filterdelayType);
        renderInsertChain(listEl, owner);
      });
    }
    for (const btn of row.querySelectorAll('[data-filterdelay-sync]')) {
      btn.addEventListener('click', () => {
        owner.setInsertParam(id, 'division', btn.dataset.filterdelaySync);
        renderInsertChain(listEl, owner); // Time-Regler muss ggf. ein-/ausgeblendet werden
      });
    }
    const pingPongBtn = row.querySelector('[data-filterdelay-pingpong]');
    pingPongBtn?.addEventListener('click', () => {
      owner.setInsertParam(id, 'pingPong', !insert.params.pingPong);
      pingPongBtn.classList.toggle('is-active', insert.params.pingPong);
    });
    for (const btn of row.querySelectorAll('[data-resonator-interval]')) {
      btn.addEventListener('click', () => {
        const oldIdx = RESONATOR_INTERVALS.findIndex((t) => t.value === insert.params.interval);
        owner.setInsertParam(id, 'interval', btn.dataset.resonatorInterval);
        const newIdx = RESONATOR_INTERVALS.findIndex((t) => t.value === btn.dataset.resonatorInterval);
        automation.recordSwitch(`${owner.laneKeyPrefix}:insert:${id}:interval`, oldIdx, newIdx);
        renderInsertChain(listEl, owner);
      });
    }
    if (insert.type === 'resonator') {
      // Automatisierbar wie der Chord-Typ beim PolySynth (registerSwitch/
      // recordSwitch, s. automation.js) -- die apply()-Rückgabe der
      // Wiedergabe darf hier bewusst NICHT renderInsertChain() aufrufen
      // (das würde bei jedem der ~45 Ticks/Sekunde die komplette Insert-
      // Liste neu bauen), deshalb ein leichtgewichtiger Direkt-Abgleich der
      // is-active-Klassen (und der 5 Tune-Regler, die ein Preset-Wechsel
      // ebenfalls überschreibt) statt eines vollen Rerenders.
      const seg = row.querySelector('.seg');
      const autoKey = `${owner.laneKeyPrefix}:insert:${id}:interval`;
      automation.registerSwitch(autoKey, seg, (v) => {
        const idx = Math.max(0, Math.min(RESONATOR_INTERVALS.length - 1, Math.round(v)));
        const value = RESONATOR_INTERVALS[idx].value;
        owner.setInsertParam(id, 'interval', value);
        for (const b of seg.querySelectorAll('[data-resonator-interval]')) {
          b.classList.toggle('is-active', b.dataset.resonatorInterval === value);
        }
        for (const knob of row.querySelectorAll('[data-resonator-tune]')) {
          knob.value = insert.params.tune[parseInt(knob.dataset.resonatorTune, 10)];
        }
      });
      seg.classList.toggle('has-auto', automation.hasLane(autoKey));

      // Einzelne Tune-Regler -- eigener Weg statt data-insert-param/
      // setInsertParam (der kennt nur "ein Feld", nicht "ein Feld eines
      // von 5 Bändern", s. inserts.js#setBandTune). Bewusst NICHT
      // automatisierbar (wie die Sample-Editor-Regler in sampler.js) --
      // das Automationssystem erwartet einen einzelnen Lane-Schlüssel pro
      // Regler, 5 zusätzliche Lanes je Resonator-Insert wären ein
      // unverhältnismässiger Ausbau für einen Regler, den man in der
      // Praxis selten laufend automatisiert statt einmalig einzustellen.
      for (const knob of row.querySelectorAll('[data-resonator-tune]')) {
        knob.addEventListener('input', (e) => {
          const i = parseInt(knob.dataset.resonatorTune, 10);
          insert.params.tune[i] = e.detail.value;
          insert.setBandTune?.(i, e.detail.value);
        });
      }
    }
    for (const btn of row.querySelectorAll('[data-ratio-mode]')) {
      btn.addEventListener('click', () => {
        owner.setInsertParam(id, 'ratioMode', btn.dataset.ratioMode);
        renderInsertChain(listEl, owner);
      });
    }
    for (const btn of row.querySelectorAll('[data-opto-mode]')) {
      btn.addEventListener('click', () => {
        owner.setInsertParam(id, 'mode', btn.dataset.optoMode);
        renderInsertChain(listEl, owner);
      });
    }
    // Einzelne Band-Knobs des Graphic EQ -- eigener Weg statt data-insert-
    // param/setInsertParam (der kennt nur "ein Feld", nicht "ein Feld eines
    // von 10 Bändern", s. inserts.js#setBandGain). Bewusst NICHT
    // automatisierbar, gleiche Begründung wie resonators Tune-Regler oben.
    for (const knob of row.querySelectorAll('[data-geq-band]')) {
      knob.addEventListener('input', (e) => {
        const i = parseInt(knob.dataset.geqBand, 10);
        insert.params.bands[i] = e.detail.value;
        insert.setBandGain?.(i, e.detail.value);
      });
    }
    if (insert.type === 'comp' || insert.type === 'opto' || insert.type === 'limiter') startCompMeter(row, insert);
    if (insert.type === 'eq8') setupEq8Graph(row, insert);
  }
}
