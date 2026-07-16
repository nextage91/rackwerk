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
    ("js/ui/knob.js",           ["XKnob"]),
    ("js/ui/fader.js",          ["XFader"]),
    ("js/vendor/qrcodegen.js",  ["qrcodegen"]),
    ("js/vendor/jsqr.js",       ["jsQR"]),
    ("js/ui/qr.js",             ["drawQR"]),
    ("js/ui/step-seq.js",       ["StepSeq", "resizePattern"]),
    ("js/ui/pattern-bank.js",   ["createPatternBank"]),
    ("js/ui/keybed.js",         ["createKeybed"]),
    ("js/core/store.js",        ["store"]),
    ("js/core/audio-engine.js", ["engine"]),
    ("js/core/dsp.js",          ["noise", "env", "autoStop", "midiToHz"]),
    ("js/core/transport.js",    ["transport", "STEPS_PER_BAR"]),
    ("js/core/fx.js",           ["masterFX"]),
    ("js/core/automation.js",   ["automation"]),
    ("js/core/song.js",         ["song"]),
    ("js/core/recorder.js",     ["recorder"]),
    ("js/core/jamlink.js",      ["jamlink", "packSignal", "unpackSignal"]),
    ("js/machines/machine.js",  ["Machine"]),
    ("js/machines/subsynth.js", ["SubSynth"]),
    ("js/machines/beatbox.js",  ["BeatBox"]),
    ("js/machines/percsynth.js", ["PercSynth"]),
    ("js/machines/polysynth.js", ["PolySynth"]),
    ("js/machines/analogkit.js", ["AnalogKit"]),
    ("js/rack/rack.js",         ["Rack", "REGISTRY"]),
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
