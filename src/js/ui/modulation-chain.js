/**
 * modulation-chain.js — UI für die Modulations-Kette (LFO/Arpeggiator),
 * das Gegenstück zu insert-chain.js für modulators.js. Gleiches generisches
 * Owner-Interface wie dort, nur mit anderen Methodennamen:
 *   owner.modulators              — Array der aktuellen Modulator-Objekte
 *   owner.laneKeyPrefix           — s. insert-chain.js
 *   owner.setModulatorParam(id, key, value)
 *   owner.setModulatorBypass(id, bool)
 *   owner.moveModulator(id, dir)
 *   owner.removeModulator(id)
 *   owner.el                      — gerendertes Maschinen-Element, liefert
 *                                    die LFO-Ziel-Auswahl (alle eigenen
 *                                    data-auto-Knobs der Maschine)
 */
import { automation } from '../core/automation.js';
import { MODULATOR_TYPES, MOD_DISPLAY, MOD_COLORS, LFO_WAVES, LFO_SYNC_BUTTONS, ARP_MODES, ARP_SYNC_BUTTONS } from '../core/modulators.js';

function modColorVars(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `--m-color:${hex}; --m-color-dim:rgba(${r},${g},${b},.22); `
    + `--m-color-glow:rgba(${r},${g},${b},.45); --m-color-tint:rgba(${r},${g},${b},.08);`;
}

/** Alle eigenen automatisierbaren Regler der Maschine als LFO-Zielauswahl --
 *  dieselben Knobs, die man auch von Hand als Automations-Lane aufnehmen
 *  kann (data-auto, s. machine.js#render()). Insert- und Modulator-Ketten-
 *  Knobs tragen bewusst KEIN data-auto (eigener Registrierungsweg, s. dort),
 *  tauchen hier also nie versehentlich als Ziel auf. */
function targetOptions(owner) {
  if (!owner.el) return [];
  const seen = new Set();
  const out = [];
  for (const knob of owner.el.querySelectorAll('x-knob[data-auto]')) {
    const key = knob.dataset.p;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, label: knob.getAttribute('label') || key });
  }
  return out;
}

let pickerEl = null;

/** `allowedTypes` filtert das Sheet (z. B. Arpeggiator nur bei Maschinen mit
 *  gehaltenen Keybed-Stimmen, s. subsynth.js/polysynth.js/fmsynth.js). */
export function openModulatorPicker(onPick, allowedTypes = MODULATOR_TYPES) {
  if (!pickerEl) {
    pickerEl = document.createElement('div');
    pickerEl.className = 'sheet sheet--modulator-picker';
    pickerEl.hidden = true;
    document.body.appendChild(pickerEl);
    pickerEl.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) { pickerEl.hidden = true; return; }
      const btn = e.target.closest('[data-type]');
      if (!btn) return;
      pickerEl.hidden = true;
      pickerEl._onPick?.(btn.dataset.type);
    });
  }
  pickerEl.innerHTML = `
    <div class="sheet__backdrop" data-close></div>
    <div class="sheet__panel" role="dialog" aria-label="Modulator">
      <div class="sheet__grip"></div>
      <h2 class="sheet__title">Modulator</h2>
      <div class="sheet__list">
        ${allowedTypes.map((type) => `
          <button type="button" class="sheet__item" data-type="${type}">
            <span class="sheet__name">${MOD_DISPLAY[type]?.name ?? type}</span>
          </button>
        `).join('')}
      </div>
    </div>
  `;
  pickerEl._onPick = onPick;
  pickerEl.hidden = false;
}

/** Rendert die komplette Modulations-Kette von `owner` in `listEl`. */
export function renderModulationChain(listEl, owner) {
  if (!listEl) return;
  const options = targetOptions(owner);

  listEl.innerHTML = owner.modulators.map((mod, idx) => {
    const knobHtml = (label, key, min, max, extra = {}) => `
      <x-knob label="${label}" min="${min}" max="${max}" value="${mod.params[key]}"
        ${extra.curve ? `curve="${extra.curve}"` : ''} ${extra.unit ? `unit="${extra.unit}"` : ''}
        ${extra.step ? `step="${extra.step}"` : ''}
        data-mod-id="${mod.id}" data-mod-param="${key}"></x-knob>
    `;

    let bodyHtml;
    if (mod.type === 'lfo') {
      bodyHtml = `
        <div class="mod-target">
          <span class="mod-target__label">Target</span>
          <select class="mod-target__select" data-mod-target>
            <option value=""${mod.params.target ? '' : ' selected'}>— none —</option>
            ${options.map((o) => `<option value="${o.key}"${o.key === mod.params.target ? ' selected' : ''}>${o.label}</option>`).join('')}
          </select>
        </div>
        <div class="seg">
          ${LFO_WAVES.map((w) => `
            <button type="button" class="seg__btn${mod.params.wave === w.value ? ' is-active' : ''}" data-lfo-wave="${w.value}">${w.label}</button>
          `).join('')}
        </div>
        <div class="seg">
          ${LFO_SYNC_BUTTONS.map((s) => `
            <button type="button" class="seg__btn${mod.params.division === s.value ? ' is-active' : ''}" data-lfo-sync="${s.value}">${s.label}</button>
          `).join('')}
        </div>
        <div class="insert-row__params">
          ${mod.params.division === 'free' ? knobHtml('Rate', 'rateHz', 0.05, 20, { curve: 'log', unit: 'Hz' }) : ''}
          ${knobHtml('Depth', 'depth', 0, 1)}
        </div>
      `;
    } else {
      bodyHtml = `
        <div class="seg">
          ${ARP_MODES.map((m) => `
            <button type="button" class="seg__btn${mod.params.mode === m.value ? ' is-active' : ''}" data-arp-mode="${m.value}">${m.label}</button>
          `).join('')}
        </div>
        <div class="seg">
          ${ARP_SYNC_BUTTONS.map((s) => `
            <button type="button" class="seg__btn${mod.params.division === s.value ? ' is-active' : ''}" data-arp-sync="${s.value}">${s.label}</button>
          `).join('')}
        </div>
        <div class="insert-row__params">
          ${knobHtml('Octaves', 'octaves', 1, 4, { step: 1 })}
        </div>
      `;
    }

    const { name, badge } = MOD_DISPLAY[mod.type];
    return `
      <section class="machine mod-module${mod.bypassed ? ' is-bypassed' : ''}"
        data-mod-id="${mod.id}" style="${modColorVars(MOD_COLORS[mod.type])}">
        <header class="machine__head">
          <span class="machine__stripe"></span>
          <div class="machine__title">
            <span>
              <div class="machine__name">${name}</div>
              <div class="machine__type">${badge} · #${mod.id}</div>
            </span>
          </div>
          <div class="machine__head-actions">
            <button type="button" class="m-btn insert-row__move" data-move="-1" aria-label="Move up" ${idx === 0 ? 'disabled' : ''}>▲</button>
            <button type="button" class="m-btn insert-row__move" data-move="1" aria-label="Move down" ${idx === owner.modulators.length - 1 ? 'disabled' : ''}>▼</button>
            <button type="button" class="m-btn insert-row__bypass${mod.bypassed ? ' is-active' : ''}" data-bypass>BYP</button>
            <button type="button" class="m-btn insert-row__remove" data-remove aria-label="Remove modulator">✕</button>
          </div>
        </header>
        <div class="machine__body">${bodyHtml}</div>
      </section>
    `;
  }).join('');

  for (const row of listEl.querySelectorAll('.mod-module')) {
    const id = parseInt(row.dataset.modId, 10);
    const mod = owner.modulators.find((m) => m.id === id);
    row.querySelector('[data-move="-1"]')?.addEventListener('click', () => owner.moveModulator(id, -1));
    row.querySelector('[data-move="1"]')?.addEventListener('click', () => owner.moveModulator(id, 1));
    row.querySelector('[data-bypass]').addEventListener('click', () => {
      owner.setModulatorBypass(id, !mod.bypassed);
      renderModulationChain(listEl, owner);
    });
    row.querySelector('[data-remove]').addEventListener('click', () => owner.removeModulator(id));

    row.querySelector('[data-mod-target]')?.addEventListener('change', (e) => {
      owner.setModulatorParam(id, 'target', e.target.value);
      renderModulationChain(listEl, owner);
    });
    for (const btn of row.querySelectorAll('[data-lfo-wave]')) {
      btn.addEventListener('click', () => {
        owner.setModulatorParam(id, 'wave', btn.dataset.lfoWave);
        renderModulationChain(listEl, owner);
      });
    }
    for (const btn of row.querySelectorAll('[data-lfo-sync]')) {
      btn.addEventListener('click', () => {
        owner.setModulatorParam(id, 'division', btn.dataset.lfoSync);
        renderModulationChain(listEl, owner); // Rate-Knob muss ggf. ein-/ausgeblendet werden
      });
    }
    for (const btn of row.querySelectorAll('[data-arp-mode]')) {
      btn.addEventListener('click', () => {
        owner.setModulatorParam(id, 'mode', btn.dataset.arpMode);
        renderModulationChain(listEl, owner);
      });
    }
    for (const btn of row.querySelectorAll('[data-arp-sync]')) {
      btn.addEventListener('click', () => {
        owner.setModulatorParam(id, 'division', btn.dataset.arpSync);
        renderModulationChain(listEl, owner);
      });
    }

    for (const knob of row.querySelectorAll('x-knob[data-mod-param]')) {
      knob.addEventListener('input', (e) => {
        owner.setModulatorParam(id, knob.dataset.modParam, e.detail.value);
      });
      // Automatisierbar wie ein Insert-Regler (s. insert-chain.js für die
      // ausführliche Begründung: die Zeile wird bei jedem Umbau komplett
      // neu gerendert, register() muss deshalb bei jedem Rendern erneut
      // auf das jeweils aktuelle Element gebunden werden).
      const autoKey = `${owner.laneKeyPrefix}:mod:${id}:${knob.dataset.modParam}`;
      automation.register(autoKey, knob, (v) => {
        knob.value = v;
        knob.dispatchEvent(new CustomEvent('input', { detail: { value: v }, bubbles: true }));
      });
      knob.classList.toggle('has-auto', automation.hasLane(autoKey));
    }
  }
}
