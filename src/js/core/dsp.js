/**
 * dsp.js — kleine, gemeinsam genutzte Audio-Helfer.
 * (Aus der BeatBox extrahiert, seit mehrere Maschinen sie brauchen.)
 */

let _noiseBuffer = null;

/** Gecachter 1-Sekunden-Rauschbuffer. Quellen starten immer bei Offset 0
 *  → jeder Anschlag klingt identisch (deterministisch). */
export function noise(ctx) {
  if (!_noiseBuffer) {
    _noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = _noiseBuffer.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return _noiseBuffer;
}

/** Exponentiell abfallende Hüllkurve als Gain-Node. */
export function env(ctx, t, peak, dur) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(Math.max(peak, 0.001), t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  return g;
}

/** Quelle sauber beenden und den Teilgraphen abbauen. */
export function autoStop(src, t, dur, nodes) {
  src.start(t);
  src.stop(t + dur + 0.05);
  src.onended = () => { src.disconnect(); nodes.forEach((n) => n.disconnect()); };
}

export const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
