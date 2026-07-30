/**
 * modular-view.js — die Modular-Maschine als "Rack im Rack": Module stecken
 * wie Maschinen im Hauptrack in einer Liste (Vorderseite: Name + Regler
 * direkt in der Zeile, ▲/▼ zum Umsortieren, Halten für Duplizieren/
 * Entfernen, "+ Add Module" am Ende). Ein Flip-Button dreht dieselbe Liste
 * auf die Rückseite: dort erscheinen dieselben Module als frei
 * VERSCHIEBBARE Kacheln auf einer zweidimensional pan-baren Steckfläche --
 * wie Caustics eigenes Modular (recherchiert, s. Chat: "schau auch nochmals
 * wie das caustic in ihrem modular gelöst haben"): Eingänge links, Ausgänge
 * rechts an jeder Kachel (Signalfluss liest sich wie ein Schaltplan von
 * links nach rechts), Kabel sind Kurven, die live den tatsächlichen Jack-
 * Positionen folgen. Verbinden bleibt wie zuvor: Ausgang antippen, dann
 * Eingang antippen (Ziehen geht auch); ✕ neben einem belegten Eingang ODER
 * das Kabel selbst antippen zum Trennen.
 *
 * ZWEI vorige Fassungen sind daran gescheitert, eine EINZIGE feste
 * Anordnung zu erraten, die für jeden Patch übersichtlich bleibt: erst
 * Module übereinander gestapelt (Kabel liefen unsichtbar unter fremden
 * Zeilen hindurch), dann nebeneinander in einer Reihe (Kabel liefen durch
 * eine schmale Seitenspur, laut Feedback weiterhin unübersichtlich). Der
 * eigentliche Kniff bei Caustic (und jedem echten Modularsystem) ist gar
 * nicht die Kabel-Optik, sondern dass der NUTZER selbst festlegt, wo ein
 * Modul steht -- Kabel-Chaos räumt man auf, indem man Module verschiebt,
 * nicht indem die App eine cleverere Anordnung errät. Deshalb hier: Modul-
 * Kopfzeile ziehen verschiebt die Kachel (Position wird in ModularPatch
 * gespeichert, s. core/modular.js#moveModuleTo/serialize), leere Fläche
 * ziehen pan't die ganze Steckfläche.
 *
 * Pan (Ziehen) UND Zoom (Pinch) laufen VOLLSTÄNDIG selbst gebaut über
 * Pointer Events, NICHT über natives overflow:auto-Scrollen (frühere
 * Fassung) -- exakt das Muster, das praktisch jeder unendliche Canvas im
 * Web nutzt (Figma, tldraw, die panzoom-Bibliothek): ein einziger
 * `transform: translate(panX,panY) scale(zoom)` auf der Kachel-Ebene
 * (.modrack__boxes), panX/panY/zoom sind reiner ANSICHTS-Zustand (nie in
 * ModularPatch gespeichert, nie mit Modul-x/y verwechselt). Der Wechsel weg
 * von nativem Scrollen hat einen konkreten, recherchierten Grund: iOS
 * Safari setzt scrollLeft/scrollTop, die man WÄHREND einer laufenden
 * Touch-Geste per JS zuweist (z. B. um beim Pinch-Zoom den Punkt unter den
 * Fingern festzuhalten), unzuverlässig um -- das ist ein bekanntes,
 * dokumentiertes WebKit-Verhalten, keine Vermutung (Nutzer-Feedback nach
 * genau so einem Versuch: "touch steuerung ist eher schlimmer geworden").
 * Ein selbst verwalteter Zahlenwert (panX/panY) plus CSS-Transform umgeht
 * das vollständig -- kein Scroll-Engine-Verhalten, das sich einmischen
 * könnte.
 *
 * Das Kabel-SVG (.modrack__cables) hängt bewusst NICHT innerhalb der
 * transformierten Ebene, sondern als eigenes, UNVERÄNDERTES Geschwister-
 * Element direkt im (fixen) .modrack__canvas-wrap -- sonst würde es doppelt
 * skaliert (transform würde vom Elternteil geerbt UND updateCables() misst
 * bereits die echten, bereits transformierten Bildschirm-Koordinaten der
 * Ports). Kabel-Koordinaten sind deshalb relativ zum WRAP (nicht zur
 * transformierten Kachel-Ebene) -- bleiben dadurch bei jedem Pan/Zoom
 * automatisch korrekt, weil sie aus den tatsächlichen (transformierten)
 * Port-Positionen gemessen werden, s. updateCables().
 *
 * Die Listen-Reihenfolge (ModularPatch#moveModule) bleibt die Sortierung
 * der VORDERSEITE -- x/y (Rückseite) ist davon unabhängig, ein Modul in der
 * Reglerliste umzusortieren verschiebt seine Kachel auf der Steckfläche
 * nicht.
 *
 * renderModularRack() wird EINMAL pro Maschine beim Bauen ihrer Bedien-
 * oberfläche aufgerufen (s. machines/modular.js#buildControls) und baut
 * die komplette UI direkt in deren eigenen Fokus-Bereich -- kein
 * eigenständiges Sheet-Overlay mehr wie bisher, jede Instanz hat ihre
 * eigene, unabhängige Rack-Liste (kein Singleton nötig, anders als der
 * "+ Add Module"-Picker und das Halten-Menü unten, die wie überall sonst
 * in der App als eine einzige wiederverwendete Sheet-Instanz laufen).
 *
 * WICHTIG: die Maschine wird beim Hinzufügen einmalig UNSICHTBAR gebaut
 * (s. rack.js#mount -- .machine-focus startet mit hidden=true, erst später
 * sichtbar gemacht). getBoundingClientRect() auf einem noch nicht
 * layouteten/sichtbaren Baum liefert überall (0,0) -- deshalb rendert
 * renderBack() (Kachel-Positionen, Kabel-Pfade) bewusst NICHT beim ersten
 * Bau, sondern erst faul, wenn der Nutzer tatsächlich auf die Rückseite
 * umschaltet (ein Klick, der zwangsläufig erst passiert, wenn das Fokus-
 * Panel längst sichtbar ist).
 */
import { MODULE_TYPES, MODULE_PORTS, MODULE_UI_PARAMS, OSCILLATOR_WAVES, FILTER_TYPES, moduleMeta } from '../core/modular.js';

export function renderModularRack(container, machine) {
  const patch = machine.patch;
  let face = 'front';
  // Ansichts-Zustand der Steckfläche (Rückseite) -- reines Pan/Zoom der
  // KAMERA, nie in ModularPatch gespeichert und nie mit Modul-x/y
  // verwechselt, s. Dateikopf-Kommentar.
  let zoom = 1;
  let panX = 0, panY = 0;

  const root = document.createElement('div');
  root.className = 'modrack';
  root.style.setProperty('--m-color', machine.constructor.meta.color);
  root.innerHTML = `
    <div class="modrack__head">
      <span class="modrack__title">Patch</span>
      <button type="button" class="m-btn modrack__flip" data-flip>🔄 Flip to Patch Bay</button>
    </div>
    <p class="modrack__hint" data-hint>Hold a module for options · tap + to add one</p>
    <div class="modrack__list" data-list></div>
    <button type="button" class="rack__add modrack__add" data-add-module>+ Add Module</button>
    <div class="modrack__canvas-outer" data-canvas-outer hidden>
      <button type="button" class="m-btn modrack__canvas-fullscreen" data-fullscreen aria-label="Toggle fullscreen patch bay">⛶</button>
      <div class="modrack__canvas-wrap" data-jackswrap>
        <svg class="modrack__cables" data-cables></svg>
        <div class="modrack__canvas" data-canvas>
          <div class="modrack__boxes" data-jacks></div>
        </div>
      </div>
    </div>
  `;
  container.appendChild(root);

  const listEl = root.querySelector('[data-list]');
  const addBtn = root.querySelector('[data-add-module]');
  const hintEl = root.querySelector('[data-hint]');
  const canvasOuterEl = root.querySelector('[data-canvas-outer]');
  const jacksWrapEl = root.querySelector('[data-jackswrap]');
  const jacksEl = root.querySelector('[data-jacks]');
  const svgEl = root.querySelector('[data-cables]');
  const flipBtn = root.querySelector('[data-flip]');
  const fullscreenBtn = root.querySelector('[data-fullscreen]');

  /* ---------- Vorderseite: Regler-Liste ---------- */

  function knobHtml(moduleId, def, value) {
    return `
      <x-knob label="${def.label}" min="${def.min}" max="${def.max}" value="${value}"
        ${def.curve ? `curve="${def.curve}"` : ''} ${def.unit ? `unit="${def.unit}"` : ''} ${def.step ? `step="${def.step}"` : ''}
        data-module-id="${moduleId}" data-module-param="${def.key}"></x-knob>
    `;
  }

  function enumButtonsHtml(moduleId, key, options, current) {
    return `
      <div class="seg modrack__row-seg" data-module-id="${moduleId}" data-module-enum="${key}">
        ${options.map((o) => `<button type="button" class="seg__btn${o.value === current ? ' is-active' : ''}" data-value="${o.value}">${o.label}</button>`).join('')}
      </div>
    `;
  }

  function rowHtml(id, m, index, count) {
    const paramDefs = MODULE_UI_PARAMS[m.type] ?? [];
    let enumHtml = '';
    if (m.type === 'oscillator' || m.type === 'lfo') enumHtml += enumButtonsHtml(id, 'wave', OSCILLATOR_WAVES, m.params.wave);
    if (m.type === 'filter') enumHtml += enumButtonsHtml(id, 'type', FILTER_TYPES, m.params.type);

    return `
      <div class="modrack__row" data-module-id="${id}">
        <div class="modrack__row-head">
          <span class="modrack__row-name">${moduleMeta(m.type).name}</span>
          <span class="modrack__row-move">
            <button type="button" class="m-btn rack-row__move-btn" data-move="-1" aria-label="Move up" ${index === 0 ? 'disabled' : ''}>▲</button>
            <button type="button" class="m-btn rack-row__move-btn" data-move="1" aria-label="Move down" ${index === count - 1 ? 'disabled' : ''}>▼</button>
          </span>
        </div>
        ${enumHtml}
        ${paramDefs.length ? `<div class="modrack__row-params">${paramDefs.map((d) => knobHtml(id, d, m.params[d.key])).join('')}</div>` : ''}
      </div>
    `;
  }

  function renderFront() {
    const entries = [...patch.modules.entries()];
    listEl.innerHTML = entries.map(([id, m], i) => rowHtml(id, m, i, entries.length)).join('');

    for (const knob of listEl.querySelectorAll('x-knob[data-module-id]')) {
      knob.addEventListener('input', (e) => {
        patch.setModuleParam(Number(knob.dataset.moduleId), knob.dataset.moduleParam, e.detail.value);
      });
    }
    for (const seg of listEl.querySelectorAll('[data-module-enum]')) {
      const id = Number(seg.dataset.moduleId);
      const key = seg.dataset.moduleEnum;
      seg.querySelectorAll('[data-value]').forEach((btn) => {
        btn.addEventListener('click', () => {
          patch.setModuleParam(id, key, btn.dataset.value);
          seg.querySelectorAll('[data-value]').forEach((b) => b.classList.toggle('is-active', b === btn));
        });
      });
    }
    for (const btn of listEl.querySelectorAll('[data-move]')) {
      btn.addEventListener('click', () => {
        const id = Number(btn.closest('.modrack__row').dataset.moduleId);
        patch.moveModule(id, Number(btn.dataset.move));
        refreshAll();
      });
    }
  }

  /* ---------- Rückseite: frei verschiebbare Steckfläche ----------
     Jede Kachel hat Eingänge links, Ausgänge rechts (Caustic-Konvention,
     s. Dateikopf-Kommentar) -- Signalfluss liest sich von links nach
     rechts wie ein Schaltplan. Die Kopfzeile einer Kachel ist der Zieh-
     Griff zum Verschieben; leere Fläche ziehen scrollt/pan't die ganze
     Steckfläche (natives 2-Achsen-Scrollen des Wraps). */

  function inPortHtml(id, p) {
    const cable = patch.cables.find((c) => c.toId === id && c.toPort === p.key);
    // Ein belegter Eingang bekommt ein eigenes, grosses "✕" zum Trennen --
    // das dünne Kabel selbst antippen bleibt zusätzlich möglich (breiterer
    // unsichtbarer Trefferbereich, s. updateCables()), aber dieser Button
    // ist ein garantiert leicht zu treffendes Ziel, unabhängig vom
    // Kabelverlauf (Chat: "ich habe es nicht geschafft [ein Kabel zu
    // entfernen]").
    return `
      <span class="port port--in" data-module-id="${id}" data-port-dir="in" data-port-key="${p.key}">
        <span class="port__dot"></span>${p.label}
        ${cable ? `<button type="button" class="port__remove" data-remove-cable="${cable.id}" aria-label="Disconnect ${p.label}">✕</button>` : ''}
      </span>
    `;
  }

  function modBoxHtml(id, m) {
    const ports = MODULE_PORTS[m.type];
    return `
      <div class="modrack__mod-box" data-module-id="${id}" style="left:${m.x}px; top:${m.y}px;">
        <div class="modrack__mod-box-head">${moduleMeta(m.type).name}</div>
        <div class="modrack__mod-box-ports">
          <div class="modrack__mod-box-ports--in">
            ${ports.inputs.map((p) => inPortHtml(id, p)).join('')}
          </div>
          <div class="modrack__mod-box-ports--out">
            ${ports.outputs.map((p) => `<span class="port port--out" data-module-id="${id}" data-port-dir="out" data-port-key="${p.key}"><span class="port__dot"></span>${p.label}</span>`).join('')}
          </div>
        </div>
      </div>
    `;
  }

  function renderBack() {
    jacksEl.innerHTML = [...patch.modules.entries()].map(([id, m]) => modBoxHtml(id, m)).join('');
    // Scharf geschalteter Ausgang (s. Tap-Verbinden weiter unten) übersteht
    // ein Neuzeichnen -- z. B. wenn man erst eine Ausgangs-Buchse antippt
    // und danach noch einen anderen Regler/Move-Pfeil auf der Vorderseite
    // anfasst, das aber keine echte Absage der Auswahl sein soll.
    if (armedFrom) {
      jacksEl.querySelector(`.port--out[data-module-id="${armedFrom.moduleId}"][data-port-key="${armedFrom.port}"]`)
        ?.classList.add('port--armed');
    }
    updateCables();
  }

  /** Bounding-Box aller Kacheln in Modell-Pixeln (unskaliert, unabhängig von
   *  pan/zoom) -- von updateCables() (SVG-Grösse) und fitContentToView()
   *  (Ansicht zentrieren) gemeinsam genutzt. null bei einem leeren Patch. */
  function contentBounds() {
    let left = Infinity, top = Infinity, right = 0, bottom = 0;
    for (const box of jacksEl.querySelectorAll('.modrack__mod-box')) {
      const m = patch.modules.get(Number(box.dataset.moduleId));
      if (!m) continue;
      left = Math.min(left, m.x);
      top = Math.min(top, m.y);
      right = Math.max(right, m.x + box.offsetWidth);
      bottom = Math.max(bottom, m.y + box.offsetHeight);
    }
    return Number.isFinite(left) ? { left, top, right, bottom } : null;
  }

  /** Pan/Zoom anwenden -- EIN gemeinsamer Transform auf die Kachel-Ebene
   *  (.modrack__boxes), s. Dateikopf-Kommentar. Das Kabel-SVG bekommt
   *  bewusst NIE diesen Transform (hängt unverändert direkt im Wrap) --
   *  updateCables() misst stattdessen die echten, bereits transformierten
   *  Bildschirm-Positionen der Ports, bleibt also unabhängig davon korrekt,
   *  wie genau pan/zoom gerade steht. */
  function applyTransform() {
    jacksEl.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    updateCables();
  }

  /** Zeichnet alle Kabel als Bezier-Kurven direkt zwischen den echten
   *  Jack-Positionen -- derselbe "S-Schwung" wie in jedem Node-Editor
   *  (Blender-Shader-Nodes, VCV Rack, Node-RED): die Kontrollpunkte liegen
   *  waagrecht neben Start/Ziel, in Flussrichtung (Ausgang rechts an der
   *  Kachel -> Kontrollpunkt weiter rechts, Eingang links an der Kachel ->
   *  Kontrollpunkt weiter links), das ergibt eine natürliche Kurve
   *  unabhängig davon, wie die Kacheln zueinander stehen.
   *
   *  Koordinaten sind relativ zum WRAP (dem fixen Sichtfenster), NICHT zur
   *  transformierten Kachel-Ebene -- das Kabel-SVG selbst bekommt nie den
   *  pan/zoom-Transform (s. Dateikopf-Kommentar), bleibt also bei jedem
   *  Pan/Zoom automatisch korrekt, weil hier direkt die tatsächlichen
   *  (schon transformierten) Bildschirm-Positionen der Ports gemessen
   *  werden, statt Modell-Koordinaten selbst umzurechnen. */
  function updateCables() {
    const wrapRect = jacksWrapEl.getBoundingClientRect();
    const portCenter = (moduleId, dir, key) => {
      const el = jacksEl.querySelector(`.port[data-module-id="${moduleId}"][data-port-dir="${dir}"][data-port-key="${key}"] .port__dot`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2 - wrapRect.left, y: r.top + r.height / 2 - wrapRect.top };
    };
    const bend = (fx, tx) => Math.max(40, Math.abs(tx - fx) / 2);

    const paths = patch.cables.map((c) => {
      const from = portCenter(c.fromId, 'out', c.fromPort);
      const to = portCenter(c.toId, 'in', c.toPort);
      if (!from || !to) return '';
      const b = bend(from.x, to.x);
      const d = `M${from.x},${from.y} C${from.x + b},${from.y} ${to.x - b},${to.y} ${to.x},${to.y}`;
      // Zweiter, unsichtbarer Pfad mit viel breiterem Strich NUR fürs
      // Antippen (Trennen) -- die sichtbare Linie bleibt dünn/elegant,
      // aber der tatsächliche Trefferbereich ist grosszügig (dieselbe
      // Klasse/data-cable-id, der Tap-Handler unten unterscheidet nicht,
      // welcher der beiden Pfade getroffen wurde).
      return `<path class="mod-cable-hit" data-cable-id="${c.id}" d="${d}"></path>`
        + `<path class="mod-cable" data-cable-id="${c.id}" d="${d}"></path>`;
    }).join('');

    // Breite UND Höhe explizit als Attribute setzen statt sich für die
    // Breite auf CSS width:100% zu verlassen -- ein <svg> ohne viewBox
    // bildet Pfad-Koordinaten sonst nicht zuverlässig browserübergreifend
    // 1:1 auf CSS-Pixel ab, wenn nur eines von beiden gesetzt ist. Grösse
    // ist die des WRAPS (fixes Sichtfenster) -- das SVG selbst wächst nicht
    // mit dem Inhalt mit (kein Scrollbereich mehr, s. Dateikopf-Kommentar),
    // overflow:visible (s. CSS) lässt Pfade trotzdem über den Rand
    // hinausragen, falls Kabel gerade ausserhalb des sichtbaren Bereichs
    // liegen.
    svgEl.setAttribute('width', String(Math.round(wrapRect.width)));
    svgEl.setAttribute('height', String(Math.round(wrapRect.height)));
    svgEl.innerHTML = paths + (pendingCablePath ?? '');
  }

  /* ---------- Verbinden: antippen (Standard) ODER ziehen (weiterhin
     möglich) -- s. Chat: Ziehen allein war auf echten Touchgeräten kaum
     zu treffen, weil der Finger genau den Zielpunkt verdeckt.
       - Tippen: Ausgang antippen schaltet ihn "scharf" (pulsierender
         Ring), danach einen Eingang antippen verbindet -- man sieht beim
         Antippen des Ziels kurz nichts, aber sobald der Finger wieder weg
         ist, ist die Verbindung sichtbar. Denselben Ausgang nochmal
         antippen (oder daneben) hebt die Auswahl wieder auf.
       - Ziehen: bleibt für alle, die die Geste schon gewohnt sind, aber
         mit zwei Verbesserungen: das gezogene Kabel endet sichtbar ÜBER
         dem Finger (GHOST_OFFSET_Y) statt exakt darunter, und der
         nächstgelegene gültige Eingang leuchtet schon aus einigem Abstand
         auf (SNAP_RADIUS) -- verbunden wird beim Loslassen mit GENAU
         diesem hervorgehobenen Ziel, nicht mit dem, was exakt unter dem
         Finger liegt (das wäre ja gerade das Problem). */
  const GHOST_OFFSET_Y = 44;
  const SNAP_RADIUS = 60;
  const TAP_MOVE_TOLERANCE = 8;
  const MIN_ZOOM = 0.5;
  const MAX_ZOOM = 2;
  // Schutz gegen überempfindlichen Zoom, wenn eine Pinch-Geste mit eng
  // beieinander liegenden Fingern beginnt (Nutzer-Feedback: "der zoom ist
  // ungewohnt sensibel"): zoom skaliert mit dist/pinchStartDist -- bei
  // einem kleinen Nenner (Finger starten nah beieinander) macht schon
  // kleinstes Fingerzittern riesige Zoom-Sprünge. Ein Mindestabstand hält
  // den Nenner in einem Bereich, in dem eine normale Fingerbewegung eine
  // vergleichbar grosse, kontrollierbare Zoom-Änderung ergibt.
  const MIN_PINCH_START_DIST = 60;

  let armedFrom = null; // { moduleId, port } -- per Tap scharf geschalteter Ausgang
  let dragFrom = null; // { moduleId, port } -- währenddessen evtl. gezogener Ausgang
  let dragMoved = false;
  let dragStartX = 0, dragStartY = 0;
  let snapTarget = null; // aktuell hervorgehobenes Eingangs-Element beim Ziehen
  let pendingCablePath = null;
  let moveFrom = null; // { id, startX, startY, origX, origY } -- gerade per Kopfzeile verschobenes Modul
  let moveMoved = false;
  let panFrom = null; // { startX, startY, origX, origY } -- Ein-Finger-Ziehen auf leerer Fläche verschiebt panX/panY
  // Zwei-Finger-Pinch-Zoom (Chat: "mit zwei fingern rein und raus zoomen").
  // activePointers zählt gleichzeitig aufliegende Finger unabhängig vom
  // Rest der Zieh-/Verbinden-Logik oben -- sobald ein ZWEITER Finger dazu-
  // kommt, wird jede laufende Einzelfinger-Geste abgebrochen und auf
  // Pinch umgeschaltet (s. pointerdown unten).
  const activePointers = new Map(); // pointerId -> {x, y}
  let pinchStartDist = 0;
  let pinchStartZoom = 1;

  function setArmed(from) {
    jacksEl.querySelector('.port--armed')?.classList.remove('port--armed');
    armedFrom = from;
    if (from) {
      jacksEl.querySelector(`.port--out[data-module-id="${from.moduleId}"][data-port-key="${from.port}"]`)
        ?.classList.add('port--armed');
    }
  }

  function clearSnapTarget() {
    snapTarget?.classList.remove('port--snap-target');
    snapTarget = null;
  }

  // Auf jacksWrapEl (die GESAMTE Steckfläche inkl. leerer Fläche zwischen
  // Kacheln) statt nur jacksEl (die Kachel-Ebene) -- ein Pinch fängt meist
  // gerade auf leerem Grund an, nicht auf einer kleinen Kachel, muss also
  // schon dort erkannt werden, nicht erst innerhalb der Kachel-Ebene.
  jacksWrapEl.addEventListener('pointerdown', (e) => {
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePointers.size === 2) {
      // Zweiter Finger dazugekommen -- ab jetzt Pinch-Zoom statt
      // Einzelfinger-Geste. Eine evtl. schon laufende Verschiebe-/Zieh-
      // Geste wird abgebrochen, sonst würden beide Interpretationen um
      // denselben ersten Finger konkurrieren.
      dragFrom = null; dragMoved = false; clearSnapTarget(); pendingCablePath = null;
      moveFrom = null; moveMoved = false;
      panFrom = null;
      const pts = [...activePointers.values()];
      pinchStartDist = Math.max(MIN_PINCH_START_DIST, Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y));
      pinchStartZoom = zoom;
      for (const id of activePointers.keys()) {
        try { jacksWrapEl.setPointerCapture(id); } catch { /* Testumgebung */ }
      }
      updateCables();
      return;
    }
    if (activePointers.size > 2) return; // ein dritter Finger -- ignorieren

    // Ports und der Trennen-Button haben Vorrang -- erst DANACH gilt ein
    // Antippen als "Modul verschieben" (s. unten). Reihenfolge ist
    // wichtig: ohne das würde ein Tap auf einen Port als Verschiebe-
    // Versuch missverstanden.
    const removeBtn = e.target.closest('[data-remove-cable]');
    if (removeBtn) {
      e.preventDefault();
      patch.disconnect(Number(removeBtn.dataset.removeCable));
      renderBack();
      return;
    }
    const inPort = e.target.closest('.port--in');
    if (inPort) {
      // Eingang antippen: nur relevant, wenn gerade ein Ausgang scharf
      // geschaltet ist -- Eingänge sind selbst nie Zieh-Quelle.
      if (armedFrom) {
        e.preventDefault();
        patch.connect(armedFrom.moduleId, armedFrom.port, Number(inPort.dataset.moduleId), inPort.dataset.portKey);
        setArmed(null);
        renderBack();
      }
      return;
    }
    const outPort = e.target.closest('.port--out');
    if (outPort) {
      // touch-action:none auf .port (s. CSS) reicht auf echten Touchgeräten
      // NICHT immer aus, um das Scrollen des umgebenden Fokus-Panels zu
      // unterdrücken -- preventDefault() zusätzlich, wie überall sonst im
      // Code, wo per Pointer gezogen wird (s. ui/knob.js#onDown).
      e.preventDefault();
      dragFrom = { moduleId: Number(outPort.dataset.moduleId), port: outPort.dataset.portKey };
      dragMoved = false;
      dragStartX = e.clientX; dragStartY = e.clientY;
      try { jacksWrapEl.setPointerCapture(e.pointerId); } catch { /* Testumgebung */ }
      e.stopPropagation();
      return;
    }
    // Überall sonst auf einer Kachel (Kopfzeile ODER Rumpf) verschiebt das
    // Modul -- NICHT nur die schmale Kopfzeile (s. Chat: "ich scrolle oft
    // im Feld anstatt das Modul zu verschieben"). Die schmale Kopfzeile
    // allein war auf echten Touchgeräten ein zu kleines, zu leicht
    // verfehltes Ziel; ein Griff verfehlt die Kopfzeile knapp landet dann
    // auf dem Kachel-Rumpf, der bis jetzt nichts Eigenes tat und deshalb
    // natives Scrollen der Steckfläche auslöste, statt das Modul zu
    // greifen.
    const box = e.target.closest('.modrack__mod-box');
    if (box) {
      e.preventDefault();
      const id = Number(box.dataset.moduleId);
      const m = patch.modules.get(id);
      if (!m) return;
      moveFrom = { id, startX: e.clientX, startY: e.clientY, origX: m.x, origY: m.y };
      moveMoved = false;
      try { jacksWrapEl.setPointerCapture(e.pointerId); } catch { /* Testumgebung */ }
      e.stopPropagation();
      return;
    }
    // Leere Fläche angetippt -- verwirft eine offene Auswahl UND startet
    // einen Pan (kein natives Scrollen mehr, s. Dateikopf-Kommentar: alles
    // hier selbst gebaut, deshalb explizit preventDefault()+
    // setPointerCapture() wie bei jeder anderen Zieh-Geste oben).
    if (armedFrom) setArmed(null);
    e.preventDefault();
    panFrom = { startX: e.clientX, startY: e.clientY, origX: panX, origY: panY };
    try { jacksWrapEl.setPointerCapture(e.pointerId); } catch { /* Testumgebung */ }
  });
  jacksWrapEl.addEventListener('pointermove', (e) => {
    if (activePointers.has(e.pointerId)) activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePointers.size === 2 && pinchStartDist > 0) {
      const pts = [...activePointers.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pinchStartZoom * (dist / pinchStartDist)));
      // Zoom um den Mittelpunkt der beiden Finger herum, nicht um die linke
      // obere Ecke der Steckfläche -- ohne das rutscht der Inhalt bei jedem
      // Reinzoomen sichtbar weg, was sich "nicht optimiert"/unnatürlich
      // anfühlt (Nutzer-Feedback). panX/panY werden so nachgeführt, dass
      // GENAU der Modell-Punkt unter dem Fingerpaar an derselben
      // Bildschirmstelle bleibt (Standard-Herleitung für einen
      // translate+scale-Transform, s. Dateikopf-Kommentar/Recherche) --
      // rein arithmetisch, ohne natives Scrollen involviert.
      if (newZoom !== zoom) {
        const midX = (pts[0].x + pts[1].x) / 2;
        const midY = (pts[0].y + pts[1].y) / 2;
        const wrapRect = jacksWrapEl.getBoundingClientRect();
        const fx = midX - wrapRect.left;
        const fy = midY - wrapRect.top;
        const modelX = (fx - panX) / zoom;
        const modelY = (fy - panY) / zoom;
        panX = fx - modelX * newZoom;
        panY = fy - modelY * newZoom;
        zoom = newZoom;
        applyTransform();
      }
      return;
    }
    if (panFrom) {
      panX = panFrom.origX + (e.clientX - panFrom.startX);
      panY = panFrom.origY + (e.clientY - panFrom.startY);
      applyTransform();
      return;
    }
    if (moveFrom) {
      const dx = e.clientX - moveFrom.startX;
      const dy = e.clientY - moveFrom.startY;
      if (!moveMoved) {
        if (Math.hypot(dx, dy) <= TAP_MOVE_TOLERANCE) return;
        moveMoved = true;
      }
      // dx/dy sind reale Bildschirm-Pixel (Fingerbewegung) -- durch `zoom`
      // teilen, um sie in Modell-Pixel umzurechnen, sonst würde ein
      // gezoomtes Modul schneller/langsamer laufen als der Finger.
      const nx = Math.max(0, moveFrom.origX + dx / zoom);
      const ny = Math.max(0, moveFrom.origY + dy / zoom);
      const box = jacksEl.querySelector(`.modrack__mod-box[data-module-id="${moveFrom.id}"]`);
      if (box) { box.style.left = `${nx}px`; box.style.top = `${ny}px`; }
      // Sofort im Modell nachziehen (nicht erst bei pointerup) -- Kabel
      // folgen dadurch live mit, genau wie bei Caustic, s. Dateikopf-
      // Kommentar. Kein separater "Übernehmen"-Schritt, wie jeder andere
      // Regler in der App.
      patch.moveModuleTo(moveFrom.id, nx, ny);
      updateCables();
      return;
    }
    if (!dragFrom) return;
    if (!dragMoved) {
      if (Math.hypot(e.clientX - dragStartX, e.clientY - dragStartY) <= TAP_MOVE_TOLERANCE) return;
      dragMoved = true; // erst ab hier ist es wirklich ein Zug, kein Tippen
    }
    const wrapRect = jacksWrapEl.getBoundingClientRect();
    const fromDot = jacksEl.querySelector(`.port[data-module-id="${dragFrom.moduleId}"][data-port-dir="out"][data-port-key="${dragFrom.port}"] .port__dot`);
    if (!fromDot) return;
    const r = fromDot.getBoundingClientRect();
    const fx = r.left + r.width / 2 - wrapRect.left;
    const fy = r.top + r.height / 2 - wrapRect.top;
    const pointerX = e.clientX;
    const pointerY = e.clientY - GHOST_OFFSET_Y; // über dem Finger, nicht darunter (Viewport-Koordinaten, s. Fang-Radius unten)
    const tx = pointerX - wrapRect.left;
    const ty = pointerY - wrapRect.top;

    let best = null, bestDist = SNAP_RADIUS;
    for (const inPort of jacksEl.querySelectorAll('.port--in')) {
      const dot = inPort.querySelector('.port__dot');
      const dr = dot.getBoundingClientRect();
      const dist = Math.hypot(dr.left + dr.width / 2 - pointerX, dr.top + dr.height / 2 - pointerY);
      if (dist < bestDist) { bestDist = dist; best = inPort; }
    }
    if (snapTarget !== best) { clearSnapTarget(); snapTarget = best; snapTarget?.classList.add('port--snap-target'); }

    // Gleicher S-Schwung wie die fertigen Kabel (s. updateCables()).
    const b = Math.max(40, Math.abs(tx - fx) / 2);
    pendingCablePath = `<path class="mod-cable mod-cable--pending" d="M${fx},${fy} C${fx + b},${fy} ${tx - b},${ty} ${tx},${ty}"></path>`;
    updateCables();
  });
  const finishCableDrag = () => {
    if (!dragFrom) return;
    if (dragMoved) {
      if (snapTarget) patch.connect(dragFrom.moduleId, dragFrom.port, Number(snapTarget.dataset.moduleId), snapTarget.dataset.portKey);
    } else {
      // Kein nennenswerter Zug -- ein einfaches Tippen, schaltet scharf/ab.
      setArmed(armedFrom && armedFrom.moduleId === dragFrom.moduleId && armedFrom.port === dragFrom.port ? null : dragFrom);
    }
    clearSnapTarget();
    dragFrom = null;
    pendingCablePath = null;
    renderBack();
  };
  jacksWrapEl.addEventListener('pointerup', (e) => {
    activePointers.delete(e.pointerId);
    if (activePointers.size < 2) pinchStartDist = 0; // Pinch endet, sobald ein Finger loslässt
    if (panFrom) { panFrom = null; return; }
    if (moveFrom) {
      // Ein blosses Antippen der Kopfzeile (kein nennenswerter Zug) ist
      // kein Verschieben -- verwirft dann wie ein Tap auf leere Fläche
      // eine offene Auswahl, statt sie stehen zu lassen.
      if (!moveMoved && armedFrom) setArmed(null);
      moveFrom = null; moveMoved = false;
      return;
    }
    finishCableDrag();
  });
  jacksWrapEl.addEventListener('pointercancel', (e) => {
    activePointers.delete(e.pointerId);
    if (activePointers.size < 2) pinchStartDist = 0;
    if (panFrom) { panFrom = null; return; }
    if (moveFrom) { moveFrom = null; moveMoved = false; return; }
    dragFrom = null; dragMoved = false;
    clearSnapTarget();
    pendingCablePath = null;
    updateCables();
  });

  svgEl.addEventListener('pointerdown', (e) => {
    const path = e.target.closest('[data-cable-id]');
    if (!path) return;
    patch.disconnect(Number(path.dataset.cableId));
    renderBack();
  });

  /* ---------- Flip ---------- */

  function setFace(next) {
    face = next;
    const isFront = face === 'front';
    listEl.hidden = !isFront;
    addBtn.hidden = !isFront;
    canvasOuterEl.hidden = isFront;
    flipBtn.textContent = isFront ? '🔄 Flip to Patch Bay' : '🔄 Flip to Controls';
    hintEl.textContent = isFront
      ? 'Hold a module for options · tap + to add one'
      : 'Drag a module\'s header to move it · tap an output, then an input to connect · tap a cable to remove it';
    armedFrom = null; // keine über einen Flip hinweg "hängende" Auswahl
    if (!isFront) {
      renderBack(); // faul -- s. Dateikopf-Kommentar
      // Ansicht (pan/zoom) jedes Mal frisch auf den aktuellen Patch
      // zentrieren, wenn man auf die Steckfläche wechselt -- reine
      // Kamera-Sache (fitContentToView() rührt nie an Modul-x/y), also
      // jederzeit gefahrlos wiederholbar, s. dort.
      fitContentToView();
    }
  }
  flipBtn.addEventListener('click', () => setFace(face === 'front' ? 'back' : 'front'));

  /* ---------- Vollbild-Steckfläche ---------- */

  /** Blendet die Steckfläche (Rückseite) auf den ganzen Bildschirm auf --
   *  bei vielen Modulen/Kabeln ist die eingebettete 320px-Box im Maschinen-
   *  Editor schnell zu eng (Chat: "eine vollansicht möglichkeit für die
   *  patch bay"). Rein optisch per CSS-Klasse (position:fixed/inset:0,
   *  s. components.css) -- kein echtes Fullscreen-API nötig (auf iOS
   *  Safari ohnehin nur eingeschränkt verfügbar), derselbe Ansatz wie schon
   *  .machine-focus selbst. Derselbe Knopf schaltet zurück -- Symbol UND
   *  aria-label wechseln mit, wie beim Flip-Button oben.
   *
   *  fitContentToView() muss NACH dem Klassenwechsel neu laufen: sie misst
   *  echte Bildschirm-Masse (getBoundingClientRect), die sich mit der
   *  Fenstergrösse der Steckfläche ändern. */
  let isCanvasFullscreen = false;

  /** Setzt die Vollbild-Höhe direkt per Inline-Style aus window.visualViewport
   *  statt sich auf --app-vh (aus window.innerHeight, s. main.js
   *  #syncViewportHeight) oder 100dvh zu verlassen -- beide blieben auf
   *  iOS Safari weiterhin zu klein (Nutzer-Feedback: "ist leider noch
   *  nicht vollbild", trotz des --app-vh-Fixes). Vermuteter Grund:
   *  --app-vh wird nur bei 'resize'/'orientationchange' aktualisiert, aber
   *  Safaris einklappende Adressleiste (typischerweise beim Scrollen --
   *  genau das, was man in der Patch-Bay ständig tut) ändert
   *  window.innerHeight OHNE zuverlässig ein 'resize'-Event auf window
   *  auszulösen, während sichtbar bleibt. window.visualViewport ist die
   *  extra dafür gedachte API (u. a. fürs Tastatur-Einblenden entworfen)
   *  und feuert IHR EIGENES 'resize', wenn sich die tatsächlich sichtbare
   *  Fläche ändert -- hier deshalb direkt und live nachgeführt, statt nur
   *  einmalig beim Öffnen gemessen. */
  function syncFullscreenCanvasHeight() {
    if (!isCanvasFullscreen) return;
    const vv = window.visualViewport;
    canvasOuterEl.style.height = `${vv ? vv.height : window.innerHeight}px`;
  }
  window.visualViewport?.addEventListener('resize', syncFullscreenCanvasHeight);
  window.addEventListener('resize', syncFullscreenCanvasHeight);

  function setCanvasFullscreen(next) {
    isCanvasFullscreen = next;
    canvasOuterEl.classList.toggle('is-fullscreen', next);
    // Aus dem verschachtelten .machine-focus__panel (overflow-y:auto,
    // eigenes Padding) heraus DIREKT an <body> umhängen, statt nur per
    // position:fixed "auszubrechen" -- drei Versuche, die Vollbild-Höhe
    // rein über CSS/JS-Höhenberechnung zu treffen (--app-vh,
    // window.visualViewport), haben auf dem Testgerät NICHTS geändert
    // (Nutzer-Feedback, mehrfach: "leider immer noch nicht", sowohl im
    // Browser als auch als Homescreen-App). Ein position:fixed-Element
    // bricht zwar aus dem NORMALEN Fluss seines Elternteils aus, bleibt
    // aber ein Kind davon -- auf manchen WebKit-Ständen reicht das
    // offenbar nicht, um zuverlässig über verschachtelte Scroll-/Padding-
    // Container hinweg wirklich die komplette Bildschirmfläche zu
    // bekommen. .machine-focus selbst (das nachweislich echt Vollbild
    // ist) hängt dagegen als DIREKTES Kind von <body> -- hier also
    // dieselbe Struktur: beim Öffnen wirklich an <body> verschieben (Event-
    // Listener bleiben beim Verschieben erhalten), beim Schliessen exakt
    // dorthin zurück, wo es im Template stand (letztes Kind von .modrack).
    if (next) {
      document.body.appendChild(canvasOuterEl);
    } else if (canvasOuterEl.parentElement !== root) {
      root.appendChild(canvasOuterEl);
    }
    // Transport-Leiste (oben) und Bottom-Bar (unten) bleiben normalerweise
    // IMMER sichtbar, auch im Vollbild-Maschinen-Editor (.machine-focus
    // lässt bewusst Lücken dafür, s. dessen top/bottom-Offsets) -- für die
    // Patch-Bay speziell aber unerwünscht: sie deckten einen Teil der neu
    // gewonnenen Vollbild-Fläche wieder zu (Nutzer-Feedback samt
    // Screenshot: beide Leisten lagen sichtbar über der Steckfläche).
    // Nur für DIESEN Vollbild-Zustand blenden wir sie zusätzlich aus, statt
    // grundsätzlich (s. body-Klasse in components.css).
    document.body.classList.toggle('modular-canvas-fullscreen', next);
    fullscreenBtn.textContent = next ? '✕' : '⛶';
    fullscreenBtn.setAttribute('aria-label', next ? 'Exit fullscreen patch bay' : 'Toggle fullscreen patch bay');
    if (next) {
      syncFullscreenCanvasHeight();
    } else {
      canvasOuterEl.style.height = '';
    }
    updateCables();
    fitContentToView();
  }
  fullscreenBtn.addEventListener('click', () => setCanvasFullscreen(!isCanvasFullscreen));

  /** Zentriert die ANSICHT (pan/zoom) auf die aktuelle Bounding-Box aller
   *  Module -- rührt NIE an m.x/m.y (reine Kamera-Sache, s. Dateikopf-
   *  Kommentar), anders als der vorige Ansatz, der die Module tatsächlich
   *  verschoben hat (Git-Historie): der überschrieb die für die kleine
   *  Ansicht sinnvolle Position dauerhaft, sobald man einmal im Vollbild
   *  zentriert hatte (Nutzer-Feedback: "sieht man sie nun in der kleinen
   *  Ansicht nicht mehr"). Weil hier nur pan/zoom geändert wird, ist das
   *  jederzeit gefahrlos wiederholbar -- läuft deshalb bei JEDEM Wechsel
   *  auf die Rückseite UND bei JEDEM Umschalten des Vollbilds (in beide
   *  Richtungen, s. setFace()/setCanvasFullscreen()), nicht nur einmalig.
   *  Ein Patch, der grösser als das Sichtfenster ist, wird dafür verkleinert
   *  (fitZoom <= 1) statt nur die linke obere Ecke zu zeigen. */
  function fitContentToView() {
    const bounds = contentBounds();
    if (!bounds) return;
    const wrapRect = jacksWrapEl.getBoundingClientRect();
    const contentW = Math.max(1, bounds.right - bounds.left);
    const contentH = Math.max(1, bounds.bottom - bounds.top);
    const fitZoom = Math.min(1, wrapRect.width / contentW, wrapRect.height / contentH);
    zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, fitZoom));
    panX = (wrapRect.width - contentW * zoom) / 2 - bounds.left * zoom;
    panY = (wrapRect.height - contentH * zoom) / 2 - bounds.top * zoom;
    applyTransform();
  }

  /* ---------- Hinzufügen / Halten-Menü ---------- */

  function refreshAll() {
    renderFront();
    if (face === 'back') renderBack();
  }

  addBtn.addEventListener('click', () => {
    openModulePicker((type) => {
      patch.addModule(type);
      refreshAll();
    });
  });

  let holdTimer = null;
  let holdMoved = false;
  let holdStartX = 0, holdStartY = 0;
  const HOLD_MS = 500;
  const MOVE_TOLERANCE = 6;
  listEl.addEventListener('pointerdown', (e) => {
    const row = e.target.closest('.modrack__row');
    if (!row || e.target.closest('x-knob, .modrack__row-seg, [data-move]')) return;
    holdMoved = false;
    holdStartX = e.clientX; holdStartY = e.clientY;
    holdTimer = setTimeout(() => {
      openModuleMenu(patch, Number(row.dataset.moduleId), row, refreshAll);
      holdTimer = null;
    }, HOLD_MS);
  });
  listEl.addEventListener('pointermove', (e) => {
    if (holdTimer == null || holdMoved) return;
    if (Math.hypot(e.clientX - holdStartX, e.clientY - holdStartY) > MOVE_TOLERANCE) {
      holdMoved = true;
      clearTimeout(holdTimer);
      holdTimer = null;
    }
  });
  const endHold = () => { clearTimeout(holdTimer); holdTimer = null; };
  listEl.addEventListener('pointerup', endHold);
  listEl.addEventListener('pointercancel', endHold);

  renderFront();
  setFace('front');
}

/* ---------- "+ Add Module"-Picker (einzige, wiederverwendete Sheet-Instanz,
   wie insertPickerEl in insert-chain.js -- kann ohnehin nie mehr als eine
   gleichzeitig offen sein) ---------- */

let modulePickerEl = null;
function openModulePicker(onPick) {
  if (!modulePickerEl) {
    modulePickerEl = document.createElement('div');
    modulePickerEl.className = 'sheet sheet--module-picker';
    modulePickerEl.hidden = true;
    modulePickerEl.innerHTML = `
      <div class="sheet__backdrop" data-close></div>
      <div class="sheet__panel">
        <div class="sheet__grip"></div>
        <h2 class="sheet__title">Add Module</h2>
        <div class="sheet__list">
          ${MODULE_TYPES.map((type) => `
            <button type="button" class="sheet__item" data-type="${type}">
              <span class="sheet__name">${moduleMeta(type).name}</span>
            </button>
          `).join('')}
        </div>
      </div>
    `;
    document.body.appendChild(modulePickerEl);
    modulePickerEl.querySelector('[data-close]').addEventListener('click', () => { modulePickerEl.hidden = true; });
    modulePickerEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-type]');
      if (!btn) return;
      modulePickerEl.hidden = true;
      modulePickerEl._onPick?.(btn.dataset.type);
    });
  }
  modulePickerEl._onPick = onPick;
  modulePickerEl.hidden = false;
}

/* ---------- Modul-Menü (Halten) -- ebenfalls eine einzige,
   wiederverwendete Instanz ---------- */

let moduleMenuEl = null;
const dismissModuleMenu = () => { moduleMenuEl?.remove(); moduleMenuEl = null; document.removeEventListener('pointerdown', onOutsideModuleMenu, true); };
const onOutsideModuleMenu = (e) => { if (moduleMenuEl && !moduleMenuEl.contains(e.target)) dismissModuleMenu(); };

function openModuleMenu(patch, moduleId, anchorEl, onChange) {
  dismissModuleMenu();
  const m = patch.modules.get(moduleId);
  if (!m) return;

  moduleMenuEl = document.createElement('div');
  moduleMenuEl.className = 'pat-chip';

  const dupBtn = document.createElement('button');
  dupBtn.className = 'pat-chip__btn';
  dupBtn.textContent = '⧉ Duplicate';
  dupBtn.addEventListener('click', () => {
    patch.addModule(m.type, { params: { ...m.params } });
    dismissModuleMenu();
    onChange();
  });
  moduleMenuEl.appendChild(dupBtn);

  // Der Output-Baustein ist der feste Endpunkt jedes Patches (s.
  // machines/modular.js#connectOutputs) -- der LETZTE darf nicht entfernbar
  // sein, sonst verstummt die Maschine ohne jeden sichtbaren Grund.
  const outputCount = [...patch.modules.values()].filter((x) => x.type === 'output').length;
  const canRemove = m.type !== 'output' || outputCount > 1;
  if (canRemove) {
    const removeBtn = document.createElement('button');
    removeBtn.className = 'pat-chip__btn pat-chip__btn--danger';
    removeBtn.textContent = '🗑 Remove';
    removeBtn.addEventListener('click', () => {
      patch.removeModule(moduleId);
      dismissModuleMenu();
      onChange();
    });
    moduleMenuEl.appendChild(removeBtn);
  }

  document.body.appendChild(moduleMenuEl);
  const r = anchorEl.getBoundingClientRect();
  const left = Math.max(8, Math.min(window.innerWidth - moduleMenuEl.offsetWidth - 8, r.left + r.width / 2 - moduleMenuEl.offsetWidth / 2));
  moduleMenuEl.style.left = `${left}px`;
  moduleMenuEl.style.top = `${Math.max(8, r.top - moduleMenuEl.offsetHeight - 8)}px`;
  setTimeout(() => document.addEventListener('pointerdown', onOutsideModuleMenu, true), 0);
}
