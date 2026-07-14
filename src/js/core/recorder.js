/**
 * recorder — schneidet die Master-Summe (nach dem Limiter) als Audiodatei mit.
 *
 * Nutzt MediaRecorder auf einem MediaStreamDestination-Node. Das Format
 * wählt der Browser: Safari/iOS liefert AAC in .m4a, Chrome Opus in .webm.
 */
import { engine } from './audio-engine.js';

const MIME_CANDIDATES = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];

class Recorder {
  constructor() {
    this.rec = null;
    this.dest = null;
    this.chunks = [];
    this.startedAt = 0;
  }

  get supported() {
    return typeof MediaRecorder !== 'undefined';
  }

  get active() {
    return this.rec?.state === 'recording';
  }

  get elapsed() {
    return this.active ? (performance.now() - this.startedAt) / 1000 : 0;
  }

  start() {
    if (this.active || !this.supported || !engine.ctx) return false;

    this.dest = engine.ctx.createMediaStreamDestination();
    engine.limiter.connect(this.dest);

    const mime = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported?.(m));
    this.rec = new MediaRecorder(this.dest.stream, mime ? { mimeType: mime } : undefined);
    this.chunks = [];
    this.rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.rec.start(250); // regelmäßige Chunks → nichts geht bei Abbruch verloren
    this.startedAt = performance.now();
    return true;
  }

  /** @returns {Promise<{blob: Blob, ext: string, seconds: number}|null>} */
  stop() {
    if (!this.active) return Promise.resolve(null);
    const seconds = this.elapsed;
    return new Promise((resolve) => {
      this.rec.onstop = () => {
        const type = this.rec.mimeType || 'audio/webm';
        const ext = type.includes('mp4') ? 'm4a' : 'webm';
        const blob = new Blob(this.chunks, { type });
        engine.limiter.disconnect(this.dest);
        this.rec = null;
        this.dest = null;
        resolve({ blob, ext, seconds });
      };
      this.rec.stop();
    });
  }
}

export const recorder = new Recorder();
