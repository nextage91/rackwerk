# RackWerk

Modulare Groovebox im Stil von Caustic 3 — Web-first (Web Audio API), gebaut für spätere Verpackung mit Capacitor (iOS/Android).

## Starten

Das Projekt nutzt native ES-Module und braucht deshalb einen lokalen Server (kein Build-Schritt nötig):

```bash
npx serve .
# oder
python3 -m http.server 8080
```

Dann im Browser öffnen — am besten in den mobilen DevTools (Touch-Emulation) oder direkt am Gerät im selben Netzwerk testen.

## Architektur

```
index.html            App-Shell: Transport, Rack, Sheet, Unlock-Overlay
css/
  tokens.css          Design-Tokens (Farben, Touch-Maße, Safe-Areas)
  app.css             Layout: Transport-Leiste, Rack, Bottom-Sheet
  components.css      Maschinen-Faceplate, Knob, Keybed
js/
  main.js             Bootstrap: Unlock → Rack → Transport-UI
  core/
    audio-engine.js   Singleton-AudioContext, Master-Bus + Limiter
    dsp.js            Gemeinsame Helfer: Noise-Buffer, Env, AutoStop
    store.js          localStorage-Wrapper mit In-Memory-Fallback
    project.js        Session serialisieren, laden, Maschinen importieren
    recorder.js       Master-Summe als Audiodatei mitschneiden
    jamlink.js        2-Geräte-Sync: WebRTC-Clock (NTP-Abgleich, sanftes Nachziehen)
    transport.js      Lookahead-Scheduler (sample-genau), BPM, Steps, Loop-Phase
    automation.js     Parameterfahrten aufnehmen (REC) und im Loop abspielen
  rack/
    rack.js           Maschinen-Registry, Slots, Hinzufügen/Entfernen
  machines/
    machine.js        Basisklasse: Output-Gain, Mute, Faceplate-Gerüst
    subsynth.js       Demo-Synth (Saw → Lowpass → Env) mit Touch-Keybed
    beatbox.js        8-Spur-Drum-Machine, Sounds komplett synthetisiert
    percsynth.js      FM-Percussion (Zaps, Bells, Congas) mit Pitch-Grid
  ui/
    knob.js           <x-knob>: vertikaler Drag, Doppeltipp = Reset
    step-seq.js       16-Step-Grid: Tippen = an/aus, vertikal ziehen = Pitch
```

### Kernentscheidungen

- **Ein AudioContext für die ganze App** (`engine`-Singleton). Er wird erst nach einer Nutzergeste erzeugt — Pflicht auf iOS/Android-WebViews.
- **Lookahead-Scheduling im Transport**: Noten werden ~100 ms im Voraus auf der AudioContext-Uhr geplant. Das Timing bleibt stabil, auch wenn der Main-Thread ruckelt.
- **Maschinen sind Klassen mit klarem Vertrag** (`buildAudio`, `buildControls`, `onStep`, `disposeAudio`). Neue Maschinen: Klasse anlegen, in `rack.js` in `REGISTRY` eintragen — fertig.
- **Automation über die Knob-Leitung**: Aufgezeichnete Fahrten setzen den Knob-Wert und feuern dessen `input`-Event — Maschinen brauchen keinen Automation-Code. Knobs werden per `data-auto`-Attribut automatisierbar; die Lane hat 128 Slots pro Takt und wird beim Playback linear interpoliert. Drehen ohne aktive Aufnahme verschiebt die ganze Lane relativ (Trim: linear additiv, log-Knobs multiplikativ); Long-Press auf einen Knob bietet das Löschen seiner Lane an.
- **Touch-first**: Alle Ziele ≥ 44 px, `touch-action: none` auf Knobs/Keys (kein versehentliches Scrollen), Pointer Events überall (funktioniert identisch mit Maus, Stift, Finger), Keybed mit Glissando via `elementFromPoint`.

## Capacitor-Vorbereitung (bereits eingebaut)

- `viewport-fit=cover` + `env(safe-area-inset-*)` für Notch/Home-Indicator
- Kein Body-Scroll, `overscroll-behavior: none` (kein Pull-to-Refresh)
- Nur relative Pfade, keine externen CDNs/Fonts → läuft offline im WebView
- Audio-Unlock-Overlay als erste Interaktion

Wenn es so weit ist: `npx cap init`, dieses Verzeichnis als `webDir` konfigurieren (oder vorher in ein `dist/` kopieren), dann `npx cap add ios android`.

## Nächste Schritte (Vorschlag)

1. **Persistenz** — Patterns, Parameter und Automation-Lanes in IndexedDB speichern/laden; Export als JSON.
2. **Mehrere Patterns pro Maschine** (A/B/C/D) mit Umschaltung, danach Song-Mode.
3. **Mixer-Sektion** — pro Maschine Pan/Level auf dem Master-Bus, später Sends + Effekte.
4. **AudioWorklet** statt nativer Nodes, sobald eigene DSP nötig wird.
