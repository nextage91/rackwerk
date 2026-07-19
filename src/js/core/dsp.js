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

let _lfsrBuffer = null;

/** Gecachter 1-Sekunden-Rauschbuffer aus einem 31-stufigen rückgekoppelten
 *  Schieberegister (Fibonacci-LFSR, Feedback-Taps Bit 13 & Bit 31 -> XOR ->
 *  zurück auf Bit 1) statt echtem Zufall -- das reale 909-Snare-Rauschen
 *  entsteht genau so (zwei CD4006-Schieberegister + CD4070-XOR-Gatter),
 *  NICHT aus einem echten Rauschgenerator. Klingt hörbar "körniger"/
 *  digitaler als Math.random()-Rauschen (nur zwei diskrete Pegel statt
 *  kontinuierlicher Amplituden), mit einer sehr langen, aber nicht
 *  unendlichen Periode (2^31-1 Takte) -- innerhalb der hier gecachten
 *  1s/48kHz-Buffer-Länge wiederholt sich das Muster nicht.
 *  Amplitude auf 1/√3 skaliert (statt ±1): das gleicht den RMS-Pegel an
 *  Math.random()*2-1 an (Gleichverteilung hat RMS 1/√3, dieses Zwei-
 *  Pegel-Signal sonst konstant RMS 1) -- ohne diesen Abgleich wären alle
 *  bestehenden, per Gehör/Messung eingepegelten Level-Werte an dieser
 *  Rauschquelle zu laut. */
export function lfsrNoise(ctx) {
  if (!_lfsrBuffer) {
    _lfsrBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = _lfsrBuffer.getChannelData(0);
    const amp = 1 / Math.sqrt(3);
    let reg = 1; // darf nie 0 werden, sonst bleibt das Register für immer 0
    for (let i = 0; i < d.length; i++) {
      const bit = ((reg >> 12) ^ (reg >> 30)) & 1; // Taps: Bit 13 & Bit 31
      reg = ((reg << 1) | bit) & 0x7fffffff; // 31 Bit breit halten
      d[i] = bit ? amp : -amp;
    }
  }
  return _lfsrBuffer;
}

/** Exponentiell abfallende Hüllkurve als Gain-Node. */
export function env(ctx, t, peak, dur) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(Math.max(peak, 0.001), t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  return g;
}

/** Quelle sauber beenden und den Teilgraphen abbauen. `offset` (Sekunden
 *  in den Buffer hinein) ist optional -- ohne Angabe wie bisher immer bei
 *  0 starten. Ein zufälliger Offset lässt eine Rauschquelle bei jedem
 *  Anschlag eine ANDERE Stelle desselben (gecachten) Rauschbuffers
 *  abspielen statt immer denselben Ausschnitt -- Analogkit nutzt das für
 *  mehr Anschlag-zu-Anschlag-Variation (s. dort). */
export function autoStop(src, t, dur, nodes, offset = 0) {
  src.start(t, offset);
  src.stop(t + dur + 0.05);
  src.onended = () => { src.disconnect(); nodes.forEach((n) => n.disconnect()); };
}

export const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

/**
 * Filterhüllkurve (SubSynth + PolySynth, identisch): startet envAmt Oktaven
 * über dem Cutoff (bis +4 Okt.) und fällt exponentiell auf den Cutoff
 * zurück — der klassische Pluck/Acid-Charakter. Gilt für Keybed- und
 * Sequenzer-Stimmen gleich.
 */
export function applyFilterEnv(filter, t, params) {
  const peak = Math.min(16000, params.cutoff * Math.pow(2, params.envAmt * 4));
  filter.frequency.setValueAtTime(peak, t);
  filter.frequency.setTargetAtTime(params.cutoff, t, Math.max(0.01, params.fDecay) / 3);
}
