/**
 * modular-view.js — die Modular-Maschine als "Rack im Rack": Module stecken
 * wie Maschinen im Hauptrack in einer Liste (Vorderseite: Name + Regler
 * direkt in der Zeile, ▲/▼ zum Umsortieren, Halten für Duplizieren/
 * Entfernen, "+ Add Module" am Ende). Ein Flip-Button dreht dieselbe Liste
 * auf die Rückseite: dort erscheinen dieselben Module NEBENEINANDER in
 * einer waagrecht scrollbaren Buchsenleiste (wie ein echtes Patch-Bay-Feld)
 * mit ihren Ein-/Ausgängen, verbunden per virtuellem Kabel (antippen zum
 * Verbinden -- Ausgang, dann Eingang antippen --, ziehen geht auch; ✕ neben
 * einem belegten Eingang ODER das Kabel selbst antippen zum Trennen).
 *
 * Die Listen-Reihenfolge (ModularPatch#moveModule) ist die EINZIGE
 * Sortierung -- Vorder- und Rückseite zeigen dieselbe Reihenfolge. Die
 * Rückseite reiht Module bewusst NEBENEINANDER statt übereinander: darunter
 * bleibt so eine durchgehend freie "Kabel-Wanne", in der jedes Kabel frei
 * verläuft (s. updateCables()) -- bei übereinander gestapelten Zeilen (eine
 * frühere Fassung) liefe ein Kabel zwischen zwei nicht benachbarten Zeilen
 * zwangsläufig unsichtbar und unantippbar unter jeder dazwischenliegenden
 * Zeile hindurch.
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
 * renderBack() (Steckplatz-Positionen, Kabel-Pfade) bewusst NICHT beim
 * ersten Bau, sondern erst faul, wenn der Nutzer tatsächlich auf die
 * Rückseite umschaltet (ein Klick, der zwangsläufig erst passiert, wenn
 * das Fokus-Panel längst sichtbar ist).
 */
import { MODULE_TYPES, MODULE_PORTS, MODULE_UI_PARAMS, OSCILLATOR_WAVES, FILTER_TYPES, moduleMeta } from '../core/modular.js';

export function renderModularRack(container, machine) {
  const patch = machine.patch;
  let face = 'front';

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
    <div class="modrack__jacks-wrap" data-jackswrap hidden>
      <svg class="modrack__cables" data-cables></svg>
      <div class="modrack__jack-strip" data-jacks></div>
    </div>
  `;
  container.appendChild(root);

  const listEl = root.querySelector('[data-list]');
  const addBtn = root.querySelector('[data-add-module]');
  const hintEl = root.querySelector('[data-hint]');
  const jacksWrapEl = root.querySelector('[data-jackswrap]');
  const jacksEl = root.querySelector('[data-jacks]');
  const svgEl = root.querySelector('[data-cables]');
  const flipBtn = root.querySelector('[data-flip]');

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

  /* ---------- Rückseite: Steckfeld-Reihe + Kabel-Wanne darunter ----------
     Module stehen hier NEBENEINANDER in einer waagrecht scrollbaren Reihe
     (wie die Buchsenleiste eines echten Patch-Bay-Feldes), statt
     übereinander wie auf der Vorderseite -- absichtlich anders: darunter
     bleibt dadurch eine durchgehend freie Fläche (die "Wanne"), in der
     JEDES Kabel unbehindert von fremden Modulen verlaufen kann. Bei
     übereinander gestapelten Zeilen (die frühere Fassung) gäbe es diese
     freie Fläche nicht -- ein Kabel zwischen zwei nicht benachbarten
     Zeilen liefe zwangsläufig unsichtbar UND unantippbar unter jeder
     dazwischenliegenden Zeile hindurch (die Zeilen sind blickdicht und
     liegen im DOM über dem SVG); s. Chat: "Kabel an der Seite unübersichtlich". */

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

  function jackTileHtml(id, m) {
    const ports = MODULE_PORTS[m.type];
    return `
      <div class="modrack__jack-tile" data-module-id="${id}">
        <div class="modrack__jack-tile-head">${moduleMeta(m.type).name}</div>
        <div class="modrack__jack-ports modrack__jack-ports--in">
          ${ports.inputs.map((p) => inPortHtml(id, p)).join('')}
        </div>
        <div class="modrack__jack-ports modrack__jack-ports--out">
          ${ports.outputs.map((p) => `<span class="port port--out" data-module-id="${id}" data-port-dir="out" data-port-key="${p.key}"><span class="port__dot"></span>${p.label}</span>`).join('')}
        </div>
      </div>
    `;
  }

  function renderBack() {
    jacksEl.innerHTML = [...patch.modules.entries()].map(([id, m]) => jackTileHtml(id, m)).join('');
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

  // Zusätzlicher Tiefenversatz je Kabel (i % 4), damit sich mehrere Kabel
  // in der Wanne nicht exakt überlagern -- bei der breiten, hohen Wanne
  // hier viel grosszügiger möglich als in der früheren schmalen Seitenspur.
  const TRAY_STEP = 16;

  /** Zeichnet alle Kabel als Bezier-Kurven, die von ihrem Ausgangs-Port
   *  senkrecht nach UNTEN in die freie Wanne unter der Steckfeld-Reihe
   *  eintauchen und erst kurz vor dem Ziel-Port wieder aufsteigen -- wie
   *  ein echtes Kabel, das lose unter einem Patch-Bay-Feld hängt. Die
   *  Wanne beginnt am unteren Rand der GESAMTEN Reihe (nicht nur der
   *  eigenen Kachel), damit auch eine höhere Nachbar-Kachel nie im Weg
   *  liegt. */
  function updateCables() {
    const wrapRect = jacksWrapEl.getBoundingClientRect();
    const stripBottom = jacksEl.getBoundingClientRect().bottom - wrapRect.top;
    const portCenter = (moduleId, dir, key) => {
      const el = jacksEl.querySelector(`.port[data-module-id="${moduleId}"][data-port-dir="${dir}"][data-port-key="${key}"] .port__dot`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2 - wrapRect.left, y: r.top + r.height / 2 - wrapRect.top };
    };

    const paths = patch.cables.map((c, i) => {
      const from = portCenter(c.fromId, 'out', c.fromPort);
      const to = portCenter(c.toId, 'in', c.toPort);
      if (!from || !to) return '';
      const well = stripBottom + 24 + (i % 4) * TRAY_STEP;
      const d = `M${from.x},${from.y} C${from.x},${well} ${to.x},${well} ${to.x},${to.y}`;
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
    // 1:1 auf CSS-Pixel ab, wenn nur eines von beiden gesetzt ist.
    svgEl.setAttribute('width', String(wrapRect.width));
    svgEl.setAttribute('height', String(jacksWrapEl.offsetHeight));
    svgEl.innerHTML = paths + (pendingCablePath ?? '');
  }
  // Die Steckfeld-Reihe scrollt waagrecht (mehr Module als Bildschirmbreite)
  // -- das SVG hängt AM WRAP, nicht an der scrollenden Reihe selbst, muss
  // die Kabel beim Scrollen also aktiv nachziehen, statt automatisch
  // "mitzuscrollen".
  jacksEl.addEventListener('scroll', updateCables);

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

  let armedFrom = null; // { moduleId, port } -- per Tap scharf geschalteter Ausgang
  let dragFrom = null; // { moduleId, port } -- währenddessen evtl. gezogener Ausgang
  let dragMoved = false;
  let dragStartX = 0, dragStartY = 0;
  let snapTarget = null; // aktuell hervorgehobenes Eingangs-Element beim Ziehen
  let pendingCablePath = null;

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

  jacksEl.addEventListener('pointerdown', (e) => {
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
    if (!outPort) {
      // Leere Fläche angetippt -- eine offene Auswahl verwerfen.
      if (armedFrom) setArmed(null);
      return;
    }
    // touch-action:none auf .port (s. CSS) reicht auf echten Touchgeräten
    // NICHT immer aus, um das Scrollen des umgebenden Fokus-Panels zu
    // unterdrücken -- preventDefault() zusätzlich, wie überall sonst im
    // Code, wo per Pointer gezogen wird (s. ui/knob.js#onDown).
    e.preventDefault();
    dragFrom = { moduleId: Number(outPort.dataset.moduleId), port: outPort.dataset.portKey };
    dragMoved = false;
    dragStartX = e.clientX; dragStartY = e.clientY;
    try { jacksEl.setPointerCapture(e.pointerId); } catch { /* Testumgebung */ }
    e.stopPropagation();
  });
  jacksEl.addEventListener('pointermove', (e) => {
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
    const tx = e.clientX - wrapRect.left;
    const ty = e.clientY - wrapRect.top - GHOST_OFFSET_Y; // über dem Finger, nicht darunter

    let best = null, bestDist = SNAP_RADIUS;
    for (const inPort of jacksEl.querySelectorAll('.port--in')) {
      const dot = inPort.querySelector('.port__dot');
      const dr = dot.getBoundingClientRect();
      const dist = Math.hypot(dr.left + dr.width / 2 - wrapRect.left - tx, dr.top + dr.height / 2 - wrapRect.top - ty);
      if (dist < bestDist) { bestDist = dist; best = inPort; }
    }
    if (snapTarget !== best) { clearSnapTarget(); snapTarget = best; snapTarget?.classList.add('port--snap-target'); }

    // Gleicher Wannen-Look wie die fertigen Kabel (s. updateCables()), aber
    // ohne Tiefenversatz -- nur eine einzelne Vorschau ist je gerade aktiv.
    const stripBottom = jacksEl.getBoundingClientRect().bottom - wrapRect.top;
    const well = stripBottom + 24;
    pendingCablePath = `<path class="mod-cable mod-cable--pending" d="M${fx},${fy} C${fx},${well} ${tx},${well} ${tx},${ty}"></path>`;
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
  jacksEl.addEventListener('pointerup', finishCableDrag);
  jacksEl.addEventListener('pointercancel', () => {
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
    jacksWrapEl.hidden = isFront;
    flipBtn.textContent = isFront ? '🔄 Flip to Patch Bay' : '🔄 Flip to Controls';
    hintEl.textContent = isFront
      ? 'Hold a module for options · tap + to add one'
      : 'Tap an output, then an input to connect · tap a cable to remove it';
    armedFrom = null; // keine über einen Flip hinweg "hängende" Auswahl
    if (!isFront) renderBack(); // faul -- s. Dateikopf-Kommentar
  }
  flipBtn.addEventListener('click', () => setFace(face === 'front' ? 'back' : 'front'));

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
