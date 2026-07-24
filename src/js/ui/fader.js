/**
 * <x-fader> — vertical channel-strip fader (linear gain 0..1, dB scale).
 *
 * Touching the track jumps the cap to the finger position (like a real
 * fader, not a relative drag) and follows the finger 1:1 afterwards.
 * Double-tap resets to the default value. Drag axis is mapped through a
 * dB scale (FLOOR_DB..0) so the throw feels like a console fader instead
 * of a linear gain slider.
 *
 * Attributes: default, value (linear gain 0..1)
 * Event: "input" (detail.value) on every change.
 */
const FLOOR_DB = -60;

export class XFader extends HTMLElement {
  static observedAttributes = ['value'];

  connectedCallback() {
    if (this.#built) return;
    this.#built = true;

    this.defaultValue = parseFloat(this.getAttribute('default') ?? this.getAttribute('value') ?? '1');
    this.#value = parseFloat(this.getAttribute('value') ?? '1');

    this.innerHTML = `
      <div class="fader__scale">
        <span>0</span><span>−6</span><span>−12</span><span>−24</span><span>−60</span>
      </div>
      <div class="fader__track">
        <div class="fader__fill"></div>
        <div class="fader__cap"></div>
      </div>
      <span class="fader__value"></span>
    `;
    this.#track = this.querySelector('.fader__track');
    this.#cap = this.querySelector('.fader__cap');
    this.#fill = this.querySelector('.fader__fill');
    this.#readout = this.querySelector('.fader__value');

    this.#track.addEventListener('pointerdown', this.#onDown);
    // Die Kappe überragt den Track um die halbe eigene Höhe an den Enden
    // (s. CSS margin-bottom auf .fader__cap) -- genau dort, wo man sie
    // greift, wenn der Fader ganz unten oder ganz oben steht. Ohne einen
    // eigenen Listener hier würde ein Tap exakt auf die sichtbare Kappe an
    // dieser Stelle am Track vorbei ins Leere (bzw. auf die Pegelanzeige
    // darunter) treffen -- der Fader würde gar nicht erst reagieren.
    // Derselbe Handler, dieselbe Pointer-Capture (immer auf #track, s.
    // #onDown) -- unabhängig davon, welches der beiden Elemente den
    // Pointerdown tatsächlich empfangen hat.
    this.#cap.addEventListener('pointerdown', this.#onDown);
    this.#render();
  }

  #built = false;
  #value = 1;
  #track; #cap; #fill; #readout;
  #trackTop = 0; #trackBottom = 0;
  #lastTap = 0;
  #downAt = 0; #downY = 0;

  get value() {
    // Before mount (element not yet in the DOM) return the attribute value.
    return this.#built ? this.#value : parseFloat(this.getAttribute('value') ?? '1');
  }
  set value(v) {
    if (!this.#built) {
      // Not yet connected → buffer via attribute, connectedCallback reads it.
      this.setAttribute('value', v);
      return;
    }
    this.#value = Math.min(1, Math.max(0, v));
    this.#render();
  }

  attributeChangedCallback(name, _old, val) {
    if (name === 'value' && this.#built) this.value = parseFloat(val);
  }

  /* ---------- linear gain (0..1) <-> fader travel (0..1), through dB ---------- */
  #toNorm(v) {
    if (v <= 0) return 0;
    const db = Math.max(FLOOR_DB, Math.min(0, 20 * Math.log10(v)));
    return (db - FLOOR_DB) / -FLOOR_DB;
  }
  #fromNorm(n) {
    n = Math.min(1, Math.max(0, n));
    if (n <= 0) return 0;
    const db = FLOOR_DB + n * -FLOOR_DB;
    return Math.pow(10, db / 20);
  }

  /* ---------- Pointer handling ---------- */
  #onDown = (e) => {
    e.preventDefault();
    this.#track.setPointerCapture?.(e.pointerId);

    const now = performance.now();
    if (now - this.#lastTap < 300) {
      this.#lastTap = 0;
      this.value = this.defaultValue;
      this.#emit();
      return; // reset stands — don't also jump to the tap position
    }

    this.#downAt = now;
    this.#downY = e.clientY;

    const r = this.#track.getBoundingClientRect();
    this.#trackTop = r.top;
    this.#trackBottom = r.bottom;
    this.#dragTo(e.clientY);

    this.#track.addEventListener('pointermove', this.#onMove);
    this.#track.addEventListener('pointerup', this.#onUp);
    this.#track.addEventListener('pointercancel', this.#onUp);
  };

  #onMove = (e) => this.#dragTo(e.clientY);

  /**
   * clientY wird direkt auf die reale, unveränderliche Track-Kante geklemmt
   * -- keine Toleranz, kein "mitwanderndes" Grenzpaar. Eine frühere Version
   * liess die Grenze bei jedem Overshoot unbegrenzt mitwachsen (Fader klebte
   * dauerhaft nach einem schnellen Drag über den kurzen Track hinaus); eine
   * Zwischenversion begrenzte das auf eine feste Toleranz, liess aber noch
   * eine Totzone übrig, sobald der Overshoot grösser als die Toleranz war
   * (weiterhin spürbares "Kleben" bei jedem realistisch schnellen Drag).
   * Mit dem harten Clamp reagiert der Wert exakt in dem Moment wieder, in
   * dem der Finger zurück über die reale Kante wandert -- keine Totzone,
   * keine verwässerte Empfindlichkeit, für jede Overshoot-Distanz gleich.
   */
  #dragTo(clientY) {
    const y = Math.min(this.#trackBottom, Math.max(this.#trackTop, clientY));
    const height = this.#trackBottom - this.#trackTop;
    const norm = height > 0 ? Math.min(1, Math.max(0, (this.#trackBottom - y) / height)) : 1;
    const next = this.#fromNorm(norm);
    if (next !== this.#value) {
      this.#value = next;
      this.#render();
      this.#emit();
    }
  }

  #onUp = (e) => {
    this.#track.releasePointerCapture?.(e.pointerId);
    this.#track.removeEventListener('pointermove', this.#onMove);
    this.#track.removeEventListener('pointerup', this.#onUp);
    this.#track.removeEventListener('pointercancel', this.#onUp);

    // Nur eine Geste ohne nennenswerte Bewegung zählt als "Tap" für den
    // Doppel-Tap-Reset -- sonst würde ein schneller Korrektur-Griff direkt
    // nach einem Flick-Drag (beides zusammen leicht unter 300ms) fälschlich
    // als zweiter Tap gewertet: Wert springt auf defaultValue, UND die
    // gerade laufende Geste bekommt (weil #onDown dafür früh zurückkehrt)
    // nie ihre pointermove/pointerup-Listener -- der Fader "klebt" dann am
    // Reset-Wert (meist 1, also ganz oben), egal wie weit man weiterzieht.
    const moved = Math.abs(e.clientY - this.#downY) > 6;
    this.#lastTap = moved ? 0 : this.#downAt;
  };

  #emit() {
    this.dispatchEvent(new CustomEvent('input', {
      detail: { value: this.#value },
      bubbles: true,
    }));
  }

  #render() {
    const norm = this.#toNorm(this.#value);
    this.#cap.style.bottom = `${norm * 100}%`;
    this.#fill.style.height = `${norm * 100}%`;
    if (this.#value <= 0) {
      this.#readout.textContent = '−∞';
    } else {
      const db = 20 * Math.log10(this.#value);
      this.#readout.textContent = `${db >= 0 ? '+' : '−'}${Math.abs(db).toFixed(1)}`;
    }
  }
}

customElements.define('x-fader', XFader);
