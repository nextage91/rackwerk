#!/usr/bin/env python3
"""
build-preview.py — bündelt das modulare Projekt in eine Einzeldatei
(rackwerk-preview.html), z. B. zum schnellen Testen auf dem Handy.

Jedes Modul wird in eine eigene IIFE gekapselt, damit modul-lokale
Konstanten (z. B. NOTE_NAMES) nicht kollidieren. Die Exporte werden
per Rückgabewert in Top-Level-Konstanten destrukturiert.
"""
import re
import pathlib

ROOT = pathlib.Path(__file__).parent
OUT = ROOT / "rackwerk-preview.html"

# Reihenfolge = Abhängigkeitsreihenfolge; Werte = exportierte Namen
MODULES = [
    ("js/core/undo.js",         ["undo"]),
    ("js/core/store.js",        ["store"]),
    ("js/core/hints.js",        ["hintOnce", "showHintToast", "hintSeen", "markHintSeen"]),
    ("js/ui/knob.js",           ["XKnob"]),
    ("js/ui/fader.js",          ["XFader"]),
    ("js/vendor/qrcodegen.js",  ["qrcodegen"]),
    ("js/vendor/jsqr.js",       ["jsQR"]),
    ("js/ui/qr.js",             ["drawQR"]),
    ("js/ui/step-seq.js",       ["StepSeq", "resizePattern"]),
    ("js/ui/pattern-bank.js",   ["createPatternBank"]),
    ("js/ui/keybed.js",         ["createKeybed"]),
    ("js/core/audio-engine.js", ["engine"]),
    ("js/core/dsp.js",          ["noise", "lfsrNoise", "env", "autoStop", "midiToHz", "applyFilterEnv"]),
    ("js/core/inserts.js",      ["INSERT_TYPES", "insertMeta", "createInsert", "insertChainLatencySec", "UI_PARAMS", "EQ_TYPES", "FILTER_DELAY_TYPES", "DELAY_SYNC_BUTTONS", "RESONATOR_INTERVALS", "INSERT_COLORS", "RATIO_MODE_BUTTONS", "OPTO_MODE_BUTTONS", "GEQ_FREQS", "makeFeedbackClipCurve"]),
    ("js/core/modular.js",      ["MODULE_TYPES", "moduleMeta", "ModularPatch", "MODULE_PORTS", "MODULE_UI_PARAMS", "OSCILLATOR_WAVES", "FILTER_TYPES"]),
    ("js/core/transport.js",    ["transport", "STEPS_PER_BAR", "shuffleTime"]),
    ("js/core/automation.js",   ["automation"]),
    ("js/core/modulators.js",   ["LFO_WAVES", "LFO_SYNC_BUTTONS", "ARP_MODES", "ARP_SYNC_BUTTONS", "MODULATOR_TYPES", "MOD_DISPLAY", "MOD_COLORS", "createModulator"]),
    ("js/ui/insert-chain.js",   ["openInsertPicker", "renderInsertChain", "INSERT_DISPLAY"]),
    ("js/ui/modulation-chain.js", ["openModulatorPicker", "renderModulationChain"]),
    ("js/ui/modular-view.js",   ["renderModularRack"]),
    ("js/core/fx.js",           ["masterFX"]),
    ("js/core/song.js",         ["song"]),
    ("js/core/recorder.js",     ["recorder"]),
    ("js/core/mic-recorder.js", ["micRecorder"]),
    ("js/core/sample-store.js", ["sampleStore", "newSampleId", "arrayBufferToBase64", "base64ToArrayBuffer"]),
    ("js/core/jamlink.js",      ["jamlink", "packSignal", "unpackSignal"]),
    ("js/machines/machine.js",  ["Machine", "openRenamePopup"]),
    ("js/machines/tracked-drum-machine.js", ["TrackedDrumMachine"]),
    ("js/machines/step-sequenced-synth.js", ["StepSequencedSynth"]),
    ("js/machines/subsynth.js", ["SubSynth"]),
    ("js/machines/beatbox.js",  ["BeatBox"]),
    ("js/machines/percsynth.js", ["PercSynth"]),
    ("js/machines/polysynth.js", ["PolySynth"]),
    ("js/machines/analogkit.js", ["AnalogKit"]),
    ("js/machines/sampler.js",  ["Sampler"]),
    ("js/machines/fmsynth.js",  ["FMSynth"]),
    ("js/machines/acidbass-worklet.js", ["ACIDBASS_WORKLET_SRC"]),
    ("js/machines/acidbass.js", ["AcidBass"]),
    ("js/machines/kicksynth.js", ["KickSynth"]),
    ("js/machines/psysynth.js", ["PsySynth"]),
    ("js/machines/modular.js",  ["Modular"]),
    ("js/rack/rack.js",         ["Rack", "REGISTRY"]),
    ("js/rack/jam-view.js",     ["initJamView", "renderJamView", "stopAllClips"]),
    ("js/core/project.js",      ["serializeProject", "loadProject", "importMachines", "newProject"]),
    ("js/main.js",              []),
]

CSS_FILES = ["css/tokens.css", "css/app.css", "css/components.css"]


def strip_module_syntax(src: str) -> str:
    src = re.sub(r"^import .*$\n", "", src, flags=re.M)        # Import-Zeilen
    src = re.sub(r"^export \{[^}]*\};\s*$\n", "", src, flags=re.M)
    src = re.sub(r"^export ", "", src, flags=re.M)             # export-Prefix
    return src


def bundle_js() -> str:
    parts = []
    for path, exports in MODULES:
        body = strip_module_syntax((ROOT / path).read_text())
        if exports:
            names = ", ".join(exports)
            parts.append(
                f"/* ===== {path} ===== */\n"
                f"const {{ {names} }} = (() => {{\n{body}\nreturn {{ {names} }};\n}})();"
            )
        else:
            parts.append(f"/* ===== {path} ===== */\n(() => {{\n{body}\n}})();")
    return "\n\n".join(parts)


def main():
    css = "\n".join((ROOT / f).read_text() for f in CSS_FILES)
    js = bundle_js()

    html = (ROOT / "index.html").read_text()
    html = re.sub(r'\s*<link rel="stylesheet"[^>]*>\n', "", html)
    html = html.replace("</head>", f"<style>\n{css}\n</style>\n</head>")
    html = html.replace(
        '<script type="module" src="js/main.js"></script>',
        f"<script>\n{js}\n</script>",
    )
    html = html.replace("<title>", "<title>Preview — ")

    OUT.write_text(html)
    print(f"OK → {OUT} ({len(html)} Bytes)")


if __name__ == "__main__":
    main()
