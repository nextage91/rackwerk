/**
 * jam-view — Live-Performance-Ansicht: Clips starten, Sound formen, mixen,
 * eine Spalte pro Instrument (wie ein Mischpult mit Clip-Slots obendrauf).
 *
 * Architektur:
 * - Clips laufen NEBEN den A/B/C/D-Pattern-Slots (s. machine.js#addClip,
 *   #bindClipData) — Starten überschreibt nie einen Slot.
 * - Alle Spuren teilen sich einen globalen Takt (den bestehenden
 *   Transport). Ein angetippter Clip wird nicht sofort scharf, sondern
 *   "queued" (wartet) und erst am nächsten Taktanfang (16tel-Vielfaches
 *   von STEPS_PER_BAR) tatsächlich eingeblendet — dieselbe Idee wie
 *   Ableton Live Session View, nur ohne eigenen Zähler pro Spur.
 * - Läuft der Transport gerade NICHT, wird sofort gebunden (kein Warten
 *   auf einen Taktanfang, der nicht kommt).
 * - "Nur Spuren mit aktivem Clip klingen": sobald IRGENDWO im Rack ein
 *   Clip läuft, werden alle Maschinen OHNE aktiven Clip automatisch still
 *   (machine.setJamGate(), s. dort — ein zusätzliches, unabhängiges Gate
 *   neben Mute/Solo, kein persistenter Zustand). Läuft NIRGENDS ein Clip,
 *   ist niemand eingeschränkt — normales Mehrspur-Rack-Verhalten, bis man
 *   anfängt zu jammen. Mehrere gleichzeitig laufende Clips auf
 *   verschiedenen Spuren bleiben dabei bewusst zusammen hörbar (layern),
 *   s. refreshJamGates().
 * - Reglerwerte (Fader/Pan/Sends/Makro-Knobs) laufen über dieselben
 *   Setter/Custom-Elemente wie überall sonst in der App (x-knob/x-fader,
 *   setLevel/setSend/…) — keine Parallel-Implementierung.
 * - Makro-Knobs sind bewusst kuratiert (4 pro Instrument), nicht
 *   vollständig: Metadaten (Label/Bereich/Kurve) werden direkt vom
 *   ECHTEN Knob im Maschinen-Panel abgelesen (kein doppelt gepflegter
 *   Bereich) und per synthetischem `input`-Event auf genau diesem Knob
 *   angewendet — derselbe Weg, den auch die Automation für data-auto-
 *   Knobs nutzt.
 */
import { transport, STEPS_PER_BAR } from '../core/transport.js';
import { undo } from '../core/undo.js';

/** Kuratierte Makro-Parameter je Maschinentyp — bewusst 4, nicht alle.
 *  Bei BeatBox/AnalogKit sind das die SPUR-Regler (Tune/Decay/Level/Snap
 *  der gerade in der Maschine gewählten Spur, this.selected) — dieselben
 *  vier, die im eigenen Panel unter "Pattern" stehen. Kit-Lautstärke hat
 *  bereits den Fader, taucht hier bewusst nicht doppelt auf. */
const MACRO_PARAMS = {
  beatbox: ['tune', 'decay', 'level', 'snap'],
  analogkit: ['tune', 'decay', 'level', 'snap'],
  subsynth: ['cutoff', 'resonance', 'envAmt', 'fDecay'],
  polysynth: ['cutoff', 'resonance', 'envAmt', 'fDecay'],
  percsynth: ['ratio', 'fmAmt', 'sweep', 'decay'],
};
const TRACK_SCOPED_TYPES = new Set(['beatbox', 'analogkit']);

/** Bewegungsschwelle Tippen-vs-Ziehen (px) -- dieselbe wie step-seq.js'
 *  TAP_THRESHOLD für Pitch-Drag: ein echter Finger-Tap hat auf dem Handy
 *  fast immer ein paar Pixel unwillkürliches Zittern. Mit dem alten Wert
 *  von 6px kippte ein normaler Tap regelmäßig fälschlich in den Dragmodus
 *  (unterdrückt dann den Click, s. makeReorderable) -- genau das Symptom
 *  "Clip startet nicht beim Antippen" auf einem echten Gerät. */
const TAP_THRESHOLD = 8;

/** Halten auf einem Clip (wie A/B/C/D-Pattern-Slots, s. pattern-bank.js)
 *  öffnet den Löschen-Chip -- dieselbe Zeitschwelle wie dort. */
const CLIP_HOLD_MS = 500;

/** Ändert einen Parameter über den ECHTEN Knob im Maschinen-Panel — löst
 *  denselben `input`-Pfad aus, den auch Handbewegung/Automation nutzen
 *  (kein `knob-grab` davor, also greift auch kein Trim/keine Aufnahme).
 *  Nimmt den Knob als Referenz statt ihn selbst nachzuschlagen: beim
 *  Ziehen eines Jam-Makro-Reglers feuert das mehrfach pro Geste (jede
 *  Wertänderung), ein erneutes querySelector() ins volle Maschinen-Panel
 *  bei jedem Schritt wäre unnötige, auf älteren iPhones spürbare Arbeit. */
function nudgeParam(knob, value) {
  knob.value = value;
  knob.dispatchEvent(new CustomEvent('input', { detail: { value }, bubbles: true }));
}

function readKnobMeta(machine, key) {
  const knob = machine.el?.querySelector(`x-knob[data-p="${key}"]`);
  if (!knob) return null;
  return {
    knob,
    label: knob.getAttribute('label') || key,
    min: knob.getAttribute('min') ?? '0',
    max: knob.getAttribute('max') ?? '1',
    curve: knob.getAttribute('curve'),
    unit: knob.getAttribute('unit'),
    value: String(knob.value),
  };
}

/** Jeder auf dem Maschinen-Panel sichtbare data-p-Knob ist ein möglicher
 *  X/Y-Pad-Ziel -- bewusst NICHT auf die 4 kuratierten Makros beschränkt
 *  (anders als buildMacros()): das Pad soll "frei" bespielbar sein, wie
 *  gewünscht. Reihenfolge = DOM-Reihenfolge im Panel (Sends zuerst, dann
 *  die maschinen-eigenen Regler), macht die Picker-Liste vorhersehbar. */
function availableXYParams(machine) {
  const knobs = [...(machine.el?.querySelectorAll('x-knob[data-p]') ?? [])];
  return knobs.map((knob) => ({ key: knob.dataset.p, label: knob.getAttribute('label') || knob.dataset.p }));
}

/** Dieselbe Normalisierung wie <x-knob>#toNorm()/#fromNorm() (dort private,
 *  hier dupliziert statt exportiert -- kein Umbau der Komponente nötig).
 *  Sorgt dafür, dass eine Pad-Geste sich exakt so anfühlt wie dasselbe
 *  Ziel direkt am Regler zu drehen, log-Kurven eingeschlossen. Für einen
 *  Regler mit symmetrischem Bereich um einen Mittelwert (z. B. Transpose,
 *  -24..24) landet dessen Standardwert automatisch auf Norm 0.5 -- also
 *  exakt der Pad-Mitte: "0/0 in der Mitte" und "auch ins Minus" ergeben
 *  sich dadurch von selbst, ohne eigene bipolare Pad-Mathematik. */
function normFromValue(value, meta) {
  const min = parseFloat(meta.min), max = parseFloat(meta.max);
  if (meta.curve === 'log') return Math.log(value / min) / Math.log(max / min);
  return (value - min) / (max - min);
}
function valueFromNorm(norm, meta) {
  const min = parseFloat(meta.min), max = parseFloat(meta.max);
  const n = Math.min(1, Math.max(0, norm));
  return meta.curve === 'log' ? min * Math.pow(max / min, n) : min + n * (max - min);
}

/* ---------- X/Y-Pad-Zuordnung (pro Maschine, nicht persistiert -- wie
 * jamState: eine Performance-Einstellung fürs aktuelle Jammen, kein
 * Projekt-Zustand). Default deckt sich mit dem alten, festen Verhalten
 * (Delay/Reverb), damit sich fürs bestehende Jam-Setup nichts ändert,
 * solange niemand die Achse umbelegt. ---------- */
const xyState = new WeakMap();
function xyStateFor(machine) {
  let st = xyState.get(machine);
  if (!st) { st = { xKey: 'sendDelay', yKey: 'sendReverb' }; xyState.set(machine, st); }
  return st;
}

/** Achsen-Wahlmenü: derselbe Popup-Baukasten wie openClipDeleteMenu (ein
 *  einzelnes, modulweites Chip, damit nie zwei gleichzeitig offen stehen),
 *  aber mit einer ganzen Options-Liste statt eines einzelnen Buttons. */
let xyMenu = null;
const dismissXYMenu = () => {
  xyMenu?.remove();
  xyMenu = null;
  document.removeEventListener('pointerdown', onOutsideXYMenu, true);
};
const onOutsideXYMenu = (e) => { if (xyMenu && !xyMenu.contains(e.target)) dismissXYMenu(); };

function openXYPicker(machine, axisLabel, anchorEl, onPick) {
  dismissXYMenu();
  xyMenu = document.createElement('div');
  xyMenu.className = 'xy-picker';
  xyMenu.innerHTML = `<div class="xy-picker__head">${axisLabel} axis</div>`;
  for (const { key, label } of availableXYParams(machine)) {
    const btn = document.createElement('button');
    btn.className = 'xy-picker__btn';
    btn.textContent = label;
    btn.addEventListener('click', () => {
      onPick(key);
      dismissXYMenu();
    });
    xyMenu.appendChild(btn);
  }
  document.body.appendChild(xyMenu);
  const r = anchorEl.getBoundingClientRect();
  const left = Math.max(8, Math.min(
    window.innerWidth - xyMenu.offsetWidth - 8,
    r.left + r.width / 2 - xyMenu.offsetWidth / 2,
  ));
  const top = Math.max(8, Math.min(window.innerHeight - xyMenu.offsetHeight - 8, r.top - xyMenu.offsetHeight - 8));
  xyMenu.style.left = `${left}px`;
  xyMenu.style.top = `${top}px`;
  setTimeout(() => document.addEventListener('pointerdown', onOutsideXYMenu, true), 0);
}

/* ---------- Jam-Wiedergabezustand (pro Maschine, nicht persistiert) ---------- */
const jamState = new WeakMap();
function stateFor(machine) {
  let st = jamState.get(machine);
  if (!st) { st = { activeClipId: null, queuedClipId: null }; jamState.set(machine, st); }
  return st;
}

/** DOM-Referenzen der aktuell gerenderten Spalten — nur gültig, während
 *  das Jam-Sheet offen ist (renderJamView() baut sie neu). */
const columnEls = new WeakMap();

let boundRack = null;

/** Einmal beim App-Start aufrufen — merkt sich das Rack und registriert
 *  den EINEN globalen Takt-Listener, der Clips quantisiert umschaltet.
 *  Läuft unabhängig davon, ob das Jam-Sheet gerade sichtbar ist (wie ein
 *  echter Clip-Launcher: einmal angetippt, wird er auch dann noch am
 *  nächsten Taktanfang scharf, wenn man zwischendurch wegnavigiert). */
export function initJamView(rack) {
  boundRack = rack;
  transport.addListener({
    onStep(step) {
      if (step % STEPS_PER_BAR !== 0) return;
      for (const machine of boundRack?.machines ?? []) {
        const st = stateFor(machine);
        if (st.queuedClipId == null) continue;
        promoteQueuedClip(machine, st);
      }
    },
  });
}

function promoteQueuedClip(machine, st) {
  const clip = machine.clips.find((c) => c.id === st.queuedClipId);
  st.activeClipId = st.queuedClipId;
  st.queuedClipId = null;
  if (clip) machine.bindClipData(clip.data);
  refreshClipStates(machine);
  refreshJamGates();
}

/** "Nur Spuren mit aktivem Clip klingen": sobald IRGENDWO im Rack ein
 *  Clip läuft, werden alle Maschinen OHNE aktiven Clip automatisch
 *  stummgeschaltet (über machine.setJamGate — unabhängig von Mute/Solo,
 *  kein persistenter Zustand). Läuft gerade NIRGENDS ein Clip, ist
 *  niemand eingeschränkt (normales Rack-Verhalten, bevor überhaupt
 *  gejammt wird). Mehrere Clips auf verschiedenen Spuren bleiben dabei
 *  weiterhin gleichzeitig hörbar (layern) — nur Spuren, die GAR keinen
 *  Clip fahren, werden stumm. Nach jeder Clip-Start/-Stop-Aktion neu
 *  ausgewertet. */
function refreshJamGates() {
  const list = boundRack?.machines ?? [];
  const jamActive = list.some((m) => stateFor(m).activeClipId != null);
  for (const m of list) {
    m.setJamGate(!jamActive || stateFor(m).activeClipId != null);
  }
}

/** Clip antippen: läuft er bereits, sofortiger Stop (kein Warten auf
 *  einen zweiten Taktanfang nötig, symmetrisch zum STOP-Button). Sonst
 *  quantisiert einreihen — oder sofort, wenn der Transport gerade steht. */
function toggleClip(machine, clipId) {
  const st = stateFor(machine);
  if (st.activeClipId === clipId) {
    stopClip(machine);
    return;
  }
  if (!transport.isPlaying) {
    st.queuedClipId = clipId;
    promoteQueuedClip(machine, st);
    return;
  }
  st.queuedClipId = clipId;
  refreshClipStates(machine);
}

/** Zurück zum normalen A/B/C/D-Pattern der Maschine — der Clip lief
 *  NEBEN patternIndex, ein erneutes setPatternIndex(patternIndex) bindet
 *  also einfach wieder das reguläre Pattern, ohne dass irgendwas anderes
 *  angefasst werden musste. */
function stopClip(machine) {
  const st = stateFor(machine);
  st.activeClipId = null;
  st.queuedClipId = null;
  machine.setPatternIndex(machine.patternIndex);
  refreshClipStates(machine);
  refreshJamGates();
}

function refreshClipStates(machine) {
  const cols = columnEls.get(machine);
  if (!cols) return; // Sheet gerade nicht offen -- nichts zu tun
  const st = stateFor(machine);
  for (const el of cols.clipsEl.querySelectorAll('.clip')) {
    const id = Number(el.dataset.clipId);
    el.dataset.state = id === st.activeClipId ? 'playing' : id === st.queuedClipId ? 'queued' : 'filled';
  }
}

/** Entfernt einen Clip endgültig (mit Undo-Angebot, wie Pattern-Clear in
 *  step-seq.js). Läuft/wartet der gelöschte Clip gerade, wird er zuerst
 *  regulär gestoppt (stopClip kümmert sich um Pattern-Rückkehr + Jam-Gates
 *  -- kein Sonderfall nötig). Undo fügt denselben Clip (gleiche id) an
 *  seiner ursprünglichen Position wieder ein, startet ihn aber nicht neu. */
function deleteClip(machine, clipId) {
  const idx = machine.clips.findIndex((c) => c.id === clipId);
  if (idx === -1) return;
  const clip = machine.clips[idx];

  const st = stateFor(machine);
  if (st.activeClipId === clipId || st.queuedClipId === clipId) stopClip(machine);

  machine.removeClip(clipId);
  const cols = columnEls.get(machine);
  if (cols) renderClips(machine, cols.clipsEl);

  undo.offer(`Clip "${clip.name}" deleted`, () => {
    machine.clips.splice(idx, 0, clip);
    const cols2 = columnEls.get(machine);
    if (cols2) renderClips(machine, cols2.clipsEl);
  });
}

/** Halten-Chip zum Löschen eines Clips -- ein einzelnes, modulweites
 *  Popup (wie pattern-bank.js' Kontext-Chip), da hier mehrere Spalten
 *  gleichzeitig Clips zeigen können: es soll trotzdem immer nur EIN Chip
 *  offen sein. */
let clipMenu = null;
const dismissClipMenu = () => {
  clipMenu?.remove();
  clipMenu = null;
  document.removeEventListener('pointerdown', onOutsideClipMenu, true);
};
const onOutsideClipMenu = (e) => { if (clipMenu && !clipMenu.contains(e.target)) dismissClipMenu(); };

function openClipDeleteMenu(machine, clipId, anchorEl) {
  dismissClipMenu();
  clipMenu = document.createElement('div');
  clipMenu.className = 'pat-chip';
  const delBtn = document.createElement('button');
  delBtn.className = 'pat-chip__btn pat-chip__btn--danger';
  delBtn.textContent = '🗑 Delete Clip';
  delBtn.addEventListener('click', () => {
    deleteClip(machine, clipId);
    dismissClipMenu();
  });
  clipMenu.appendChild(delBtn);
  document.body.appendChild(clipMenu);
  // über dem Clip platzieren, am Bildschirmrand einklemmen (wie pattern-bank.js)
  const r = anchorEl.getBoundingClientRect();
  const left = Math.max(8, Math.min(
    window.innerWidth - clipMenu.offsetWidth - 8,
    r.left + r.width / 2 - clipMenu.offsetWidth / 2,
  ));
  clipMenu.style.left = `${left}px`;
  clipMenu.style.top = `${Math.max(8, r.top - clipMenu.offsetHeight - 8)}px`;
  setTimeout(() => document.addEventListener('pointerdown', onOutsideClipMenu, true), 0);
  clearTimeout(clipMenu.dismissTimer);
  clipMenu.dismissTimer = setTimeout(dismissClipMenu, 4000);
}

/* ---------- Rendering ---------- */

function renderClips(machine, clipsEl) {
  if (!machine.clips.length) {
    clipsEl.innerHTML = '<div class="clips-empty">No clips yet.<br>Hold a pattern slot in the Rack.</div>';
    return;
  }
  const st = stateFor(machine);
  clipsEl.innerHTML = machine.clips.map((clip) => {
    const state = clip.id === st.activeClipId ? 'playing' : clip.id === st.queuedClipId ? 'queued' : 'filled';
    return `
      <div class="clip" data-clip-id="${clip.id}" data-state="${state}">
        <span class="clip__progress"></span>
        <span class="clip__label">${clip.name}</span>
      </div>
    `;
  }).join('');
  clipsEl.querySelectorAll('.clip').forEach((el) => {
    el.addEventListener('click', () => {
      if (el.dataset.suppressClick) return;
      toggleClip(machine, Number(el.dataset.clipId));
    });
  });
  makeReorderable(clipsEl, machine);
}

/** Clips innerhalb ihrer Spalte per Ziehen umsortieren (Pointer-Events,
 *  kein HTML5-Drag&Drop -- das funktioniert auf iPhone/Touch nicht
 *  zuverlässig). Tauscht bei Überschreiten der halben Nachbarhöhe mit
 *  dem direkten Nachbarn, reicht für die kurzen Listen hier völlig. */
function makeReorderable(clipsEl, machine) {
  let dragEl = null, pointerId = null, startY = 0;
  let holdTimer = null;
  // Bleibt über die ganze Geste bestehen (nicht per Timeout selbst wieder
  // gelöscht!) -- der Löschen-Chip kann beliebig lange offen stehen, bevor
  // der Finger tatsächlich losgelassen wird; suppressClick muss erst in
  // release() gesetzt werden, genau dann, wenn der Click-Handler ihn auch
  // wirklich prüft (sonst wäre ein zu früh selbst-löschendes Flag längst
  // wieder weg und der Loslasser würde den Clip zusätzlich starten/stoppen).
  let heldForDelete = false;

  const cancelHold = () => { clearTimeout(holdTimer); holdTimer = null; };

  clipsEl.addEventListener('pointerdown', (e) => {
    const clip = e.target.closest('.clip');
    if (!clip) return;
    dragEl = clip;
    pointerId = e.pointerId;
    startY = e.clientY;
    heldForDelete = false;
    // Halten (wie A/B/C/D-Slots, s. pattern-bank.js) öffnet den Löschen-
    // Chip -- bricht ab, sobald daraus ein echtes Ziehen wird (s. pointer-
    // move) oder der Finger vorher losgelassen wird.
    holdTimer = setTimeout(() => {
      holdTimer = null;
      heldForDelete = true;
      openClipDeleteMenu(machine, Number(clip.dataset.clipId), clip);
    }, CLIP_HOLD_MS);
  });

  clipsEl.addEventListener('pointermove', (e) => {
    if (!dragEl || e.pointerId !== pointerId) return;
    const dy = e.clientY - startY;
    if (!dragEl.classList.contains('is-dragging')) {
      if (Math.abs(dy) < TAP_THRESHOLD) return;
      cancelHold();
      dragEl.classList.add('is-dragging');
      dragEl.setPointerCapture(pointerId);
    }
    dragEl.style.transform = `translateY(${dy}px)`;

    const h = dragEl.offsetHeight + 5; // Höhe + Lückenabstand (s. .clips gap)
    if (dy > h / 2) {
      const next = dragEl.nextElementSibling;
      if (next) {
        clipsEl.insertBefore(next, dragEl);
        startY += h;
        dragEl.style.transform = `translateY(${dy - h}px)`;
      }
    } else if (dy < -h / 2) {
      const prev = dragEl.previousElementSibling;
      if (prev) {
        clipsEl.insertBefore(dragEl, prev);
        startY -= h;
        dragEl.style.transform = `translateY(${dy + h}px)`;
      }
    }
  });

  const release = (e) => {
    if (!dragEl || e.pointerId !== pointerId) return;
    cancelHold();
    const wasDragging = dragEl.classList.contains('is-dragging');
    dragEl.classList.remove('is-dragging');
    dragEl.style.transform = '';
    if (wasDragging) {
      const order = [...clipsEl.children].map((el) => Number(el.dataset.clipId));
      machine.clips = order.map((id) => machine.clips.find((c) => c.id === id));
    }
    if (wasDragging || heldForDelete) {
      dragEl.dataset.suppressClick = '1';
      setTimeout(() => { if (dragEl) delete dragEl.dataset.suppressClick; }, 80);
    }
    dragEl = null; pointerId = null;
  };
  clipsEl.addEventListener('pointerup', release);
  clipsEl.addEventListener('pointercancel', release);
}

/** Frei belegbares X/Y-Pad: jede Achse ist auf einen beliebigen data-p-
 *  Knob der Maschine gemappt (Tippen auf das Achsen-Label öffnet den
 *  Picker, s. openXYPicker). Die Pad-Mitte entspricht IMMER der Mitte des
 *  aktuell zugeordneten Reglerbereichs (normFromValue/valueFromNorm,
 *  dieselbe Kurven-Mathematik wie <x-knob>) -- bei einem symmetrischen
 *  Bereich wie Transpose (-24..24) landet der Neutralwert dadurch exakt
 *  in der Pad-Mitte und Ziehen nach links ergibt einen negativen Wert,
 *  ganz ohne eigene bipolare Sonderbehandlung. Default bleibt Delay/
 *  Reverb (deckt sich mit dem alten, festen Verhalten). */
function buildXYPad(machine) {
  const wrap = document.createElement('div');
  wrap.className = 'xy-wrap';
  wrap.innerHTML = `
    <div class="xypad">
      <div class="xypad__grid"></div>
      <div class="xypad__dot"></div>
      <button type="button" class="xypad__axis xypad__axis--x"></button>
      <button type="button" class="xypad__axis xypad__axis--y"></button>
    </div>
  `;
  const pad = wrap.querySelector('.xypad');
  const dot = pad.querySelector('.xypad__dot');
  const xBtn = wrap.querySelector('.xypad__axis--x');
  const yBtn = wrap.querySelector('.xypad__axis--y');
  const st = xyStateFor(machine);

  const syncLabels = () => {
    xBtn.textContent = `${(readKnobMeta(machine, st.xKey)?.label ?? st.xKey).toUpperCase()} →`;
    yBtn.textContent = `↑ ${(readKnobMeta(machine, st.yKey)?.label ?? st.yKey).toUpperCase()}`;
  };
  const syncDot = () => {
    const xMeta = readKnobMeta(machine, st.xKey);
    const yMeta = readKnobMeta(machine, st.yKey);
    const x = xMeta ? normFromValue(parseFloat(xMeta.value), xMeta) : 0.5;
    const y = yMeta ? normFromValue(parseFloat(yMeta.value), yMeta) : 0.5;
    dot.style.left = `${Math.min(1, Math.max(0, x)) * 100}%`;
    dot.style.top = `${(1 - Math.min(1, Math.max(0, y))) * 100}%`;
  };
  syncLabels();
  syncDot();

  let dragging = false;
  // Startet ein Pointerdown auf/nahe einem Achsen-Label (deren Tap-Fläche
  // per CSS-Padding bewusst über den sichtbaren Text hinausreicht, sitzt
  // aber direkt in der Pad-Ecke), erst bei ECHTER Bewegung über
  // TAP_THRESHOLD zu einem Drag machen -- sonst würde jeder Tap aufs Label
  // (öffnet den Picker) den Punkt zugleich in die Ecke springen lassen,
  // und ein Drag, der zufällig genau in der Ecke beginnt, könnte nie
  // starten. Ein Pointerdown ausserhalb der Labels bleibt wie gehabt ein
  // sofortiger Sprung (kein Schwellwert nötig, kein Label im Weg).
  // WICHTIG: setPointerCapture() NUR aufrufen, wenn es wirklich zu einem
  // Drag wird -- sonst leitet Chromium das nachfolgende SYNTHETISCHE
  // click-Event vom Achsen-Button auf das Pad um (der Button feuert dann
  // nie), ein reiner Tap aufs Label würde den Picker also nie öffnen.
  // (jsdom bildet dieses Capture-Verhalten nicht nach, daher fiel das
  // erst im echten Browser auf.)
  let pendingStart = null;
  const setFromEvent = (e) => {
    const r = pad.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    dot.style.left = `${x * 100}%`;
    dot.style.top = `${y * 100}%`;
    const xMeta = readKnobMeta(machine, st.xKey);
    const yMeta = readKnobMeta(machine, st.yKey);
    if (xMeta) nudgeParam(xMeta.knob, valueFromNorm(x, xMeta));
    if (yMeta) nudgeParam(yMeta.knob, valueFromNorm(1 - y, yMeta));
  };
  pad.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.xypad__axis')) {
      pendingStart = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };
      return;
    }
    dragging = true;
    pad.setPointerCapture(e.pointerId);
    setFromEvent(e);
  });
  pad.addEventListener('pointermove', (e) => {
    if (dragging) { setFromEvent(e); return; }
    if (!pendingStart || e.pointerId !== pendingStart.pointerId) return;
    const dx = e.clientX - pendingStart.x, dy = e.clientY - pendingStart.y;
    if (Math.hypot(dx, dy) < TAP_THRESHOLD) return;
    dragging = true;
    pad.setPointerCapture(e.pointerId);
    setFromEvent(e);
  });
  const releasePad = () => { dragging = false; pendingStart = null; };
  pad.addEventListener('pointerup', releasePad);
  pad.addEventListener('pointercancel', releasePad);

  xBtn.addEventListener('click', () => openXYPicker(machine, 'X', xBtn, (key) => {
    st.xKey = key;
    syncLabels();
    syncDot();
  }));
  yBtn.addEventListener('click', () => openXYPicker(machine, 'Y', yBtn, (key) => {
    st.yKey = key;
    syncLabels();
    syncDot();
  }));

  return wrap;
}

function buildMacros(machine) {
  const type = machine.constructor.meta.type;
  const params = MACRO_PARAMS[type] ?? [];
  const wrap = document.createElement('div');
  wrap.className = 'macros';
  for (const key of params) {
    const meta = readKnobMeta(machine, key);
    if (!meta) continue;
    const knob = document.createElement('x-knob');
    knob.setAttribute('label', meta.label);
    knob.setAttribute('min', meta.min);
    knob.setAttribute('max', meta.max);
    if (meta.curve) knob.setAttribute('curve', meta.curve);
    if (meta.unit) knob.setAttribute('unit', meta.unit);
    knob.setAttribute('value', meta.value);
    knob.addEventListener('input', (e) => nudgeParam(meta.knob, e.detail.value));
    wrap.appendChild(knob);
  }
  return wrap;
}

function buildColumn(machine) {
  const { color } = machine.constructor.meta;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  const col = document.createElement('div');
  col.className = 'channel';
  col.style.setProperty('--ch-color', color);
  col.style.setProperty('--ch-glow', `rgba(${r},${g},${b},.5)`);

  // IMMER rendern (auch leer für Nicht-Drum-Maschinen), nie ganz weglassen:
  // ein bedingt weggelassenes Element macht die Fixhöhe von .strip je nach
  // Maschinentyp unterschiedlich hoch, was Fader/Encoder/XY-Pad zwischen
  // den Spalten gegeneinander verschiebt (schon mal gesehen, s. Verlauf
  // zur Makro-Knob-Ausrichtung). .channel__track reserviert seine Höhe
  // per CSS auch leer.
  const trackLabel = `<div class="channel__track">${
    TRACK_SCOPED_TYPES.has(machine.constructor.meta.type) ? (machine.tracks[machine.selected]?.name ?? '') : ''
  }</div>`;

  col.innerHTML = `
    <div class="channel__head">
      <span class="channel__stripe"></span>
      <div class="channel__name">${machine.constructor.meta.name}<small>#${machine.id}</small></div>
    </div>
    <div class="clips"></div>
    <button type="button" class="clip-stop">STOP</button>
  `;
  col.querySelector('.clip-stop').addEventListener('click', () => stopClip(machine));

  const clipsEl = col.querySelector('.clips');
  renderClips(machine, clipsEl);

  col.appendChild(buildXYPad(machine));

  const strip = document.createElement('div');
  strip.className = 'strip';
  strip.innerHTML = `
    <div class="strip__row">
      <button type="button" class="msbtn is-solo${machine.soloed ? ' is-active' : ''}">SOLO</button>
      <button type="button" class="msbtn is-mute${machine.muted ? ' is-active' : ''}">MUTE</button>
    </div>
    <div class="fader-row"></div>
    ${trackLabel}
  `;
  const soloBtn = strip.querySelector('.is-solo');
  const muteBtn = strip.querySelector('.is-mute');
  soloBtn.addEventListener('click', () => { machine.setSoloed(!machine.soloed); soloBtn.classList.toggle('is-active', machine.soloed); });
  muteBtn.addEventListener('click', () => { machine.setMuted(!machine.muted); muteBtn.classList.toggle('is-active', machine.muted); });

  const fader = document.createElement('x-fader');
  fader.setAttribute('default', '1');
  fader.setAttribute('value', String(machine.level));
  fader.addEventListener('input', (e) => machine.setLevel(e.detail.value));
  strip.querySelector('.fader-row').appendChild(fader);
  strip.querySelector('.fader-row').appendChild(buildMacros(machine));

  col.appendChild(strip);

  columnEls.set(machine, { col, clipsEl });
  return col;
}

/** Baut die komplette Jam-Ansicht neu — beim Öffnen des Sheets aufgerufen
 *  (wie Mixer#render()), damit sie immer den aktuellen Rack-Zustand
 *  zeigt (Maschinen hinzugefügt/entfernt, Namen/Farben etc.). */
export function renderJamView(listEl) {
  listEl.innerHTML = '';
  for (const machine of boundRack?.machines ?? []) {
    listEl.appendChild(buildColumn(machine));
  }
  // Fängt z. B. eine Maschine ab, die WÄHREND laufender Clip-Wiedergabe neu
  // ins Rack kam (setJamGate() lief für sie noch nie) — beim (Wieder-)
  // Öffnen des Sheets bekommt jede Maschine garantiert den aktuell
  // korrekten Gate-Zustand.
  refreshJamGates();
}
