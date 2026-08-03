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
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).parent
OUT = ROOT / "rackwerk-preview.html"

# Reihenfolge = Abhängigkeitsreihenfolge; Werte = exportierte Namen
MODULES = [
    ("js/core/undo.js",         ["undo"]),
    ("js/core/store.js",        ["store"]),
    ("js/core/hints.js",        ["hintOnce", "showHintToast", "hintSeen", "markHintSeen"]),
    ("js/ui/knob.js",           ["XKnob"]),
    ("js/ui/fader.js",          ["XFader"]),
    ("js/ui/meter.js",          ["XMeter", "computeLevels"]),
    ("js/vendor/qrcodegen.js",  ["qrcodegen"]),
    ("js/vendor/jsqr.js",       ["jsQR"]),
    ("js/ui/qr.js",             ["drawQR"]),
    ("js/ui/step-seq.js",       ["StepSeq", "resizePattern"]),
    ("js/ui/pattern-bank.js",   ["createPatternBank"]),
    ("js/ui/keybed.js",         ["createKeybed"]),
    ("js/core/audio-engine.js", ["engine"]),
    ("js/core/dsp.js",          ["noise", "lfsrNoise", "env", "autoStop", "midiToHz", "applyFilterEnv"]),
    ("js/core/onepole-worklet.js", ["ONEPOLE_WORKLET_SRC"]),
    ("js/core/resonator-worklet.js", ["RESONATOR_PROCESSOR_NAME", "RESONATOR_PARAMS", "RESONATOR_META_JSON", "RESONATOR_WASM_BASE64", "RESONATOR_WORKLET_SRC"]),
    ("js/core/inserts.js",      ["INSERT_TYPES", "insertMeta", "createInsert", "insertChainLatencySec", "UI_PARAMS", "EQ_TYPES", "EQ_SLOPES", "EQ8_GAIN_RANGES", "FILTER_DELAY_TYPES", "DELAY_SYNC_BUTTONS", "INSERT_COLORS", "RATIO_MODE_BUTTONS", "OPTO_MODE_BUTTONS", "GEQ_FREQS", "makeFeedbackClipCurve", "makeDriveCurve"]),
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
    ("js/rack/jam-view.js",     ["initJamView", "renderJamView", "stopAllClips", "exitJamMode", "serializeScenes", "deserializeScenes"]),
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


def check_syntax(js: str) -> None:
    """Prüft das gebündelte JS mit `node --check`, falls Node verfügbar ist.

    Motivation (echter, hier aufgetretener Fehler): die beiden Worklet-
    Dateien (machines/acidbass-worklet.js, core/eq8-onepole-worklet.js)
    liefern ihren DSP-Code als Template-Literal-STRING aus, weil RackWerk
    als eine einzelne HTML-Datei ausgeliefert wird (s. dortige Dateiköpfe).
    Ein einzelnes Backtick irgendwo in diesem String -- z. B. in einem
    Kommentar, der eine Code-Stelle zitieren will -- beendet das Literal
    vorzeitig und macht das GESAMTE Bundle unparsbar. Im unmodularisierten
    Dev-Server fällt das nicht auf, weil dort andere Dateigrenzen gelten;
    sichtbar wird es erst als weisse Seite mit einem SyntaxError, der
    irgendwo weit hinter der eigentlichen Ursache zeigt.

    Ohne Node im PATH wird still übersprungen -- der Check ist ein
    Sicherheitsnetz, keine harte Build-Abhängigkeit.
    """
    node = shutil.which("node")
    if not node:
        print("Hinweis: node nicht gefunden -- Syntaxprüfung übersprungen.")
        return
    with tempfile.NamedTemporaryFile("w", suffix=".js", encoding="utf-8", delete=False) as fh:
        fh.write(js)
        tmp = fh.name
    try:
        res = subprocess.run([node, "--check", tmp], capture_output=True, text=True)
        if res.returncode != 0:
            # Zeilennummern beziehen sich auf das Bundle -- der Kommentarkopf
            # jedes Moduls (/* ===== pfad ===== */) zeigt, aus welcher Datei
            # die betroffene Stelle stammt.
            raise SystemExit(
                "FEHLER: das gebündelte JS ist nicht parsbar.\n"
                "Häufigste Ursache: ein Backtick im Quelltext-String eines\n"
                "Worklets (s. check_syntax() in dieser Datei).\n\n"
                + res.stderr.strip()
            )
    finally:
        pathlib.Path(tmp).unlink(missing_ok=True)


def main():
    css = "\n".join((ROOT / f).read_text() for f in CSS_FILES)
    js = bundle_js()
    check_syntax(js)

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
