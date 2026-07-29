/**
 * modular-view.js — Patch-Editor für die Modular-Maschine: Module als
 * verschiebbare Kästchen, Kabel per Ziehen von einem Ausgangs- zu einem
 * Eingangs-Port verbinden, Kabel antippen zum Löschen, Modul halten für
 * Duplizieren/Entfernen.
 *
 * Eine einzige, wiederverwendete Sheet-Instanz (wie insertPickerEl in
 * insert-chain.js) -- es kann ohnehin nie mehr als ein Patch-Editor
 * gleichzeitig offen sein.
 */
import { MODULE_TYPES, MODULE_PORTS, MODULE_UI_PARAMS, OSCILLATOR_WAVES, FILTER_TYPES, moduleMeta } from '../core/modular.js';

let editorEl = null;
let canvasEl = null;
let svgEl = null;
let modulePickerEl = null;
let currentMachine = null;

function ensureEditor() {
  if (editorEl) return;
  editorEl = document.createElement('div');
  editorEl.className = 'sheet sheet--modular';
  editorEl.hidden = true;
  editorEl.innerHTML = `
    <div class="sheet__backdrop"></div>
    <div class="sheet__panel modular-editor">
      <div class="modular-editor__head">
        <h2 class="sheet__title" data-title>Modular</h2>
        <button type="button" class="m-btn" data-close-editor>✕</button>
      </div>
      <p class="modular-editor__hint">Drag from an output dot to an input dot to connect · tap a cable to remove it · hold a module for options</p>
      <div class="modular-editor__canvas-wrap">
        <svg class="modular-editor__cables"></svg>
        <div class="modular-editor__canvas"></div>
      </div>
      <button type="button" class="rack__add modular-editor__add" data-add-module>+ Add Module</button>
    </div>
  `;
  document.body.appendChild(editorEl);
  canvasEl = editorEl.querySelector('.modular-editor__canvas');
  svgEl = editorEl.querySelector('.modular-editor__cables');

  editorEl.querySelector('[data-close-editor]').addEventListener('click', closeEditor);
  editorEl.querySelector('[data-add-module]').addEventListener('click', openModulePicker);

  // Kabel per Antippen löschen -- eigener Listener auf dem SVG statt pro
  // Pfad, damit neu gezeichnete Kabel nicht jedes Mal neu verdrahtet werden
  // müssen (dasselbe Delegations-Muster wie überall sonst in der App).
  svgEl.addEventListener('pointerdown', (e) => {
    const path = e.target.closest('[data-cable-id]');
    if (!path || !currentMachine) return;
    currentMachine.patch.disconnect(Number(path.dataset.cableId));
    renderPatch();
  });

  wireModuleDrag();
  wireCableDrag();
}

function closeEditor() {
  editorEl.hidden = true;
  currentMachine = null;
}

export function openModularEditor(machine) {
  ensureEditor();
  currentMachine = machine;
  editorEl.querySelector('[data-title]').textContent = `Modular — ${machine.displayName}`;
  // Erst sichtbar machen, DANN rendern -- updateCables() misst Port-
  // Positionen per getBoundingClientRect(); solange das Sheet noch
  // [hidden] (display:none) ist, liefert das überall (0,0) und alle Kabel
  // zeichnen sich als Nulllängen-Pfade in der Ecke (unsichtbar, bis z. B.
  // ein Modul gezogen wird und updateCables() erneut läuft).
  editorEl.hidden = false;
  renderPatch();
}

/* ---------- Modul-Kästchen ---------- */

function knobHtml(moduleId, def, value) {
  return `
    <x-knob label="${def.label}" min="${def.min}" max="${def.max}" value="${value}"
      ${def.curve ? `curve="${def.curve}"` : ''} ${def.unit ? `unit="${def.unit}"` : ''} ${def.step ? `step="${def.step}"` : ''}
      data-module-id="${moduleId}" data-module-param="${def.key}"></x-knob>
  `;
}

function enumButtonsHtml(moduleId, key, options, current) {
  return `
    <div class="seg mod-box__seg" data-module-id="${moduleId}" data-module-enum="${key}">
      ${options.map((o) => `<button type="button" class="seg__btn${o.value === current ? ' is-active' : ''}" data-value="${o.value}">${o.label}</button>`).join('')}
    </div>
  `;
}

function moduleBoxHtml(id, m) {
  const ports = MODULE_PORTS[m.type];
  const paramDefs = MODULE_UI_PARAMS[m.type] ?? [];
  let enumHtml = '';
  if (m.type === 'oscillator' || m.type === 'lfo') enumHtml += enumButtonsHtml(id, 'wave', OSCILLATOR_WAVES, m.params.wave);
  if (m.type === 'filter') enumHtml += enumButtonsHtml(id, 'type', FILTER_TYPES, m.params.type);

  return `
    <div class="mod-box" data-module-id="${id}" style="left:${m.x}px; top:${m.y}px;">
      <div class="mod-box__head">${moduleMeta(m.type).name}</div>
      <div class="mod-box__ports mod-box__ports--in">
        ${ports.inputs.map((p) => `<span class="port port--in" data-module-id="${id}" data-port-dir="in" data-port-key="${p.key}"><span class="port__dot"></span>${p.label}</span>`).join('')}
      </div>
      ${enumHtml}
      <div class="mod-box__params">${paramDefs.map((d) => knobHtml(id, d, m.params[d.key])).join('')}</div>
      <div class="mod-box__ports mod-box__ports--out">
        ${ports.outputs.map((p) => `<span class="port port--out" data-module-id="${id}" data-port-dir="out" data-port-key="${p.key}">${p.label}<span class="port__dot"></span></span>`).join('')}
      </div>
    </div>
  `;
}

function renderPatch() {
  if (!currentMachine) return;
  const patch = currentMachine.patch;
  canvasEl.innerHTML = [...patch.modules.entries()].map(([id, m]) => moduleBoxHtml(id, m)).join('');

  for (const knob of canvasEl.querySelectorAll('x-knob[data-module-id]')) {
    knob.addEventListener('input', (e) => {
      patch.setModuleParam(Number(knob.dataset.moduleId), knob.dataset.moduleParam, e.detail.value);
    });
  }
  for (const seg of canvasEl.querySelectorAll('[data-module-enum]')) {
    const id = Number(seg.dataset.moduleId);
    const key = seg.dataset.moduleEnum;
    seg.querySelectorAll('[data-value]').forEach((btn) => {
      btn.addEventListener('click', () => {
        patch.setModuleParam(id, key, btn.dataset.value);
        seg.querySelectorAll('[data-value]').forEach((b) => b.classList.toggle('is-active', b === btn));
      });
    });
  }
  updateCables();
}

/** Zeichnet alle Kabel als quadratische Bezier-Kurven zwischen den
 *  Mittelpunkten ihrer Port-Punkte -- läuft nach jedem Modul-Zug und nach
 *  jeder Patch-Änderung erneut (billige DOM-Messung, Modulanzahl ist klein). */
function updateCables() {
  if (!currentMachine) return;
  const wrapRect = editorEl.querySelector('.modular-editor__canvas-wrap').getBoundingClientRect();
  const scrollLeft = editorEl.querySelector('.modular-editor__canvas-wrap').scrollLeft;
  const scrollTop = editorEl.querySelector('.modular-editor__canvas-wrap').scrollTop;
  const portCenter = (moduleId, dir, key) => {
    const el = canvasEl.querySelector(`.port[data-module-id="${moduleId}"][data-port-dir="${dir}"][data-port-key="${key}"] .port__dot`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2 - wrapRect.left + scrollLeft, y: r.top + r.height / 2 - wrapRect.top + scrollTop };
  };

  const paths = currentMachine.patch.cables.map((c) => {
    const from = portCenter(c.fromId, 'out', c.fromPort);
    const to = portCenter(c.toId, 'in', c.toPort);
    if (!from || !to) return '';
    const midX = (from.x + to.x) / 2;
    return `<path class="mod-cable" data-cable-id="${c.id}" d="M${from.x},${from.y} C${midX},${from.y} ${midX},${to.y} ${to.x},${to.y}"></path>`;
  }).join('');

  svgEl.innerHTML = paths + (pendingCablePath ?? '');
}

/* ---------- Modul verschieben ---------- */

function wireModuleDrag() {
  let dragId = null;
  let startX = 0, startY = 0, origX = 0, origY = 0;
  const MOVE_TOLERANCE = 6;
  let moved = false;
  let holdTimer = null;
  const HOLD_MS = 500;

  canvasEl.addEventListener('pointerdown', (e) => {
    const box = e.target.closest('.mod-box');
    if (!box || e.target.closest('.port, x-knob, .mod-box__seg')) return;
    if (!currentMachine) return;
    dragId = Number(box.dataset.moduleId);
    const m = currentMachine.patch.modules.get(dragId);
    if (!m) return;
    startX = e.clientX; startY = e.clientY;
    origX = m.x; origY = m.y;
    moved = false;
    try { canvasEl.setPointerCapture(e.pointerId); } catch { /* Testumgebung, s. EQ8-Graph */ }
    holdTimer = setTimeout(() => { openModuleMenu(dragId, box); holdTimer = null; }, HOLD_MS);
  });
  canvasEl.addEventListener('pointermove', (e) => {
    if (dragId == null) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (!moved && Math.hypot(dx, dy) > MOVE_TOLERANCE) {
      moved = true;
      clearTimeout(holdTimer); holdTimer = null;
    }
    if (!moved) return;
    const m = currentMachine.patch.modules.get(dragId);
    if (!m) return;
    m.x = Math.max(0, origX + dx);
    m.y = Math.max(0, origY + dy);
    const box = canvasEl.querySelector(`.mod-box[data-module-id="${dragId}"]`);
    if (box) { box.style.left = `${m.x}px`; box.style.top = `${m.y}px`; }
    updateCables();
  });
  const endDrag = () => { clearTimeout(holdTimer); holdTimer = null; dragId = null; moved = false; };
  canvasEl.addEventListener('pointerup', endDrag);
  canvasEl.addEventListener('pointercancel', endDrag);
}

/* ---------- Kabel ziehen ---------- */

let pendingFrom = null; // { moduleId, port }
let pendingCablePath = null;

function wireCableDrag() {
  canvasEl.addEventListener('pointerdown', (e) => {
    const port = e.target.closest('.port--out');
    if (!port) return;
    pendingFrom = { moduleId: Number(port.dataset.moduleId), port: port.dataset.portKey };
    try { canvasEl.setPointerCapture(e.pointerId); } catch { /* s. oben */ }
    e.stopPropagation(); // nicht auch noch als Modul-Zug zählen
  });
  canvasEl.addEventListener('pointermove', (e) => {
    if (!pendingFrom) return;
    const wrapRect = editorEl.querySelector('.modular-editor__canvas-wrap').getBoundingClientRect();
    const wrap = editorEl.querySelector('.modular-editor__canvas-wrap');
    const fromDot = canvasEl.querySelector(`.port[data-module-id="${pendingFrom.moduleId}"][data-port-dir="out"][data-port-key="${pendingFrom.port}"] .port__dot`);
    if (!fromDot) return;
    const r = fromDot.getBoundingClientRect();
    const fx = r.left + r.width / 2 - wrapRect.left + wrap.scrollLeft;
    const fy = r.top + r.height / 2 - wrapRect.top + wrap.scrollTop;
    const tx = e.clientX - wrapRect.left + wrap.scrollLeft;
    const ty = e.clientY - wrapRect.top + wrap.scrollTop;
    const midX = (fx + tx) / 2;
    pendingCablePath = `<path class="mod-cable mod-cable--pending" d="M${fx},${fy} C${midX},${fy} ${midX},${ty} ${tx},${ty}"></path>`;
    updateCables();
  });
  const finishDrag = (e) => {
    if (!pendingFrom) return;
    const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.port--in');
    if (target && currentMachine) {
      currentMachine.patch.connect(pendingFrom.moduleId, pendingFrom.port, Number(target.dataset.moduleId), target.dataset.portKey);
    }
    pendingFrom = null;
    pendingCablePath = null;
    renderPatch();
  };
  canvasEl.addEventListener('pointerup', finishDrag);
  canvasEl.addEventListener('pointercancel', () => { pendingFrom = null; pendingCablePath = null; updateCables(); });
}

/* ---------- Modul-Menü (Halten) ---------- */

let moduleMenuEl = null;
const dismissModuleMenu = () => { moduleMenuEl?.remove(); moduleMenuEl = null; document.removeEventListener('pointerdown', onOutsideModuleMenu, true); };
const onOutsideModuleMenu = (e) => { if (moduleMenuEl && !moduleMenuEl.contains(e.target)) dismissModuleMenu(); };

function openModuleMenu(moduleId, anchorEl) {
  dismissModuleMenu();
  if (!currentMachine) return;
  const m = currentMachine.patch.modules.get(moduleId);
  if (!m) return;

  moduleMenuEl = document.createElement('div');
  moduleMenuEl.className = 'pat-chip';

  const dupBtn = document.createElement('button');
  dupBtn.className = 'pat-chip__btn';
  dupBtn.textContent = '⧉ Duplicate';
  dupBtn.addEventListener('click', () => {
    currentMachine.patch.addModule(m.type, { params: { ...m.params }, x: m.x + 24, y: m.y + 24 });
    dismissModuleMenu();
    renderPatch();
  });
  moduleMenuEl.appendChild(dupBtn);

  // Der Output-Baustein ist der feste Endpunkt jedes Patches (s.
  // machines/modular.js#connectOutputs) -- der LETZTE darf nicht entfernbar
  // sein, sonst verstummt die Maschine ohne jeden sichtbaren Grund.
  const outputCount = [...currentMachine.patch.modules.values()].filter((x) => x.type === 'output').length;
  const canRemove = m.type !== 'output' || outputCount > 1;
  if (canRemove) {
    const removeBtn = document.createElement('button');
    removeBtn.className = 'pat-chip__btn pat-chip__btn--danger';
    removeBtn.textContent = '🗑 Remove';
    removeBtn.addEventListener('click', () => {
      currentMachine.patch.removeModule(moduleId);
      dismissModuleMenu();
      renderPatch();
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

/* ---------- "+ Add Module"-Picker ---------- */

function openModulePicker() {
  if (!modulePickerEl) {
    modulePickerEl = document.createElement('div');
    modulePickerEl.className = 'sheet sheet--module-picker';
    modulePickerEl.hidden = true;
    modulePickerEl.innerHTML = `
      <div class="sheet__backdrop" data-close></div>
      <div class="sheet__panel">
        <div class="sheet__grip"></div>
        <h2 class="sheet__title">Add Module</h2>
        <div class="sheet__list" id="module-picker-list"></div>
      </div>
    `;
    document.body.appendChild(modulePickerEl);
    modulePickerEl.querySelector('[data-close]').addEventListener('click', () => { modulePickerEl.hidden = true; });
    const list = modulePickerEl.querySelector('#module-picker-list');
    for (const type of MODULE_TYPES) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'sheet__item';
      item.innerHTML = `<span><div class="sheet__name">${moduleMeta(type).name}</div></span>`;
      item.addEventListener('click', () => {
        if (currentMachine) {
          // Reihum in einem Raster platzieren statt immer bei (20,20) --
          // sonst landet jedes neue Modul exakt auf dem Oszillator der
          // Grundausstattung und verdeckt ihn vollständig (Ports/Regler
          // unerreichbar), s. Chat-Screenshot beim Testen.
          const n = currentMachine.patch.modules.size;
          const cols = 6;
          const x = 20 + (n % cols) * 170;
          const y = 20 + Math.floor(n / cols) * 170;
          currentMachine.patch.addModule(type, { x, y });
          renderPatch();
        }
        modulePickerEl.hidden = true;
      });
      list.appendChild(item);
    }
  }
  modulePickerEl.hidden = false;
}
