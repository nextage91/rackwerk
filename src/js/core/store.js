/**
 * store — dünner Wrapper um localStorage mit In-Memory-Fallback.
 *
 * In manchen eingebetteten WebViews (z. B. Datei-Previews) ist
 * localStorage blockiert; dann läuft der Speicher nur für die Sitzung.
 * `store.persistent` sagt der UI, welcher Fall vorliegt.
 */
const PREFIX = 'rackwerk:';

class Store {
  constructor() {
    this.mem = new Map();
    this.persistent = false;
    try {
      localStorage.setItem(PREFIX + '__test', '1');
      localStorage.removeItem(PREFIX + '__test');
      this.persistent = true;
    } catch { /* Fallback auf Map */ }
  }

  get(key) {
    try {
      if (this.persistent) return localStorage.getItem(PREFIX + key);
    } catch { /* fällt durch */ }
    return this.mem.get(key) ?? null;
  }

  set(key, value) {
    try {
      if (this.persistent) {
        localStorage.setItem(PREFIX + key, value);
        return;
      }
    } catch { /* fällt durch */ }
    this.mem.set(key, value);
  }

  remove(key) {
    try {
      if (this.persistent) {
        localStorage.removeItem(PREFIX + key);
        return;
      }
    } catch { /* fällt durch */ }
    this.mem.delete(key);
  }

  /** Alle Schlüssel (ohne Prefix). */
  keys() {
    if (this.persistent) {
      const out = [];
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k?.startsWith(PREFIX)) out.push(k.slice(PREFIX.length));
        }
        return out;
      } catch { /* fällt durch */ }
    }
    return [...this.mem.keys()];
  }
}

export const store = new Store();
