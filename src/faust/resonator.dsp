// resonator.dsp -- Modal-Synthese-Kern für den Resonator-Insert (s.
// core/inserts.js#DEFS.resonator). Ersetzt die vorherige 5-Band-
// Delayline-Bank (Karplus-Strong-artig) durch eine echte Modal-Synthese
// (pm.modalModel aus Fausts physmodels.lib -- dieselbe Grundlage, die
// Faust intern für seine Glockenmodelle nutzt, s. libraries/modalmodels/*
// Bell): N unabhängige Resonanz-Moden, jede mit eigener Frequenz,
// Amplitude UND eigener Abklingzeit -- der Kernunterschied zur alten
// Bank, die für alle 5 Bänder denselben Damping-Filter teilte. Hier
// klingen hohe Moden automatisch schneller ab als tiefe (physikalisch
// korrekt), gesteuert vom `damping`-Regler.
//
// Wird per tools/build-resonator-worklet.mjs zu WebAssembly kompiliert
// und als AudioWorkletProcessor in core/resonator-worklet.js eingebettet
// (RackWerk liefert eine einzige gebündelte index.html aus, s. README --
// kein Laufzeit-Zugriff auf diese .dsp-Datei oder den Faust-Compiler
// selbst, nur das Kompilat).
//
// Bleibt bewusst NUR der resonierende Kern (Erreger-Ducker + Sicherheits-
// Limiter + Dry/Wet bleiben wie bisher aussen in JS, s. DEFS.resonator.
// build() -- ein Faust-Patch, der versucht ALLES selbst zu regeln, wäre
// hier unnötig: die bestehende Ducker/Limiter-Kette ist schon ausgiebig
// stresstestet).
import("stdfaust.lib");

N = 24;

pitch = hslider("[0]pitch", 220, 20, 2000, 0.01) : si.smoo;
resonance = hslider("[1]resonance", 0.6, 0, 1, 0.001) : si.smoo;
damping = hslider("[2]damping", 8000, 200, 18000, 1) : si.smoo;

// Deckt sich mit resonanceToDecayTime() in inserts.js (0.05s..6s) --
// beide Kurven müssen zusammenpassen, falls der Regler je wieder in JS
// vorgerechnet werden muss.
decayTime = 0.05 * pow(120, resonance);

// Bell/plate-artige Partialverteilung: milde Inharmonizität (Klavier-
// saiten-Formel) plus ein winziges, deterministisches Pseudo-Zufalls-
// Detuning pro Partialton (Hash des Index -- echte Zufälligkeit ist zur
// Kompilierzeit nicht verfügbar/nötig) -- vermeidet einen exakt
// harmonischen, "synthetischen" Oberton-Stapel.
B = 0.0004;
hashDetune(i) = (hashFrac(i) - 0.5) * 0.01; // +/-0.5%
hashFrac(i) = frac(sin(i * 12.9898) * 43758.5453);
frac(x) = x - floor(x);
ratio(i) = (i + 1) * sqrt(1 + B * (i + 1) * (i + 1)) * (1 + hashDetune(i));

freq(i) = pitch * ratio(i);
freqs = par(i, N, freq(i));

gain(i) = 1.0 / pow(i + 1, 0.8);
gains = par(i, N, gain(i));

// Höhere Partialtöne klingen schneller ab, gesteuert von `damping` (wie
// ein Tiefpass-Cutoff, dasselbe Reglergefühl wie bisher): weit unterhalb
// des Cutoffs behält eine Mode die volle, aus `resonance` abgeleitete
// Abklingzeit, weit darüber klingt sie deutlich schneller ab.
modeT60(i) = max(0.01, decayTime / (1 + pow(freq(i) / damping, 2)));
t60s = par(i, N, modeT60(i));

// Kalibriert auf ungefähr denselben Pegel wie die alte Bank bei Mix=100%
// (feinjustiert in inserts.js über die dortige Pegelkompensation, s.
// Kommentar dort -- dieser Wert ist ein grober Ausgangspunkt, kein
// exaktes Ziel).
outGain = 0.09;
process = _ : pm.modalModel(N, freqs, t60s, gains) : *(outGain);
