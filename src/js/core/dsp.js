/**
 * dsp.js — kleine, gemeinsam genutzte Audio-Helfer.
 * (Aus der BeatBox extrahiert, seit mehrere Maschinen sie brauchen.)
 */
import { LADDER_FILTER_WORKLET_SRC } from './ladder-filter-worklet.js';

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

/** ADR-Hüllkurve als Gain-Node: Attack (0 -> peak), dann exponentieller
 *  Decay (peak -> 0.001, praktisch stumm), dann Release (0.001 -> echte 0).
 *  `attack`/`release` (Sekunden) sind optional -- Default 0/0.05 reproduziert
 *  exakt das alte, feste Verhalten (sofortiger Sprung auf `peak`, fixer
 *  50ms-Tail), damit bestehende Spuren beim Umstieg unverändert klingen.
 *
 *  `exponentialRampToValueAtTime` kann nie exakt 0 erreichen (nur
 *  asymptotisch) UND verlangt einen von 0 verschiedenen Startwert -- daher
 *  landet der Decay bei 0.001 statt 0, und der letzte Schritt von dort auf
 *  echte 0 läuft linear über `release` (das kann `linearRampToValueAtTime`
 *  problemlos, exponentiell nicht). Ohne diesen letzten Schritt bliebe die
 *  Gain bis zum harten stop() bei 0.001 hängen und spränge dann abrupt auf
 *  0 -- ein winziges, aber echtes Klicken am Ende jedes Sounds.
 *
 *  g.totalDur trägt die volle Länge (attack+dur+release) ab `t` -- autoStop()
 *  braucht diesen Wert (nicht nur `dur`), um Quelle/Zusatzknoten erst nach
 *  dem vollständigen Ausklang abzubauen. */
export function env(ctx, t, peak, dur, { attack = 0, release = 0.05 } = {}) {
  const g = ctx.createGain();
  const pk = Math.max(peak, 0.001);
  const rel = Math.max(release, 0.005);
  if (attack > 0) {
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(pk, t + attack);
  } else {
    g.gain.setValueAtTime(pk, t);
  }
  g.gain.exponentialRampToValueAtTime(0.001, t + attack + dur);
  g.gain.linearRampToValueAtTime(0, t + attack + dur + rel);
  g.totalDur = attack + dur + rel;
  return g;
}

/** Quelle sauber beenden und den Teilgraphen abbauen. `dur` muss die VOLLE
 *  Hüllkurvenlänge sein (z.B. `g.totalDur` von env() oben), nicht nur die
 *  reine Decay-Zeit -- sonst stoppt die Quelle mitten in ihrem eigenen
 *  Release-Ausklang. `offset` (Sekunden in den Buffer hinein) ist optional
 *  -- ohne Angabe wie bisher immer bei 0 starten. Ein zufälliger Offset
 *  lässt eine Rauschquelle bei jedem Anschlag eine ANDERE Stelle desselben
 *  (gecachten) Rauschbuffers abspielen statt immer denselben Ausschnitt --
 *  Analogkit nutzt das für mehr Anschlag-zu-Anschlag-Variation (s. dort). */
export function autoStop(src, t, dur, nodes, offset = 0) {
  src.start(t, offset);
  src.stop(t + dur);
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

/** Generisches Lazy-Ladeschema für die per Blob-URL geladenen, hand-
 *  geschriebenen Worklets in diesem Projekt -- EIN gemeinsamer Cache (Map
 *  von Prozessorname auf Promise) statt einer eigenen Ladefunktion pro
 *  Worklet. Lebt hier (statt z. B. in core/inserts.js) als abhängigkeits-
 *  freier Basis-Helfer, den sowohl Insert-Effekte als auch Maschinen (s.
 *  makeLadderFilter unten) nutzen können, ohne dass eine der beiden Seiten
 *  von der anderen importieren müsste. */
const simpleWorkletPromises = new Map();
const simpleWorkletReadyFlags = new Map();
export function ensureSimpleWorklet(ctx, processorName, src) {
  if (!simpleWorkletPromises.has(processorName)) {
    let promise;
    if (!ctx.audioWorklet) {
      promise = Promise.resolve(false);
    } else {
      const blob = new Blob([src], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      promise = ctx.audioWorklet.addModule(url)
        .then(() => { URL.revokeObjectURL(url); simpleWorkletReadyFlags.set(processorName, true); return true; })
        .catch((err) => {
          URL.revokeObjectURL(url);
          console.error(`Worklet-Modul "${processorName}" konnte nicht geladen werden -- betroffener Effekt bleibt transparent.`, err);
          return false;
        });
    }
    simpleWorkletPromises.set(processorName, promise);
  }
  return simpleWorkletPromises.get(processorName);
}
export function simpleWorkletReady(processorName) {
  return simpleWorkletReadyFlags.get(processorName) === true;
}

/** Selbstschwingungsfähiger 4-poliger Ladder-Tiefpass (s.
 *  ladder-filter-worklet.js für die vollständige Herleitung -- die von
 *  AcidBass' TB-303-Filterkern losgelöste, generische Fassung) als
 *  Drop-in-Ersatz für `ctx.createBiquadFilter()` in polyphonen Maschinen
 *  wie SubSynth.
 *
 *  `.frequency`/`.Q` sind ECHTE, von der Worklet-Lade-Race UNABHÄNGIGE
 *  AudioParams -- absichtlich über je einen eigenen `ConstantSourceNode`
 *  realisiert statt direkt `node.parameters.get(...)` zurückzugeben: der
 *  Worklet-Knoten selbst existiert (wie bei jedem Blob-URL-Worklet dieses
 *  Projekts) erst NACH einem asynchronen `audioWorklet.addModule()`, aber
 *  Aufrufer wie core/dsp.js#applyFilterEnv rufen `filter.frequency
 *  .setValueAtTime()/.setTargetAtTime()` SOFORT nach dem Anlegen auf --
 *  ein `ConstantSourceNode.offset` ist von Anfang an ein vollwertiges
 *  AudioParam (unabhängig vom Worklet-Ladezustand), automatisiert also
 *  bereits korrekt VOR dem eigentlichen `attach()`, und wird dort einfach
 *  in den (auf 0 gesetzten) intrinsischen Wert des echten Worklet-Parameters
 *  eingespeist -- exakt derselbe zeitliche Verlauf, als hätte von Anfang an
 *  eine Verbindung bestanden. */
export function makeLadderFilter(ctx) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const freqSource = ctx.createConstantSource();
  freqSource.offset.value = 1000;
  freqSource.start();
  const qSource = ctx.createConstantSource();
  qSource.offset.value = 4;
  qSource.start();
  let node = null;
  let disposed = false;

  const attach = () => {
    node = new AudioWorkletNode(ctx, 'rackwerk-ladder', { numberOfInputs: 1, numberOfOutputs: 1 });
    node.parameters.get('frequency').value = 0;
    node.parameters.get('Q').value = 0;
    freqSource.connect(node.parameters.get('frequency'));
    qSource.connect(node.parameters.get('Q'));
    input.connect(node).connect(output);
  };

  if (simpleWorkletReady('rackwerk-ladder')) {
    attach();
  } else {
    input.connect(output);
    ensureSimpleWorklet(ctx, 'rackwerk-ladder', LADDER_FILTER_WORKLET_SRC).then((ok) => {
      if (!ok || disposed) return;
      input.disconnect(output);
      attach();
    });
  }

  return {
    input,
    output,
    frequency: freqSource.offset,
    Q: qSource.offset,
    // Reines Anzeige-/Kompatibilitätsfeld -- ein Ladder-Filter ist immer
    // Tiefpass (wie ein echtes Moog-/TB-303-Filter), anders als
    // BiquadFilterNode kennt er kein umschaltbares `.type`. Wird von
    // aufrufendem Code (s. machines/subsynth.js) trotzdem beschrieben,
    // damit derselbe Codepfad für beide Filterarten funktioniert.
    type: 'lowpass',
    dispose() {
      disposed = true;
      input.disconnect();
      output.disconnect();
      freqSource.stop(); freqSource.disconnect();
      qSource.stop(); qSource.disconnect();
      node?.disconnect();
    },
  };
}
