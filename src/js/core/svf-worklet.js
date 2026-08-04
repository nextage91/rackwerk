/**
 * TPT (Topology-Preserving Transform) State-Variable-Filter als
 * AudioWorkletProcessor -- Ersatz für die bisherige Dry/Highpass/Lowpass-
 * Kreuzblende aus zwei `BiquadFilterNode`s im Master-Sweep-Filter (s.
 * core/fx.js#buildFilterChain).
 *
 * Warum nicht weiter BiquadFilterNode: das Sweep-Pad in der Jam-Ansicht
 * (jam-view.js) ist der EINZIGE Regler im ganzen Rack, der per Touch-Drag
 * kontinuierlich in Echtzeit gezogen wird statt nur angetippt -- bei sehr
 * schnellen `frequency`/`Q`-Änderungen kann ein Biquad hörbar knacksen,
 * weil seine internen Verzögerungsglieder (z^-1/z^-2) noch den Zustand der
 * ALTEN Koeffizienten tragen, wenn die neuen greifen (Koeffizienten- und
 * Zustandssprung fallen zeitlich auseinander). Die "Topology-Preserving"-
 * Struktur (Andy Simper/Cytomic, Standardliteratur für digitale State-
 * Variable-Filter) baut die Integratoren so, dass genau dieser Sprung
 * ausbleibt -- UND liefert Lowpass/Highpass/Bandpass gleichzeitig aus
 * EINEM gemeinsamen Kern, weshalb der Sweep-Regler (der zwischen Highpass-
 * und Lowpass-Charakter überblendet) hier mit einer einzigen Filterstufe
 * auskommt statt zwei parallelen Biquads + drei Gain-Knoten für die
 * Kreuzblende.
 *
 * Kein Transzendentale im Sample-Loop: tan()/Koeffizienten werden nur EINMAL
 * PRO BLOCK neu gerechnet (sweep/reso sind bewusst k-rate-Parameter, s.
 * parameterDescriptors -- für einen Touch-Drag reicht das, ein Update alle
 * 128 Samples/~2.9ms ist weit unter jeder Zipper-Hörschwelle), nicht pro
 * Sample wie es a-rate-Parameter erzwingen würden.
 *
 * hpMaxHz/lpMinHz/edgeMinHz/edgeMaxHz kommen als processorOptions vom
 * Aufrufer (core/inserts.js#makeSweepFilter) -- dieselben vier Eckwerte,
 * die fx.js vorher direkt in seine eigene #logLerp-Rechnung einsetzte,
 * jetzt nur eine Ebene tiefer. So bleibt dieser Worklet ein generischer,
 * wiederverwendbarer Sweep-Filter-Kern statt fest an fx.js' Hz-Bereich
 * gekoppelt zu sein.
 *
 * Wie bei allen anderen Worklets in diesem Projekt: exportiert nur den
 * Quelltext als String -- RackWerk wird als EINE gebündelte index.html
 * ausgeliefert, der String wird zur Laufzeit per Blob-URL an
 * audioWorklet.addModule() übergeben. Eigener globaler Scope ohne Zugriff
 * auf unsere ES-Module, deshalb komplett eigenständig.
 */
export const SVF_WORKLET_SRC = `
/** Wie core/onepole-worklet.js#DENORMAL_FLOOR -- schützt vor dauerhaft im
 *  Denormal-Bereich hängenden Zustandswerten nach dem Verstummen des
 *  Eingangs (auf manchen CPUs deutlich langsamere Gleitkomma-Arithmetik). */
const DENORMAL_FLOOR = 1e-30;

class RackwerkSVFProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'sweep', defaultValue: 0, minValue: -1, maxValue: 1, automationRate: 'k-rate' },
      { name: 'reso', defaultValue: 5, minValue: 0.1, maxValue: 30, automationRate: 'k-rate' },
    ];
  }

  constructor(options) {
    super();
    const po = options.processorOptions ?? {};
    this.edgeMinHz = po.edgeMinHz ?? 20;
    this.hpMaxHz = po.hpMaxHz ?? 5000;
    this.edgeMaxHz = po.edgeMaxHz ?? 20000;
    this.lpMinHz = po.lpMinHz ?? 150;

    // TPT-Integrator-Zustand (ic1eq/ic2eq), EIN Paar pro Kanal -- wie
    // onepole-worklet.js: fester Float64Array-Puffer statt wachsendem
    // JS-Array, Kanalzahl steht beim Anlegen fest.
    this.ic1 = new Float64Array(32);
    this.ic2 = new Float64Array(32);

    // Koeffizienten-Cache -- sweep/reso sind k-rate (ein Wert pro Block),
    // updateCoeffs() lohnt sich trotzdem als expliziter Cache-Check: bei
    // stillstehenden Reglern (der Normalfall) spart das drei Divisionen
    // plus ein tan() pro Block.
    this.lastSweep = NaN;
    this.lastReso = NaN;
    this.a1 = 0; this.a2 = 0; this.a3 = 0; this.k = 0;
    this.dryGain = 1; this.hpGain = 0; this.lpGain = 0;
  }

  updateCoeffs(sweep, reso) {
    if (sweep === this.lastSweep && reso === this.lastReso) return;
    this.lastSweep = sweep;
    this.lastReso = reso;

    const s = Math.max(-1, Math.min(1, sweep));
    // Dieselbe log-Interpolation wie fx.js' frühere #logLerp -- sweep<0
    // wandert Richtung Highpass (Grenzfreq. steigt von edgeMinHz Richtung
    // hpMaxHz), sweep>0 Richtung Lowpass (fällt von edgeMaxHz Richtung
    // lpMinHz). Bei sweep=0 ist der gewählte Wert irrelevant (hp/lpGain
    // sind dann beide 0, reiner Dry-Durchlauf).
    const fc = s < 0
      ? this.edgeMinHz * Math.pow(this.hpMaxHz / this.edgeMinHz, -s)
      : this.edgeMaxHz * Math.pow(this.lpMinHz / this.edgeMaxHz, s);
    this.dryGain = 1 - Math.abs(s);
    this.hpGain = s < 0 ? -s : 0;
    this.lpGain = s > 0 ? s : 0;

    // Nyquist-Sicherheitsklemme: tan(pi*fc/fs) läuft bei fc->fs/2 gegen
    // Unendlich -- edgeMaxHz (20kHz) liegt bei ungewöhnlich niedrigen
    // Sample-Raten sonst gefährlich nah dran.
    const fcSafe = Math.min(fc, sampleRate * 0.49);
    const g = Math.tan(Math.PI * fcSafe / sampleRate);
    // reso ist der GLEICHE Wert, den die alte BiquadFilterNode-Fassung als
    // .Q entgegennahm (Regler-Bereich 0.7..15, s. fx.js) -- Chromes
    // natives BiquadFilterNode folgt bei niedrigen Grenzfrequenzen relativ
    // zur Sample-Rate (hier 150-5000Hz bei 44.1/48kHz) EMPIRISCH NICHT der
    // Lehrbuch-RBJ-Beziehung peak_dB ≈ 20*log10(Q), sondern eher
    // peak_dB ≈ Q (nachgemessen per getFrequencyResponse: Q=5 -> ~5.4dB
    // Peak, Q=15 -> ~15dB, Q=20 -> 20dB, nicht die per RBJ-Formel zu
    // erwartenden 14/23.5/26dB). Ein TPT-SVF mit direktem k=1/reso hätte
    // bei gleichem reso-Wert also eine deutlich AGGRESSIVERE Resonanz als
    // die alte Fassung -- reso wird deshalb zuerst in ein äquivalentes
    // SVF-Q umgerechnet (qEff = 10^(reso/20)), das bei der SVF-eigenen
    // Lehrbuch-Formel dieselbe gemessene peak_dB-Kurve reproduziert. Damit
    // klingt Reso beim Umstieg von Biquad auf SVF UNVERÄNDERT.
    const qEff = Math.pow(10, reso / 20);
    const k = 1 / Math.max(0.05, qEff);
    const a1 = 1 / (1 + g * (g + k));
    this.a1 = a1;
    this.a2 = g * a1;
    this.a3 = g * this.a2;
    this.k = k;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || !output.length) return true;

    // k-rate: parameters.sweep/reso haben IMMER genau ein Element.
    this.updateCoeffs(parameters.sweep[0], parameters.reso[0]);
    const { a1, a2, a3, k, dryGain, hpGain, lpGain } = this;

    for (let ch = 0; ch < output.length; ch++) {
      const inCh = input?.[ch];
      const outCh = output[ch];
      let ic1 = this.ic1[ch];
      let ic2 = this.ic2[ch];

      for (let i = 0; i < outCh.length; i++) {
        const x = inCh ? inCh[i] : 0;
        // Andy-Simper/Cytomic-TPT-SVF: liefert Lowpass (v2) UND Highpass
        // (x - k*v1 - v2) aus demselben Durchlauf -- der Sweep-Regler
        // blendet nur noch zwischen den beiden fertigen Ausgängen (plus
        // trocken), baut aber nie zwei getrennte Filterketten auf.
        const v3 = x - ic2;
        const v1 = a1 * ic1 + a2 * v3;
        const v2 = ic2 + a2 * ic1 + a3 * v3;
        ic1 = 2 * v1 - ic1;
        ic2 = 2 * v2 - ic2;
        const lp = v2;
        const hp = x - k * v1 - v2;
        outCh[i] = dryGain * x + hpGain * hp + lpGain * lp;
      }

      // Denormal-/NaN-Schutz einmal pro Block, wie onepole-worklet.js.
      if (ic1 > -DENORMAL_FLOOR && ic1 < DENORMAL_FLOOR) ic1 = 0;
      if (ic2 > -DENORMAL_FLOOR && ic2 < DENORMAL_FLOOR) ic2 = 0;
      if (!Number.isFinite(ic1) || !Number.isFinite(ic2)) { ic1 = 0; ic2 = 0; }
      this.ic1[ch] = ic1;
      this.ic2[ch] = ic2;
    }
    return true;
  }
}
registerProcessor('rackwerk-svf', RackwerkSVFProcessor);
`;
