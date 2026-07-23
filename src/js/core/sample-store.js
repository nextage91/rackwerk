/**
 * sample-store — IndexedDB-Ablage für Sampler-Audiodaten.
 *
 * Samples sind zu groß für localStorage (store.js, ~5-10MB Limit gesamt) —
 * IndexedDB fasst um Größenordnungen mehr und blockiert den Main-Thread
 * nicht. Ein Sample lebt hier unter einer generierten ID; Projekte
 * (project.js/sampler.js) speichern nur die ID, nie die Audiodaten selbst
 * (bleibt so klein genug für den synchronen Autosave-Pfad).
 *
 * In-Memory-Fallback (wie store.js), falls IndexedDB blockiert ist (manche
 * eingebetteten WebViews) — dann überleben Samples nur die Sitzung.
 */
const DB_NAME = 'rackwerk-samples';
const STORE_NAME = 'samples';
const DB_VERSION = 1;

const mem = new Map();
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB not available')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE_NAME); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

let counter = 0;
/** Eindeutige, zeitlich sortierbare Sample-ID (kollisionsarm genug für
 *  Client-lokale Zwecke — kein Cross-Device-Anspruch). */
export function newSampleId() {
  return `smp_${Date.now()}_${counter++}`;
}

/** Für den Datei-Export (main.js): eine IndexedDB-ID ist auf einem ANDEREN
 *  Gerät/Browser-Profil bedeutungslos -- die exportierte Projekt-Datei
 *  bettet die Rohdaten deshalb als Base64 ein. Chunk-weise (statt
 *  String.fromCharCode(...bytes)), sonst reißt der Aufruf-Stack bei
 *  Samples im MB-Bereich ("Maximum call stack size exceeded"). */
export function arrayBufferToBase64(buf) {
  let bin = '';
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Gegenstück beim Import (sampler.js#deserialize). */
export function base64ToArrayBuffer(base64) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export const sampleStore = {
  async put(id, arrayBuffer) {
    try {
      const db = await openDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(arrayBuffer, id);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      mem.set(id, arrayBuffer);
    }
  },

  /** @returns {Promise<ArrayBuffer|null>} */
  async get(id) {
    if (!id) return null;
    try {
      const db = await openDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(id);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => reject(req.error);
      });
    } catch {
      return mem.get(id) ?? null;
    }
  },

  async remove(id) {
    try {
      const db = await openDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(id);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      mem.delete(id);
    }
  },
};
