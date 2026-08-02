# RackWerk

Groovebox-Web-App im Stil von Caustic 3 — Web-first (Web Audio API), Touch-first,
gebaut für spätere Verpackung mit Capacitor (iOS/Android).

## Aufbau dieses Repos

| Pfad | Zweck |
|---|---|
| `index.html` | Gebündelte Einzeldatei — das, was GitHub Pages ausliefert. Wird generiert, nicht von Hand bearbeitet! |
| `src/` | Das modulare Quellprojekt (ES-Module, CSS, Bundler). Hier wird entwickelt. |
| `tools/` | Dev-Werkzeuge (nicht Teil der App), z. B. der Layout-Check. |

## Entwickeln & Deployen

1. Änderungen in `src/` machen (Details zur Architektur: [`src/README.md`](src/README.md)).
2. Bundle bauen:
   ```bash
   cd src
   python3 build-preview.py        # erzeugt rackwerk-preview.html
   ```
3. Für GitHub Pages: den Titel-Präfix entfernen und als `index.html` ins Repo-Root legen:
   ```bash
   sed 's/<title>Preview — /<title>/' rackwerk-preview.html > ../index.html
   ```
4. Commit auf `main` → Pages ist nach 1–2 Minuten aktuell.

**Wichtig:** Jedes neue JS-Modul und jeder neue Export muss in die `MODULES`-Liste
in `src/build-preview.py` eingetragen werden (in Abhängigkeitsreihenfolge), sonst
fehlt er im Bundle.

## Layout-Check (nach jeder UI-Änderung)

Die App ist Touch-first und wird nur auf dem iPhone genutzt. Nach **jeder**
Änderung an Markup/CSS/Layout wird `tools/layout-check.mjs` ausgeführt: Es bootet
das gebündelte `index.html` in Chromium über gängige iPhone-Breiten (320–430 px)
und prüft, dass nichts horizontal aus dem Bild läuft und die Transport-Bedien-
elemente (Play, PRJ, REC, BPM) immer komplett sichtbar sind.

```bash
python3 -m http.server 8901 &        # Server auf dem Repo-Root
node tools/layout-check.mjs          # exit 0 = alles passt
```

(Braucht Playwright als Dev-Abhängigkeit — `npm i playwright`; die App selbst
bleibt abhängigkeitsfrei.)

## DSP-/Regressionstests (nach jeder Änderung an Inserts/Maschinen-DSP)

`tools/dsp-tests/` enthält Playwright-Skripte, die echtes Audio (nicht nur
UI-Zustand) über AnalyserNode/AudioWorklet-Introspektion prüfen: eq8s
Flankensteilheiten, das Reverb-/Resonator-Damping, den AcidBass-DSP-Kern
(Endlichkeit, Headroom, Zipper-Freiheit) sowie die Touch-Interaktion der
eq8-/Insert-Chain-UI. Jede Datei ist einzeln lauffähig
(`node tools/dsp-tests/eq8-slopes.mjs`), der Runner baut das Bundle und
führt alle auf einmal aus:

```bash
node tools/dsp-check.mjs             # baut das Bundle + testet, exit 0 = alles grün
node tools/dsp-check.mjs --no-build  # nutzt das vorhandene index.html
```

Startet dafür einen eigenen, isolierten Server (Port 8987) — kein manueller
Server-Start nötig, anders als beim Layout-Check. Braucht ebenfalls
Playwright als Dev-Abhängigkeit.

Diese Tests decken reale, in der Entwicklung gefundene Bugs ab (u. a. eine
Web-Audio-Render-Quantum-Latenz, die eq8s 6/18dB/Okt-Flanken und das
Reverb-/Resonator-Damping unbemerkt um Grössenordnungen verstellte) —
gehören also bei jeder Änderung an `core/inserts.js`, den beiden
`*-worklet.js`-DSP-Kernen oder `ui/insert-chain.js` mit dazu.
