/**
 * inserts.js — pro Maschine frei zusammensteckbare Insert-Effekte
 * (Compressor, EQ, Drive/Saturation).
 *
 * Jeder Insert ist ein eigenständiger Mini-Graph mit eingebautem
 * Dry/Wet-Bypass:
 *
 *   input ─┬─ dryGain ────────────────┬─ output
 *          └─ [Effekt-Kette] ─ wetGain┘
 *
 * setBypass() schaltet nur dry/wet um — die AUSSENVERKABELUNG (wie die
 * Insert-Kette in machine.js hintereinandergehängt wird) bleibt dabei
 * unberührt, das Rewiring der Kette passiert nur beim Hinzufügen/
 * Entfernen/Verschieben eines Inserts, nicht beim Bypass-Toggle.
 */
import { engine } from './audio-engine.js';
import { transport } from './transport.js';
import { noise } from './dsp.js';
import { ONEPOLE_WORKLET_SRC } from './onepole-worklet.js';
import { RESONATOR_PROCESSOR_NAME, RESONATOR_META_JSON, RESONATOR_WASM_BASE64, RESONATOR_WORKLET_SRC } from './resonator-worklet.js';
import { GATE_WORKLET_SRC } from './gate-worklet.js';
import { FREQSHIFT_WORKLET_SRC } from './freqshift-worklet.js';
import { BEATREPEAT_WORKLET_SRC } from './beatrepeat-worklet.js';
import { BITCRUSH_WORKLET_SRC } from './bitcrush-worklet.js';

/** Linear-zu-Tanh-Blend statt eines reinen Tanh-Shapers: bei amount=0 ist
 *  die Kurve exakte Identität (Drive komplett zugedreht → 0 zusätzliche
 *  Harmonische), bei amount=1 volle Sättigung (K=30, praktisch hartes
 *  Clipping). Ein reiner `tanh(k*x)` mit k über amount skaliert (k=1
 *  bei amount=0) klingt schon bei niedrigem amount hörbar verzerrt, weil
 *  selbst k=1 spürbar von der Identität abweicht — das Blending macht
 *  den Regler über den ganzen Bereich nutzbar, von ganz sauber bis hart. */
export function makeDriveCurve(amount) {
  const n = 1024;
  const curve = new Float32Array(n);
  const K = 30;
  const norm = Math.tanh(K);
  for (let i = 0; i < n; i++) {
    // (n - 1), NICHT n -- s. dieselbe Korrektur + Begründung bei
    // makeSatCurve() in analogkit.js: sonst landet x=0 nicht auf dem
    // Tabellenindex, den WaveShaperNode für x=0 tatsächlich abfragt,
    // wodurch echte Stille einen kleinen, hörbaren DC-Versatz bekommt.
    const x = (i * 2) / (n - 1) - 1;
    const driven = Math.tanh(K * x) / norm;
    curve[i] = (1 - amount) * x + amount * driven;
  }
  return curve;
}

/** Sicherheits-Weichbegrenzer für die Filter-Delay-Feedback-Schleife (s.
 *  DEFS.filterDelay) -- reines tanh(x), UNNORMALISIERT (anders als
 *  makeDriveCurve oben): für normale Pegel (|x| deutlich unter 1) praktisch
 *  linear/unhörbar, biegt aber mathematisch GARANTIERT nie über ±1 hinaus,
 *  egal wie viel Gain sich in der Schleife aufbaut. Ersetzt eine reine
 *  Gain-Reduktion (DynamicsCompressorNode) -- die reagiert nur graduell
 *  (Ratio 20:1 ist kein hartes Ceiling) und kam bei sehr kurzer Delay-Zeit
 *  (kürzer als ihre eigene Release-Zeit) nicht schnell genug hinterher, um
 *  dichte Retriggerung bei extrem hohem Feedback abzufangen (gemessen: Peak
 *  > 2.6 trotz Limiter, auch mit sehr schnellem Attack/Release). Ein
 *  WaveShaper reagiert dagegen pro Sample, ganz ohne Attack-/Release-Zeit. */
export function makeFeedbackClipCurve() {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / (n - 1) - 1;
    curve[i] = Math.tanh(x);
  }
  return curve;
}

/** Bandsättigungskurve für DEFS.tape -- wie makeDriveCurve() ein Blend
 *  Identität<->Sättigung über `amount` (bei 0 exakte Identität, bei 1 volle
 *  Sättigung), aber mit einem zusätzlichen quadratischen Term VOR dem tanh:
 *  reines tanh(K*x) ist punktsymmetrisch (nur ungerade Harmonische, klingt
 *  "digitaler"/kantiger), ein Band sättigt dagegen leicht ASYMMETRISCH
 *  zwischen positiver/negativer Halbwelle (Remanenz-Verhalten des Bandes)
 *  und erzeugt dadurch zusätzlich geradzahlige Harmonische -- der klassische
 *  "wärmere" Bandklang. Der dadurch eingeschleuste kleine Gleichspannungs-
 *  anteil wird NICHT hier kompensiert, sondern von einem separaten
 *  DC-Sperrfilter hinter dem Shaper entfernt (s. DEFS.tape.build()). */
function makeTapeCurve(amount) {
  const n = 1024;
  const curve = new Float32Array(n);
  // K=6 (wie ursprünglich) sättigt bereits bei HALBEM Vollausschlag fast
  // vollständig (tanh(6*0.5)~0.995) -- das klang selbst bei niedrigem
  // `amount` schon deutlich nach Verzerrung/Drive statt nach der gewünschten
  // dezenten Bandsättigung ("soll eigentlich nur bandsättigen", s. Chat).
  // K=1.6 lässt die Kurve bis in den oberen Pegelbereich hinein nahezu
  // linear, rundet also wirklich erst nahe Vollausschlag -- deutlich näher
  // am echten Bandsättigungs-Charakter (nur bei "heissem" Signal hörbar).
  const K = 1.6;
  const norm = Math.tanh(K);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / (n - 1) - 1;
    const shaped = Math.tanh(K * (x + 0.15 * x * x)) / norm;
    curve[i] = (1 - amount) * x + amount * shaped;
  }
  return curve;
}

const dbToLin = (db) => Math.pow(10, db / 20);

/** Handfest GEMESSENE Zusatzlatenzen zweier Web-Audio-Bausteine, die diese
 *  Datei mehrfach nutzt (DynamicsCompressorNode-Lookahead, WaveShaperNode-
 *  Interpolationsfilter bei oversample:'4x') -- keine Werte aus der
 *  Spezifikation (die legt hierzu nichts fest, "implementation-defined"),
 *  sondern per Impulsantwort-Messung ermittelt: ein Impuls allein durch den
 *  jeweiligen Knoten geschickt, der Sample-Index des Antwort-Peaks mit einer
 *  unveränderten Referenz verglichen (298 bzw. 202 Samples statt 10, bei
 *  48kHz -- glatte 6ms/4ms, offenbar feste ZEITEN statt fester Sample-
 *  Zahlen, überleben eine abweichende ctx.sampleRate also unverändert).
 *  Betrifft jeden Effekt, der intern einen dieser Knotentypen NUR im WET-
 *  Pfad seines eigenen Mix-Reglers nutzt (Comp/Opto/Limiter/Resonator via
 *  DynamicsCompressorNode, Drive/Tape via WaveShaperNode) -- ohne
 *  Kompensation summiert der Mix-Regler dort zwei zueinander verschobene
 *  Kopien desselben Signals, hörbar als Kammfilter-"Phasing" (am stärksten
 *  bei Mix~50%). Auf anderen Engines (v. a. WebKit/iOS, das eigentliche
 *  Zielgerät dieser App) womöglich leicht abweichend, aber ein
 *  kompensierter Wert ist immer näher an richtig als gar keiner. */
const DYNAMICS_COMPRESSOR_LATENCY_SEC = 0.006;
const WAVESHAPER_4X_LATENCY_SEC = 0.004;

/** Grundverzögerung des Tape-Machine-Wow/Flutter-Delays (s. DEFS.tape) --
 *  liegt konstant im Wet-Pfad an, unabhängig vom wowFlutter-Reglerstand
 *  (der steuert nur den Modulationshub oben drauf). Muss mindestens den
 *  grössten negativen Modulationshub abdecken (wowFlutter=1: -0.7ms Wow -
 *  0.25ms Flutter = -0.95ms, s. wowGain/flutterGain unten), sonst könnte
 *  die Delay-Zeit ins Negative rutschen. 1.5ms lässt gut 0.5ms
 *  Sicherheitsabstand. Bewusst KLEIN gehalten (ursprünglich 7ms/±5.5ms
 *  Hub): ein moduliertes Delay dieser Grössenordnung erzeugt beim Mischen
 *  mit einer unmodulierten Kopie (Dry/Wet-Regler <1, aber genauso bei
 *  parallelem Processing z. B. über einen Send) hörbares Kammfilter-
 *  "Phasing" -- klang eher nach Flanger als nach echtem Bandgeräte-Wobbel.
 *  Reale Tonbandmaschinen liegen im Bereich weniger Zehntel-Millisekunden;
 *  bei diesen kleineren Hüben liegen die Kammfilter-Kerben so hoch/eng,
 *  dass sie praktisch nicht mehr als Flanger-Sweep wahrnehmbar sind. */
const TAPE_WOWFLUTTER_BASE_DELAY_SEC = 0.0015;

/** Grundverzögerung/max. Modulationshub der beiden Chorus-Delay-Leitungen
 *  (s. DEFS.chorus) -- deutlich grösser als das Tape-Wow/Flutter oben
 *  (15ms statt 1.5ms Basis), weil hier das Kammfilter-"Phasing" der
 *  gewünschte Chorus-Effekt SELBST ist, nicht ein zu vermeidender
 *  Nebeneffekt. depth=1 moduliert bis zu ±6ms um die 15ms-Basis --
 *  15-6=9ms bleibt komfortabel über 0, keine Gefahr einer negativen
 *  Delay-Zeit. */
const CHORUS_BASE_DELAY_SEC = 0.015;
const CHORUS_MAX_DEPTH_SEC = 0.006;

/** Grundfrequenzen der sechs Allpass-Stufen des Phasers (s. DEFS.phaser) --
 *  log-artig über den Mittenbereich gestaffelt (grob Faktor ~1.6 je Stufe),
 *  näher an echten mehrstufigen Analog-Phasern (deren Stufen sich meist auf
 *  einen mittleren Frequenzbereich konzentrieren) als eine gleichmässige
 *  Streuung über den ganzen Hörbereich. PHASER_DEPTH_FACTOR bestimmt den
 *  Modulationshub JEDER Stufe relativ zu ihrer eigenen Grundfrequenz (nicht
 *  additiv in Hz) -- bei depth=1 sweept jede Stufe zwischen 0.3x und 1.7x
 *  ihrer Grundfrequenz, bleibt garantiert positiv (0.3x > 0) und bleibt über
 *  alle sechs Stufen hinweg musikalisch zusammenhängend (ein Sweep in
 *  Oktaven statt in Hz-Schritten). */
const PHASER_STAGE_FREQS = [220, 380, 620, 1000, 1600, 2600];
const PHASER_STAGE_Q = 0.7;
const PHASER_DEPTH_FACTOR = 0.7;

/** Acht Analyse-/Synthese-Bänder des Vocoders (s. DEFS.vocoder) -- log-artig
 *  über den für Sprachverständlichkeit wichtigsten Bereich gestaffelt
 *  (Grundton bis Zischlaute), dieselbe Bandanzahl wie eq8 (8), aber mit
 *  eigener, für Vocoder-Zwecke optimierter Frequenzverteilung statt
 *  EQ8_FREQ_MIN/MAX gleichmässig log über den GESAMTEN Hörbereich. */
const VOCODER_BANDS = [200, 350, 600, 1000, 1600, 2500, 4000, 6500];
const VOCODER_BAND_Q = 3.5;
/** Fester Rauschanteil im Carrier -- klassischer Vocoder-Trick, verbessert
 *  die Verständlichkeit von Konsonanten/Zischlauten spürbar (ein reiner
 *  Sägezahn-Carrier hat in den oberen Bändern kaum eigene Energie mehr,
 *  Rauschen füllt genau diese Lücke). Bewusst NICHT als Regler exponiert --
 *  hält die Bedienung auf drei Kernregler fokussiert (wie beim Opto-
 *  Kompressor), ein Fixwert reicht für den beabsichtigten Effekt. */
const VOCODER_NOISE_MIX = 0.12;
/** Empirisch (Stresstest, s. tools/dsp-tests/vocoder-gate-freqshift.mjs)
 *  bestimmte Pegel-Kalibrierung: VOCODER_ANALYSIS_GAIN hebt die (nach
 *  Gleichrichtung+Glättung typischerweise leise) Hüllkurve auf einen
 *  Bereich an, der die Carrier-Bandgains sinnvoll zwischen ~0 und ~1
 *  aussteuert; VOCODER_OUT_LEVEL gleicht die Summe aller acht Bänder auf
 *  einen mit dem Dry-Pfad vergleichbaren Pegel aus (dieselbe Rolle wie
 *  DATTORRO_OUT_LEVEL beim Reverb). */
const VOCODER_ANALYSIS_GAIN = 6;
const VOCODER_OUT_LEVEL = 1.4;
let vocoderAbsCurve = null;
/** Vollweg-Gleichrichtung (|x|) als WaveShaper-Kurve -- billiger Trick,
 *  einen ctx.createWaveShaper() als Gleichrichter zu missbrauchen, statt
 *  eine eigene AudioParam-Rechnung zu bauen. Modulweit EINMAL berechnet
 *  und wiederverwendet (dieselbe Kurve für jedes Band jeder Vocoder-
 *  Instanz, ändert sich nie). */
function getVocoderAbsCurve() {
  if (!vocoderAbsCurve) {
    const n = 1024;
    vocoderAbsCurve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / (n - 1) - 1;
      vocoderAbsCurve[i] = Math.abs(x);
    }
  }
  return vocoderAbsCurve;
}

/** Kompensations-Delay für den TROCKENEN Pfad eines Effekts -- derselbe
 *  Trick wie ein Mastering-Limiter mit Lookahead, nur umgekehrt: verzögert
 *  die unverarbeitete Kopie um genau die Zeit, die der Effekt-Pfad durch
 *  einen der obigen Knoten zusätzlich braucht, damit Dry und Wet beim
 *  Mischen wieder phasengleich sind. Bei mix=1 (dry.gain=0) wirkt sich das
 *  nicht aus -- nur bei Zwischenstellungen ändert es hörbar etwas. */
function makeDryCompensationDelay(ctx, seconds) {
  const d = ctx.createDelay(Math.max(0.02, seconds * 2));
  d.delayTime.value = seconds;
  return d;
}

/** Lädt das gemeinsame 1-Pol-Worklet-Modul GENAU EINMAL fürs App-weite
 *  AudioContext-Singleton (gleiches Muster wie machines/acidbass.js#
 *  ensureAcidBassWorklet). `onePoleReady` erlaubt den Aufrufern eine
 *  SYNCHRONE Entscheidung -- die build()-Funktionen der Inserts müssen ein
 *  fertig verkabeltes Objekt zurückgeben, ein await ist dort nicht
 *  möglich. Wer gebaut wird, BEVOR das Modul steht (praktisch nur der
 *  allererste betroffene Insert einer Session, danach ist das Promise
 *  gecacht), bekommt übergangsweise einen transparenten Platzhalter und
 *  rüstet selbst nach, sobald das Modul geladen ist. */
let onePoleWorkletPromise = null;
let onePoleReady = false;
function ensureOnePoleWorklet(ctx) {
  if (!onePoleWorkletPromise) {
    if (!ctx.audioWorklet) {
      onePoleWorkletPromise = Promise.resolve(false);
    } else {
      const blob = new Blob([ONEPOLE_WORKLET_SRC], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      onePoleWorkletPromise = ctx.audioWorklet.addModule(url)
        .then(() => { URL.revokeObjectURL(url); onePoleReady = true; return true; })
        .catch((err) => {
          URL.revokeObjectURL(url);
          console.error('1-Pol-Worklet-Modul konnte nicht geladen werden -- betroffene Filterstufen bleiben transparent.', err);
          return false;
        });
    }
  }
  return onePoleWorkletPromise;
}

/** Lädt den (per tools/build-resonator-worklet.mjs vorkompilierten) Faust-
 *  Modal-Synthese-Worklet, gleiches Lazy-Muster wie ensureOnePoleWorklet
 *  oben. Das WebAssembly-Modul wird EINMAL kompiliert und wiederverwendet
 *  -- eine kompilierte WebAssembly.Module-Instanz ist beliebig oft neu
 *  instanziierbar (s. createResonatorNode unten), ein Modul pro Resonator-
 *  Insert wäre unnötig teuer. */
let resonatorWorkletPromise = null;
let resonatorReady = false;
let resonatorWasmModule = null;
function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function ensureResonatorWorklet(ctx) {
  if (!resonatorWorkletPromise) {
    if (!ctx.audioWorklet) {
      resonatorWorkletPromise = Promise.resolve(false);
    } else {
      const blob = new Blob([RESONATOR_WORKLET_SRC], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      resonatorWorkletPromise = Promise.all([
        ctx.audioWorklet.addModule(url),
        WebAssembly.compile(base64ToBytes(RESONATOR_WASM_BASE64)),
      ])
        .then(([, wasmModule]) => {
          URL.revokeObjectURL(url);
          resonatorWasmModule = wasmModule;
          resonatorReady = true;
          return true;
        })
        .catch((err) => {
          URL.revokeObjectURL(url);
          console.error('Resonator-Worklet-Modul konnte nicht geladen werden -- Resonator bleibt transparent (kein Klangeffekt).', err);
          return false;
        });
    }
  }
  return resonatorWorkletPromise;
}

/** Baut EINE frische Resonator-Node aus dem bereits kompilierten Modul
 *  (s. ensureResonatorWorklet) -- ein AudioWorkletNode ist NICHT
 *  wiederverwendbar über mehrere Instanzen hinweg, jeder Resonator-Insert
 *  braucht seine eigene. `factory.json` muss das VOLLSTÄNDIGE Faust-Meta-
 *  JSON sein (nicht nur die UI-Parameterliste) -- FaustWasmInstantiator
 *  liest mehr daraus als nur die Regler-Adressen. */
function createResonatorNode(ctx) {
  return new AudioWorkletNode(ctx, RESONATOR_PROCESSOR_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: {
      factory: { module: resonatorWasmModule, json: RESONATOR_META_JSON, soundfiles: {} },
      sampleSize: 4,
    },
  });
}

/** Generisches Lazy-Ladeschema für die drei einfachen Hand-geschriebenen
 *  Worklets unten (Gate/Frequenzschieber/Beat-Repeat) -- dasselbe Muster
 *  wie ensureOnePoleWorklet, aber ohne WASM-Kompilierschritt (reines JS,
 *  kein Faust-Build nötig). EIN gemeinsamer Cache (Map von Prozessorname
 *  auf Promise) statt drei fast identischer Funktionen. */
const simpleWorkletPromises = new Map();
const simpleWorkletReadyFlags = new Map();
function ensureSimpleWorklet(ctx, processorName, src) {
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
function simpleWorkletReady(processorName) {
  return simpleWorkletReadyFlags.get(processorName) === true;
}

/** Einpoliger Tiefpass (y[n] = (1-a)*x[n] + a*y[n-1]) als Damping-Filter
 *  für den Reverb-Tank und die Resonator-Delaylines -- bewusst NICHT der
 *  naheliegende ctx.createBiquadFilter(): ein 2-poliger Biquad-Tiefpass
 *  hat (unabhängig von Q, auch bei sehr kleinem Q) einen kleinen, aber
 *  unvermeidbaren Überschwinger >1.0 nahe der Grenzfrequenz (gemessen
 *  ~1.15-1.22x). In einer Feedback-Schleife reicht das, um bei dichter/
 *  rhythmischer Retriggerung (echter Musikbetrieb, nicht nur ein einzelner
 *  Impuls) tatsächlich unbegrenzt aufzuschaukeln, siehe git-history dieser
 *  Datei. Ein einpoliger Tiefpass hat dagegen |H(w)| <= 1 für JEDE
 *  Frequenz, beweisbar (Gleichheit nur bei w=0) -- kein Überschwinger
 *  möglich, egal welche Grenzfrequenz. Damit gilt decay*|H(w)| <= decay < 1
 *  garantiert, für jede Parameter-Kombination, nicht nur für einzeln
 *  getestete.
 *
 *  Diese Begründung galt schon immer -- die frühere UMSETZUNG als nativer
 *  Graph-Zyklus (GainNode + DelayNode mit einem Sample Verzögerung) war
 *  aber GEMESSEN um Grössenordnungen daneben: die Web-Audio-Spec verlangt
 *  für jeden Zyklus im Graphen mindestens einen vollen Render-Quantum (128
 *  Samples) Latenz, die "Ein-Sample"-Verzögerung wurde also faktisch zu
 *  ~128 Samples. Gerechnet wurde damit nicht y[n] = (1-a)x[n] + a*y[n-1],
 *  sondern y[n] = (1-a)x[n] + a*y[n-128] -- kein 1-Pol-Tiefpass mehr,
 *  sondern ein kammfilterartiges Gebilde mit Polstellen im Abstand von
 *  rund fs/128 (~375Hz), dessen wirksame Grenzfrequenz über den gesamten
 *  Reglerbereich 500-15000Hz irgendwo bei ~4-120Hz lag. Der Damping-Regler
 *  zeigte also durchgehend etwa das 128-fache dessen an, was tatsächlich
 *  passierte -- Hallfahnen und Resonator-Ausklänge waren entsprechend
 *  deutlich dumpfer als angezeigt.
 *
 *  Deshalb jetzt dieselbe AudioWorklet-Stufe wie bei eq8 (s. core/
 *  onepole-worklet.js): sample-für-sample im Worklet gerechnet, kein
 *  Zyklus im nativen Graphen, keine Quantum-Latenz. Die umgebende
 *  Feedback-Schleife bleibt davon unberührt -- ihre eigene Delayline
 *  liefert weiterhin das für einen Zyklus vorgeschriebene Verzögerungs-
 *  glied, die Schleifenlaufzeit ändert sich also nicht.
 *
 *  input/output sind bewusst eigene, STABILE GainNodes: solange das
 *  Worklet-Modul noch lädt, verbindet der Platzhalter input direkt auf
 *  output (transparent, also |H|=1 -- die Stabilitätsschranke oben gilt
 *  weiterhin, nur eben ohne Höhendämpfung); sobald das Modul steht, wird
 *  die echte Stufe dazwischengehängt, ohne dass der umgebende Graph seine
 *  Verkabelung anfassen muss. */
function makeOnePoleLowpass(ctx, cutoffHz) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  let filter = null;
  let disposed = false;
  let freq = cutoffHz;

  const attach = () => {
    // outputChannelCount bewusst NICHT gesetzt -- so übernimmt der Knoten
    // die Kanalzahl seines Eingangs (mono bleibt mono), statt eine
    // Mono-Delayline unnötig auf Stereo aufzublasen.
    filter = new AudioWorkletNode(ctx, 'rackwerk-onepole', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      processorOptions: { highpass: false },
    });
    filter.parameters.get('cutoff').value = freq;
    input.connect(filter).connect(output);
  };

  if (onePoleReady) {
    attach();
  } else {
    input.connect(output);
    ensureOnePoleWorklet(ctx).then((ok) => {
      if (!ok || disposed) return;
      input.disconnect(output);
      attach();
    });
  }

  return {
    input,
    output,
    setFreq(hz, t, timeConstant) {
      freq = hz;
      filter?.parameters.get('cutoff').setTargetAtTime(hz, t, timeConstant);
    },
    dispose() {
      disposed = true;
      input.disconnect();
      output.disconnect();
      filter?.disconnect();
    },
  };
}

/** Schroeder-Allpass-Diffusor: ein Knoten mit gleicher Betragsantwort über
 *  alle Frequenzen (verändert also NICHT die Klangfarbe), aber streut die
 *  Phase -- genau das braucht ein algorithmischer Reverb VOR dem eigentlichen
 *  Delay-Netzwerk, um einen einzelnen Impuls in ein dichtes Bündel dicht
 *  aufeinanderfolgender Mikro-Echos zu verwandeln, statt eines hörbar
 *  "klickenden" Attacks direkt vor dem Hall-Schwanz.
 *    w[n] = x[n] + g*w[n-D]      (läuft in die Delay-Leitung)
 *    y[n] = -g*w[n] + w[n-D]     (Ausgang)
 *  Braucht ZWEI Abgriffe an derselben DelayNode (Fan-out ist in Web Audio
 *  unproblematisch): einen für die Rückkopplung in sich selbst, einen für
 *  den direkten Ausgang. */
function makeAllpass(ctx, delayTime, g) {
  const delay = ctx.createDelay(1);
  delay.delayTime.value = delayTime;
  const input = ctx.createGain(); // w[n]-Summierpunkt
  const output = ctx.createGain(); // y[n]-Summierpunkt
  const fbGain = ctx.createGain();
  fbGain.gain.value = g;
  const ffGain = ctx.createGain();
  ffGain.gain.value = -g;

  input.connect(delay);
  delay.connect(fbGain).connect(input); // Rückkopplung: g*w[n-D] zurück in w[n]
  input.connect(ffGain).connect(output); // -g*w[n]
  delay.connect(output); // + w[n-D] (direkter Delay-Ausgang, zweiter Abgriff)

  return {
    input,
    output,
    // `delay` (die interne DelayNode) UND `feed` (der w[n]-Summierpunkt,
    // identisch mit `input`) zusätzlich exponiert -- der Dattorro-Tank
    // braucht beides von aussen: `delay.delayTime` als LFO-Modulationsziel
    // für die beiden modulierten Allpässe, `feed` als Abgriffspunkt für
    // zusätzliche, kürzere Tap-Delays (dieselbe Leitung an einer früheren
    // Stelle gelesen -- für ein lineares, zeitinvariantes System identisch
    // damit, dieselbe Delay-Leitung an dieser Stelle abzugreifen).
    delay,
    feed: input,
    dispose() { input.disconnect(); output.disconnect(); delay.disconnect(); fbGain.disconnect(); ffGain.disconnect(); },
  };
}

/** Dattorro-Hall-Konstanten (Jon Dattorro, "Effect Design Part 1:
 *  Reverberator and Other Filters", J. Audio Eng. Soc., 1997) -- die
 *  "Figure-8"-Tank-Topologie hinter vielen als besonders "lush"/musikalisch
 *  geltenden Hallgeräten (Vorbild für Lexicon-artige Plates, u.a. auch für
 *  SuperColliders JPverb). Ersetzt das zuvor selbst entworfene 8-Leitungen-
 *  Hadamard-FDN (klang bereits deutlich besser als die allererste Fassung,
 *  blieb aber eine selbst hergeleitete Topologie statt eines erprobten,
 *  vielfach nachgebauten Referenzdesigns).
 *  Alle Sample-Zahlen unten sind bei der Referenz-Samplerate des Original-
 *  Papers (29761 Hz) angegeben -- dattorroSec() in DEFS.reverb.build()
 *  rechnet sie in Sekunden um (DelayNode.delayTime ist ohnehin sekunden-
 *  statt samplebasiert, damit automatisch unabhängig von ctx.sampleRate
 *  korrekt). Cross-verifiziert gegen zwei unabhängige, sich exakt deckende
 *  Referenz-Portierungen (ein WebAudio-AudioWorklet und ein MATLAB-Port). */
const DATTORRO_REF_SR = 29761;

/** Eingangsdiffusion: 4 serielle Allpässe VOR dem eigentlichen Tank (wie
 *  beim alten FDN, nur mit den Original-Konstanten statt frei gewählten
 *  Werten). */
const DATTORRO_INPUT_DIFFUSION = [
  { samples: 142, gain: 0.75 },
  { samples: 107, gain: 0.75 },
  { samples: 379, gain: 0.625 },
  { samples: 277, gain: 0.625 },
];

/** Eine Tank-Hälfte: erster Allpass (im Original-Paper mit modulierter
 *  Delay-Zeit für einen Chorus-artigen "Lush"-Charakter -- hier bewusst
 *  UNMODULIERT, s. Kommentar bei buildTankHalf() in DEFS.reverb.build())
 *  -> langes Delay 1 -> Damping -> Decay -> fester, GEGENGLEICH gepolter
 *  Allpass (negatives Gain) -> langes Delay 2 -> Decay -> Kreuzkopplung in
 *  die JEWEILS ANDERE Hälfte (kein NxN-Mischnetz wie beim alten Hadamard-
 *  FDN, sondern zwei Hälften, die sich nur gegenseitig speisen --
 *  Dattorros charakteristisches "Figure-8"). */
const DATTORRO_TANK = [
  { modDelay: 672, modGain: 0.7, delay1: 4453, ap5Delay: 1800, ap5Gain: -0.5, delay2: 3720 },
  { modDelay: 908, modGain: 0.7, delay1: 4217, ap5Delay: 2656, ap5Gain: -0.5, delay2: 3163 },
];

/** Ausgangs-"Taps": je Kanal 7 kurze Zusatz-Delays, die dieselbe Leitung
 *  (gespeist vom selben Quellsignal wie das jeweilige lange Delay/der feste
 *  Allpass) an einer FRÜHEREN, kürzeren Stelle abgreifen -- für ein
 *  lineares, zeitinvariantes System exakt äquivalent zum Original-Design
 *  (eine einzelne, an mehreren Stellen gelesene Delay-Leitung), ohne eine
 *  eigene Mehrfach-Abgriff-Leitung bauen zu müssen. `half` indiziert
 *  DATTORRO_TANK, `which` wählt zwischen den drei Abgriffspunkten dieser
 *  Hälfte (vor Delay 1 / vor dem festen Allpass / vor Delay 2). Vorzeichen
 *  und Reihenfolge wie im Original-Paper -- die grössten zwei Taps je Kanal
 *  kommen bewusst aus der JEWEILS ANDEREN Tank-Hälfte (Stereo-Dekorrelation:
 *  linker und rechter Kanal ziehen ihre Haupt-Energie aus verschiedenen
 *  Leitungen). */
const DATTORRO_TAPS = {
  L: [
    { half: 1, which: 'delay1', samples: 266, sign: 1 },
    { half: 1, which: 'delay1', samples: 2974, sign: 1 },
    { half: 1, which: 'ap5', samples: 1913, sign: -1 },
    { half: 1, which: 'delay2', samples: 1996, sign: 1 },
    { half: 0, which: 'delay1', samples: 1990, sign: -1 },
    { half: 0, which: 'ap5', samples: 187, sign: -1 },
    { half: 0, which: 'delay2', samples: 1066, sign: -1 },
  ],
  R: [
    { half: 0, which: 'delay1', samples: 353, sign: 1 },
    { half: 0, which: 'delay1', samples: 3627, sign: 1 },
    { half: 0, which: 'ap5', samples: 1228, sign: -1 },
    { half: 0, which: 'delay2', samples: 2673, sign: 1 },
    { half: 1, which: 'delay1', samples: 2111, sign: -1 },
    { half: 1, which: 'ap5', samples: 335, sign: -1 },
    { half: 1, which: 'delay2', samples: 121, sign: -1 },
  ],
};

/** Pegelausgleich für die 7-fach-Tap-Summe je Kanal (s. DATTORRO_TAPS) --
 *  unity-Gain-Taps wie im Original-Paper summieren sich sonst deutlich
 *  lauter als der Dry-Pfad. Empirisch per Peak-Messung bestimmt (s.
 *  Testprotokoll bei der Umstellung von FDN auf Dattorro). */
const DATTORRO_OUT_LEVEL = 0.25;

/** Feste Schwelle statt Regler — wie beim 1176-Vorbild: kein Threshold-
 *  Knopf, stattdessen treibt Input den Pegel in einen fest eingestellten
 *  Kompressor hinein ("drive it hard"). Output macht danach die Lautstärke
 *  wieder wett. */
const COMP_FIXED_THRESHOLD_DB = -18;

/** Ratio ist beim 1176 eine Taster-Reihe, kein Drehregler. Kleinere Knee
 *  bei höherer Ratio = härterer Einsatz; "all" (alle Taster gedrückt, der
 *  legendäre "British Mode"/Nuke) fährt Ratio+Knee auf Anschlag für den
 *  krachigsten, am wenigsten transparenten Charakter. */
const RATIO_MODES = {
  4:    { ratio: 4,  knee: 24 },
  8:    { ratio: 8,  knee: 18 },
  12:   { ratio: 12, knee: 12 },
  20:   { ratio: 20, knee: 6 },
  all:  { ratio: 20, knee: 0 },
};
export const RATIO_MODE_BUTTONS = [
  { value: '4', label: '4' },
  { value: '8', label: '8' },
  { value: '12', label: '12' },
  { value: '20', label: '20' },
  { value: 'all', label: 'ALL' },
];

/** Der echte LA-2A hat keinen Ratio-Regler, sondern einen Zweistufen-
 *  Schalter -- "Compress" (~3:1, moderat, für Gesang/Bass) und "Limit"
 *  (~20:1, hart, fürs "Zudrücken" lauter Peaks). */
const OPTO_MODES = {
  compress: { ratio: 3 },
  limit: { ratio: 20 },
};
export const OPTO_MODE_BUTTONS = [
  { value: 'compress', label: 'Compress' },
  { value: 'limit', label: 'Limit' },
];

/** ISO-nahe Standardfrequenzen eines klassischen 10-Band-Grafik-EQs
 *  (Oktavabstand) -- eigene, feste Bänder, bewusst UI/DSP-seitig komplett
 *  getrennt vom parametrischen eq8 oben (dort frei positionierbar/
 *  Q-einstellbar, hier fixe Frequenzen + feste Bandbreite, dafür als
 *  Schieberegler-Reihe auf einen Blick bedienbar, wie am Hardware-Vorbild). */
export const GEQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
/** Q für ~1-Oktav-Bandbreite bei einem Peaking-Filter (RBJ Audio-EQ-
 *  Cookbook), damit sich benachbarte Bänder bei Oktavabstand sauber
 *  überlappen statt Lücken/harte Stufen zu lassen. */
const GEQ_Q = 1.41;

/** Maximale Rauschamplitude bei Hiss=1 (s. DEFS.tape) -- ursprünglich 0.05,
 *  war deutlich zu laut: Band-Grundrauschen will man grundsätzlich nur ganz
 *  leise mit dabei haben, kein hörbares Zischen im Vordergrund. Erst um 60%
 *  gesenkt (0.05 -> 0.02), dann nochmals um 30% (0.02 -> 0.014) fürs feinere
 *  Einstellen im dezenten Bereich. Als Nebeneffekt deckt der GESAMTE
 *  Regelweg des Knobs jetzt den tatsächlich brauchbaren, dezenten Bereich
 *  ab, statt dass (wie ursprünglich) schon die untere Hälfte des Reglers zu
 *  laut war und nur ein kleiner Ausschnitt am unteren Anschlag praktisch
 *  nutzbar blieb -- ohne Kurven-Änderung, allein durch die Skalierung
 *  "verfeinert" sich damit die Auflösung im leisen, gewünschten Bereich. */
const HISS_MAX_GAIN = 0.014;

/* ---------- eq8: Highpass/Lowpass mit wählbarer Flankensteilheit ----------
 * Ein "Band" ist hier nicht mehr zwingend EIN Audio-Node: bei Highpass/
 * Lowpass entscheidet die Flankensteilheit (b.slope) über 1-4 kaskadierte
 * Teil-Nodes (echte 1-polige Stufen für 6dB/Okt-Anteile, native Biquads für
 * 12dB/Okt-Anteile). Jeder Teil-Node wird als { kind, input, output, ... }
 * gekapselt, damit build()/rebuildBand() sie generisch in Serie verketten
 * können, ohne zwischen BiquadFilterNode/AudioWorkletNode (input===output
 * ===node) unterscheiden zu müssen.
 *
 * Die 1-poligen Stufen laufen über einen AudioWorkletProcessor (s.
 * eq8-onepole-worklet.js), NICHT über eine Gain/Delay-Rückkopplungs-
 * schleife wie das ältere makeOnePoleLowpass() (genutzt für Reverb/
 * Resonator-Damping): eine erste Version genau so gebaut wurde per echter
 * Audio-Messung als UNGENAU entlarvt -- die Web-Audio-Spec verlangt für
 * jeden ZYKLUS im Graphen mindestens ein volles Render-Quantum (128
 * Samples) Verzögerung, eine "1-Sample"-DelayNode in einer Rückkopplungs-
 * schleife bekommt also effektiv ~128 statt 1 Sample Verzögerung, was die
 * tatsächliche Grenzfrequenz um denselben Faktor verschiebt (gemessen: ein
 * auf 4000Hz gestellter "Tiefpass" dämpfte bereits deutlich bei 100Hz).
 * Ein Worklet rechnet die Rekursion dagegen sample-für-sample im eigenen
 * JS-Code -- kein Zyklus im nativen Graphen, keine Quantum-Latenz. */

/** Für peaking/lowshelf/highshelf ist Gain=0 die neutrale "aus"-Stellung
 *  (s. bisheriger Kommentar bei DEFS.eq8) -- das gilt NICHT für Highpass/
 *  Lowpass, deren `gain`-Parameter laut Web-Audio-Spec bei diesen Typen
 *  gar keine Wirkung hat (ein inaktives Band würde also unverändert
 *  weiterfiltern). Neutrale Stellung ist hier stattdessen eine Grenz-
 *  frequenz am Rand des Hörbereichs -- praktisch nicht von echtem Bypass
 *  zu unterscheiden. Peaking/Shelf-Bänder bleiben unverändert (eigener
 *  Ast in setEq8BandParams unten), diese Funktion gilt nur für die
 *  Frequenz von Highpass/Lowpass-Bändern. */
function eq8EffectiveFreq(b) {
  if (b.active) return b.freq;
  if (b.type === 'lowpass') return 20000;
  if (b.type === 'highpass') return 20;
  return b.freq;
}

function eq8WrapBiquad(node) { return { kind: 'biquad', node, input: node, output: node }; }

function eq8MakeBiquad(ctx, type, freq, q) {
  const node = ctx.createBiquadFilter();
  node.type = type;
  node.frequency.value = freq;
  node.Q.value = q;
  return node;
}

/** Baut EINE 1-polige Teil-Node (6dB/Okt-Anteil) -- nutzt dieselbe
 *  gemeinsame Worklet-Stufe wie der Damping-Filter von Reverb/Resonator
 *  (s. ensureOnePoleWorklet/makeOnePoleLowpass oben). Solange das Modul
 *  noch lädt (praktisch nur für den allerersten betroffenen Insert einer
 *  Session möglich), bleibt die Stufe ein transparenter Platzhalter --
 *  sobald das Modul bereitsteht, ruft `rebuildOnceReady` (übergeben von
 *  build()/rebuildBand) genau diese Band-Position neu auf, was dann den
 *  echten Worklet-Node einsetzt. */
function eq8MakeOnePoleStage(ctx, highpass, freq, rebuildOnceReady) {
  if (onePoleReady) {
    const node = new AudioWorkletNode(ctx, 'rackwerk-onepole', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { highpass },
    });
    node.parameters.get('cutoff').value = freq;
    return { kind: 'onepoleWorklet', node, input: node, output: node };
  }
  ensureOnePoleWorklet(ctx).then((ok) => { if (ok) rebuildOnceReady(); });
  const node = ctx.createGain();
  return { kind: 'passthrough', node, input: node, output: node };
}

/** Baut die 1-4 Teil-Nodes EINES logischen Bandes, abhängig von Typ und
 *  (bei Highpass/Lowpass) Flankensteilheit. Peaking/Shelf ist immer genau
 *  ein Biquad (unverändert). `rebuildOnceReady` s. eq8MakeOnePoleStage. */
function eq8BuildBandNodes(ctx, b, rebuildOnceReady) {
  if (b.type === 'highpass' || b.type === 'lowpass') {
    const freq = eq8EffectiveFreq(b);
    const slope = b.slope ?? 12;
    const highpass = b.type === 'highpass';
    if (slope === 6) {
      return [eq8MakeOnePoleStage(ctx, highpass, freq, rebuildOnceReady)];
    }
    if (slope === 18) {
      const biquad = eq8MakeBiquad(ctx, b.type, freq, b.q);
      return [eq8WrapBiquad(biquad), eq8MakeOnePoleStage(ctx, highpass, freq, rebuildOnceReady)];
    }
    if (slope === 48 && highpass) {
      // Brickwall: 4 kaskadierte Biquads = 8-polig = -48dB/Okt (Nutzer-
      // Vorgabe, bewusst nur für Highpass, s. EQ_SLOPES-Kommentar).
      return Array.from({ length: 4 }, () => eq8WrapBiquad(eq8MakeBiquad(ctx, 'highpass', freq, b.q)));
    }
    // Default/Fallback: 12dB/Okt, ein einzelner nativer Biquad (identisch
    // zum bisherigen Alleinstellungsfall).
    return [eq8WrapBiquad(eq8MakeBiquad(ctx, b.type, freq, b.q))];
  }
  // peaking / lowshelf / highshelf -- unverändert, immer ein Biquad.
  const node = eq8MakeBiquad(ctx, b.type, b.freq, b.q);
  node.gain.value = b.active ? b.gain : 0;
  return [eq8WrapBiquad(node)];
}

function eq8DisposeSub(s) {
  if (s.kind === 'onepoleWorklet') s.node.port?.close?.();
  s.node.disconnect();
}

/** Schreibt freq/Q (und bei peaking/shelf: gain) aller Teil-Nodes EINES
 *  Bandes neu -- für reine Parameteränderungen (freq/gain/q/active), die
 *  KEINEN Neuaufbau brauchen (Node-Anzahl bleibt gleich). Q gilt für ALLE
 *  Biquad-Teil-Nodes eines Bandes gemeinsam (ein mehrpoliges resonantes
 *  Filter wie eine Analog-Filter-Leiter teilt sich ebenfalls eine
 *  Resonanz über alle Stufen) -- die 1-poligen Worklet-Stufen (und der
 *  transparente Platzhalter, solange das Modul noch lädt) haben kein
 *  Q-Konzept (physikalisch: ein 1-Pol-Filter kann nicht resonieren) und
 *  werden hier einfach übersprungen. */
function eq8ApplyBandParams(subs, b) {
  const freq = (b.type === 'highpass' || b.type === 'lowpass') ? eq8EffectiveFreq(b) : b.freq;
  for (const s of subs) {
    if (s.kind === 'biquad') {
      s.node.frequency.setTargetAtTime(freq, engine.now, 0.01);
      s.node.Q.setTargetAtTime(b.q, engine.now, 0.01);
    } else if (s.kind === 'onepoleWorklet') {
      s.node.parameters.get('cutoff').setTargetAtTime(freq, engine.now, 0.01);
    }
    // 'passthrough' (Worklet lädt noch): ignoriert freq, hat nichts zu tun.
  }
  if (b.type === 'peaking' || b.type === 'lowshelf' || b.type === 'highshelf') {
    subs[0].node.gain.setTargetAtTime(b.active ? b.gain : 0, engine.now, 0.01);
  }
}

/** Betragsfrequenzgang (dB) einer 1-poligen Worklet-Stufe bei freqHz --
 *  kein natives getFrequencyResponse() für einen AudioWorkletNode
 *  vorhanden, deshalb direkt aus der bekannten Übertragungsfunktion
 *  berechnet -- DIESELBEN Koeffizientenformeln wie im Worklet selbst
 *  (eq8-onepole-worklet.js) bzw. machines/acidbass-worklet.js#OnePole:
 *  Tiefpass H(z)=(1-a)/(1-a·z⁻¹); Hochpass H(z)=k·(1-z⁻¹)/(1-a·z⁻¹) mit
 *  k=0.5·(1+a), a=exp(-2π·fc/fs). */
function eq8OnePoleResponseDb(freqHz, cutoffHz, sampleRate, highpass) {
  const a = Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
  const w = (2 * Math.PI * freqHz) / sampleRate;
  const cw = Math.cos(w), sw = Math.sin(w);
  const denomRe = 1 - a * cw, denomIm = a * sw;
  const denomMagSq = denomRe * denomRe + denomIm * denomIm;
  let numMagSq;
  if (!highpass) {
    const numMag = 1 - a;
    numMagSq = numMag * numMag;
  } else {
    const k = 0.5 * (1 + a);
    const numRe = k * (1 - cw), numIm = k * sw;
    numMagSq = numRe * numRe + numIm * numIm;
  }
  return 10 * Math.log10(Math.max(1e-12, numMagSq / denomMagSq));
}

const DEFS = {
  comp: {
    name: 'Compressor',
    // Feste Zusatzlatenz des DynamicsCompressorNode-Lookaheads (s.
    // DYNAMICS_COMPRESSOR_LATENCY_SEC oben) -- von insertChainLatencySec()
    // gelesen, damit machine.js jede Maschine gegenüber dem Rest des Racks
    // zeitlich ausgleichen kann (s. dortigen PDC-Kommentar).
    latencySec: DYNAMICS_COMPRESSOR_LATENCY_SEC,
    // 1176-Style: Input (treibt in die feste Schwelle), Attack, Release,
    // Ratio-Modus (Taster statt Regler), Output (Makeup) — kein Threshold.
    // mix: Parallelkompression ("New-York-Style", wie Abletons Compressor-
    // Dry/Wet) -- 1.0 (Default) entspricht dem alten, immer volltrocken-
    // freien Verhalten, rückwärtskompatibel zu alten Projekten ohne dieses
    // Feld.
    defaults: { input: 0, output: 0, attack: 0.003, release: 0.25, ratioMode: '4', mix: 1 },
    build(ctx, p) {
      // Eigener äusserer Ein-/Ausgang für den Dry/Wet-Blend -- getrennt von
      // inputGain (der bleibt die reine, compressor-interne "Input"-Trimmung
      // vor der festen Schwelle, soll die trockene Kopie nicht mitfärben).
      const input = ctx.createGain();
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      dry.gain.value = 1 - p.mix;
      wet.gain.value = p.mix;

      // Kompensiert den Lookahead des DynamicsCompressorNode unten (s.
      // DYNAMICS_COMPRESSOR_LATENCY_SEC oben) -- ohne das käme die trockene
      // Kopie ~6ms VOR der bearbeiteten an, beim Mischen (mix<1) ein
      // hörbares Kammfilter-"Phasing", am stärksten um mix=0.5.
      const dryDelay = makeDryCompensationDelay(ctx, DYNAMICS_COMPRESSOR_LATENCY_SEC);

      const inputGain = ctx.createGain();
      inputGain.gain.value = dbToLin(p.input);
      const node = ctx.createDynamicsCompressor();
      node.threshold.value = COMP_FIXED_THRESHOLD_DB;
      const mode = RATIO_MODES[p.ratioMode] ?? RATIO_MODES['4'];
      node.ratio.value = mode.ratio;
      node.knee.value = mode.knee;
      node.attack.value = p.attack;
      node.release.value = p.release;
      const outputGain = ctx.createGain();
      outputGain.gain.value = dbToLin(p.output);

      input.connect(dryDelay).connect(dry);
      input.connect(inputGain);
      inputGain.connect(node);
      node.connect(outputGain);
      outputGain.connect(wet);
      const outSum = ctx.createGain();
      dry.connect(outSum);
      wet.connect(outSum);

      return {
        input, output: outSum,
        setParam(key, v) {
          const t = engine.now;
          if (key === 'input') inputGain.gain.setTargetAtTime(dbToLin(v), t, 0.01);
          else if (key === 'output') outputGain.gain.setTargetAtTime(dbToLin(v), t, 0.01);
          else if (key === 'attack') node.attack.setTargetAtTime(v, t, 0.01);
          else if (key === 'release') node.release.setTargetAtTime(v, t, 0.01);
          else if (key === 'ratioMode') {
            const m = RATIO_MODES[v] ?? RATIO_MODES['4'];
            node.ratio.setTargetAtTime(m.ratio, t, 0.01);
            node.knee.setTargetAtTime(m.knee, t, 0.01);
          } else if (key === 'mix') {
            dry.gain.setTargetAtTime(1 - v, t, 0.01);
            wet.gain.setTargetAtTime(v, t, 0.01);
          }
        },
        // Live-Gain-Reduction fürs GR-Meter — Web Audio liefert den Wert
        // direkt vom nativen Compressor, kein separates Analyse-Tapping
        // nötig (negative dB, 0 = keine Reduktion).
        getReductionDb() { return node.reduction ?? 0; },
        dispose() {
          input.disconnect(); dry.disconnect(); wet.disconnect(); outSum.disconnect();
          dryDelay.disconnect(); inputGain.disconnect(); node.disconnect(); outputGain.disconnect();
        },
      };
    },
  },
  eq: {
    name: 'EQ',
    // Bewusst EIN Band (nicht fest 3-bandig) — die freie Kette erlaubt es,
    // bei Bedarf mehrere EQ-Instanzen zu stapeln (Low-Shelf + Peak + High-
    // Shelf), passt zur gewählten "flexiblen Kette" statt einer festen.
    defaults: { type: 'peaking', freq: 1000, gain: 0, q: 1 },
    build(ctx, p) {
      const node = ctx.createBiquadFilter();
      node.type = p.type;
      node.frequency.value = p.freq;
      node.gain.value = p.gain;
      node.Q.value = p.q;
      return {
        input: node,
        output: node,
        setParam(key, v) {
          if (key === 'type') node.type = v;
          else if (key === 'freq') node.frequency.setTargetAtTime(v, engine.now, 0.01);
          else if (key === 'gain') node.gain.setTargetAtTime(v, engine.now, 0.01);
          else if (key === 'q') node.Q.setTargetAtTime(v, engine.now, 0.01);
        },
        dispose() { node.disconnect(); },
      };
    },
  },
  eq8: {
    name: '8-Band EQ',
    // 8 feste Bänder (anders als 'eq' oben) -- touch-bedienbares Pendant zu
    // EQ8/Pro-Q. Ein inaktives peaking/shelf-Band bleibt fest in der Kette
    // (kein Umverkabeln beim An-/Ausschalten), wird aber lautlos auf
    // neutral (Gain 0) gezwungen. Highpass/Lowpass-Bänder (s. EQ_TYPES)
    // haben dagegen keinen Gain-Parameter, der bei diesen Typen überhaupt
    // etwas bewirkt (Web-Audio-Spec) -- ihre neutrale Stellung ist
    // stattdessen eine Grenzfrequenz am Rand des Hörbereichs, s.
    // eq8EffectiveFreq() oben. gainRange ist reiner UI-Zustand (welcher
    // dB-Ausschnitt gerade angezeigt/gezogen wird), berührt keinen
    // Audio-Node.
    defaults: {
      bands: Array.from({ length: 8 }, () => ({ active: false, type: 'peaking', freq: 1000, gain: 0, q: 1, slope: 12 })),
      gainRange: 18,
    },
    build(ctx, p) {
      // Stabile Anker-Nodes: input/output dieses Objekts bleiben IMMER
      // dieselbe Node-Referenz, auch wenn Band 0 oder Band 7 durch einen
      // Flankensteilheit-/Typ-Wechsel intern komplett neu aufgebaut wird
      // (s. rebuildBand) -- sonst hinge createInsert()s äusserer Dry/Wet-
      // Wrapper irgendwann an einer bereits entsorgten toten Node.
      const headIn = ctx.createGain();
      const tailOut = ctx.createGain();
      // Das 1-Pol-Worklet lädt ASYNCHRON (s. eq8MakeOnePoleStage): wird
      // dieser Insert entfernt, BEVOR das Modul fertig geladen ist, feuert
      // der rebuildOnceReady-Callback trotzdem noch. Ohne dieses Flag
      // würde er dann auf bereits entsorgten Nodes herumverkabeln und neue
      // AudioWorkletNodes in einen toten Teilgraphen hängen, die nie wieder
      // jemand abräumt.
      let disposed = false;
      const bandNodes = p.bands.map((b, i) => eq8BuildBandNodes(ctx, b, () => rebuildBand(i)));
      let prevOut = headIn;
      for (const subs of bandNodes) {
        prevOut.connect(subs[0].input);
        for (let k = 0; k < subs.length - 1; k++) subs[k].output.connect(subs[k + 1].input);
        prevOut = subs[subs.length - 1].output;
      }
      prevOut.connect(tailOut);

      /** Baut die Teil-Nodes EINES Bandes komplett neu (Typ- oder
       *  Flankensteilheit-Wechsel -- die Anzahl Teil-Nodes kann sich
       *  ändern). Trennt die alte Kette exakt an den drei Stellen, an
       *  denen sie mit dem Rest verbunden war (Vorgänger→erste Teil-Node,
       *  intern zwischen den Teil-Nodes, letzte Teil-Node→Nachfolger),
       *  entsorgt die alten Nodes, verkabelt die neuen an derselben
       *  Stelle. Reine Parameteränderungen (freq/gain/q/active) laufen
       *  NICHT hier durch, s. eq8ApplyBandParams(). */
      function rebuildBand(i) {
        if (disposed) return;
        const oldSubs = bandNodes[i];
        const prevN = i === 0 ? headIn : bandNodes[i - 1][bandNodes[i - 1].length - 1].output;
        const nextN = i === bandNodes.length - 1 ? tailOut : bandNodes[i + 1][0].input;

        prevN.disconnect(oldSubs[0].input);
        for (let k = 0; k < oldSubs.length - 1; k++) oldSubs[k].output.disconnect(oldSubs[k + 1].input);
        oldSubs[oldSubs.length - 1].output.disconnect(nextN);
        oldSubs.forEach(eq8DisposeSub);

        const newSubs = eq8BuildBandNodes(ctx, p.bands[i], () => rebuildBand(i));
        prevN.connect(newSubs[0].input);
        for (let k = 0; k < newSubs.length - 1; k++) newSubs[k].output.connect(newSubs[k + 1].input);
        newSubs[newSubs.length - 1].output.connect(nextN);
        bandNodes[i] = newSubs;
      }

      return {
        input: headIn,
        output: tailOut,
        // Der generische Insert-Wrapper kennt nur ein flaches key/value-
        // setParam -- passt nicht auf "ein Feld eines von 8 Bändern".
        // setBand/getEq8Response/setGainRange sind bewusst zusätzliche,
        // eq8-eigene Methoden (gleiches Muster wie getReductionDb beim
        // Compressor), die createInsert() unten optional durchreicht.
        // p.bands wird von der UI direkt mutiert (dieselbe Referenz wie
        // insert.params.bands), setBand liest daraus nur den aktuellen
        // Wert und schreibt ihn an die echten Audio-Nodes.
        setParam() {}, // eq8 läuft komplett über setBand/setGainRange, s. oben
        setBand(i, field) {
          const b = p.bands[i];
          if (!bandNodes[i]) return;
          if (field === 'type' || field === 'slope') rebuildBand(i);
          else eq8ApplyBandParams(bandNodes[i], b);
        },
        // Reine Anzeige-/Zieh-Skalierung des Touch-Graphen -- kein Audio-
        // Node betroffen, der Gain-WERT jedes Bandes bleibt unverändert.
        setGainRange(v) { p.gainRange = v; },
        /** Summierte dB-Antwort aller AKTIVEN Bänder über freqArray (Hz) --
         *  echte Berechnung statt einer geschätzten Silhouette (s. machine.js#
         *  eqCurvePath für den Einzelband-EQ). dB-Werte addieren sich für
         *  in Serie geschaltete Filter korrekt (Amplituden multiplizieren
         *  sich, log(a*b) = log(a)+log(b)) -- gilt unverändert, egal ob ein
         *  Band aus einem oder mehreren kaskadierten Teil-Nodes besteht. */
        getEq8Response(freqArray) {
          const mag = new Float32Array(freqArray.length);
          const phase = new Float32Array(freqArray.length);
          const totalDb = new Float32Array(freqArray.length);
          for (let i = 0; i < bandNodes.length; i++) {
            const b = p.bands[i];
            if (!b.active) continue;
            const freq = (b.type === 'highpass' || b.type === 'lowpass') ? eq8EffectiveFreq(b) : b.freq;
            for (const s of bandNodes[i]) {
              if (s.kind === 'biquad') {
                s.node.getFrequencyResponse(freqArray, mag, phase);
                for (let j = 0; j < freqArray.length; j++) {
                  totalDb[j] += 20 * Math.log10(Math.max(1e-6, mag[j]));
                }
              } else if (s.kind === 'onepoleWorklet') {
                const highpass = b.type === 'highpass';
                for (let j = 0; j < freqArray.length; j++) {
                  totalDb[j] += eq8OnePoleResponseDb(freqArray[j], freq, ctx.sampleRate, highpass);
                }
              }
              // 'passthrough' (Worklet lädt noch): trägt 0dB bei, wird
              // übersprungen -- die 1-Pol-Formel würde hier eine falsche
              // Kurvenform vorgaukeln, obwohl der Node aktuell transparent ist.
            }
          }
          return totalDb;
        },
        dispose() {
          disposed = true;
          headIn.disconnect();
          tailOut.disconnect();
          bandNodes.forEach((subs) => subs.forEach(eq8DisposeSub));
        },
      };
    },
  },
  drive: {
    name: 'Drive',
    // Feste Zusatzlatenz des 4x-Oversampling-Interpolationsfilters (s.
    // WAVESHAPER_4X_LATENCY_SEC oben) -- s. Kommentar bei DEFS.comp.latencySec.
    latencySec: WAVESHAPER_4X_LATENCY_SEC,
    // base: Pre-Shaper-Filter (wie Abletons Saturator-"Color"-Sektion) --
    // VOR der Sättigung, entscheidet WELCHE Frequenzen überhaupt in den
    // Shaper laufen, nicht nur wie das Ergebnis klingt (das macht `tone`
    // danach, ein reiner Ausgangs-Klangfarbe-Filter). Ein Low-Shelf: positiver
    // Wert hebt Bässe VOR der Sättigung an (mehr/wärmere Bass-Harmonische),
    // negativer senkt sie ab (Sättigung verlagert sich zu Mitten/Höhen --
    // "fizzy"/präsenter statt wummernd). 0 = flach = unverändert.
    // mix: Dry/Wet wie Abletons Saturator -- 1.0 (Default) entspricht dem
    // alten, immer volltrockenfreien Verhalten.
    defaults: { drive: 0.4, tone: 0.6, level: 0.8, base: 0, mix: 1 },
    build(ctx, p) {
      const input = ctx.createGain();
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      dry.gain.value = 1 - p.mix;
      wet.gain.value = p.mix;

      const pre = ctx.createBiquadFilter();
      pre.type = 'lowshelf';
      pre.frequency.value = 300;
      pre.gain.value = p.base * 15; // ±15dB, deutlich hörbar ohne extrem zu sein

      const shaper = ctx.createWaveShaper();
      shaper.oversample = '4x';
      shaper.curve = makeDriveCurve(p.drive);
      const tone = ctx.createBiquadFilter();
      tone.type = 'lowpass';
      tone.Q.value = 0.7;
      tone.frequency.value = 400 * Math.pow(12000 / 400, p.tone);
      const level = ctx.createGain();
      level.gain.value = p.level;

      // Kompensiert das 4x-Oversampling-Interpolationsfilter des Shapers
      // oben (s. WAVESHAPER_4X_LATENCY_SEC) -- sonst käme die trockene
      // Kopie ~4ms VOR der gesättigten an, beim Mischen (mix<1) ein
      // hörbares Kammfilter-"Phasing", am stärksten um mix=0.5.
      const dryDelay = makeDryCompensationDelay(ctx, WAVESHAPER_4X_LATENCY_SEC);
      input.connect(dryDelay).connect(dry);
      input.connect(pre);
      pre.connect(shaper);
      shaper.connect(tone);
      tone.connect(level);
      level.connect(wet);
      const outSum = ctx.createGain();
      dry.connect(outSum);
      wet.connect(outSum);

      // Kurve neu bauen ist teuer (1024 Sample-tanh() + Reassignment an den
      // Audio-Thread, das zudem bei aktivem Signal hörbar knackst, weil
      // WaveShaper-Kurven beim Wechsel nicht überblendet werden) -- der Knob
      // feuert aber auf JEDEN pointermove, beim Ziehen also bis zu 60x/s.
      // Gleiches Entprellen wie fx.js' #buildIR() für den Reverb-Impuls.
      let driveTimer = null;
      return {
        input, output: outSum,
        setParam(key, v) {
          if (key === 'drive') {
            clearTimeout(driveTimer);
            driveTimer = setTimeout(() => { shaper.curve = makeDriveCurve(v); }, 60);
          }
          else if (key === 'tone') tone.frequency.setTargetAtTime(400 * Math.pow(12000 / 400, v), engine.now, 0.01);
          else if (key === 'level') level.gain.setTargetAtTime(v, engine.now, 0.01);
          else if (key === 'base') pre.gain.setTargetAtTime(v * 15, engine.now, 0.01);
          else if (key === 'mix') {
            dry.gain.setTargetAtTime(1 - v, engine.now, 0.01);
            wet.gain.setTargetAtTime(v, engine.now, 0.01);
          }
        },
        dispose() {
          clearTimeout(driveTimer);
          input.disconnect(); dry.disconnect(); wet.disconnect(); outSum.disconnect();
          dryDelay.disconnect(); pre.disconnect(); shaper.disconnect(); tone.disconnect(); level.disconnect();
        },
      };
    },
  },
  filterDelay: {
    name: 'Filter Delay',
    // Anders als Comp/EQ/Drive (die immer voll "wet" arbeiten) braucht ein
    // Delay einen eigenen, stufenlosen Dry/Wet-Regler -- der äussere
    // dryGain/wetGain-Umschalter von createInsert() ist ein reiner Bypass
    // (0 oder 1, kein Zwischenwert), kein Mix-Regler. Der Mix-Regler lebt
    // deshalb INNERHALB dieses Effekts, wie schon Drive's `level`.
    //
    // pingPong (wie Abletons Delay): zwei Verzögerungsleitungen im Über-
    // Kreuz-Feedback (delayL -> filterL -> [Panner] UND -> feedbackL ->
    // delayR -> filterR -> [Panner] UND -> feedbackR -> zurück in delayL,
    // usw.) statt einer einzelnen. Mathematisch ÄQUIVALENT zum alten
    // Einzelleitungs-Mono-Delay, wenn beide Panner auf 0 (Mitte) stehen --
    // jede Wiederholung durchläuft exakt dieselbe Anzahl Filter-/Feedback-
    // Stufen wie im alten Design, nur auf zwei Knoten verteilt (Echo n
    // erscheint bei nT, gedämpft um feedback^(n-1), identisch zum Original
    // -- nachgerechnet). Deshalb KEIN struktureller Graph-Umbau nötig, wenn
    // pingPong ein-/ausgeschaltet wird: nur die beiden Panner-Werte ändern
    // sich (0/0 = Mono wie bisher, -1/1 = volles Ping-Pong).
    //
    // division (wie Abletons Delay-Sync): 'free' (Default) lässt `time`
    // (Sekunden) wie bisher frei wirken; jeder Notenwert überschreibt die
    // Delay-Zeit relativ zu transport.bpm und hält sie bei jeder Tempo-
    // Änderung aktuell (transport.addListener, gleiche Set-basierte
    // Registry wie bei Maschinen -- ein Insert ist selbst keine Maschine,
    // meldet sich hier aber genauso an).
    defaults: {
      time: 0.35, feedback: 0.4, filterFreq: 2000, filterType: 'lowpass', mix: 0.35,
      pingPong: false, division: 'free', swing: 50,
    },
    build(ctx, p) {
      const input = ctx.createGain();
      const output = ctx.createGain();
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      dry.gain.value = 1 - p.mix;
      wet.gain.value = p.mix;

      // 4s statt 2s Maximum: bei tiefstem Tempo (40 BPM, s. transport.js)
      // braucht selbst eine gesynct 1/2-Note schon 3s -- 2s hätte das
      // stillschweigend gekappt (DelayNode klemmt delayTime laut Spezifikation
      // ohne Fehler auf maxDelayTime, kein Crash, aber falsche/verwirrende
      // Zeit).
      const delayL = ctx.createDelay(4.0);
      const delayR = ctx.createDelay(4.0);
      const computeTime = () => (p.division === 'free'
        ? p.time
        : transport.stepDuration * 4 * (DELAY_SYNC_DIVISIONS[p.division] ?? 1));
      // Swing (nur bei Tempo-Sync sinnvoll, s. UI_PARAMS.filterDelay): delayR
      // bekommt zusätzlich zur Basiszeit einen festen Versatz von bis zu
      // einem halben 16tel-Step (dieselbe Formel wie shuffleTime()). Da
      // delayL/delayR eine Kreuz-Feedback-Schleife bilden (delayL -> ... ->
      // delayR -> ... -> delayL, s. Kommentar oben), wechseln sich die
      // Wiederholungsabstände dadurch OHNE jedes Scheduling automatisch
      // zwischen delayL- und delayR-Zeit ab -- exakt der "swingt jede zweite
      // Wiederholung" -Effekt, rein aus der bestehenden Topologie heraus.
      // swing=50 (Default) ergibt delayR===delayL, mathematisch identisch
      // zum bisherigen Verhalten (s. Kommentar oben zur pingPong-Äquivalenz).
      const computeSwingShift = () => (p.division === 'free' || p.swing <= 50
        ? 0
        : (p.swing - 50) / 50 * transport.stepDuration);
      const t0 = computeTime();
      delayL.delayTime.value = t0;
      delayR.delayTime.value = t0 + computeSwingShift();

      // Feedback-Schleife: delay -> filter -> feedback -> zurück in delay.
      // Der WET-Abgriff sitzt NACH dem Filter, nicht am rohen Delay-Ausgang
      // -- sonst wäre bei Mix=100% das ERSTE Echo noch ein unverändertes,
      // ungefiltertes Abbild des Eingangssignals (nur zeitversetzt), was
      // sich anhört, als würde trotz Mix=100% noch das Trockensignal
      // durchkommen. So durchläuft JEDE Wiederholung, auch die erste, den
      // Filter -- nur die nachfolgenden (die zusätzlich durch die
      // Feedback-Schleife liefen) werden zunehmend stärker gefiltert.
      const filterL = ctx.createBiquadFilter();
      const filterR = ctx.createBiquadFilter();
      for (const f of [filterL, filterR]) {
        f.type = p.filterType;
        f.frequency.value = p.filterFreq;
        f.Q.value = 0.7;
      }
      const feedbackL = ctx.createGain();
      const feedbackR = ctx.createGain();
      feedbackL.gain.value = p.feedback;
      feedbackR.gain.value = p.feedback;
      // Weichbegrenzer IN der Feedback-Schleife (s. makeFeedbackClipCurve()
      // oben) -- fängt genau die Filter-Überhöhung ab, die bisher die
      // 0.8-Feedback-Obergrenze nötig machte (s. UI_PARAMS.filterDelay-
      // Kommentar), erlaubt dadurch ein deutlich höheres, fast selbst-
      // schwingendes Feedback ohne unbegrenztes Aufschaukeln -- verifiziert
      // per Stresstest (dichte Retriggerung über Feedback x Filtertyp x
      // Filterfrequenz x Zeit x PingPong). Ein erster Versuch mit einem
      // DynamicsCompressorNode (wie beim Resonator-Limiter) reichte NICHT:
      // dessen Ratio (20:1) ist kein hartes Ceiling, nur eine graduelle
      // Reduktion, und bei sehr kurzer Delay-Zeit (Minimum 0.01s, kürzer als
      // jede sinnvolle Release-Zeit) kam er nie zur Ruhe -- gemessen Peak
      // > 2.6 trotz Kompressor. Der WaveShaper reagiert dagegen pro Sample,
      // ganz ohne Attack-/Release-Verzögerung.
      const clipL = ctx.createWaveShaper();
      const clipR = ctx.createWaveShaper();
      const feedbackClipCurve = makeFeedbackClipCurve();
      clipL.curve = feedbackClipCurve;
      clipR.curve = feedbackClipCurve;
      clipL.oversample = '2x';
      clipR.oversample = '2x';
      const pannerL = ctx.createStereoPanner();
      const pannerR = ctx.createStereoPanner();
      pannerL.pan.value = p.pingPong ? -1 : 0;
      pannerR.pan.value = p.pingPong ? 1 : 0;

      input.connect(dry).connect(output);
      input.connect(delayL);
      delayL.connect(filterL);
      filterL.connect(pannerL).connect(wet);
      filterL.connect(feedbackL).connect(clipL).connect(delayR);
      delayR.connect(filterR);
      filterR.connect(pannerR).connect(wet);
      filterR.connect(feedbackR).connect(clipR).connect(delayL);
      wet.connect(output);

      // Setzt delayL auf die gerade Basiszeit und delayR auf Basiszeit+Swing
      // -- einziger Ort, der beide Delay-Zeiten anfasst, damit time/division/
      // swing/BPM-Änderungen nie auseinanderlaufen können.
      const applyTimes = () => {
        const time = computeTime();
        const t = engine.now;
        delayL.delayTime.setTargetAtTime(time, t, 0.02);
        delayR.delayTime.setTargetAtTime(time + computeSwingShift(), t, 0.02);
      };

      const bpmListener = {
        onTransport(event) {
          if (event !== 'bpm' || p.division === 'free') return;
          applyTimes();
        },
      };
      transport.addListener(bpmListener);

      return {
        input, output,
        setParam(key, v) {
          const t = engine.now;
          if (key === 'time') {
            if (p.division === 'free') applyTimes();
          } else if (key === 'feedback') {
            feedbackL.gain.setTargetAtTime(v, t, 0.01);
            feedbackR.gain.setTargetAtTime(v, t, 0.01);
          } else if (key === 'filterFreq') {
            filterL.frequency.setTargetAtTime(v, t, 0.01);
            filterR.frequency.setTargetAtTime(v, t, 0.01);
          } else if (key === 'filterType') {
            filterL.type = v; filterR.type = v;
          } else if (key === 'mix') {
            dry.gain.setTargetAtTime(1 - v, t, 0.01);
            wet.gain.setTargetAtTime(v, t, 0.01);
          } else if (key === 'pingPong') {
            pannerL.pan.setTargetAtTime(v ? -1 : 0, t, 0.02);
            pannerR.pan.setTargetAtTime(v ? 1 : 0, t, 0.02);
          } else if (key === 'division' || key === 'swing') {
            applyTimes();
          }
        },
        dispose() {
          transport.removeListener(bpmListener);
          input.disconnect(); output.disconnect(); dry.disconnect(); wet.disconnect();
          delayL.disconnect(); delayR.disconnect();
          filterL.disconnect(); filterR.disconnect();
          feedbackL.disconnect(); feedbackR.disconnect();
          clipL.disconnect(); clipR.disconnect();
          pannerL.disconnect(); pannerR.disconnect();
        },
      };
    },
  },
  reverb: {
    name: 'Reverb',
    // Anders als der Master-Reverb in fx.js (Faltung mit einem einmalig
    // erzeugten, statischen Impuls) läuft hier ein ECHTES Feedback-Netzwerk
    // -- nach Jon Dattorros bewährter "Figure-8"-Plate/Hall-Topologie (s.
    // DATTORRO_*-Konstanten oben), nicht mehr das zuvor selbst entworfene
    // 8-Leitungen-Hadamard-FDN. Zwei Tank-Hälften speisen sich gegenseitig
    // (statt eines NxN-Mischnetzes), mit exakt den Original-Delay-Zeiten/
    // Gains/Ausgangs-Taps des Papers -- dasselbe Referenzdesign, auf dem
    // viele als "lush"/musikalisch geltende Hallgeräte aufbauen.
    defaults: { size: 1.0, decay: 0.35, damping: 6000, mix: 0.35 },
    build(ctx, p) {
      const input = ctx.createGain();
      const output = ctx.createGain();
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      dry.gain.value = 1 - p.mix;
      wet.gain.value = p.mix;

      const dattorroSec = (samples) => samples / DATTORRO_REF_SR;
      // Alle mit "size" skalierenden Delays (Diffusion + Tank + Taps)
      // sammeln sich hier als {node, baseSec} -- setParam('size', v) zieht
      // sie synchron nach. Anders als beim alten FDN (dort blieb die
      // Eingangsdiffusion FEST, nur die Tank-Delays skalierten) skaliert
      // hier alles zusammen -- physikalisch stimmiger (ein "grösserer Raum"
      // hat auch längere frühe Reflexionen, nicht nur einen längeren
      // Nachhall-Schwanz) und näher an echten Dattorro-Portierungen, die
      // alle Konstanten gemeinsam mit derselben Grösse skalieren.
      const sizedDelays = [];
      function sizedDelayNode(baseSamples, maxSeconds) {
        const d = ctx.createDelay(maxSeconds);
        const baseSec = dattorroSec(baseSamples);
        d.delayTime.value = baseSec * p.size;
        sizedDelays.push({ node: d, baseSec });
        return d;
      }
      function sizedAllpass(baseSamples, gain) {
        const baseSec = dattorroSec(baseSamples);
        const ap = makeAllpass(ctx, baseSec * p.size, gain);
        sizedDelays.push({ node: ap.delay, baseSec });
        return ap;
      }

      // ---------- Eingangsdiffusion: 4 serielle Allpässe (s. DATTORRO_INPUT_DIFFUSION) ----------
      const diffusers = DATTORRO_INPUT_DIFFUSION.map((d) => sizedAllpass(d.samples, d.gain));
      input.connect(diffusers[0].input);
      for (let i = 1; i < diffusers.length; i++) diffusers[i - 1].output.connect(diffusers[i].input);
      const diffusedOut = diffusers[diffusers.length - 1].output;

      // Sicherheits-Weichbegrenzer an der Kreuzkopplung (s. makeFeedbackClipCurve()
      // oben, gleiche Technik wie bei DEFS.filterDelay) -- ohne das liess sich
      // messen, dass ein PARAMETERWECHSEL (setParam für decay/damping/size,
      // z.B. per Automation oder wenn der Regler beim Laden eines Projekts
      // von den Default- auf gespeicherte Werte rampt) die Rückkopplungs-
      // schleife für die kurze Rampdauer durch einen ZWISCHENZUSTAND führen
      // kann, der (anders als Start- und Zielwert je für sich) kurzzeitig
      // instabil ist -- ein einmal in die DelayNode-Puffer geratener
      // Extremwert (im Grenzfall Infinity/NaN) klingt danach NIE mehr ab,
      // selbst wenn die Parameter längst wieder auf einem sauber stabilen
      // Wert stehen (ein FIR-Delay hat kein "Vergessen", ein einmal
      // gespeichertes Sample bleibt bis es reihum wieder ausgelesen wird).
      // Der WaveShaper reagiert pro Sample (kein Attack/Release-Nachlauf)
      // und ist mathematisch garantiert auf (-1,1) begrenzt, unabhängig
      // davon, wie extrem der Zwischenzustand war.
      const feedbackClipCurve = makeFeedbackClipCurve();

      // ---------- Tank: zwei kreuzgekoppelte Hälften ("Figure-8", s. DATTORRO_TANK) ----------
      // Das Original-Paper moduliert die Delay-Zeit GENAU dieses ersten
      // Allpasses je Hälfte (Chorus-artiges "Lush"). Anders als beim alten
      // FDN (dort waren die modulierten Delays einfache, nicht-rekursive
      // DelayNodes) sitzt diese Delay-Zeit hier INNERHALB der eigenen
      // Rückkopplungsschleife des Allpasses -- gemessen (Diagnose-Sweep bei
      // der Umstellung) führte genau das zu echtem, langsam aufschaukelndem
      // Energiezuwachs (nicht nur hörbarem Flattern, sondern tatsächlicher
      // Instabilität bei hohem Decay), obwohl der Allpass für sich betrachtet
      // energieerhaltend ist -- eine modulierte Delay-ZEIT innerhalb einer
      // REKURSIVEN Schleife ist ein zeitvariantes System, für das der beim
      // alten FDN bewiesene "Modulation fügt keine Energie hinzu"-Satz (der
      // sich auf EINFACHE, nicht-rekursive Delays bezieht) nicht automatisch
      // gilt. Bewusst KEINE Modulation hier -- eine sichere Variante (z.B.
      // ein zusätzliches, nicht-rekursives moduliertes Delay in Serie) wäre
      // als eigener, separat getesteter Schritt nachrüstbar.
      function buildTankHalf(cfg) {
        const modAp = sizedAllpass(cfg.modDelay, cfg.modGain);

        const delay1 = sizedDelayNode(cfg.delay1, 1.0);
        modAp.output.connect(delay1);

        // Damper ist ein einpoliger Tiefpass (makeOnePoleLowpass), NICHT
        // ctx.createBiquadFilter() -- ein 2-poliger Biquad überschwingt
        // >1.0 nahe der Grenzfrequenz, egal welches Q. Damit gilt
        // decay*|Filter| <= decay < 1 GARANTIERT (s. Stabilitäts-Kommentar
        // bei setParam unten).
        const damp = makeOnePoleLowpass(ctx, p.damping);
        delay1.connect(damp.input);

        // decay wird laut Original-Paper ZWEIMAL je Tank-Hälfte angewandt
        // (hier + nochmal an der Kreuzkopplung unten) -- s. Stabilitäts-
        // Kommentar bei setParam, das macht die Schleife SICHERER als beim
        // alten FDN (dort nur einmal je Runde), nicht unsicherer.
        const decayGain1 = ctx.createGain();
        decayGain1.gain.value = p.decay;
        damp.output.connect(decayGain1);

        // Fester, GEGENGLEICH gepolter Allpass (negatives Gain -- anders
        // als der modulierte oben) -- exakt wie im Original-Paper.
        const ap5 = sizedAllpass(cfg.ap5Delay, cfg.ap5Gain);
        decayGain1.connect(ap5.input);

        const delay2 = sizedDelayNode(cfg.delay2, 1.0);
        ap5.output.connect(delay2);

        const decayGain2 = ctx.createGain();
        decayGain2.gain.value = p.decay;
        delay2.connect(decayGain2);

        const clip = ctx.createWaveShaper();
        clip.curve = feedbackClipCurve;
        clip.oversample = '2x';
        decayGain2.connect(clip);

        return {
          input: modAp.input, // Eingang dieser Hälfte (Summe aus geteiltem Diffusions-Signal + Kreuzkopplung der ANDEREN Hälfte)
          crossFeedOut: clip, // -> Eingang der ANDEREN Hälfte
          // Abgriffspunkte für die Ausgangs-Taps (s. DATTORRO_TAPS): jeweils
          // das Signal, das in die entsprechende lange Delay-Leitung/den
          // festen Allpass hineinläuft -- ein zusätzliches, kürzeres Delay
          // ab demselben Punkt ist für ein lineares System exakt
          // gleichbedeutend mit einem weiteren Lesekopf auf DERSELBEN
          // Leitung an einer früheren Stelle.
          tapSources: { delay1: modAp.output, ap5: ap5.feed, delay2: ap5.output },
          dampers: [damp],
          decayGains: [decayGain1, decayGain2],
          disposables: [modAp, ap5, delay1, delay2, damp, decayGain1, decayGain2, clip],
        };
      }
      const tanks = DATTORRO_TANK.map(buildTankHalf);

      // Dasselbe diffundierte Eingangssignal speist BEIDE Tank-Hälften;
      // die beiden Hälften speisen sich zusätzlich GEGENSEITIG (Figure-8) --
      // kein NxN-Mischnetz wie beim alten Hadamard-FDN, nur diese eine
      // Kreuzkopplung.
      diffusedOut.connect(tanks[0].input);
      diffusedOut.connect(tanks[1].input);
      tanks[0].crossFeedOut.connect(tanks[1].input);
      tanks[1].crossFeedOut.connect(tanks[0].input);

      // ---------- Ausgangs-Taps: 7 je Kanal (s. DATTORRO_TAPS) ----------
      const leftSum = ctx.createGain();
      const rightSum = ctx.createGain();
      const tapNodes = [];
      function wireTaps(channelTable, dest) {
        for (const tap of channelTable) {
          const source = tanks[tap.half].tapSources[tap.which];
          const d = sizedDelayNode(tap.samples, 1.0);
          const g = ctx.createGain();
          g.gain.value = tap.sign;
          source.connect(d).connect(g).connect(dest);
          tapNodes.push(d, g);
        }
      }
      wireTaps(DATTORRO_TAPS.L, leftSum);
      wireTaps(DATTORRO_TAPS.R, rightSum);

      // Echtes Stereo-Ausgangssignal (zwei unterschiedliche Tap-Summen,
      // nicht nur ein gedoppeltes Mono-Signal wie beim alten FDN) --
      // DATTORRO_OUT_LEVEL gleicht die 7-fach-Summe (unity-Taps wie im
      // Original-Paper) auf einen mit dem Dry-Pfad vergleichbaren Pegel
      // aus, empirisch per Peak-Messung bestimmt (s. Testprotokoll).
      const merger = ctx.createChannelMerger(2);
      const outLevel = ctx.createGain();
      outLevel.gain.value = DATTORRO_OUT_LEVEL;
      leftSum.connect(merger, 0, 0);
      rightSum.connect(merger, 0, 1);
      merger.connect(outLevel);

      input.connect(dry).connect(output);
      outLevel.connect(wet).connect(output);

      return {
        input, output,
        setParam(key, v) {
          const t = engine.now;
          if (key === 'size') {
            for (const { node, baseSec } of sizedDelays) node.delayTime.setTargetAtTime(baseSec * v, t, 0.05);
          } else if (key === 'decay') {
            // Stabilität: pro Tank-Hälfte wird decay ZWEIMAL angewandt
            // (decayGain1 + decayGain2), ein voller Umlauf (Hälfte A dann
            // B) also mit decay^4 statt (wie beim alten FDN) decay^1 --
            // für decay<1 ist decay^4 IMMER kleiner als decay, die Schleife
            // ist damit für jeden erlaubten decay-Wert noch konservativer
            // stabil als vorher, nicht knapper.
            for (const tank of tanks) for (const dg of tank.decayGains) dg.gain.setTargetAtTime(v, t, 0.02);
          } else if (key === 'damping') {
            for (const tank of tanks) for (const damp of tank.dampers) damp.setFreq(v, t, 0.02);
          } else if (key === 'mix') {
            dry.gain.setTargetAtTime(1 - v, t, 0.01);
            wet.gain.setTargetAtTime(v, t, 0.01);
          }
        },
        dispose() {
          input.disconnect(); output.disconnect(); dry.disconnect(); wet.disconnect();
          for (const d of diffusers) d.dispose();
          for (const tank of tanks) {
            for (const n of tank.disposables) { if (typeof n.dispose === 'function') n.dispose(); else n.disconnect(); }
          }
          for (const n of tapNodes) n.disconnect();
          leftSum.disconnect(); rightSum.disconnect(); merger.disconnect(); outLevel.disconnect();
        },
      };
    },
  },
  resonator: {
    name: 'Resonator',
    // ZWEI DynamicsCompressorNodes im Wet-Pfad hintereinander (Anreger-
    // Ducker unten + Sicherheits-Limiter, s. build()) -- doppelte
    // Zusatzlatenz gegenüber den anderen Kompressor-basierten Inserts.
    latencySec: DYNAMICS_COMPRESSOR_LATENCY_SEC * 2,
    // Kern (Anregung -> Resonanzkörper) ist jetzt eine echte Modal-
    // Synthese (s. faust/resonator.dsp, zu WebAssembly kompiliert und in
    // core/resonator-worklet.js eingebettet) statt der früheren 5-Band-
    // Delayline-Bank -- Nutzer-Feedback: "klingt immer noch nicht so
    // schön". 24 unabhängige Resonanz-Moden statt 5, mit individueller
    // (nicht mehr geteilter) Abklingzeit pro Mode -- hohe Moden klingen
    // automatisch schneller ab als tiefe, physikalisch korrekt, war mit
    // EINEM gemeinsamen Damping-Filter für alle 5 Bänder vorher nicht
    // abbildbar. Dafür entfallen die 5 einzeln bespielbaren Tune-Regler
    // (setBandTune/interval-Presets) -- bei 24 automatisch verteilten,
    // leicht inharmonischen Partialtönen ergibt "jeden einzeln von Hand
    // stimmen" keinen Sinn mehr, das war explizit der Sinn der
    // automatischen Verteilung (s. resonator.dsp).
    //
    // Anreger-Ducker + Sicherheits-Limiter (s. unten) bleiben UNVERÄNDERT
    // -- die bestehende, ausgiebig stresstestete Kette (s. weiter unten in
    // build()) funktioniert unabhängig davon, was dazwischenhängt.
    defaults: { pitch: 220, resonance: 0.6, damping: 8000, mix: 0.35, width: 0.5 },
    build(ctx, p) {
      const input = ctx.createGain();
      const output = ctx.createGain();
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      dry.gain.value = 1 - p.mix;
      wet.gain.value = p.mix;

      // Anreger-Ducker: anders als ein Bandpass-Filter würde ein Modal-
      // Resonator ein DAUERHAFTES Eingangssignal ständig weiter einfärben
      // statt eigenständig auszuklingen -- der Ducker lässt nur den
      // Anschlag (~30ms) fast unkomprimiert durch und drosselt den
      // gehaltenen Teil, damit der Resonanzkörper nach dem Anschlag
      // EIGENSTÄNDIG mit seiner eigenen Stimmung ausklingt.
      //
      // Schwelle/Ratio DEUTLICH milder als bei der alten Delayline-Bank
      // (dort -50dB/20:1) -- die alte Bank reagierte nur auf Energie NAHE
      // ihrer eigenen 5 Resonanzfrequenzen, praktisch unempfindlich
      // gegenüber der Klangfarbe der Anregung selbst. Die neue, breitbandige
      // 24-Moden-Synthese dagegen reagiert auf das GANZE Spektrum der
      // Anregung -- ein derart hartes Ducking (-50dB/20:1) presst ein
      // Anschlagssignal fast bis zur Rechteckwelle zusammen, deren massive
      // Obertöne die vielen hochfrequenten Moden weit über den normalen
      // Pegel hinaus anregten (gemessen: kurzzeitig >30x Übersteuerung vor
      // dem Sicherheits-Limiter). -24dB/4:1 lässt die Anschlagsdynamik viel
      // natürlicher durch, dämpft aber immer noch zuverlässig den
      // gehaltenen Teil eines Dauertons.
      const exciter = ctx.createDynamicsCompressor();
      exciter.threshold.value = -24;
      exciter.knee.value = 6;
      exciter.ratio.value = 4;
      exciter.attack.value = 0.03;
      exciter.release.value = 0.2;
      input.connect(exciter);

      // Stabile Anker-Nodes um den eigentlichen Resonanzkern -- der lädt
      // asynchron (s. ensureResonatorWorklet), coreIn/coreOut bleiben aber
      // von Anfang an dieselbe Node-Referenz, unabhängig davon, ob gerade
      // noch der transparente Platzhalter (direkte Verbindung) oder schon
      // der echte AudioWorkletNode dazwischenhängt. Gleiches Muster wie
      // die Damping-Filter-Platzhalter (makeOnePoleLowpass) und eq8s
      // headIn/tailOut.
      const coreIn = ctx.createGain();
      const coreOut = ctx.createGain();
      exciter.connect(coreIn);

      let resonatorNode = null;
      let placeholderConnected = false;
      let disposed = false;
      const connectPlaceholder = () => { coreIn.connect(coreOut); placeholderConnected = true; };
      const pushParams = (node) => {
        const t = ctx.currentTime;
        node.parameters.get('/resonator/pitch').setTargetAtTime(p.pitch, t, 0.001);
        node.parameters.get('/resonator/resonance').setTargetAtTime(p.resonance, t, 0.001);
        node.parameters.get('/resonator/damping').setTargetAtTime(p.damping, t, 0.001);
      };
      const swapInRealNode = () => {
        if (disposed) return;
        if (placeholderConnected) { coreIn.disconnect(coreOut); placeholderConnected = false; }
        resonatorNode = createResonatorNode(ctx);
        pushParams(resonatorNode);
        coreIn.connect(resonatorNode).connect(coreOut);
      };
      if (resonatorReady) {
        swapInRealNode();
      } else {
        connectPlaceholder();
        ensureResonatorWorklet(ctx).then((ok) => { if (ok) swapInRealNode(); });
      }

      // Stereo-Weite über einen klassischen Haas-Trick statt echter
      // Stereo-Ausgabe aus dem Faust-Patch (der Modal-Kern ist bewusst
      // mono -- ein zweiter, leicht verstimmter Kern für "echte" Breite
      // wäre doppelter Rechenaufwand für einen subtilen Unterschied):
      // ein Kanal bleibt unverzögert, der andere läuft durch eine winzige
      // (0..15ms) Verzögerung, per `width` gesteuert. Bei width=0 sind
      // beide Kanäle identisch (Delay=0 -> Bild kollabiert zu Mono), bei
      // width=1 ergibt sich ein hörbar breiteres Bild.
      const widenDelay = ctx.createDelay(0.02);
      widenDelay.delayTime.value = p.width * 0.015;
      coreOut.connect(widenDelay);
      const merger = ctx.createChannelMerger(2);
      coreOut.connect(merger, 0, 0);
      widenDelay.connect(merger, 0, 1);

      // limiter: unverändert aus der alten Bank -- eine dicht retriggerte/
      // stark resonierende Anregung kann kurzzeitig deutlich über den
      // Trockenpegel hinausschiessen, bevor die modeneigenen Abklingzeiten
      // greifen. Schwelle bewusst auf 0dB (Web-Audio-Maximum): ein
      // normaler gehaltener Ton bleibt praktisch unangetastet, nur
      // Ausreisser werden gezähmt.
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = 0;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.15;
      merger.connect(limiter);

      // Kompensiert den Lookahead BEIDER Kompressoren im Wet-Pfad (Anreger-
      // Ducker oben + Sicherheits-Limiter unten, je DYNAMICS_COMPRESSOR_
      // LATENCY_SEC) -- ohne Kompensation käme die trockene Kopie ~12ms VOR
      // der resonierten an, beim Mischen (mix<1) ein hörbares Kammfilter-
      // "Phasing".
      const dryDelay = makeDryCompensationDelay(ctx, DYNAMICS_COMPRESSOR_LATENCY_SEC * 2);
      input.connect(dryDelay).connect(dry).connect(output);
      limiter.connect(wet).connect(output);

      return {
        input, output,
        setParam(key, v) {
          const t = engine.now;
          if (key === 'pitch' || key === 'resonance' || key === 'damping') {
            if (resonatorNode) resonatorNode.parameters.get(`/resonator/${key}`).setTargetAtTime(v, t, 0.02);
          } else if (key === 'width') {
            widenDelay.delayTime.setTargetAtTime(v * 0.015, t, 0.02);
          } else if (key === 'mix') {
            dry.gain.setTargetAtTime(1 - v, t, 0.01);
            wet.gain.setTargetAtTime(v, t, 0.01);
          }
        },
        dispose() {
          disposed = true;
          input.disconnect(); output.disconnect(); dry.disconnect(); wet.disconnect();
          dryDelay.disconnect(); exciter.disconnect(); limiter.disconnect();
          coreIn.disconnect(); coreOut.disconnect(); widenDelay.disconnect(); merger.disconnect();
          resonatorNode?.disconnect();
        },
      };
    },
  },
  opto: {
    name: 'Opto Compressor',
    // Feste Zusatzlatenz des DynamicsCompressorNode-Lookaheads -- s.
    // Kommentar bei DEFS.comp.latencySec.
    latencySec: DYNAMICS_COMPRESSOR_LATENCY_SEC,
    // LA-2A-Tribut: EIN Hauptregler ("Peak Reduction", wie am echten Gerät)
    // statt eines Attack/Release/Knee-Vierersatzes -- Attack/Release/Knee
    // stehen FEST auf für optische Kompressoren typische, deutlich trägere/
    // weichere Werte als beim FET-Style-Compressor oben (echte T4-
    // Elektrolumineszenzzelle: ~10ms Attack, mehrstufiger Release mit langem
    // "Sag"-Schwanz -- hier als EIN repräsentativer Kompromisswert, kein
    // bit-genaues Bauteil-Modell, ehrlich als Tribut statt Emulation
    // gedacht). Limit/Compress ist der echte Zweistufen-Schalter des
    // Originals (Ratio ~20:1 vs. ~3:1, s. OPTO_MODES oben).
    defaults: { reduction: 0.4, gain: 0, mode: 'compress', mix: 1 },
    build(ctx, p) {
      const input = ctx.createGain();
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      dry.gain.value = 1 - p.mix;
      wet.gain.value = p.mix;

      const ATTACK = 0.01;
      const RELEASE = 0.5;
      const KNEE = 18;
      const node = ctx.createDynamicsCompressor();
      node.attack.value = ATTACK;
      node.release.value = RELEASE;
      node.knee.value = KNEE;
      node.ratio.value = (OPTO_MODES[p.mode] ?? OPTO_MODES.compress).ratio;
      // reduction (0..1) -> Threshold: verschiebt die Ansprechschwelle nach
      // unten, wie das Peak-Reduction-Poti am Original -- 0 = kaum Wirkung
      // (-4dB), 1 = tief in die Zelle getrieben (-40dB).
      node.threshold.value = -4 - p.reduction * 36;

      const makeup = ctx.createGain();
      makeup.gain.value = dbToLin(p.gain);

      // Kompensiert den Lookahead von node oben (s.
      // DYNAMICS_COMPRESSOR_LATENCY_SEC) -- sonst käme die trockene Kopie
      // ~6ms VOR der komprimierten an, beim Mischen (mix<1) ein hörbares
      // Kammfilter-"Phasing", am stärksten um mix=0.5.
      const dryDelay = makeDryCompensationDelay(ctx, DYNAMICS_COMPRESSOR_LATENCY_SEC);
      input.connect(dryDelay).connect(dry);
      input.connect(node);
      node.connect(makeup);
      makeup.connect(wet);
      const outSum = ctx.createGain();
      dry.connect(outSum);
      wet.connect(outSum);

      return {
        input, output: outSum,
        setParam(key, v) {
          const t = engine.now;
          if (key === 'reduction') node.threshold.setTargetAtTime(-4 - v * 36, t, 0.01);
          else if (key === 'gain') makeup.gain.setTargetAtTime(dbToLin(v), t, 0.01);
          else if (key === 'mode') node.ratio.setTargetAtTime((OPTO_MODES[v] ?? OPTO_MODES.compress).ratio, t, 0.01);
          else if (key === 'mix') {
            dry.gain.setTargetAtTime(1 - v, t, 0.01);
            wet.gain.setTargetAtTime(v, t, 0.01);
          }
        },
        // Gleiches GR-Meter wie beim FET-Compressor -- derselbe generische
        // Abgriff des nativen reduction-Werts, UI erkennt die Methode statt
        // des Typs (s. machine.js/insert-chain.js#startCompMeter).
        getReductionDb() { return node.reduction ?? 0; },
        dispose() {
          input.disconnect(); dry.disconnect(); wet.disconnect(); outSum.disconnect();
          dryDelay.disconnect(); node.disconnect(); makeup.disconnect();
        },
      };
    },
  },
  tape: {
    name: 'Tape Machine',
    // Feste Zusatzlatenz aus Sättigungs-Oversampling PLUS Wow/Flutter-
    // Grunddelay (s. WAVESHAPER_4X_LATENCY_SEC/TAPE_WOWFLUTTER_BASE_DELAY_SEC
    // oben) -- s. Kommentar bei DEFS.comp.latencySec.
    latencySec: WAVESHAPER_4X_LATENCY_SEC + TAPE_WOWFLUTTER_BASE_DELAY_SEC,
    // Vierteilige Kette wie ein echtes Bandgerät: Sättigung (Kopf-
    // Übersteuerung, s. makeTapeCurve oben) -> DC-Sperrfilter (die bewusst
    // asymmetrische Sättigungskurve könnte sonst einen Gleichspannungsanteil
    // einschleusen) -> Höhen-Rolloff (die Bandbreite eines Tonkopfs ist
    // physikalisch begrenzt, anders als ein digitaler Signalweg) -> Wow/
    // Flutter (Gleichlaufschwankung der Bandmaschine, über ein NICHT-
    // rekursives, moduliertes Delay -- der bewährt sichere Modulationsfall,
    // s. FM-Synth-Stresstest/Reverb-Kommentare, KEIN Feedback-Loop wie beim
    // Filter-Delay/Reverb, deshalb ohne deren Stabilitätsrisiko) -> Rauschen
    // (Band-Grundrauschen, konstant anliegend wie am echten Gerät, nicht
    // vom Eingang getriggert).
    defaults: { drive: 0.3, tone: 8000, wowFlutter: 0.3, hiss: 0.15, mix: 1 },
    build(ctx, p) {
      const input = ctx.createGain();
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      dry.gain.value = 1 - p.mix;
      wet.gain.value = p.mix;

      const shaper = ctx.createWaveShaper();
      shaper.oversample = '4x';
      shaper.curve = makeTapeCurve(p.drive);

      const dcBlock = ctx.createBiquadFilter();
      dcBlock.type = 'highpass';
      dcBlock.frequency.value = 20;
      dcBlock.Q.value = 0.7;

      const tone = ctx.createBiquadFilter();
      tone.type = 'lowpass';
      tone.Q.value = 0.7;
      tone.frequency.value = p.tone;

      // Wow (langsam, ~0.6Hz) + Flutter (schneller, ~7Hz) moduliertes Delay --
      // NICHT rekursiv, speist nur vorwärts in den Signalweg, keine
      // Rückkopplungsschleife. Basiswert s. TAPE_WOWFLUTTER_BASE_DELAY_SEC
      // oben -- knapp über dem grössten negativen Modulationshub
      // (wowFlutter=1: -0.7ms-0.25ms), damit die effektive Zusatzlatenz des
      // Effekts (der bei mix=1 direkt hörbar ist, s. Kompensations-
      // Kommentar unten) so klein wie ohne Clipping-Risiko möglich bleibt.
      const wfDelay = ctx.createDelay(0.05);
      wfDelay.delayTime.value = TAPE_WOWFLUTTER_BASE_DELAY_SEC;
      const wowLfo = ctx.createOscillator();
      wowLfo.type = 'sine';
      wowLfo.frequency.value = 0.6;
      const flutterLfo = ctx.createOscillator();
      flutterLfo.type = 'sine';
      flutterLfo.frequency.value = 7;
      const wowGain = ctx.createGain();
      const flutterGain = ctx.createGain();
      wowGain.gain.value = p.wowFlutter * 0.0007;
      flutterGain.gain.value = p.wowFlutter * 0.00025;
      wowLfo.connect(wowGain).connect(wfDelay.delayTime);
      flutterLfo.connect(flutterGain).connect(wfDelay.delayTime);
      wowLfo.start();
      flutterLfo.start();

      // Bandrauschen: konstant anliegend (wie am echten Gerät), nicht vom
      // Eingangssignal getriggert -- derselbe gecachte Rauschbuffer wie bei
      // den Drum-Synthesen (dsp.js#noise), hier in Dauerschleife.
      const hissSrc = ctx.createBufferSource();
      hissSrc.buffer = noise(ctx);
      hissSrc.loop = true;
      const hissGain = ctx.createGain();
      hissGain.gain.value = p.hiss * HISS_MAX_GAIN;
      hissSrc.connect(hissGain);
      hissSrc.start();

      // Kompensiert die STATISCHEN Zusatzlatenzen im Wet-Pfad: das 4x-
      // Oversampling des Shapers (WAVESHAPER_4X_LATENCY_SEC) PLUS die
      // Grundverzögerung des Wow/Flutter-Delays oben (TAPE_WOWFLUTTER_
      // BASE_DELAY_SEC; dessen eigene Modulation kommt on top --
      // absichtlich NICHT mitkompensiert: das leichte Schweben zwischen
      // Dry und Wet bei aufgedrehtem Wow/Flutter ist der beabsichtigte
      // Chorus-artige Bandmaschinen-Charakter, kein Fehler). Ohne diese
      // Basis-Kompensation wäre die trockene Kopie deutlich vor der
      // bearbeiteten, beim Mischen (mix<1) hörbares Kammfilter-"Phasing"
      // selbst bei wowFlutter=0 -- UND (unabhängig vom Mix-Regler) trägt
      // diese Summe bei mix=1 die volle Zusatzlatenz des Effekts gegenüber
      // dem Rest des Mixes, weshalb sie so klein wie möglich gehalten wird.
      const dryDelay = makeDryCompensationDelay(ctx, WAVESHAPER_4X_LATENCY_SEC + TAPE_WOWFLUTTER_BASE_DELAY_SEC);
      input.connect(dryDelay).connect(dry);
      input.connect(shaper);
      shaper.connect(dcBlock);
      dcBlock.connect(tone);
      tone.connect(wfDelay);
      wfDelay.connect(wet);
      hissGain.connect(wet);
      const outSum = ctx.createGain();
      dry.connect(outSum);
      wet.connect(outSum);

      // Kurve neu bauen ist teuer -- gleiches Entprellen wie DEFS.drive oben.
      let driveTimer = null;
      return {
        input, output: outSum,
        setParam(key, v) {
          const t = engine.now;
          if (key === 'drive') {
            clearTimeout(driveTimer);
            driveTimer = setTimeout(() => { shaper.curve = makeTapeCurve(v); }, 60);
          } else if (key === 'tone') tone.frequency.setTargetAtTime(v, t, 0.02);
          else if (key === 'wowFlutter') {
            wowGain.gain.setTargetAtTime(v * 0.0007, t, 0.05);
            flutterGain.gain.setTargetAtTime(v * 0.00025, t, 0.05);
          } else if (key === 'hiss') hissGain.gain.setTargetAtTime(v * HISS_MAX_GAIN, t, 0.05);
          else if (key === 'mix') {
            dry.gain.setTargetAtTime(1 - v, t, 0.01);
            wet.gain.setTargetAtTime(v, t, 0.01);
          }
        },
        dispose() {
          clearTimeout(driveTimer);
          input.disconnect(); dry.disconnect(); wet.disconnect(); outSum.disconnect();
          dryDelay.disconnect(); shaper.disconnect(); dcBlock.disconnect(); tone.disconnect(); wfDelay.disconnect();
          wowLfo.stop(); wowLfo.disconnect(); flutterLfo.stop(); flutterLfo.disconnect();
          wowGain.disconnect(); flutterGain.disconnect();
          hissSrc.stop(); hissSrc.disconnect(); hissGain.disconnect();
        },
      };
    },
  },
  chorus: {
    name: 'Chorus',
    // Zwei modulierte Delay-Leitungen, GEGENPHASIG angesteuert von EINER
    // einzigen LFO (Stimme 2 bekommt dieselbe LFO-Spannung nur mit -1
    // multipliziert) -- klassischer "Boss CE-1"-artiger Stereo-Chorus.
    // Bewusst KEINE zweite Oszillator-Instanz für die Phasenverschiebung
    // (der naheliegende erste Ansatz): zwei unabhängige Oszillatoren mit
    // zeitversetztem Start halten ihre relative Phase nur so lange exakt,
    // wie sich die Rate nie ändert -- bei jeder rate-Automation würde ihre
    // relative Phase graduell auseinanderlaufen (jeder Oszillator rundet
    // seinen eigenen internen Phasenzähler für sich). Eine einzelne LFO,
    // deren Signal einmal direkt und einmal invertiert abgegriffen wird,
    // bleibt dagegen IMMER exakt 180° versetzt, unabhängig von rate-
    // Änderungen -- kein Restrisiko, keine Sonderfallbehandlung nötig.
    //
    // Nicht rekursiv (kein Feedback) -- derselbe sichere Modulationsfall
    // wie das Tape-Machine-Wow/Flutter-Delay oben (s. dortigen Kommentar);
    // eine modulierte Delay-ZEIT innerhalb einer Rückkopplungsschleife wäre
    // dagegen der bei DEFS.reverb dokumentierte Instabilitätsfall.
    latencySec: CHORUS_BASE_DELAY_SEC,
    defaults: { rate: 0.8, depth: 0.5, width: 0.7, mix: 0.35 },
    build(ctx, p) {
      const input = ctx.createGain();
      const output = ctx.createGain();
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      dry.gain.value = 1 - p.mix;
      wet.gain.value = p.mix;

      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = p.rate;
      const depthGain = ctx.createGain();
      depthGain.gain.value = p.depth * CHORUS_MAX_DEPTH_SEC;
      const invert = ctx.createGain();
      invert.gain.value = -1;
      lfo.connect(depthGain);
      depthGain.connect(invert);
      lfo.start();

      const delayL = ctx.createDelay(CHORUS_BASE_DELAY_SEC + CHORUS_MAX_DEPTH_SEC + 0.002);
      delayL.delayTime.value = CHORUS_BASE_DELAY_SEC;
      const delayR = ctx.createDelay(CHORUS_BASE_DELAY_SEC + CHORUS_MAX_DEPTH_SEC + 0.002);
      delayR.delayTime.value = CHORUS_BASE_DELAY_SEC;
      depthGain.connect(delayL.delayTime);
      invert.connect(delayR.delayTime);

      const panL = ctx.createStereoPanner();
      const panR = ctx.createStereoPanner();
      panL.pan.value = -p.width;
      panR.pan.value = p.width;

      input.connect(delayL).connect(panL).connect(wet);
      input.connect(delayR).connect(panR).connect(wet);

      const dryDelay = makeDryCompensationDelay(ctx, CHORUS_BASE_DELAY_SEC);
      input.connect(dryDelay).connect(dry).connect(output);
      wet.connect(output);

      return {
        input, output,
        setParam(key, v) {
          const t = engine.now;
          if (key === 'rate') lfo.frequency.setTargetAtTime(v, t, 0.05);
          else if (key === 'depth') depthGain.gain.setTargetAtTime(v * CHORUS_MAX_DEPTH_SEC, t, 0.05);
          else if (key === 'width') {
            panL.pan.setTargetAtTime(-v, t, 0.02);
            panR.pan.setTargetAtTime(v, t, 0.02);
          } else if (key === 'mix') {
            dry.gain.setTargetAtTime(1 - v, t, 0.01);
            wet.gain.setTargetAtTime(v, t, 0.01);
          }
        },
        dispose() {
          lfo.stop(); lfo.disconnect();
          depthGain.disconnect(); invert.disconnect();
          delayL.disconnect(); delayR.disconnect(); panL.disconnect(); panR.disconnect();
          input.disconnect(); output.disconnect(); dry.disconnect(); wet.disconnect(); dryDelay.disconnect();
        },
      };
    },
  },
  phaser: {
    name: 'Phaser',
    // Sechs seriell geschaltete Allpass-Stufen (BiquadFilterNode, type
    // 'allpass') -- ihre Summe mit dem trockenen Signal erzeugt die
    // charakteristischen wandernden Kerben (Kammfilter durch Phasen-
    // auslöschung, NICHT durch Laufzeitunterschiede wie beim Chorus/
    // Flanger). Jede Stufe hat eine EIGENE Grundfrequenz (PHASER_STAGE_
    // FREQS, log gestaffelt über den Mittenbereich) und wird von DERSELBEN
    // LFO moduliert, aber mit einem zur jeweiligen Grundfrequenz
    // proportionalem Hub (additive AudioParam-Modulation, gleiche Technik
    // wie das Tape-Wow/Flutter oben) -- so bleibt der Sweep über alle
    // Stufen musikalisch zusammenhängend (Oktaven statt Hz-Schritte).
    //
    // Feedback (Resonanz) schliesst den Ausgang der letzten Stufe über
    // einen Weichbegrenzer (makeFeedbackClipCurve, gleiche Technik wie
    // DEFS.filterDelay/DEFS.reverb) zurück auf den Eingang der Kette.
    // Anders als eine modulierte DELAY-Zeit in einer Rückkopplungsschleife
    // (s. Instabilitäts-Kommentar bei DEFS.reverb) ist eine modulierte
    // FILTER-Frequenz hier unkritisch: ein Allpass hat per Definition bei
    // JEDER Koeffizientenwahl exakt |H(f)|=1 für alle f -- die Verstärkung
    // der Schleife ist also, unabhängig vom momentanen LFO-Stand, immer
    // exakt durch den feedback-Reglerwert selbst begrenzt (<=0.9), nie
    // höher. Trotzdem per Stresstest verifiziert (tools/dsp-tests/chorus-
    // phaser.mjs), nicht nur aus der Theorie angenommen.
    defaults: { rate: 0.3, depth: 0.6, feedback: 0.3, mix: 0.5 },
    build(ctx, p) {
      const input = ctx.createGain();
      const output = ctx.createGain();
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      dry.gain.value = 1 - p.mix;
      wet.gain.value = p.mix;

      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = p.rate;
      lfo.start();

      const stages = PHASER_STAGE_FREQS.map((freq) => {
        const filter = ctx.createBiquadFilter();
        filter.type = 'allpass';
        filter.frequency.value = freq;
        filter.Q.value = PHASER_STAGE_Q;
        const modGain = ctx.createGain();
        modGain.gain.value = freq * PHASER_DEPTH_FACTOR * p.depth;
        lfo.connect(modGain).connect(filter.frequency);
        return { filter, modGain, baseFreq: freq };
      });

      const stageInput = ctx.createGain();
      input.connect(stageInput);
      let node = stageInput;
      for (const stage of stages) { node.connect(stage.filter); node = stage.filter; }
      const chainOut = node;

      const feedbackGain = ctx.createGain();
      feedbackGain.gain.value = p.feedback;
      const feedbackClip = ctx.createWaveShaper();
      feedbackClip.curve = makeFeedbackClipCurve();
      feedbackClip.oversample = '2x';
      chainOut.connect(feedbackGain).connect(feedbackClip).connect(stageInput);

      input.connect(dry).connect(output);
      chainOut.connect(wet).connect(output);

      return {
        input, output,
        setParam(key, v) {
          const t = engine.now;
          if (key === 'rate') lfo.frequency.setTargetAtTime(v, t, 0.05);
          else if (key === 'depth') {
            for (const stage of stages) stage.modGain.gain.setTargetAtTime(stage.baseFreq * PHASER_DEPTH_FACTOR * v, t, 0.05);
          } else if (key === 'feedback') feedbackGain.gain.setTargetAtTime(v, t, 0.02);
          else if (key === 'mix') {
            dry.gain.setTargetAtTime(1 - v, t, 0.01);
            wet.gain.setTargetAtTime(v, t, 0.01);
          }
        },
        dispose() {
          lfo.stop(); lfo.disconnect();
          for (const stage of stages) { stage.filter.disconnect(); stage.modGain.disconnect(); }
          stageInput.disconnect(); feedbackGain.disconnect(); feedbackClip.disconnect();
          input.disconnect(); output.disconnect(); dry.disconnect(); wet.disconnect();
        },
      };
    },
  },
  gate: {
    name: 'Gate',
    // Web Audio kennt kein natives Gate/Expander-Node (DynamicsCompressorNode
    // kann nur LAUTE Signale dämpfen, nie LEISE -- die entgegengesetzte
    // Dynamikrichtung) -- braucht darum einen eigenen Hüllkurvenfolger +
    // Schwellenvergleich, s. gate-worklet.js. Gleiches Lazy-Lade-/
    // Platzhalter-Muster wie der Resonator-Worklet oben: bis das Modul
    // geladen ist, läuft das Signal unverändert durch (transparent statt
    // stumm) -- ein Gate, das während des Ladens die Musik verschluckt,
    // wäre schlimmer als kurzzeitig gar keine Wirkung zu haben.
    defaults: { threshold: -40, attack: 0.005, release: 0.15, range: -60, mix: 1 },
    build(ctx, p) {
      const input = ctx.createGain();
      const output = ctx.createGain();
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      dry.gain.value = 1 - p.mix;
      wet.gain.value = p.mix;

      const coreIn = ctx.createGain();
      const coreOut = ctx.createGain();
      let gateNode = null;
      let placeholderConnected = false;
      let disposed = false;
      const connectPlaceholder = () => { coreIn.connect(coreOut); placeholderConnected = true; };
      const pushParams = (node) => {
        const t = ctx.currentTime;
        node.parameters.get('threshold').setTargetAtTime(p.threshold, t, 0.001);
        node.parameters.get('attack').setTargetAtTime(p.attack, t, 0.001);
        node.parameters.get('release').setTargetAtTime(p.release, t, 0.001);
        node.parameters.get('range').setTargetAtTime(p.range, t, 0.001);
      };
      const swapInRealNode = () => {
        if (disposed) return;
        if (placeholderConnected) { coreIn.disconnect(coreOut); placeholderConnected = false; }
        gateNode = new AudioWorkletNode(ctx, 'rackwerk-gate', { numberOfInputs: 1, numberOfOutputs: 1 });
        pushParams(gateNode);
        coreIn.connect(gateNode).connect(coreOut);
      };
      if (simpleWorkletReady('rackwerk-gate')) {
        swapInRealNode();
      } else {
        connectPlaceholder();
        ensureSimpleWorklet(ctx, 'rackwerk-gate', GATE_WORKLET_SRC).then((ok) => { if (ok) swapInRealNode(); });
      }

      input.connect(coreIn);
      coreOut.connect(wet).connect(output);
      input.connect(dry).connect(output);

      return {
        input, output,
        setParam(key, v) {
          const t = engine.now;
          if (key === 'threshold' || key === 'attack' || key === 'release' || key === 'range') {
            if (gateNode) gateNode.parameters.get(key).setTargetAtTime(v, t, 0.02);
          } else if (key === 'mix') {
            dry.gain.setTargetAtTime(1 - v, t, 0.01);
            wet.gain.setTargetAtTime(v, t, 0.01);
          }
        },
        dispose() {
          disposed = true;
          input.disconnect(); output.disconnect(); dry.disconnect(); wet.disconnect();
          coreIn.disconnect(); coreOut.disconnect();
          gateNode?.disconnect();
        },
      };
    },
  },
  freqShift: {
    name: 'Frequency Shifter',
    // ECHTE Frequenzverschiebung (alle Teiltöne um denselben Hz-Betrag
    // verschoben, dadurch inharmonisch/"glockig"), nicht zu verwechseln mit
    // Pitch-Shifting -- s. freqshift-worklet.js für die Hilbert-Transform-/
    // Einseitenband-Herleitung. Gleiches Lazy-Lade-/Platzhalter-Muster wie
    // Gate/Resonator oben.
    defaults: { shift: 150, mix: 0.5 },
    build(ctx, p) {
      const input = ctx.createGain();
      const output = ctx.createGain();
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      dry.gain.value = 1 - p.mix;
      wet.gain.value = p.mix;

      const coreIn = ctx.createGain();
      const coreOut = ctx.createGain();
      let shiftNode = null;
      let placeholderConnected = false;
      let disposed = false;
      const connectPlaceholder = () => { coreIn.connect(coreOut); placeholderConnected = true; };
      const swapInRealNode = () => {
        if (disposed) return;
        if (placeholderConnected) { coreIn.disconnect(coreOut); placeholderConnected = false; }
        shiftNode = new AudioWorkletNode(ctx, 'rackwerk-freqshift', { numberOfInputs: 1, numberOfOutputs: 1 });
        shiftNode.parameters.get('shift').setTargetAtTime(p.shift, ctx.currentTime, 0.001);
        coreIn.connect(shiftNode).connect(coreOut);
      };
      if (simpleWorkletReady('rackwerk-freqshift')) {
        swapInRealNode();
      } else {
        connectPlaceholder();
        ensureSimpleWorklet(ctx, 'rackwerk-freqshift', FREQSHIFT_WORKLET_SRC).then((ok) => { if (ok) swapInRealNode(); });
      }

      input.connect(coreIn);
      coreOut.connect(wet).connect(output);
      input.connect(dry).connect(output);

      return {
        input, output,
        setParam(key, v) {
          const t = engine.now;
          if (key === 'shift') {
            if (shiftNode) shiftNode.parameters.get('shift').setTargetAtTime(v, t, 0.02);
          } else if (key === 'mix') {
            dry.gain.setTargetAtTime(1 - v, t, 0.01);
            wet.gain.setTargetAtTime(v, t, 0.01);
          }
        },
        dispose() {
          disposed = true;
          input.disconnect(); output.disconnect(); dry.disconnect(); wet.disconnect();
          coreIn.disconnect(); coreOut.disconnect();
          shiftNode?.disconnect();
        },
      };
    },
  },
  vocoder: {
    name: 'Vocoder',
    // Klassische Bode/Dudley-Vocoder-Architektur: das Eingangssignal
    // (Modulator, z. B. eine Stimme) wird in VOCODER_BANDS.length Bänder
    // zerlegt (Bandpass), jedes Band gleichgerichtet (WaveShaper, s.
    // getVocoderAbsCurve) und geglättet (derselbe 1-Pol-Tiefpass-Worklet
    // wie Reverb-Damping/Resonator, s. makeOnePoleLowpass) -- die
    // resultierende Hüllkurve moduliert direkt die Lautstärke des JEWEILS
    // GLEICHEN Bandpass-Bands, aber angewandt auf einen EINGEBAUTEN
    // Carrier-Oszillator (Sägezahn + etwas Rauschen, s. VOCODER_NOISE_MIX)
    // statt auf ein zweites, extern angeschlossenes Signal -- ein "echter"
    // Vocoder mit externem Carrier (z. B. ein Synth-Sound, den die Stimme
    // moduliert) bräuchte eine Sidechain-Routing-Infrastruktur, die es in
    // RackWerk noch nirgends gibt; der eingebaute Carrier liefert sofort
    // den klassischen "Roboterstimme"-Vocoder-Sound ohne neue Architektur.
    defaults: { carrierPitch: 110, response: 25, mix: 0.7 },
    build(ctx, p) {
      const input = ctx.createGain();
      const output = ctx.createGain();
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      dry.gain.value = 1 - p.mix;
      wet.gain.value = p.mix;

      const carrierOsc = ctx.createOscillator();
      carrierOsc.type = 'sawtooth';
      carrierOsc.frequency.value = p.carrierPitch;
      carrierOsc.start();
      const carrierNoise = ctx.createBufferSource();
      carrierNoise.buffer = noise(ctx);
      carrierNoise.loop = true;
      const noiseGain = ctx.createGain();
      noiseGain.gain.value = VOCODER_NOISE_MIX;
      carrierNoise.connect(noiseGain);
      carrierNoise.start();
      const carrierSum = ctx.createGain();
      carrierOsc.connect(carrierSum);
      noiseGain.connect(carrierSum);

      const wetSum = ctx.createGain();
      const absCurve = getVocoderAbsCurve();
      const bands = VOCODER_BANDS.map((freq) => {
        const analysis = ctx.createBiquadFilter();
        analysis.type = 'bandpass';
        analysis.frequency.value = freq;
        analysis.Q.value = VOCODER_BAND_Q;
        input.connect(analysis);

        const rectify = ctx.createWaveShaper();
        rectify.curve = absCurve;
        analysis.connect(rectify);

        const analysisGain = ctx.createGain();
        analysisGain.gain.value = VOCODER_ANALYSIS_GAIN;
        rectify.connect(analysisGain);

        const envelope = makeOnePoleLowpass(ctx, p.response);
        analysisGain.connect(envelope.input);

        const carrierFilter = ctx.createBiquadFilter();
        carrierFilter.type = 'bandpass';
        carrierFilter.frequency.value = freq;
        carrierFilter.Q.value = VOCODER_BAND_Q;
        carrierSum.connect(carrierFilter);

        const bandGain = ctx.createGain();
        bandGain.gain.value = 0;
        envelope.output.connect(bandGain.gain);
        carrierFilter.connect(bandGain);
        bandGain.connect(wetSum);

        return { analysis, rectify, analysisGain, envelope, carrierFilter, bandGain };
      });

      const outLevel = ctx.createGain();
      outLevel.gain.value = VOCODER_OUT_LEVEL;
      wetSum.connect(outLevel);

      input.connect(dry).connect(output);
      outLevel.connect(wet).connect(output);

      return {
        input, output,
        setParam(key, v) {
          const t = engine.now;
          if (key === 'carrierPitch') carrierOsc.frequency.setTargetAtTime(v, t, 0.02);
          else if (key === 'response') {
            for (const band of bands) band.envelope.setFreq(v, t, 0.02);
          } else if (key === 'mix') {
            dry.gain.setTargetAtTime(1 - v, t, 0.01);
            wet.gain.setTargetAtTime(v, t, 0.01);
          }
        },
        dispose() {
          input.disconnect(); output.disconnect(); dry.disconnect(); wet.disconnect();
          carrierOsc.stop(); carrierOsc.disconnect();
          carrierNoise.stop(); carrierNoise.disconnect();
          noiseGain.disconnect(); carrierSum.disconnect(); wetSum.disconnect(); outLevel.disconnect();
          for (const band of bands) {
            band.analysis.disconnect(); band.rectify.disconnect(); band.analysisGain.disconnect();
            band.envelope.dispose(); band.carrierFilter.disconnect(); band.bandGain.disconnect();
          }
        },
      };
    },
  },
  beatRepeat: {
    name: 'Beat Repeat',
    // Tempo-synchrones Stottern/Wiederholen einer live gespielten Scheibe
    // (wie Abletons "Beat Repeat") -- s. beatrepeat-worklet.js für die
    // Chance-/Decay-Semantik. IMMER tempo-synchron (anders als Filter
    // Delay: kein 'free'-Sekunden-Modus) -- "Grid" ist bei Beat Repeat
    // konzeptionell immer ein Notenwert, nie eine freie Zeit.
    defaults: { division: '1/16', chance: 0.35, decay: 0.3, mix: 1 },
    build(ctx, p) {
      const input = ctx.createGain();
      const output = ctx.createGain();
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      dry.gain.value = 1 - p.mix;
      wet.gain.value = p.mix;

      const coreIn = ctx.createGain();
      const coreOut = ctx.createGain();
      let repeatNode = null;
      let placeholderConnected = false;
      let disposed = false;
      const connectPlaceholder = () => { coreIn.connect(coreOut); placeholderConnected = true; };
      const computeIntervalSec = () => transport.stepDuration * 4 * (DELAY_SYNC_DIVISIONS[p.division] ?? 0.25);
      const applyInterval = () => {
        if (repeatNode) repeatNode.parameters.get('intervalSec').setTargetAtTime(computeIntervalSec(), ctx.currentTime, 0.001);
      };
      const pushParams = (node) => {
        const t = ctx.currentTime;
        node.parameters.get('intervalSec').setTargetAtTime(computeIntervalSec(), t, 0.001);
        node.parameters.get('chance').setTargetAtTime(p.chance, t, 0.001);
        node.parameters.get('decay').setTargetAtTime(p.decay, t, 0.001);
      };
      const swapInRealNode = () => {
        if (disposed) return;
        if (placeholderConnected) { coreIn.disconnect(coreOut); placeholderConnected = false; }
        repeatNode = new AudioWorkletNode(ctx, 'rackwerk-beatrepeat', { numberOfInputs: 1, numberOfOutputs: 1 });
        pushParams(repeatNode);
        coreIn.connect(repeatNode).connect(coreOut);
      };
      if (simpleWorkletReady('rackwerk-beatrepeat')) {
        swapInRealNode();
      } else {
        connectPlaceholder();
        ensureSimpleWorklet(ctx, 'rackwerk-beatrepeat', BEATREPEAT_WORKLET_SRC).then((ok) => { if (ok) swapInRealNode(); });
      }

      const bpmListener = { onTransport(event) { if (event === 'bpm') applyInterval(); } };
      transport.addListener(bpmListener);

      input.connect(coreIn);
      coreOut.connect(wet).connect(output);
      input.connect(dry).connect(output);

      return {
        input, output,
        setParam(key, v) {
          const t = engine.now;
          if (key === 'division') applyInterval();
          else if (key === 'chance') { if (repeatNode) repeatNode.parameters.get('chance').setTargetAtTime(v, t, 0.02); }
          else if (key === 'decay') { if (repeatNode) repeatNode.parameters.get('decay').setTargetAtTime(v, t, 0.02); }
          else if (key === 'mix') {
            dry.gain.setTargetAtTime(1 - v, t, 0.01);
            wet.gain.setTargetAtTime(v, t, 0.01);
          }
        },
        dispose() {
          disposed = true;
          transport.removeListener(bpmListener);
          input.disconnect(); output.disconnect(); dry.disconnect(); wet.disconnect();
          coreIn.disconnect(); coreOut.disconnect();
          repeatNode?.disconnect();
        },
      };
    },
  },
  bitcrush: {
    name: 'Bitcrusher',
    // Sample-Rate-/Bit-Reduktion (wie Abletons "Redux") -- s.
    // bitcrush-worklet.js für die Sample&Hold-/Quantisierungs-Herleitung
    // und warum hier BEWUSST keine Anti-Aliasing-Filterung stattfindet
    // (das Aliasing IST der gewünschte Lo-Fi-Effekt). Gleiches Lazy-Lade-/
    // Platzhalter-Muster wie Gate/Frequency Shifter/Beat Repeat oben.
    defaults: { rate: 8000, bits: 8, jitter: 0, mix: 1 },
    build(ctx, p) {
      const input = ctx.createGain();
      const output = ctx.createGain();
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      dry.gain.value = 1 - p.mix;
      wet.gain.value = p.mix;

      const coreIn = ctx.createGain();
      const coreOut = ctx.createGain();
      let crushNode = null;
      let placeholderConnected = false;
      let disposed = false;
      const connectPlaceholder = () => { coreIn.connect(coreOut); placeholderConnected = true; };
      const pushParams = (node) => {
        const t = ctx.currentTime;
        node.parameters.get('rate').setTargetAtTime(p.rate, t, 0.001);
        node.parameters.get('bits').setTargetAtTime(p.bits, t, 0.001);
        node.parameters.get('jitter').setTargetAtTime(p.jitter, t, 0.001);
      };
      const swapInRealNode = () => {
        if (disposed) return;
        if (placeholderConnected) { coreIn.disconnect(coreOut); placeholderConnected = false; }
        crushNode = new AudioWorkletNode(ctx, 'rackwerk-bitcrush', { numberOfInputs: 1, numberOfOutputs: 1 });
        pushParams(crushNode);
        coreIn.connect(crushNode).connect(coreOut);
      };
      if (simpleWorkletReady('rackwerk-bitcrush')) {
        swapInRealNode();
      } else {
        connectPlaceholder();
        ensureSimpleWorklet(ctx, 'rackwerk-bitcrush', BITCRUSH_WORKLET_SRC).then((ok) => { if (ok) swapInRealNode(); });
      }

      input.connect(coreIn);
      coreOut.connect(wet).connect(output);
      input.connect(dry).connect(output);

      return {
        input, output,
        setParam(key, v) {
          const t = engine.now;
          if (key === 'rate' || key === 'bits' || key === 'jitter') {
            if (crushNode) crushNode.parameters.get(key).setTargetAtTime(v, t, 0.02);
          } else if (key === 'mix') {
            dry.gain.setTargetAtTime(1 - v, t, 0.01);
            wet.gain.setTargetAtTime(v, t, 0.01);
          }
        },
        dispose() {
          disposed = true;
          input.disconnect(); output.disconnect(); dry.disconnect(); wet.disconnect();
          coreIn.disconnect(); coreOut.disconnect();
          crushNode?.disconnect();
        },
      };
    },
  },
  geq: {
    name: 'Graphic EQ',
    // 10 feste Bänder (Oktavabstand, s. GEQ_FREQS oben) -- anders als das
    // parametrische 'eq' (frei positionierbar) oder 'eq8' (8 frei
    // positionierbare Bänder mit Touch-Graph) hier eine reine Balkenreihe
    // wie am Hardware-Vorbild: pro Band nur ein Gain-Regler, Frequenz/Q
    // liegen fest.
    defaults: { bands: GEQ_FREQS.map(() => 0) },
    build(ctx, p) {
      const nodes = GEQ_FREQS.map((freq, i) => {
        const node = ctx.createBiquadFilter();
        node.type = 'peaking';
        node.frequency.value = freq;
        node.Q.value = GEQ_Q;
        node.gain.value = p.bands[i] ?? 0;
        return node;
      });
      for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);

      return {
        input: nodes[0],
        output: nodes[nodes.length - 1],
        // Läuft komplett über setBandGain -- gleiches Muster wie setBand
        // beim 8-Band-EQ (der generische setParam(key,value) kennt nur "ein
        // Feld", nicht "ein Feld eines von 10 Bändern").
        setParam() {},
        setBandGain(i, v) {
          p.bands[i] = v;
          nodes[i]?.gain.setTargetAtTime(v, engine.now, 0.01);
        },
        dispose() { nodes.forEach((n) => n.disconnect()); },
      };
    },
  },
  limiter: {
    name: 'Limiter',
    // Feste Zusatzlatenz des DynamicsCompressorNode-Lookaheads -- s.
    // Kommentar bei DEFS.comp.latencySec.
    latencySec: DYNAMICS_COMPRESSOR_LATENCY_SEC,
    // Bewusst NICHT dieselbe Rolle wie engine.limiter (audio-engine.js) --
    // jener ist ein unsichtbares App-weites Sicherheitsnetz direkt vor
    // ctx.destination, nie eingestellt/gesehen. Dieser Insert ist ein
    // bewusst eingesetztes, sichtbares Mastering-Werkzeug (klassischer
    // "Brickwall"-Loudness-Limiter): schnellerer, fester Attack und härterer,
    // fester Knee als der 1176-Style-Compressor oben (der stattdessen
    // Ratio-MODI statt eines Ceilings anbietet).
    defaults: { inputGain: 0, ceiling: -0.5, release: 0.05, mix: 1 },
    build(ctx, p) {
      const input = ctx.createGain();
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      dry.gain.value = 1 - p.mix;
      wet.gain.value = p.mix;

      const inputGain = ctx.createGain();
      inputGain.gain.value = dbToLin(p.inputGain);
      const ATTACK = 0.001;
      const RATIO = 20;
      const KNEE = 0;
      const node = ctx.createDynamicsCompressor();
      node.attack.value = ATTACK;
      node.ratio.value = RATIO;
      node.knee.value = KNEE;
      node.release.value = p.release;
      node.threshold.value = p.ceiling;

      // Kompensiert den Lookahead von node oben (s.
      // DYNAMICS_COMPRESSOR_LATENCY_SEC) -- sonst käme die trockene Kopie
      // ~6ms VOR der limitierten an, beim Mischen (mix<1) ein hörbares
      // Kammfilter-"Phasing", am stärksten um mix=0.5.
      const dryDelay = makeDryCompensationDelay(ctx, DYNAMICS_COMPRESSOR_LATENCY_SEC);
      input.connect(dryDelay).connect(dry);
      input.connect(inputGain);
      inputGain.connect(node);
      node.connect(wet);
      const outSum = ctx.createGain();
      dry.connect(outSum);
      wet.connect(outSum);

      return {
        input, output: outSum,
        setParam(key, v) {
          const t = engine.now;
          if (key === 'inputGain') inputGain.gain.setTargetAtTime(dbToLin(v), t, 0.01);
          else if (key === 'ceiling') node.threshold.setTargetAtTime(v, t, 0.01);
          else if (key === 'release') node.release.setTargetAtTime(v, t, 0.01);
          else if (key === 'mix') {
            dry.gain.setTargetAtTime(1 - v, t, 0.01);
            wet.gain.setTargetAtTime(v, t, 0.01);
          }
        },
        getReductionDb() { return node.reduction ?? 0; },
        dispose() {
          input.disconnect(); dry.disconnect(); wet.disconnect(); outSum.disconnect();
          dryDelay.disconnect(); inputGain.disconnect(); node.disconnect();
        },
      };
    },
  },
};

export const INSERT_TYPES = Object.keys(DEFS);
export function insertMeta(type) {
  return { name: DEFS[type].name, defaults: { ...DEFS[type].defaults } };
}

/** Gruppierung der Insert-Typen für den "+ Insert Effect"-Picker (s.
 *  ui/insert-chain.js#openInsertPicker) -- rein kosmetisch/für die Übersicht,
 *  KEIN Ersatz für INSERT_TYPES (das bleibt die vollständige, unsortierte
 *  Liste aus DEFS-Schlüsseln, z. B. für insertChainLatencySec()). Bei jedem
 *  neuen Insert-Typ MUSS er hier in genau einer Kategorie auftauchen --
 *  sonst fehlt er im Picker (s. Sanity-Check gleich unten).
 *
 * Reihenfolge der Kategorien selbst ist ebenfalls bewusst gewählt: die
 * "Werkzeug"-artigen Effekte (Dynamik, EQ) zuerst, die "Charakter"-artigen
 * (Modulation, Zeit-basiert, Sättigung, exotische Klangerzeugung) danach --
 * ungefähr dieselbe Reihenfolge, in der ein Insert-Chain typischerweise
 * aufgebaut wird. */
export const INSERT_CATEGORIES = [
  { label: 'Dynamics', types: ['comp', 'opto', 'limiter', 'gate'] },
  { label: 'EQ & Filter', types: ['eq', 'eq8', 'geq'] },
  { label: 'Modulation', types: ['chorus', 'phaser'] },
  { label: 'Delay & Reverb', types: ['filterDelay', 'reverb', 'beatRepeat'] },
  { label: 'Saturation & Lo-Fi', types: ['drive', 'tape', 'bitcrush'] },
  { label: 'Spectral & Synthesis', types: ['resonator', 'freqShift', 'vocoder'] },
];
// Sanity-Check (entwicklungszeitlich, kein Laufzeitrisiko in Produktion):
// jeder INSERT_TYPES-Eintrag muss in GENAU einer Kategorie vorkommen --
// sonst würde ein neuer Insert-Typ im Picker stillschweigend fehlen.
{
  const categorized = INSERT_CATEGORIES.flatMap((c) => c.types);
  const missing = INSERT_TYPES.filter((t) => !categorized.includes(t));
  const extra = categorized.filter((t) => !INSERT_TYPES.includes(t));
  if (missing.length || extra.length) {
    console.error('INSERT_CATEGORIES ist nicht deckungsgleich mit INSERT_TYPES -- fehlend:', missing, 'überzählig:', extra);
  }
}

/** Frontplatten-Farbe je Insert-Typ — dieselbe --m-color-Mechanik wie bei
 *  den Maschinen, macht jedes Modul auf einen Blick unterscheidbar. */
export const INSERT_COLORS = {
  comp: '#e8b84b',   // FET-Kompressor: Messing/Gold, wie ein 1176
  eq: '#4fd1a5',     // Rack-EQ: kühles Teal
  eq8: '#5ec8e0',    // 8-Band-EQ: helles Cyan, deutlich von der Teal-Farbe des Einzelband-EQ abgesetzt
  drive: '#e8643f',  // Sättigung: warmes Glühen
  filterDelay: '#6f9ceb', // Delay: kühles Blau, wie ein Tape-/Digital-Delay-Rack
  reverb: '#a888e0', // Reverb: Violett, wie ein Hall-/Space-Rack
  resonator: '#e0c840', // Resonator: Messing/Glockenspiel-Gelb, wie angeschlagenes Metall
  opto: '#c9a0e0',   // Opto-Kompressor: sanftes Lavendel, deutlich vom Messing/Gold des FET-Comp abgesetzt
  tape: '#d99a5b',   // Tape Machine: warmes Sepia/Rostbraun, wie altes Bandmaterial
  geq: '#7fd9c4',    // Graphic EQ: helles Türkis, von eq/eq8's Teal/Cyan abgesetzt
  limiter: '#e0555f', // Limiter: warnendes Rot -- hartes Ceiling-Werkzeug
  chorus: '#7fb8e0', // Chorus: kühles Himmelblau, deutlich vom Delay-Blau abgesetzt
  phaser: '#e07fc0', // Phaser: Magenta/Pink, wie ein klassisches Modulations-Pedal
  gate: '#8fa0b0',   // Gate: nüchternes Grau-Blau, wie ein technisches Dynamik-Werkzeug
  freqShift: '#5ee0b0', // Frequency Shifter: kühles Türkis-Grün, exotisch/unharmonisch wirkend
  vocoder: '#c0e05e', // Vocoder: giftiges Gelb-Grün, wie eine klassische Roboterstimme
  beatRepeat: '#e08f5e', // Beat Repeat: warmes Orange, Performance-/Glitch-Charakter
  bitcrush: '#9ae05e', // Bitcrusher: schrilles Lime-Grün, wie ein 8-Bit-Retro-Gerät
};

/** UI-Metadaten je Parameter (Label/Bereich/Kurve/Einheit) — getrennt von
 *  den DSP-Defaults, weil die UI mehr wissen muss als der Audiograph. */
export const UI_PARAMS = {
  comp: [
    { key: 'input', label: 'Input', min: -20, max: 20, unit: 'dB' },
    { key: 'attack', label: 'Attack', min: 0.0002, max: 0.5, curve: 'log', unit: 's' },
    { key: 'release', label: 'Release', min: 0.02, max: 1, curve: 'log', unit: 's' },
    { key: 'output', label: 'Output', min: -20, max: 20, unit: 'dB' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, unit: '' },
  ],
  eq: [
    { key: 'freq', label: 'Freq', min: 20, max: 20000, curve: 'log', unit: 'Hz' },
    { key: 'gain', label: 'Gain', min: -24, max: 24, unit: 'dB' },
    { key: 'q', label: 'Q', min: 0.1, max: 10, curve: 'log', unit: '' },
  ],
  drive: [
    { key: 'drive', label: 'Drive', min: 0, max: 1, unit: '' },
    { key: 'base', label: 'Base', min: -1, max: 1, unit: '' },
    { key: 'tone', label: 'Tone', min: 0, max: 1, unit: '' },
    { key: 'level', label: 'Level', min: 0, max: 2, unit: '' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, unit: '' },
  ],
  filterDelay: [
    { key: 'time', label: 'Time', min: 0.01, max: 1.5, curve: 'log', unit: 's' },
    // War früher auf 0.8 gedeckelt (Filter-Überhöhung bei lowpass/highpass
    // nahe der Cutoff-Frequenz, ~1.15-1.22x, liess die Schleife sonst
    // unbegrenzt aufschaukeln, s. alte Fassung dieses Kommentars in der
    // Git-History). Jetzt durch einen tanh-Weichbegrenzer IN der Feedback-
    // Schleife (s. makeFeedbackClipCurve()/DEFS.filterDelay) sicher bis 0.9
    // anhebbar -- per Stresstest verifiziert (dichte Retriggerung über
    // Feedback x Filtertyp x Filterfrequenz x Zeit x PingPong, 72 Kombina-
    // tionen). WICHTIG: "sicher" heisst hier "schaukelt nicht mehr
    // unbegrenzt auf" (bounded), NICHT "Spitzenpegel bleibt immer <= 1.0" --
    // am ungünstigsten Punkt (sehr kurze Zeit nahe dem Minimum + lowpass/
    // highpass nahe einer Resonanzspitze) wurden Spitzenpegel bis ~1.75
    // gemessen, klar über 1.0, aber STABIL (10s-Dauertest praktisch gleicher
    // Wert wie 4s, kein weiteres Wachstum) -- der App-weite Master-Limiter
    // fängt das am Ende der Kette ab. bandpass war in JEDER getesteten
    // Kombination unauffällig (< 0.6 Spitzenpegel), da bandpass laut
    // Web-Audio-Spezifikation keine Überhöhung kennt (s. Kommentar bei
    // DEFS.resonator). Ein Versuch, den Weichbegrenzer selbst schärfer zu
    // stimmen (tanh(1.6x) statt tanh(x)), verschlimmerte die Extremfälle
    // deutlich (Spitzen bis 2.8) statt sie zu verbessern -- die zusätzlichen
    // Oberwellen der schärferen Kurve regen die Filterresonanz offenbar
    // zusätzlich an. tanh(x) unnormalisiert war die bessere Wahl.
    { key: 'feedback', label: 'Feedback', min: 0, max: 0.9, unit: '' },
    { key: 'filterFreq', label: 'Filter', min: 200, max: 8000, curve: 'log', unit: 'Hz' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, unit: '' },
    // Nur bei Tempo-Sync sinnvoll (s. DEFS.filterDelay#computeSwingShift) --
    // wie 'time' oben wird sie in insert-chain.js abhängig von `division`
    // ein-/ausgeblendet, nur mit umgekehrter Bedingung.
    { key: 'swing', label: 'Swing', min: 50, max: 75, unit: '%' },
  ],
  reverb: [
    { key: 'size', label: 'Size', min: 0.3, max: 3, curve: 'log', unit: '' },
    // Deutlich enger gedeckelt als beim alten Hadamard-FDN (dort bis 0.9
    // sauber, s. git-history) -- die Dattorro-"Figure-8"-Tank-Topologie hat
    // KEINE orthogonale Mischmatrix, die dem Netzwerk beweisbar für JEDE
    // Parameter-Kombination Energieerhaltung garantiert; stattdessen sitzen
    // hier zwei sich gegenseitig speisende Allpässe (modAp/ap5), die JEDER
    // FÜR SICH zwar stabil sind, deren KOMBINIERTE Phasenantwort aber bei
    // bestimmten (unregelmässig verteilten, nicht einfach vorhersagbaren)
    // Decay/Damping/Size-Kombinationen resonant aufschaukeln kann -- per
    // Sweep gemessen: schon ab decay=0.5 traten bei manchen Damping-Werten
    // Aufschaukel-Effekte auf (kein sauberes Abklingen mehr, teils bis zum
    // Clip-Limiter). Ein WaveShaper-Begrenzer an der Kreuzkopplung (s.
    // feedbackClipCurve in DEFS.reverb.build()) fängt das zwar SICHER ab
    // (kein Absturz/Infinity/NaN mehr möglich), verhindert aber nicht ein
    // hörbares, lautes "Hängenbleiben" bei zu hohem Decay -- 0.4 ist per
    // Sweep über den GESAMTEN Damping-Bereich (500-15000Hz) UND Size-Bereich
    // (0.3-3) sowie zusätzlich per dichter Retrigger-Stresstest an den
    // Extrem-Ecken (kürzeste/längste Size x wenigste/meiste Dämpfung)
    // durchgehend sauber bestätigt -- mit spürbarem Abstand zum ersten
    // beobachteten Aufschaukeln bei 0.5.
    { key: 'decay', label: 'Decay', min: 0, max: 0.4, unit: '' },
    { key: 'damping', label: 'Damping', min: 500, max: 15000, curve: 'log', unit: 'Hz' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, unit: '' },
  ],
  resonator: [
    { key: 'pitch', label: 'Pitch', min: 55, max: 880, curve: 'log', unit: 'Hz' },
    { key: 'resonance', label: 'Resonance', min: 0, max: 1, unit: '' },
    { key: 'damping', label: 'Damping', min: 500, max: 15000, curve: 'log', unit: 'Hz' },
    { key: 'width', label: 'Width', min: 0, max: 1, unit: '' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, unit: '' },
  ],
  opto: [
    { key: 'reduction', label: 'Peak Reduct.', min: 0, max: 1, unit: '' },
    { key: 'gain', label: 'Gain', min: -20, max: 20, unit: 'dB' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, unit: '' },
  ],
  tape: [
    { key: 'drive', label: 'Drive', min: 0, max: 1, unit: '' },
    { key: 'tone', label: 'Tone', min: 2000, max: 16000, curve: 'log', unit: 'Hz' },
    { key: 'wowFlutter', label: 'Wow/Flut.', min: 0, max: 1, unit: '' },
    { key: 'hiss', label: 'Hiss', min: 0, max: 1, unit: '' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, unit: '' },
  ],
  limiter: [
    { key: 'inputGain', label: 'Input', min: 0, max: 24, unit: 'dB' },
    { key: 'ceiling', label: 'Ceiling', min: -20, max: 0, unit: 'dB' },
    { key: 'release', label: 'Release', min: 0.01, max: 0.5, curve: 'log', unit: 's' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, unit: '' },
  ],
  chorus: [
    { key: 'rate', label: 'Rate', min: 0.05, max: 8, curve: 'log', unit: 'Hz' },
    { key: 'depth', label: 'Depth', min: 0, max: 1, unit: '' },
    { key: 'width', label: 'Width', min: 0, max: 1, unit: '' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, unit: '' },
  ],
  phaser: [
    { key: 'rate', label: 'Rate', min: 0.02, max: 8, curve: 'log', unit: 'Hz' },
    { key: 'depth', label: 'Depth', min: 0, max: 1, unit: '' },
    { key: 'feedback', label: 'Feedback', min: 0, max: 0.9, unit: '' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, unit: '' },
  ],
  gate: [
    { key: 'threshold', label: 'Threshold', min: -80, max: 0, unit: 'dB' },
    { key: 'attack', label: 'Attack', min: 0.0002, max: 0.5, curve: 'log', unit: 's' },
    { key: 'release', label: 'Release', min: 0.005, max: 2, curve: 'log', unit: 's' },
    { key: 'range', label: 'Range', min: -80, max: 0, unit: 'dB' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, unit: '' },
  ],
  freqShift: [
    { key: 'shift', label: 'Shift', min: -1000, max: 1000, unit: 'Hz' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, unit: '' },
  ],
  vocoder: [
    { key: 'carrierPitch', label: 'Carrier', min: 55, max: 880, curve: 'log', unit: 'Hz' },
    { key: 'response', label: 'Response', min: 5, max: 60, curve: 'log', unit: 'Hz' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, unit: '' },
  ],
  beatRepeat: [
    { key: 'chance', label: 'Chance', min: 0, max: 1, unit: '' },
    { key: 'decay', label: 'Decay', min: 0, max: 1, unit: '' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, unit: '' },
  ],
  bitcrush: [
    { key: 'rate', label: 'Rate', min: 200, max: 48000, curve: 'log', unit: 'Hz' },
    { key: 'bits', label: 'Bits', min: 1, max: 16, step: 1, unit: '' },
    { key: 'jitter', label: 'Jitter', min: 0, max: 1, unit: '' },
    { key: 'mix', label: 'Mix', min: 0, max: 1, unit: '' },
  ],
};

/** EQ-Filtertyp ist ein Enum, kein Knob — eigene, kleine Liste fürs UI. */
export const EQ_TYPES = [
  { value: 'lowshelf', label: 'Low Shelf' },
  { value: 'peaking', label: 'Peak' },
  { value: 'highshelf', label: 'High Shelf' },
  { value: 'highpass', label: 'High Pass' },
  { value: 'lowpass', label: 'Low Pass' },
];

/** Flankensteilheit für eq8s Highpass/Lowpass-Bänder (s. DEFS.eq8) --
 *  eigene Auswahl, weil Steilheit orthogonal zum Typ ist (dieselben vier
 *  Werte gelten für Highpass UND Lowpass, bis auf Brickwall). 6/12/18
 *  entsprechen 1/2/3 kaskadierten Polen (s. buildEq8BandNodes), 48
 *  ("Brickwall") vier kaskadierten Biquads (8-polig) -- bewusst nur für
 *  Highpass angeboten (Nutzer-Anfrage: tiefe Frequenzen/Rumpeln radikal
 *  wegschneiden ist der übliche Brickwall-Anwendungsfall, ein Brickwall-
 *  Lowpass war explizit nicht gewünscht). */
export const EQ_SLOPES = [
  { value: 6, label: '-6 dB/Okt' },
  { value: 12, label: '-12 dB/Okt' },
  { value: 18, label: '-18 dB/Okt' },
  { value: 48, label: 'Brickwall', highpassOnly: true },
];

/** Wählbare Zoomstufen für eq8s Gain-Achse (s. DEFS.eq8.defaults.gainRange) --
 *  ±dB, symmetrisch. Ersetzt den früher festen ±24dB-Bereich: derselbe
 *  Ziehweg auf dem Touch-Graphen bildet bei kleinerer Zoomstufe einen
 *  kleineren dB-Bereich ab, also mehr Auflösung für feine Anpassungen. */
export const EQ8_GAIN_RANGES = [3, 6, 12, 18];

/** Filter-Delay-Filtertyp ist ebenfalls ein Enum, kein Knob. */
export const FILTER_DELAY_TYPES = [
  { value: 'lowpass', label: 'Low Pass' },
  { value: 'highpass', label: 'High Pass' },
  { value: 'bandpass', label: 'Band Pass' },
];

/** Tempo-Sync-Notenwerte für den Filter Delay (wie Abletons Delay) -- als
 *  Faktor relativ zu EINER Viertelnote (= 1 Beat). 'free' (nicht hier, s.
 *  DEFS.filterDelay) lässt die Zeit weiterhin frei in Sekunden (Time-Regler)
 *  -- diese Werte überschreiben sie stattdessen relativ zum Song-Tempo,
 *  bei jeder BPM-Änderung live nachgeführt (transport.addListener). */
export const DELAY_SYNC_DIVISIONS = {
  '1/16': 0.25,
  '1/8t': 1 / 3,
  '1/8': 0.5,
  '1/8d': 0.75,
  '1/4t': 2 / 3,
  '1/4': 1,
  '1/4d': 1.5,
  '1/2': 2,
};
export const DELAY_SYNC_BUTTONS = [
  { value: 'free', label: 'Free' },
  { value: '1/16', label: '1/16' },
  { value: '1/8t', label: '1/8t' },
  { value: '1/8', label: '1/8' },
  { value: '1/8d', label: '1/8.' },
  { value: '1/4t', label: '1/4t' },
  { value: '1/4', label: '1/4' },
  { value: '1/4d', label: '1/4.' },
  { value: '1/2', label: '1/2' },
];

/** Notenwert-Auswahl für Beat Repeat (s. DEFS.beatRepeat) -- dieselben
 *  Werte wie DELAY_SYNC_BUTTONS, aber OHNE 'free': Beat Repeats "Grid" ist
 *  konzeptionell immer ein Notenwert, nie eine freie Sekundenzahl. */
export const BEATREPEAT_DIVISIONS = DELAY_SYNC_BUTTONS.filter((b) => b.value !== 'free');

let nextInsertId = 1;

/**
 * Summierte feste Zusatzlatenz einer Insert-Kette (nur die tatsächlich
 * aktiven, nicht bypassten Inserts zählen -- ein bypasster Insert läuft
 * beim Ausgang komplett am Effekt vorbei, s. createInsert()#dryGain/wetGain
 * oben, hat also keine hörbare Zusatzlatenz). Für machine.js#refreshLatency-
 * Compensation: jede Maschine gleicht ihre eigene Summe gegen das
 * Rack-Maximum aus, damit z. B. eine Tape Machine (~5.5ms) ihre Maschine
 * nicht hörbar aus dem Groove der anderen schiebt.
 */
export function insertChainLatencySec(inserts) {
  return inserts.reduce((sum, insert) => (
    insert.bypassed ? sum : sum + (DEFS[insert.type]?.latencySec ?? 0)
  ), 0);
}

/**
 * Baut einen Insert. `saved` (optional) = { id, params, bypassed } aus
 * einem vorher gespeicherten Projekt — fehlende Parameter fallen auf die
 * Effekt-Defaults zurück (z. B. wenn ein neuer Parameter dazukommt).
 *
 * `saved.id` wird, falls vorhanden, ÜBERNOMMEN statt eine neue ID zu
 * vergeben -- Automation-Lanes für Insert-Parameter sind über
 * `${machineId}:insert:${insertId}:${param}` verdrahtet (s. machine.js);
 * ohne stabile IDs würde jedes Neuladen eines Projekts allen Inserts
 * FRISCHE IDs zuteilen und aufgenommene Fahrten dadurch unsichtbar
 * verwaisen lassen (Lane bleibt gespeichert, aber nie wieder erreichbar).
 */
export function createInsert(type, saved = null) {
  const def = DEFS[type];
  if (!def) throw new Error(`Unbekannter Insert-Typ: ${type}`);
  const ctx = engine.ctx;
  // structuredClone statt einfachem Spread: def.defaults ist modulweit EIN
  // Objekt -- bei verschachtelten Werten (eq8s bands-Array) würde ein
  // flacher Spread nur die Referenz kopieren, alle Instanzen desselben
  // Insert-Typs teilten sich dann dieselben Bänder (jede Änderung an EINEM
  // Insert würde alle anderen mitverändern). Für die bisherigen, rein
  // flachen defaults (Zahlen/Strings) ändert der Clone nichts.
  const params = structuredClone({ ...def.defaults, ...saved?.params });
  const bypassed = saved?.bypassed ?? false;
  const id = saved?.id ?? nextInsertId++;
  if (saved?.id != null) nextInsertId = Math.max(nextInsertId, saved.id + 1);

  const input = ctx.createGain();
  const output = ctx.createGain();
  const dryGain = ctx.createGain();
  const wetGain = ctx.createGain();
  // Direkt setzen (nicht rampen) — beim Bau steht noch nichts an, ein
  // Ramp würde nur unnötig verzögern, wann der Insert "fertig" ist.
  dryGain.gain.value = bypassed ? 1 : 0;
  wetGain.gain.value = bypassed ? 0 : 1;
  const effect = def.build(ctx, params);

  input.connect(dryGain);
  dryGain.connect(output);
  input.connect(effect.input);
  effect.output.connect(wetGain);
  wetGain.connect(output);

  // Analyser fürs Pegel-Meter der Insert-Zeile (s. ui/insert-chain.js) --
  // tapt `output`, den einzigen, für JEDEN Insert-Typ gleich geformten
  // Ausgangsknoten dieses Wrappers (unabhängig von internen Eigenheiten
  // wie EQ8s Ketten-Biquads oder Reverb/Resonator-Feedback-Netzen).
  // Lazy angelegt wie Machine#getMeterAnalyser, gleiche Begründung.
  let meterAnalyser = null;

  const insert = {
    id,
    type,
    name: def.name,
    params,
    bypassed,
    input,
    output,
    setParam(key, value) {
      params[key] = value;
      effect.setParam(key, value);
    },
    // Nur beim Compressor vorhanden — UI prüft auf Existenz statt Typ.
    getReductionDb: effect.getReductionDb ? () => effect.getReductionDb() : undefined,
    // Nur beim 8-Band-EQ vorhanden (s. dortigen Kommentar in DEFS.eq8).
    setBand: effect.setBand ? (i, field) => effect.setBand(i, field) : undefined,
    getEq8Response: effect.getEq8Response ? (freqArray) => effect.getEq8Response(freqArray) : undefined,
    setGainRange: effect.setGainRange ? (v) => effect.setGainRange(v) : undefined,
    // Nur beim Graphic EQ vorhanden (s. dortigen Kommentar in DEFS.geq).
    setBandGain: effect.setBandGain ? (i, v) => effect.setBandGain(i, v) : undefined,
    setBypass(b) {
      insert.bypassed = b;
      const t = engine.now;
      dryGain.gain.setTargetAtTime(b ? 1 : 0, t, 0.01);
      wetGain.gain.setTargetAtTime(b ? 0 : 1, t, 0.01);
    },
    getMeterAnalyser() {
      if (!meterAnalyser) {
        meterAnalyser = ctx.createAnalyser();
        meterAnalyser.fftSize = 512;
        output.connect(meterAnalyser);
      }
      return meterAnalyser;
    },
    serialize() {
      return { id, type, params: { ...params }, bypassed: insert.bypassed };
    },
    dispose() {
      input.disconnect();
      output.disconnect();
      dryGain.disconnect();
      wetGain.disconnect();
      meterAnalyser?.disconnect();
      effect.dispose();
    },
  };

  return insert;
}
