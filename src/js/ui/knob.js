/**
 * <x-knob> — touch-optimierter Drehregler.
 *
 * Bedienung wie in Hardware-Apps üblich:
 * - Ziehen ändert den Wert: hoch ODER nach rechts = mehr, beides
 *   kombiniert sich (diagonal). Horizontal ist wichtig für eingebettete
 *   WebViews/Sheets, in denen vertikales Wischen native Gesten auslöst.
 * - Volle Drag-Strecke ≈ 150 px für den ganzen Wertebereich
 * - Doppeltipp setzt auf den Standardwert zurück
 * - touch-action:none im CSS verhindert, dass das Rack dabei scrollt
 *
 * Attribute: label, min, max, value, default, unit, step, curve ("lin"|"log")
 * Event: "input" (detail.value) bei jeder Änderung.
 */
const DRAG_RANGE_PX = 150;
const ANGLE_MIN = -135;
const ANGLE_MAX = 135;

export class XKnob extends HTMLElement {
  static observedAttributes = ['value'];

  connectedCallback() {
    if (this.#built) return;
    this.#built = true;

    this.min = parseFloat(this.getAttribute('min') ?? '0');
    this.max = parseFloat(this.getAttribute('max') ?? '1');
    this.step = parseFloat(this.getAttribute('step') ?? '0');
    this.curve = this.getAttribute('curve') ?? 'lin';
    this.unit = this.getAttribute('unit') ?? '';
    this.defaultValue = parseFloat(
      this.getAttribute('default') ?? this.getAttribute('value') ?? `${this.min}`
    );
    this.#value = parseFloat(this.getAttribute('value') ?? `${this.min}`);

    this.innerHTML = `
      <div class="knob__dial"><div class="knob__pointer"></div></div>
      <span class="knob__label">${this.getAttribute('label') ?? ''}</span>
      <span class="knob__value"></span>
    `;
    this.#dial = this.querySelector('.knob__dial');
    this.#pointer = this.querySelector('.knob__pointer');
    this.#readout = this.querySelector('.knob__value');

    this.#dial.addEventListener('pointerdown', this.#onDown);
    this.#render();
  }

  #built = false;
  #value = 0;
  #dial; #pointer; #readout;
  #dragStartY = 0;
  #dragStartX = 0;
  #dragStartNorm = 0;
  #lastTap = 0;
  #lpTimer = null;
  #lpStartY = 0;

  get value() {
    // Vor dem Aufbau (Element noch nicht im DOM) den Attributwert liefern
    return this.#built ? this.#value : parseFloat(this.getAttribute('value') ?? '0');
  }
  set value(v) {
    if (!this.#built) {
      // Noch nicht verbunden → puffern; connectedCallback liest das Attribut
      this.setAttribute('value', v);
      return;
    }
    this.#value = Math.min(this.max, Math.max(this.min, v));
    this.#render();
  }

  attributeChangedCallback(name, _old, val) {
    if (name === 'value' && this.#built) this.value = parseFloat(val);
  }

  /* ---------- Normalisierung (0..1), optional logarithmisch ---------- */
  #toNorm(v) {
    if (this.curve === 'log') {
      return Math.log(v / this.min) / Math.log(this.max / this.min);
    }
    return (v - this.min) / (this.max - this.min);
  }
  #fromNorm(n) {
    n = Math.min(1, Math.max(0, n));
    let v = this.curve === 'log'
      ? this.min * Math.pow(this.max / this.min, n)
      : this.min + n * (this.max - this.min);
    if (this.step > 0) v = Math.round(v / this.step) * this.step;
    return v;
  }

  /* ---------- Pointer-Handling ---------- */
  #onDown = (e) => {
    e.preventDefault();
    this.#dial.setPointerCapture?.(e.pointerId);
    this.#emitPlain('knob-grab');

    // Long-Press (z. B. »Automation löschen«): 550 ms ohne nennenswerte
    // Bewegung. Wird beim Ziehen oder Loslassen abgebrochen.
    this.#lpStartY = e.clientY;
    clearTimeout(this.#lpTimer);
    this.#lpTimer = setTimeout(() => {
      this.#lpTimer = null;
      this.#emitPlain('knob-longpress');
    }, 550);

    // Doppeltipp → Reset auf Standardwert (+ Signal an die Automation)
    const now = performance.now();
    if (now - this.#lastTap < 300) {
      this.value = this.defaultValue;
      this.#emit();
      this.#emitPlain('knob-reset');
    }
    this.#lastTap = now;

    this.#dragStartY = e.clientY;
    this.#dragStartX = e.clientX;
    this.#dragStartNorm = this.#toNorm(this.#value);

    this.#dial.addEventListener('pointermove', this.#onMove);
    this.#dial.addEventListener('pointerup', this.#onUp);
    this.#dial.addEventListener('pointercancel', this.#onUp);
  };

  #onMove = (e) => {
    if (this.#lpTimer &&
        (Math.abs(e.clientY - this.#lpStartY) > 6 ||
         Math.abs((e.clientX ?? this.#dragStartX) - this.#dragStartX) > 6)) {
      clearTimeout(this.#lpTimer);
      this.#lpTimer = null;
    }
    const dy = this.#dragStartY - e.clientY;                       // hoch = mehr
    const dx = (e.clientX ?? this.#dragStartX) - this.#dragStartX; // rechts = mehr
    const rawNorm = this.#dragStartNorm + (dy + dx) / DRAG_RANGE_PX;
    // Über den Anschlag hinausgezogen (rawNorm < 0 oder > 1)? Anker
    // mitschieben, sonst entsteht eine tote Zone: der Wert bliebe bei
    // 0/1 hängen, bis der Finger beim Umkehren wieder über die
    // URSPRÜNGLICHE Zugstrecke zurückgewandert ist -- fühlt sich wie ein
    // klemmender Regler an (dieselbe Idee wie x-fader#dragTo).
    const norm = Math.min(1, Math.max(0, rawNorm));
    if (rawNorm !== norm) {
      this.#dragStartNorm = norm;
      this.#dragStartY = e.clientY;
      this.#dragStartX = e.clientX ?? this.#dragStartX;
    }
    const next = this.#fromNorm(norm);
    if (next !== this.#value) {
      this.#value = next;
      this.#render();
      this.#emit();
    }
  };

  #onUp = (e) => {
    clearTimeout(this.#lpTimer);
    this.#lpTimer = null;
    this.#dial.releasePointerCapture?.(e.pointerId);
    this.#dial.removeEventListener('pointermove', this.#onMove);
    this.#dial.removeEventListener('pointerup', this.#onUp);
    this.#dial.removeEventListener('pointercancel', this.#onUp);
    this.#emitPlain('knob-release');
  };

  #emitPlain(type) {
    this.dispatchEvent(new CustomEvent(type, { bubbles: true }));
  }

  #emit() {
    this.dispatchEvent(new CustomEvent('input', {
      detail: { value: this.#value },
      bubbles: true,
    }));
  }

  #render() {
    const norm = this.#toNorm(this.#value);
    const angle = ANGLE_MIN + norm * (ANGLE_MAX - ANGLE_MIN);
    this.#pointer.style.transform = `rotate(${angle}deg)`;

    const digits = (this.max - this.min) > 100 ? 0 : 2;
    this.#readout.textContent =
      `${this.#value.toFixed(digits)}${this.unit ? ' ' + this.unit : ''}`;
  }
}

customElements.define('x-knob', XKnob);
