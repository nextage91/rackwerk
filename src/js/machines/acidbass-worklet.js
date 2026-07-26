/**
 * AcidBass-DSP-Kern als AudioWorkletProcessor -- Sample-für-Sample-Portierung
 * der TB-303-Algorithmen aus Open303 (RobinSchmidt, MIT-lizenziert,
 * github.com/RobinSchmidt/Open303) auf Basis der tatsächlichen Quelldateien
 * (rosic_TeeBeeFilter.h/.cpp, rosic_Open303.h/.cpp, rosic_DecayEnvelope,
 * rosic_LeakyIntegrator, rosic_OnePoleFilter, rosic_MipMappedWaveTable) --
 * KEIN Code kopiert, komplett neu in JS geschrieben, aber die Formeln/
 * Koeffizienten sind bewusst 1:1 übernommen, weil genau DAS beim ersten
 * Anlauf (native BiquadFilterNode-Kaskade + Rückkopplungsschleife) fehlte:
 * eine echte 303 nutzt weder kaskadierte 2-polige Biquads noch einen
 * simplen Feedback-Gain, sondern eine ganz bestimmte 4-stufige "Leapfrog"-
 * Rekursion (Formeln von mystran/kunn) MIT einem Hochpass IN der
 * Rückkopplung -- das lässt sich mit nativen AudioNodes/AudioParam-
 * Automation nicht nachbilden, deshalb jetzt echtes Sample-für-Sample-DSP
 * per AudioWorklet (Browser-Unterstützung seit iOS 14.5/Safari 14.1 (2021),
 * also kein Blocker mehr für die vorher deswegen bewusst vermiedene
 * AudioWorklet-Variante).
 *
 * Bewusst NICHT übernommen (Aufwand/Nutzen-Abwägung, s. Chat): die
 * 4-fache Überabtastung + elliptisches Anti-Aliasing-Filter von Open303,
 * sowie zwei sehr subtile Fixfilter (Allpass 14Hz, Notch bei 7.5Hz/Bw 4.7 --
 * beides praktisch unterhalb der Hörbarkeitsschwelle für einen Bass-Sound).
 * Stattdessen: PolyBLEP-entschärfte Sägezahn-Flanke gegen Aliasing (einfacher,
 * aber wirksamer Kompromiss für einen einzelnen, meist tieffrequenten Ton).
 *
 * Diese Datei exportiert NUR den Quelltext als String (kein echtes ES-Modul-
 * Verhalten hier drin) -- der String wird zur Laufzeit per Blob-URL an
 * `audioWorklet.addModule()` übergeben (s. acidbass.js), weil RackWerk als
 * EINE gebündelte index.html ausgeliefert wird (kein zweiter Dateipfad für
 * ein separates Worklet-Modul verfügbar, s. README "Aufbau dieses Repos").
 * Der Worklet-Code selbst läuft in einem eigenen globalen Scope OHNE Zugriff
 * auf unsere ES-Module -- deshalb komplett eigenständig, keine Imports.
 */
export const ACIDBASS_WORKLET_SRC = `
class OnePole {
  constructor(mode) {
    this.mode = mode; // 'hp' oder 'lp'
    this.b0 = 1; this.b1 = 0; this.a1 = 0;
    this.x1 = 0; this.y1 = 0;
  }
  setCutoff(cutoff, sr) {
    const x = Math.exp(-2 * Math.PI * cutoff / sr);
    if (this.mode === 'hp') {
      this.b0 = 0.5 * (1 + x);
      this.b1 = -0.5 * (1 + x);
      this.a1 = x;
    } else {
      this.b0 = 1 - x;
      this.b1 = 0;
      this.a1 = x;
    }
  }
  process(input) {
    const y = this.b0 * input + this.b1 * this.x1 + this.a1 * this.y1;
    this.x1 = input;
    this.y1 = y;
    return y;
  }
  reset() { this.x1 = 0; this.y1 = 0; }
}

class LeakyIntegrator {
  constructor() { this.coeff = 0; this.y1 = 0; }
  setTimeConstantMs(tauMs, sr) {
    this.coeff = tauMs > 0 ? Math.exp(-1 / (sr * 0.001 * tauMs)) : 0;
  }
  process(input) { return (this.y1 = input + this.coeff * (this.y1 - input)); }
  setState(v) { this.y1 = v; }
  reset() { this.y1 = 0; }
}

class DecayEnv {
  constructor() { this.c = 1; this.y = 0; }
  setDecayMs(tauMs, sr) { this.c = Math.exp(-1 / (0.001 * tauMs * sr)); }
  trigger() { this.y = 1 / this.c; }
  process() { this.y *= this.c; return this.y; }
}

// PolyBLEP-Korrektur einer naiven Sägezahn-Flanke gegen Aliasing (Standard-
// technik für nicht-wavetable-basierte Oszillatoren, s. Dateikopf).
function polyBlep(t, dt) {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  } else if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}

const ONE_OVER_SQRT2 = 0.70710678118654752440;
const TANH_SHAPER_FACTOR = 70.083339; // dB2amp(36.9) -- s. rosic_MipMappedWaveTable
const TANH_SHAPER_OFFSET = 4.37;

/** Ausgangs-Headroom -- die Amp-Hüllkurve summiert Basis-Decay + Filter-
 *  Hüllkurven-Anteil + (bei Accent) einen weiteren 4x-Anteil (s. Open303-
 *  Formel in process() unten), erreicht bei vollem Accent+Resonanz+Hi-Res
 *  gemeinsam Rohpegel deutlich über 1.0 (per Stresstest verifiziert). Der
 *  finale tanh()-Limiter (s. process()) verhindert echtes Aufschaukeln,
 *  diese Konstante hält aber schon den TYPISCHEN Pegel (auch bei Accent)
 *  in einem für den Mix sinnvollen Bereich, statt sich auf den Limiter als
 *  einzige Bremse zu verlassen. */
const OUTPUT_HEADROOM = 0.4;

class AcidBassProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    const sr = sampleRate; // global in AudioWorkletGlobalScope

    this.sr = sr;
    this.phase = 0;
    this.oscFreq = 55;
    this.pitchSlew = new LeakyIntegrator();

    // Ladder-Filter-Zustand (4 Stufen, TB_303-Modus, s. rosic_TeeBeeFilter):
    this.y1 = 0; this.y2 = 0; this.y3 = 0; this.y4 = 0;
    this.feedbackHp = new OnePole('hp');
    this.feedbackHp.setCutoff(150, sr);
    this.b0 = 0; this.k = 0; this.g = 1;

    // Vor-/Nachfilter (feste Klangformung, s. rosic_Open303-Konstruktor):
    this.preHp = new OnePole('hp');
    this.preHp.setCutoff(44.486, sr);
    this.postHp = new OnePole('hp');
    this.postHp.setCutoff(24.167, sr);

    // Filterhüllkurve (reine Decay-Kurve, RC-geglättet -- s. Dateikopf):
    this.mainEnv = new DecayEnv();
    this.rc1 = new LeakyIntegrator(); // normale Attack-Glättung
    this.rc1.setTimeConstantMs(3, sr);
    this.rc2 = new LeakyIntegrator(); // Accent-Attack-Glättung (separater Pfad)
    this.rc2.setTimeConstantMs(3, sr);
    this.accentGain = 0;
    this.envScaler = 1;
    this.envOffset = 0;

    // Amp-Basishüllkurve -- fest ~1.2s Decay (Devil-Fish-Bereich 16..3000ms,
    // Stock-303 laut Handbuch fix; wir exponieren dafür bewusst KEINEN Regler,
    // s. Dateikopf/Chat: gehört nicht zum gewählten Devil-Fish-Subset), NICHT
    // bei Slide retriggert -- echtes Legato, kein Neuanschlag der Lautstärke.
    // Die eigentliche "Notenlänge" kommt fast komplett aus dem Filterhüllkurven-
    // Anteil unten (mainEnv*0.45 bzw. *4 bei Accent) -- genau wie beim echten
    // 303, s. rosic_Open303::getSample().
    this.ampBaseEnv = new DecayEnv();
    this.ampBaseEnv.setDecayMs(1230, sr);
    this.ampDeClicker = new OnePole('lp');
    this.ampDeClicker.setCutoff(200, sr);

    this.lastMidi = null;
    this.disposed = false;

    this.p = {
      waveform: 'saw', tune: 0, cutoff: 500, resonance: 0.5, envMod: 0.5,
      decay: 0.3, accentDecay: 0.15, accent: 0.6, overdrive: 0, filterFM: 0,
      slideTime: 0.06, hiRes: false,
    };
    this.resonanceSkewed = 0;

    this.eventQueue = [];
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'params') {
        Object.assign(this.p, d.params);
        this.#onParamsChanged();
      } else if (d.type === 'trigger') {
        this.eventQueue.push(d);
      } else if (d.type === 'dispose') {
        this.disposed = true;
      }
    };
    this.#onParamsChanged();
  }

  #onParamsChanged() {
    const p = this.p;
    this.pitchSlew.setTimeConstantMs(0.2 * Math.max(1, p.slideTime * 1000), this.sr);
    // Open303s eigene resonanceSkewed-Kurve (exponentieller Skew) ist auf ihre
    // VST-UI-Konvention zugeschnitten und sättigt bei unserem linearen 0..1-
    // Regler schon ab ca. 50% Reglerweg (per Messung: r(0.5)=0.82, r(1.0)=1.0
    // -- die obere Hälfte des Reglers hätte sich fast tot angefühlt, exakt
    // dasselbe Problem wie beim ersten nativen Anlauf mit dem falsch
    // kalibrierten Feedback-Gain, s. Dateikopf/Chat). Stattdessen: direkte
    // lineare Skalierung, per Messung (Standalone-Sweep über 200-2000Hz) so
    // gewählt, dass Selbstschwingung erst im OBEREN Reglerviertel einsetzt
    // (typisches 303-Reglergefühl) und Hi-Res spürbar aggressiver selbst-
    // schwingt. Der Sicherheits-Clip unten (Tanh im Feedback-Pfad)
    // fängt jeden Rest-Fall ab, in dem die reine Ladder-Rekursion sonst
    // unbegrenzt aufschwingen würde (eine rein lineare Rückkopplung hat KEIN
    // natürliches Limit -- anders als eine echte Diodenkette).
    const r = Math.max(0, Math.min(1, p.resonance));
    this.resonanceRaw = r;
    this.resonanceSkewed = r * (p.hiRes ? 2.2 : 1.6);

    // Gemessene envMod->Cutoff-Skalierung/Offset (s. Dateikopf,
    // rosic_Open303::calculateEnvModScalerAndOffset -- Konstanten aus
    // Hardware-Messungen des Open303-Projekts übernommen):
    const c0 = 313.8152786059267, c1 = 2394.411986817546;
    const oF = 0.048292930943553, oC = 0.294391201442418;
    const sLoF = 3.773996325111173, sLoC = 0.736965594166206;
    const sHiF = 4.194548788411135, sHiC = 0.864344900642434;
    const e = Math.max(0, Math.min(1, p.envMod));
    let c = Math.log(Math.max(1, p.cutoff) / c0) / Math.log(c1 / c0);
    c = Math.max(0, Math.min(1, c));
    const sLo = sLoF * e + sLoC;
    const sHi = sHiF * e + sHiC;
    this.envScaler = (1 - c) * sLo + c * sHi;
    this.envOffset = oF * c + oC;
  }

  #trigger(ev) {
    const p = this.p;
    const freq = 440 * Math.pow(2, (ev.midi + p.tune - 69) / 12);
    const isSlide = ev.slide && this.lastMidi != null;
    if (!isSlide) {
      this.pitchSlew.setState(freq);
    }
    this.oscFreqTarget = freq;

    const decayMs = Math.max(1, (ev.accent ? p.accentDecay : p.decay) * 1000);
    this.mainEnv.setDecayMs(decayMs, this.sr);
    this.accentGain = ev.accent ? Math.max(0, Math.min(1, p.accent)) : 0;

    // Slide: echtes Legato -- weder Filter- noch Amp-Hüllkurve werden neu
    // getriggert (genau wie im echten Open303: triggerNote() ruft mainEnv.
    // trigger()+ampEnv.noteOn() auf, slideToNote() KEINS von beidem -- nur
    // die Zielfrequenz ändert sich, der Rest der laufenden Kurven läuft
    // unbeeinflusst weiter).
    if (!isSlide) {
      this.mainEnv.trigger();
      this.ampBaseEnv.trigger();
    }
    this.lastMidi = ev.midi;
  }

  #oscSample(dt) {
    // Naiver, PolyBLEP-entschärfter Sägezahn (SAW303 ist algorithmisch ein
    // gewöhnlicher Sägezahn, s. Dateikopf); SQUARE303 = derselbe Sägezahn
    // durch den asymmetrischen Tanh-Shaper der echten 303 gejagt (harte,
    // aber NICHT symmetrische ~47/53%-Rechteckflanke -- s. Dateikopf).
    let saw = 2 * this.phase - 1;
    saw -= polyBlep(this.phase, dt);
    if (this.p.waveform === 'square') {
      return -Math.tanh(TANH_SHAPER_FACTOR * saw + TANH_SHAPER_OFFSET);
    }
    return saw;
  }

  process(inputs, outputs) {
    if (this.disposed) return false;
    const out = outputs[0][0];
    if (!out) return true;
    const p = this.p;
    const sr = this.sr;
    const blockStart = currentTime;

    for (let i = 0; i < out.length; i++) {
      const sampleTime = blockStart + i / sr;
      while (this.eventQueue.length && this.eventQueue[0].time <= sampleTime) {
        this.#trigger(this.eventQueue.shift());
      }

      // Tonhöhe: lineares RC-Gleiten in Hz (genau wie im echten Pitch-
      // Slew-Limiter, s. Dateikopf -- kein Klick-Risiko wie früher bei
      // AudioParam-Automation, hier einfach imperativer Code pro Sample).
      this.oscFreq = this.pitchSlew.process(this.oscFreqTarget ?? this.oscFreq);
      const dt = this.oscFreq / sr;
      this.phase += dt;
      if (this.phase >= 1) this.phase -= 1;

      // Filterhüllkurve: rohe Decay-Kurve, RC-geglättet für normale UND
      // (separat) Accent-Attack-Zeit, dann per gemessener Skalierung/Offset
      // in Oktaven-Modulation umgerechnet -- s. Dateikopf.
      const mainEnvOut = this.mainEnv.process();
      const tmp1 = this.envScaler * (this.rc1.process(mainEnvOut) - this.envOffset);
      const tmp2raw = this.accentGain > 0 ? mainEnvOut : 0;
      const tmp2 = this.accentGain * this.rc2.process(tmp2raw);
      let instCutoff = p.cutoff * Math.pow(2, tmp1 + tmp2);
      // Devil-Fish Filter-FM: Oszillator moduliert die Cutoff-Frequenz direkt.
      if (p.filterFM > 0) instCutoff += this.#oscSample(dt) * p.filterFM * 2500;
      instCutoff = Math.max(30, Math.min(18000, instCutoff));

      // TB_303-Ladder-Koeffizienten (exakte Formel aus rosic_TeeBeeFilter::
      // calculateCoefficientsApprox4, TB_303-Zweig -- s. Dateikopf):
      const wc = 2 * Math.PI * instCutoff / sr;
      const fx = wc * ONE_OVER_SQRT2 / (2 * Math.PI);
      this.b0 = (0.00045522346 + 6.1922189 * fx) / (1 + 12.358354 * fx + 4.4156345 * fx * fx);
      let k = fx * (fx * (fx * (fx * (fx * (fx + 7198.6997) - 5837.7917) - 476.47308) + 614.95611) + 213.87126) + 16.998792;
      let g = k * 0.058823529411764705882352941176471; // 1/17
      // Hi-Res (Devil Fish) ist schon in resonanceSkewed eingerechnet (s.
      // #onParamsChanged) -- erweitert den nutzbaren Resonanz-Bereich über
      // die Stock-Selbstschwing-Schwelle hinaus.
      const r = this.resonanceSkewed;
      g = (g - 1) * r + 1;
      g = g * (1 + r);
      k = k * r;
      this.k = k; this.g = g;

      // Devil-Fish Overdrive: treibt das Oszillatorsignal VOR dem Filter
      // härter (s. Handbuch -- "mehr Pegel unter Stress in die Kaskade"),
      // weich begrenzt statt hart geklippt.
      let osc = -this.#oscSample(dt); // Vorzeichen wie im Original (s. Dateikopf)
      if (p.overdrive > 0) {
        const drive = 1 + p.overdrive * 3;
        osc = Math.tanh(osc * drive) / Math.tanh(drive);
      }
      let sig = this.preHp.process(osc);

      // Weicher Clip im Rückkopplungspfad -- s. #onParamsChanged: die reine
      // Ladder-Rekursion (Open303s TB_303-Zweig) ist komplett LINEAR (kein
      // shape()-Aufruf im Original, s. Dateikopf-Recherche), hat also KEIN
      // natürliches Limit, sobald k über die Stabilitätsschwelle steigt --
      // eine echte Diodenkette begrenzt sich dagegen selbst (die Dioden
      // sättigen), genau DAS macht "Selbstschwingung" statt "Aufschaukeln
      // bis unendlich" hörbar aus. Per Standalone-Sweep verifiziert (s.
      // Chat): ohne diesen Clip explodiert die Rekursion bei hohen
      // Cutoff+Resonanz-Kombinationen auf Infinity/NaN.
      const y0 = sig - this.feedbackHp.process(Math.tanh(k * this.y4));
      this.y1 += 2 * this.b0 * (y0 - this.y1 + this.y2);
      this.y2 += this.b0 * (this.y1 - 2 * this.y2 + this.y3);
      this.y3 += this.b0 * (this.y2 - 2 * this.y3 + this.y4);
      this.y4 += this.b0 * (this.y3 - 2 * this.y4);
      // Der Tanh-Clip oben begrenzt nur das, was ZURÜCK in die Schleife
      // fliesst -- einmal gesättigt wirkt er wie ein KONSTANTER statt
      // proportionaler Gegendruck, das reicht bei extremen Regler-
      // Kombinationen (z. B. Cutoff+EnvMod+Resonanz+Hi-Res alle am Anschlag)
      // NICHT, um die internen Zustände y1..y4 selbst zu begrenzen (per
      // Stresstest verifiziert: ohne diese Klammer liefen Peaks bis >80 auf,
      // weit ausserhalb von ±1 -- gefährlich laut). WEICHER Zustands-Clamp
      // (tanh statt Math.max/min!) -- ein harter Clamp erzeugt an der
      // Decken-Berührung eine ECHTE Unstetigkeit (per Klick-Regressionstest
      // gefunden: hörbarer Sprung genau dort, wo der Zustand kurz an die
      // Grenze lief, s. Chat) -- ein reales Filter sättigt dagegen immer
      // WEICH (Transistor-/Dioden-Kennlinie), nie mit einer harten Kante.
      const STATE_LIMIT = 8;
      this.y1 = STATE_LIMIT * Math.tanh(this.y1 / STATE_LIMIT);
      this.y2 = STATE_LIMIT * Math.tanh(this.y2 / STATE_LIMIT);
      this.y3 = STATE_LIMIT * Math.tanh(this.y3 / STATE_LIMIT);
      this.y4 = STATE_LIMIT * Math.tanh(this.y4 / STATE_LIMIT);
      sig = 2 * this.g * this.y4;

      sig = this.postHp.process(sig);
      // Letztes Sicherheitsnetz für den Gesamtausgang -- garantiert |sig|<=1
      // unabhängig von jeder Regler-Kombination, ohne bei normalen
      // Einstellungen hörbar einzugreifen (tanh(x)≈x für kleine x).
      sig = Math.tanh(sig);

      let ampEnvOut = this.ampBaseEnv.process() + 0.45 * mainEnvOut + this.accentGain * 4.0 * mainEnvOut;
      ampEnvOut = this.ampDeClicker.process(ampEnvOut);

      // Finale Begrenzung: sig ist zwar schon auf ±1 geklemmt (s. oben), aber
      // ampEnvOut kann bei Accent (0.45x/4x-Anteil, s. Kommentar oben) deutlich
      // über 1 liegen -- ohne dies könnte das Produkt bei einer aggressiven
      // Accent+Resonanz+EnvMod-Kombination (echte, physikalisch stetige
      // Selbstschwingung, kein Bug -- per Sample-für-Sample-Analyse verifiziert,
      // s. Chat) kurzzeitig über ±1 hinausschiessen.
      out[i] = Math.max(-1, Math.min(1, sig * ampEnvOut * OUTPUT_HEADROOM));
    }
    return true;
  }
}

registerProcessor('acidbass-voice', AcidBassProcessor);
`;
