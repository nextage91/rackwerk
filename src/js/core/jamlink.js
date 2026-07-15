/**
 * jamlink — verbindet zwei Geräte für synchrones Jammen.
 *
 * Aufbau (serverlos, per Copy-Paste-Signaling):
 *   Host: createOffer() → Code A → an Gast schicken
 *   Gast: createAnswer(A) → Code B → zurück an Host
 *   Host: acceptAnswer(B) → DataChannel offen
 *
 * Sync-Prinzip (wie Ableton Link: nur Uhr, kein Audio):
 * - Der Gast misst per Ping/Pong den Versatz zwischen den performance-
 *   Uhren beider Geräte (NTP-artig: offset = t1 − (t0 + rtt/2), geglättet).
 * - Der Host sendet alle 500 ms (und bei Play/Stop/BPM sofort) einen
 *   Clock-Anker: „Step S liegt bei Host-Zeit T, BPM B, läuft/steht".
 * - Der Gast rechnet T über den Offset in seine eigene Audio-Uhr um und
 *   ruft transport.syncTo() — der zieht den Scheduler sanft nach.
 * - Zusätzlich können beide Seiten ihren Maschinen-Zustand über den
 *   Kanal schicken (Jam-Import ohne Datei-Umweg).
 */
import { transport } from './transport.js';
import { engine } from './audio-engine.js';

const CLOCK_INTERVAL_MS = 500;
const PING_INTERVAL_MS = 2000;

/* ---------- Signal-Codes packen/entpacken ----------
   SDP ist sehr redundant → Deflate drückt die Codes von ~1200 auf
   ~400 Zeichen. Das macht die QR-Codes grob (Version ~15 statt ~30)
   und damit vom Display gut scanbar. Präfix 'RW1.' kennzeichnet das
   komprimierte Format; alte unkomprimierte Codes (reines base64-JSON)
   werden weiterhin akzeptiert. */
const CODE_PREFIX = 'RW1.';

function bytesToB64(buf) {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s);
}
function b64ToBytes(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function packSignal(desc) {
  const json = JSON.stringify(desc);
  if (typeof CompressionStream === 'undefined') return btoa(json); // altes WebView
  const stream = new Blob([json]).stream()
    .pipeThrough(new CompressionStream('deflate-raw'));
  return CODE_PREFIX + bytesToB64(await new Response(stream).arrayBuffer());
}

export async function unpackSignal(code) {
  code = code.trim();
  if (!code.startsWith(CODE_PREFIX)) return JSON.parse(atob(code)); // Alt-Format
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Dieses Gerät kann den Code nicht lesen (System zu alt).');
  }
  const stream = new Blob([b64ToBytes(code.slice(CODE_PREFIX.length))]).stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  return JSON.parse(await new Response(stream).text());
}

/** Welche ICE-Kandidaten-Typen stecken im SDP? (Diagnose-Anzeige) */
function candidateTypes(sdp) {
  const types = new Set();
  for (const m of (sdp ?? '').matchAll(/a=candidate:\S+ \d+ \S+ \d+ \S+ \d+ typ (\w+)/g)) {
    types.add(m[1]);
  }
  return [...types];
}

class JamLink {
  constructor() {
    this.pc = null;
    this.dc = null;
    this.role = null;          // 'host' | 'guest'
    this.connected = false;
    this.offset = null;        // hostPerf − localPerf (ms), geglättet
    this.rtt = 0;
    this.onstate = null;       // (event: 'open'|'closed'|'sync') => void
    this.onProjectReceived = null;
    this.clockTimer = null;
    this.pingTimer = null;
    this.transportListener = null;
    /** ICE-Kandidaten-Typen des eigenen Codes ('host','srflx','relay') —
     *  nur 'host' + Fehlschlag deutet auf Client-Isolation im WLAN hin. */
    this.localCandidateTypes = [];
  }

  get supported() {
    return typeof RTCPeerConnection !== 'undefined';
  }

  #newPeer() {
    return new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        // Best-Effort-TURN-Relay (Open-Relay-Projekt, kostenlos):
        // hilft bei Carrier-NAT (Mobilfunk) und strengen Routern.
        // Ist der Dienst nicht erreichbar, wird er einfach ignoriert.
        {
          urls: [
            'turn:openrelay.metered.ca:80',
            'turn:openrelay.metered.ca:443',
            'turn:openrelay.metered.ca:443?transport=tcp',
          ],
          username: 'openrelayproject',
          credential: 'openrelayproject',
        },
      ],
    });
  }

  /**
   * Verbindungsphasen an die UI melden. Ohne das bleibt die Oberfläche
   * nach dem Code-Austausch stumm, wenn sich die Geräte nicht erreichen
   * (z. B. beide hinter Mobilfunk-NAT und kein TURN-Relay verfügbar).
   */
  #wirePC() {
    const report = () => {
      const st = this.pc?.connectionState ?? this.pc?.iceConnectionState;
      if (st === 'connecting' || st === 'checking') {
        this.onstate?.('connecting');
      } else if (st === 'failed') {
        this.onstate?.('failed');
      } else if (st === 'disconnected' && this.connected) {
        this.onstate?.('unstable');
      }
    };
    this.pc.onconnectionstatechange = report;
    this.pc.oniceconnectionstatechange = report;
  }

  /** Wartet auf abgeschlossenes ICE-Gathering (max. 3 s). */
  #gathered() {
    return new Promise((resolve) => {
      if (this.pc.iceGatheringState === 'complete') return resolve();
      const check = () => {
        if (this.pc.iceGatheringState === 'complete') {
          this.pc.removeEventListener('icegatheringstatechange', check);
          resolve();
        }
      };
      this.pc.addEventListener('icegatheringstatechange', check);
      setTimeout(resolve, 3000);
    });
  }

  /* ---------- Verbindungsaufbau ---------- */
  async createOffer() {
    this.close();
    this.role = 'host';
    this.pc = this.#newPeer();
    this.#wirePC();
    this.dc = this.pc.createDataChannel('jam');
    this.#wireChannel();
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await this.#gathered();
    this.localCandidateTypes = candidateTypes(this.pc.localDescription?.sdp);
    return packSignal(this.pc.localDescription);
  }

  async acceptAnswer(code) {
    await this.pc.setRemoteDescription(await unpackSignal(code));
  }

  async createAnswer(offerCode) {
    this.close();
    this.role = 'guest';
    this.pc = this.#newPeer();
    this.#wirePC();
    this.pc.ondatachannel = (e) => {
      this.dc = e.channel;
      this.#wireChannel();
    };
    await this.pc.setRemoteDescription(await unpackSignal(offerCode));
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await this.#gathered();
    this.localCandidateTypes = candidateTypes(this.pc.localDescription?.sdp);
    return packSignal(this.pc.localDescription);
  }

  /* ---------- Kanal ---------- */
  #wireChannel() {
    this.dc.onopen = () => {
      this.connected = true;
      // Beide Seiten messen per Ping/Pong die Laufzeit (Basis der ±ms-Anzeige);
      // nur der Gast leitet daraus zusätzlich den Uhren-Offset für den Sync ab.
      this.#ping();
      this.pingTimer = setInterval(() => this.#ping(), PING_INTERVAL_MS);
      if (this.role === 'host') {
        this.clockTimer = setInterval(() => this.#sendClock(), CLOCK_INTERVAL_MS);
        this.transportListener = { onTransport: () => this.#sendClock() };
        transport.addListener(this.transportListener);
      }
      this.onstate?.('open');
    };
    this.dc.onclose = () => {
      this.connected = false;
      this.#stopTimers();
      this.onstate?.('closed');
    };
    this.dc.onmessage = (e) => {
      try { this.#onMsg(JSON.parse(e.data)); } catch { /* fremdes Paket */ }
    };
  }

  #send(obj) {
    if (this.dc?.readyState === 'open') this.dc.send(JSON.stringify(obj));
  }

  /* ---------- Uhren-Abgleich (Gast) ---------- */
  #ping() {
    this.#send({ t: 'ping', t0: performance.now() });
  }

  /* ---------- Clock-Anker (Host) ---------- */
  #sendClock() {
    const snap = transport.syncSnapshot();
    // Audio-Zeit des Ankers → performance-Zeit des Hosts
    const anchorPerf = performance.now() + (snap.audioTime - engine.now) * 1000;
    this.#send({
      t: 'clock',
      bpm: snap.bpm,
      playing: snap.playing,
      step: snap.step,
      anchorPerf,
    });
  }

  /* ---------- Nachrichten ---------- */
  #onMsg(m) {
    if (m.t === 'ping') {
      this.#send({ t: 'pong', t0: m.t0, t1: performance.now() });

    } else if (m.t === 'pong') {
      const t2 = performance.now();
      const rtt = t2 - m.t0;
      const offset = m.t1 - (m.t0 + rtt / 2);
      // exponentiell glätten — einzelne Jitter-Ausreißer verwerfen
      this.offset = this.offset == null ? offset : this.offset * 0.7 + offset * 0.3;
      this.rtt = rtt;
      this.onstate?.('sync');

    } else if (m.t === 'clock' && this.role === 'guest') {
      if (this.offset == null) return; // erst Uhr abgleichen
      const localPerf = m.anchorPerf - this.offset;
      const localAudio = engine.now + (localPerf - performance.now()) / 1000;
      transport.syncTo({
        bpm: m.bpm,
        playing: m.playing,
        step: m.step,
        audioTime: localAudio,
      });

    } else if (m.t === 'project') {
      this.onProjectReceived?.(m.data);
    }
  }

  /** Eigene Maschinen ans andere Gerät schicken (beide Richtungen möglich). */
  sendProject(data) {
    this.#send({ t: 'project', data });
  }

  #stopTimers() {
    clearInterval(this.clockTimer);
    clearInterval(this.pingTimer);
    this.clockTimer = this.pingTimer = null;
    if (this.transportListener) {
      transport.removeListener(this.transportListener);
      this.transportListener = null;
    }
  }

  close() {
    this.#stopTimers();
    try { this.dc?.close(); } catch { /* egal */ }
    try { this.pc?.close(); } catch { /* egal */ }
    this.dc = this.pc = null;
    this.connected = false;
    this.offset = null;
    this.role = null;
  }
}

export const jamlink = new JamLink();
