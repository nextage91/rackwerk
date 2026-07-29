/**
 * modular-view.js — die Modular-Maschine als "Rack im Rack": Module stecken
 * wie Maschinen im Hauptrack in einer Liste (Vorderseite: Name + Regler
 * direkt in der Zeile, ▲/▼ zum Umsortieren, Halten für Duplizieren/
 * Entfernen, "+ Add Module" am Ende). Ein Flip-Button dreht dieselbe Liste
 * auf die Rückseite: dort erscheinen dieselben Module als Steckfelder mit
 * ihren Ein-/Ausgängen, verbunden per virtuellem Kabel (ziehen zum
 * Verbinden, antippen zum Trennen).
 *
 * Die Listen-Reihenfolge (ModularPatch#moveModule) ist die EINZIGE
 * Sortierung -- Vorder- und Rückseite zeigen dieselbe Reihenfolge, keine
 * zwei unabhängigen Layouts wie in der vorigen freien Leinwand-Version.
 * Das macht die Rückseite nebenbei einfacher: Steckplätze stehen in einer
 * normalen, mitwachsenden Liste statt auf einer festen 1400x1000-Fläche,
 * kein Modul-Herumziehen und keine Scroll-Offset-Rechnung mehr nötig.
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
      <div class="modrack__jacks" data-jacks></div>
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

  /* ---------- Rückseite: Steckfeld + Kabel ---------- */

  function jackRowHtml(id, m) {
    const ports = MODULE_PORTS[m.type];
    return `
      <div class="modrack__jack-row" data-module-id="${id}">
        <div class="modrack__jack-row-head">${moduleMeta(m.type).name}</div>
        <div class="modrack__jack-ports modrack__jack-ports--in">
          ${ports.inputs.map((p) => `<span class="port port--in" data-module-id="${id}" data-port-dir="in" data-port-key="${p.key}"><span class="port__dot"></span>${p.label}</span>`).join('')}
        </div>
        <div class="modrack__jack-ports modrack__jack-ports--out">
          ${ports.outputs.map((p) => `<span class="port port--out" data-module-id="${id}" data-port-dir="out" data-port-key="${p.key}">${p.label}<span class="port__dot"></span></span>`).join('')}
        </div>
      </div>
    `;
  }

  function renderBack() {
    jacksEl.innerHTML = [...patch.modules.entries()].map(([id, m]) => jackRowHtml(id, m)).join('');
    updateCables();
  }

  // Breite der reservierten Spur rechts neben den Zeilen (s. CSS
  // .modrack__jacks-wrap padding-right) -- dort verlaufen die Kabel, statt
  // querbeet unter fremden Zeilen hindurch (s. updateCables()).
  const LANE_MARGIN = 12;

  /** Zeichnet alle Kabel als Bezier-Kurven. Ports beider Sorten sitzen am
   *  rechten Rand jeder Zeile (Ein- links von Aus-Port) -- ein simpler
   *  Mittelpunkt zwischen zwei Ports bliebe fast immer in genau dieser
   *  Spalte und liefe damit UNTER jeder dazwischenliegenden Zeile hindurch,
   *  unsichtbar UND unantippbar (die Zeilen sind blickdicht und liegen im
   *  DOM über dem SVG). Deshalb biegen alle Kabel stattdessen erst in eine
   *  eigene, zeilenfreie Spur ganz rechts aus (s. LANE_MARGIN/CSS padding),
   *  laufen dort frei sichtbar hoch/runter und kommen erst kurz vor dem
   *  Ziel-Port wieder zurück -- wie bei einem echten Patch-Bay-Steckfeld.
   *  Leichter Versatz je Kabel (i % 3), damit sich mehrere Kabel in der
   *  Spur nicht exakt überlagern. */
  function updateCables() {
    const wrapRect = jacksWrapEl.getBoundingClientRect();
    const laneX = wrapRect.width - LANE_MARGIN;
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
      const lane = laneX - (i % 3) * 10;
      return `<path class="mod-cable" data-cable-id="${c.id}" d="M${from.x},${from.y} C${lane},${from.y} ${lane},${to.y} ${to.x},${to.y}"></path>`;
    }).join('');

    // Breite UND Höhe explizit als Attribute setzen statt sich für die
    // Breite auf CSS width:100% zu verlassen -- ein <svg> ohne viewBox
    // bildet Pfad-Koordinaten sonst nicht zuverlässig browserübergreifend
    // 1:1 auf CSS-Pixel ab, wenn nur eines von beiden gesetzt ist.
    svgEl.setAttribute('width', String(wrapRect.width));
    svgEl.setAttribute('height', String(jacksEl.offsetHeight));
    svgEl.innerHTML = paths + (pendingCablePath ?? '');
  }

  let pendingFrom = null; // { moduleId, port }
  let pendingCablePath = null;

  jacksEl.addEventListener('pointerdown', (e) => {
    const port = e.target.closest('.port--out');
    if (!port) return;
    // touch-action:none auf .port (s. CSS) reicht auf echten Touchgeräten
    // NICHT immer aus, um das Scrollen des umgebenden Fokus-Panels zu
    // unterdrücken -- preventDefault() zusätzlich, wie überall sonst im
    // Code, wo per Pointer gezogen wird (s. ui/knob.js#onDown). Ohne das:
    // der erste Zug wird als Scrollversuch interpretiert statt als
    // Kabel-Ziehen, das Kabel verbindet sich nie (Chat-Report: "kann die
    // Patch-Punkte nicht miteinander verbinden").
    e.preventDefault();
    pendingFrom = { moduleId: Number(port.dataset.moduleId), port: port.dataset.portKey };
    try { jacksEl.setPointerCapture(e.pointerId); } catch { /* Testumgebung */ }
    e.stopPropagation();
  });
  jacksEl.addEventListener('pointermove', (e) => {
    if (!pendingFrom) return;
    const wrapRect = jacksWrapEl.getBoundingClientRect();
    const fromDot = jacksEl.querySelector(`.port[data-module-id="${pendingFrom.moduleId}"][data-port-dir="out"][data-port-key="${pendingFrom.port}"] .port__dot`);
    if (!fromDot) return;
    const r = fromDot.getBoundingClientRect();
    const fx = r.left + r.width / 2 - wrapRect.left;
    const fy = r.top + r.height / 2 - wrapRect.top;
    const tx = e.clientX - wrapRect.left;
    const ty = e.clientY - wrapRect.top;
    const lane = wrapRect.width - LANE_MARGIN;
    pendingCablePath = `<path class="mod-cable mod-cable--pending" d="M${fx},${fy} C${lane},${fy} ${lane},${ty} ${tx},${ty}"></path>`;
    updateCables();
  });
  const finishCableDrag = (e) => {
    if (!pendingFrom) return;
    const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.port--in');
    if (target) patch.connect(pendingFrom.moduleId, pendingFrom.port, Number(target.dataset.moduleId), target.dataset.portKey);
    pendingFrom = null;
    pendingCablePath = null;
    renderBack();
  };
  jacksEl.addEventListener('pointerup', finishCableDrag);
  jacksEl.addEventListener('pointercancel', () => { pendingFrom = null; pendingCablePath = null; updateCables(); });

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
    hintEl.hidden = !isFront;
    jacksWrapEl.hidden = isFront;
    flipBtn.textContent = isFront ? '🔄 Flip to Patch Bay' : '🔄 Flip to Controls';
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
