/**
 * main.js — verdrahtet Engine, Transport, Rack und die Transport-Leiste.
 */
import './ui/knob.js';                       // registriert <x-knob>
import './ui/fader.js';                      // registriert <x-fader>
import './ui/meter.js'; // registriert <x-meter>
import { drawQR } from './ui/qr.js';
import { jsQR } from './vendor/jsqr.js';
import { engine } from './core/audio-engine.js';
import { transport, STEPS_PER_BAR } from './core/transport.js';
import { automation } from './core/automation.js';
import { store } from './core/store.js';
import { serializeProject, loadProject, importMachines, newProject } from './core/project.js';
import { recorder } from './core/recorder.js';
import { sampleStore, arrayBufferToBase64 } from './core/sample-store.js';
import { jamlink } from './core/jamlink.js';
import { masterFX } from './core/fx.js';
import { song } from './core/song.js';
import { undo } from './core/undo.js';
import { hintOnce, showHintToast } from './core/hints.js';
import { Rack, REGISTRY } from './rack/rack.js';
import { initJamView, renderJamView, stopAllClips, exitJamMode } from './rack/jam-view.js';
import { initChannelStripView } from './ui/channel-strip-view.js';

const $ = (sel) => document.querySelector(sel);
const SAMPLER_CLASS = REGISTRY.find((M) => M.meta.type === 'sampler');

/** Öffnen-Funktionen für Mix/Song/Jam, von wireChannelStripView/wireSongUI/
 *  wireJamViewUI befüllt -- die Bottom-Bar (wireBottomBar) ruft sie auf,
 *  ohne die jeweilige Sheet-Logik zu duplizieren. */
const modeOpen = {};

/** Schliesst JEDE app-weite Overlay-Ebene -- die eigentliche Ein-Fenster-
 *  Regel (Nutzer-Anfrage: die Overlays "lappen" beim Tab-Wechsel
 *  übereinander, weil bisher jede Stelle nur GEGEN sich selbst schloss,
 *  nicht gegen alle anderen). Deckt die drei Bottom-Bar-Konsolen + das
 *  Projekte-Sheet hier ab, sowie (über rack.closeOverlays()) Rack selbst:
 *  jedes Maschinen-Fokus-Overlay + das Add-Machine-Sheet. Jede Stelle, die
 *  eine neue Ebene öffnet, ruft das VORHER auf -- Bottom-Bar-Tabs
 *  (wireBottomBar), Projekte-Sheet (wireProjectUI), und Rack selbst über
 *  den rack.onBeforeOpenOverlay-Hook (s. rack.js) für Maschinen-Fokus/
 *  Add-Machine-Sheet, damit z. B. ein offen gelassenes Add-Machine-Sheet
 *  nicht mehr jeden weiteren Tap abfängt (per Reproduktion bestätigt: ein
 *  Tap auf einen Bottom-Bar-Tab registrierte dann gar nicht mehr). */
function closeAllOverlays(rack) {
  $('#project-sheet').hidden = true;
  $('#mixer-sheet').hidden = true;
  $('#song-sheet').hidden = true;
  $('#jam-sheet').hidden = true;
  rack.closeOverlays();
}

/** Während des interaktiven Tutorials (s. wireOnboardingUI) läuft eine
 *  eigene Wegwerf-Session im selben `rack` -- Autosave (boot()) UND das
 *  Projekte-Sheet (wireProjectUI) müssen das wissen, um NICHT versehentlich
 *  Demo-Inhalt über die echte Session zu schreiben (Autosave-Slot bzw.
 *  ein benanntes gespeichertes Projekt). Modulweites Flag statt Parameter-
 *  Durchreichen, weil beide Stellen unabhängig voneinander in main.js
 *  verdrahtet werden. */
let tutorialActive = false;

/* ---------- 1) Audio-Unlock (Pflicht-Geste auf iOS/Android) ---------- */
$('#btn-unlock').addEventListener('click', async () => {
  const hint = $('#btn-unlock small');
  try {
    const ok = await engine.unlock();
    if (!ok) {
      hint.textContent = 'Audio blocked — tap again';
      return;
    }
  } catch (err) {
    console.error('Audio unlock failed:', err);
    hint.textContent = 'Audio unavailable: ' + err.message;
    return;
  }

  $('#unlock-overlay').hidden = true;
  boot();
});

/* iOS pausiert den AudioContext beim App-Wechsel (Jam-Codes verschicken!)
   und weckt ihn nicht selbst wieder auf. Symptom: Gast spielt, Host bleibt
   stumm. Deshalb: bei Rückkehr in die App und bei jeder Berührung wieder
   anwerfen — resume() ist idempotent und kostet im Normalfall nichts. */
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) engine.resume();
});
window.addEventListener('focus', () => engine.resume());
document.addEventListener('pointerdown', () => engine.resume(), true);

/* Transport-Höhe als CSS-Variable durchreichen — der Vollbild-Mixer setzt
   sich darunter, damit Play/Stop/BPM auch bei offenem Mixer bedienbar
   bleiben. Höhe hängt von der Safe-Area ab, deshalb bei Resize/Rotation
   neu messen statt einen Fixwert zu raten. */
const syncTransportHeight = () => {
  const h = $('#transport')?.getBoundingClientRect().height;
  if (h) document.documentElement.style.setProperty('--transport-h', `${h}px`);
};
/* Gleiche Idee für die Bottom-Bar (--bottombar-h): die Konsolen-Sheets
   (.sheet__panel--console) und der Vollbild-Machine-Editor lassen unten
   genau so viel Platz frei, wie die Bar gerade braucht (Safe-Area-abhängig,
   deshalb messen statt raten). */
const syncBottomBarHeight = () => {
  const h = $('#bottombar')?.getBoundingClientRect().height;
  if (h) document.documentElement.style.setProperty('--bottombar-h', `${h}px`);
};
/* html/body selbst brauchen dieselbe Behandlung, damit sie in JEDEM
   Kontext (Browser-Tab, Homescreen-Standalone, Rotation) exakt den von
   window.innerHeight gemeldeten Bereich ausfüllen -- 100dvh reicht dafür
   auf iOS nicht überall zuverlässig. Per Diagnose bestätigt: html/body/
   Bottom-Bar füllen damit bereits exakt den Bereich, den iOS der Seite
   zur Verfügung stellt (html.rect.bottom === innerHeight, keine Lücke
   IM Layout). Ein evtl. verbleibender toter Streifen unten im Homescreen-
   Standalone-Modus (App per "Zum Home-Bildschirm" statt echter App-Store-
   Installation) liegt AUSSERHALB dieses Bereichs -- eine von iOS reservierte
   Zone, die über kein CSS/JS von der Seite aus erreichbar ist (kein Safe-
   Area-Wert, keine Viewport-API zeigt sie an). Das ist eine Plattform-
   Grenze, kein Layout-Bug. */
const syncViewportHeight = () => {
  document.documentElement.style.setProperty('--app-vh', `${window.innerHeight}px`);
};
window.addEventListener('resize', () => { syncViewportHeight(); syncTransportHeight(); syncBottomBarHeight(); });
window.addEventListener('orientationchange', () => { syncViewportHeight(); syncTransportHeight(); syncBottomBarHeight(); });
syncViewportHeight();
syncTransportHeight();
syncBottomBarHeight();

/* ---------- 2) App-Start, sobald Audio bereit ist ---------- */
function boot() {
  const rack = new Rack($('#rack'), $('#machine-sheet'));
  rack.onBeforeOpenOverlay = () => closeAllOverlays(rack);
  song.bind(rack); // Song-Wiedergabe/-Aufnahme braucht Zugriff aufs Rack

  // Master-Effekte: Ketten an die Send-Busse hängen, Panel ans Rack-Ende
  masterFX.init();
  $('#rack').appendChild(masterFX.render());

  // Letzte Session wiederherstellen; sonst Startbesetzung mit Demo-Groove
  let restored = false;
  const autosave = store.get('autosave');
  if (autosave) {
    try {
      loadProject(rack, JSON.parse(autosave));
      restored = true;
    } catch (err) {
      console.warn('Autosave could not be loaded, starting fresh:', err);
    }
  }
  if (!restored) {
    newProject(rack); // Startbesetzung: BeatBox + SubSynth mit Demo-Groove
  }

  wireTransportUI();
  wireProjectUI(rack);
  const jam = wireJamUI(rack);
  wireSongUI(rack);
  wireChannelStripView(rack);
  initJamView(rack);
  wireJamViewUI();
  wireBottomBar(rack); // braucht modeOpen.{mix,song,jam}, also NACH den drei wireXUI oben
  wireUndoUI();
  wireOnboardingUI(rack);

  // Per Kamera-Scan geöffnet? (#jam=Code in der URL) → direkt beitreten.
  // Hash sofort entfernen, damit ein Reload nicht erneut beitritt.
  const jamCode = location.hash.match(/#jam=(.+)$/);
  if (jamCode) {
    history.replaceState(null, '', location.pathname + location.search);
    $('#project-sheet').hidden = false;
    jam.joinWithCode(jamCode[1]);
  }

  // Autosave: alle 3 s den kompletten Zustand sichern -- pausiert während
  // der Tutorial-Sandbox (s. tutorialActive), sonst würde die Wegwerf-Demo-
  // Session den echten Autosave-Slot überschreiben.
  setInterval(() => {
    if (tutorialActive) return;
    try {
      store.set('autosave', JSON.stringify(serializeProject(rack)));
    } catch (err) {
      console.warn('Autosave failed:', err);
    }
  }, 3000);
}

/* ---------- Projekte-Sheet ---------- */
function wireProjectUI(rack) {
  const sheet = $('#project-sheet');
  const list = $('#project-list');
  const nameInput = $('#project-name');

  $('#project-hint').hidden = store.persistent;

  // Merkt sich, unter welchem Namen zuletzt gespeichert/geladen wurde --
  // unabhängig vom Autosave (eigener, fester Speicherplatz, kennt keinen
  // Namen) UND unabhängig vom Namensfeld selbst (nur eine DOM-Eigenschaft,
  // beim Neuladen der Seite weg). Ohne das musste man nach jedem Neustart
  // den Namen erneut eintippen, nur um das gewohnte Projekt zu
  // überschreiben -- selbst wenn der Autosave denselben Inhalt schon
  // wiederhergestellt hatte (Nutzer-Feedback, s. Chat).
  nameInput.value = store.get('currentProjectName') ?? '';

  // Während der Tutorial-Sandbox zeigt `rack` Demo-Inhalt statt der echten
  // Session (s. tutorialActive) -- Speichern/Laden/Import/Export hier
  // gesperrt, sonst könnte Speichern versehentlich ein echtes gespeichertes
  // Projekt mit Demo-Daten überschreiben (Löschen bestehender Projekte
  // bleibt erlaubt, betrifft nur den Store, nicht den Sandbox-Inhalt).
  const blockedDuringTutorial = () => {
    if (!tutorialActive) return false;
    showHintToast('Finish the tour first — Save/Load is disabled during the demo.');
    return true;
  };

  const refreshList = () => {
    list.innerHTML = '';
    const names = store.keys()
      .filter((k) => k.startsWith('project:'))
      .map((k) => k.slice('project:'.length))
      .sort();
    if (!names.length) {
      list.innerHTML = '<p class="sheet__empty">No saved projects yet.</p>';
      return;
    }
    for (const name of names) {
      const item = document.createElement('div');
      item.className = 'sheet__item sheet__item--project';
      item.innerHTML = `
        <button class="project__load">${name}</button>
        <button class="project__delete" aria-label="Delete project">✕</button>
      `;
      item.querySelector('.project__load').addEventListener('click', () => {
        if (blockedDuringTutorial()) return;
        // Snapshot der laufenden Session VOR dem Laden -- loadProject()
        // leert das Rack sofort (rack.clear()); scheitert das Parsen/
        // Deserialisieren mittendrin, bliebe ohne Rollback ein halb
        // geleertes Rack stehen, das der Autosave 3s später über die
        // letzte gute Session schreibt (stiller Datenverlust).
        const backup = serializeProject(rack);
        try {
          loadProject(rack, JSON.parse(store.get(`project:${name}`)));
          nameInput.value = name;
          store.set('currentProjectName', name);
          sheet.hidden = true;
        } catch (err) {
          console.error('Project could not be loaded:', err);
          loadProject(rack, backup);
          showHintToast('Project could not be loaded — the file seems to be damaged. Your previous session was restored.');
        }
      });
      item.querySelector('.project__delete').addEventListener('click', () => {
        store.remove(`project:${name}`);
        refreshList();
      });
      list.appendChild(item);
    }
  };

  $('#btn-projects').addEventListener('click', () => {
    closeAllOverlays(rack); // schliesst auch ein evtl. offenes Maschinen-Fokus/Add-Machine-Sheet/anderen Tab
    refreshList();
    sheet.hidden = false;
  });
  sheet.querySelector('[data-close]').addEventListener('click', () => {
    sheet.hidden = true;
  });

  $('#btn-save-project').addEventListener('click', () => {
    if (blockedDuringTutorial()) return;
    const name = nameInput.value.trim() || 'Untitled';
    store.set(`project:${name}`, JSON.stringify(serializeProject(rack)));
    store.set('currentProjectName', name);
    refreshList();
    showHintToast(`Saved: ${name}`, 2000);
  });

  $('#btn-new-session').addEventListener('click', () => {
    if (blockedDuringTutorial()) return;
    // Verwirft die aktuelle Session (Autosave überschreibt sie gleich) —
    // deshalb einmal nachfragen.
    if (!window.confirm('Start a new session? The current setup will be ' +
      'discarded (unsaved changes will be lost).')) return;
    newProject(rack);
    nameInput.value = '';
    // Bewusst gelöscht statt nur das Feld zu leeren: ohne das würde ein
    // Reload direkt nach "New Session" den alten Namen wieder ins Feld
    // zurückholen (s. oben) -- eine frische Session soll beim nächsten
    // Speichern wieder nach einem Namen fragen, nicht versehentlich das
    // vorherige Projekt überschreiben.
    store.remove('currentProjectName');
    sheet.hidden = true;
  });

  /* ---- Export / Import als Datei ---- */
  const download = (filename, blob) => {
    try {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    } catch (err) {
      console.error('Download not possible:', err);
    }
  };

  // Sampler-Maschinen speichern in serializeProject() nur die IndexedDB-
  // Referenz-ID (state.tracks[].sampleId, s. sampler.js) -- die ist auf
  // einem ANDEREN Gerät/Browser-Profil bedeutungslos. Für den Datei-Export
  // holt diese Funktion die Rohdaten einmalig nach und bettet sie als
  // Base64 ein (state.tracks[].sampleData), damit die Datei überall
  // eigenständig lauffähig ist. Autosave/"Save Project" (beide über
  // store.js/localStorage) durchlaufen das bewusst NICHT — dort bleibt
  // die IndexedDB-Referenz genügend (gleiches Gerät, "voll persistent"
  // war genau dafür die Anforderung).
  const embedSamplerSamples = async (data) => {
    for (const md of data.machines) {
      if (md.type !== 'sampler') continue;
      for (const tr of md.state.tracks ?? []) {
        if (!tr.sampleId) continue;
        const arrBuf = await sampleStore.get(tr.sampleId);
        if (arrBuf) tr.sampleData = arrayBufferToBase64(arrBuf);
      }
    }
  };

  $('#btn-export').addEventListener('click', async () => {
    if (blockedDuringTutorial()) return;
    const name = (nameInput.value.trim() || 'session').replace(/[^\wäöüÄÖÜß-]+/g, '_');
    const data = serializeProject(rack);
    await embedSamplerSamples(data);
    const json = JSON.stringify(data, null, 2);
    download(`rackwerk-${name}.json`, new Blob([json], { type: 'application/json' }));
  });

  const fileInput = $('#file-input');
  let importMode = 'replace';
  $('#btn-import-replace').addEventListener('click', () => { importMode = 'replace'; fileInput.click(); });
  $('#btn-import-merge').addEventListener('click', () => { importMode = 'merge'; fileInput.click(); });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    if (blockedDuringTutorial()) { fileInput.value = ''; return; }
    const reader = new FileReader();
    reader.onload = () => {
      // Snapshot VOR dem Import -- bei "replace" leert loadProject() das
      // Rack sofort; bricht das Parsen/Deserialisieren einer beschädigten
      // Datei mittendrin ab, bliebe ohne Rollback ein halb geleertes/halb
      // befülltes Rack stehen, das der Autosave 3s später über die letzte
      // gute Session schreibt (stiller Datenverlust). Bei "merge" ist der
      // Backup ein günstiges No-Op-Netz für denselben Fehlerfall.
      const backup = serializeProject(rack);
      try {
        const data = JSON.parse(reader.result);
        if (importMode === 'replace') loadProject(rack, data);
        else importMachines(rack, data);
        sheet.hidden = true;
      } catch (err) {
        console.error('Import failed:', err);
        loadProject(rack, backup);
        showHintToast('Import failed — the file seems to be damaged or isn\'t a RackWerk project. Your previous session was restored.');
      }
      fileInput.value = '';
    };
    reader.readAsText(file);
  });

  /* ---- Master-Aufnahme ---- */
  const recBtn = $('#btn-audio-rec');
  const recTime = $('#rec-time');
  const recResult = $('#rec-result');
  const prjBtn = $('#btn-projects');
  let recTimer = null;

  const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  recBtn.addEventListener('click', async () => {
    if (!recorder.active) {
      if (!recorder.supported) {
        recResult.textContent = 'Recording is unfortunately not supported by this WebView.';
        return;
      }
      if (!recorder.start()) return;
      recBtn.textContent = '■ Stop & Save';
      recTime.hidden = false;
      prjBtn.classList.add('is-recording');
      recTimer = setInterval(() => { recTime.textContent = fmtTime(recorder.elapsed); }, 500);
    } else {
      clearInterval(recTimer);
      const result = await recorder.stop();
      recBtn.textContent = '● Start Recording';
      recTime.hidden = true;
      prjBtn.classList.remove('is-recording');
      if (!result) return;
      recResult.innerHTML = '';

      // 1) Sofort anhören — funktioniert auch in Sandboxes ohne Download
      let url = null;
      try { url = URL.createObjectURL(result.blob); } catch { /* Sandbox */ }
      if (url) {
        const player = document.createElement('audio');
        player.controls = true;
        player.src = url;
        player.className = 'rec-player';
        // Manche Sandboxes blockieren blob:-URLs in Medien-Elementen.
        // Fallback: einmalig als data:-URL nachladen (umgeht die Sperre).
        let retried = false;
        player.addEventListener('error', () => {
          if (retried) {
            player.replaceWith(Object.assign(document.createElement('p'), {
              className: 'sheet__hint',
              textContent: 'Playback is blocked here — please use Download/Share or test in Safari.',
            }));
            return;
          }
          retried = true;
          const reader = new FileReader();
          reader.onload = () => { player.src = reader.result; };
          reader.readAsDataURL(result.blob);
        });
        recResult.appendChild(player);
      }

      // 2) Natives Teilen-Menü (iOS: »In Dateien sichern«, AirDrop, …) —
      //    der zuverlässigste Weg aus eingebetteten WebViews heraus
      const file = new File([result.blob], `rackwerk-jam.${result.ext}`,
        { type: result.blob.type });
      // canShare fehlt in manchen WebViews, obwohl share() existiert →
      // Button auch dann zeigen und den Versuch einfach wagen
      const canShareFiles = navigator.share &&
        (navigator.canShare ? navigator.canShare({ files: [file] }) : true);
      if (canShareFiles) {
        const shareBtn = document.createElement('button');
        shareBtn.className = 'm-btn rec-share';
        shareBtn.textContent = '⇪ Share / Save …';
        shareBtn.addEventListener('click', () => {
          navigator.share({ files: [file] }).catch(() => { /* abgebrochen */ });
        });
        recResult.appendChild(shareBtn);
      }

      // 3) Klassischer Download als dritter Weg (Safari, Desktop)
      if (url) {
        const link = document.createElement('a');
        link.className = 'rec-link';
        link.href = url;
        link.download = `rackwerk-jam.${result.ext}`;
        const kb = Math.round(result.blob.size / 1024);
        link.textContent = `⬇ Download (${fmtTime(result.seconds)}, .${result.ext}, ${kb} KB)`;
        recResult.appendChild(link);
      }
    }
  });
}

/* ---------- Jam-Session ---------- */
function wireJamUI(rack) {
  const idle = $('#jam-idle');
  const setup = $('#jam-setup');
  const active = $('#jam-active');
  const instructions = $('#jam-instructions');
  const codeOut = $('#jam-code-out');
  const codeIn = $('#jam-code-in');
  const status = $('#jam-status');
  const prjBtn = $('#btn-projects');
  const beatLed = $('#jam-beat-led');
  const qrwrap = $('#jam-qrwrap');
  const qrCanvas = $('#jam-qr');
  const netinfo = $('#jam-netinfo');
  const shareBtn = $('#btn-jam-share');
  const scanBtn = $('#btn-jam-scan');
  const scanBox = $('#jam-scan');
  const video = $('#jam-video');

  const show = (phase) => {
    idle.hidden = phase !== 'idle';
    setup.hidden = phase !== 'setup';
    active.hidden = phase !== 'active';
  };

  const fail = (err) => {
    console.error('Jam error:', err);
    instructions.textContent = 'Connection failed: ' + (err?.message ?? err);
  };

  /* ---------- QR-Austausch ----------
     Host-QR enthält eine App-URL (#jam=Code): Der Gast scannt mit der
     normalen Kamera-App, Safari öffnet RackWerk und tritt automatisch
     bei. Der Antwort-QR des Gasts enthält den rohen Code — den scannt
     der Host IN der App (sein RTCPeerConnection lebt in diesem Tab). */
  const joinURL = (code) => `${location.origin}${location.pathname}#jam=${code}`;

  /* Diagnose: Netzwerkwege beider Seiten (aus den ICE-Kandidaten).
     „verdeckt (mDNS)" heißt: Der Browser versteckt die lokale IP —
     deren Auflösung scheitert in vielen Netzen (v. a. Hotspots). */
  const NET_NAMES = { host: 'local', srflx: 'public (STUN)', relay: 'TURN relay' };
  const netLabel = (info) =>
    info.types.map((x) => NET_NAMES[x] ?? x).join(', ') +
    (info.mdns ? ' [address hidden/mDNS]' : '');
  const renderNetInfo = () => {
    const parts = [];
    if (jamlink.localInfo?.types.length) parts.push('Own paths: ' + netLabel(jamlink.localInfo));
    if (jamlink.remoteInfo?.types.length) parts.push('Other side: ' + netLabel(jamlink.remoteInfo));
    netinfo.textContent = parts.join(' · ');
    netinfo.hidden = parts.length === 0;
  };

  const showOwnCode = (code) => {
    codeOut.value = code;
    const ok = drawQR(qrCanvas, jamlink.role === 'host' ? joinURL(code) : code);
    qrwrap.hidden = !ok;
    shareBtn.hidden = !navigator.share;
    renderNetInfo();
  };
  const clearOwnCode = () => {
    codeOut.value = '';
    qrwrap.hidden = netinfo.hidden = shareBtn.hidden = true;
  };

  /* Einmalig Kamera-Freigabe holen, BEVOR Offer/Answer entstehen:
     Mit erteilter Freigabe schreiben die Browser echte lokale IPs statt
     verdeckter mDNS-Namen in die Kandidaten — erst damit klappt die
     Direktverbindung z. B. über den persönlichen Hotspot zuverlässig.
     Abgelehnt? Dann läuft alles wie bisher weiter (mit mDNS). */
  let mediaGranted = false;
  const unlockNetwork = async () => {
    if (mediaGranted || !navigator.mediaDevices?.getUserMedia) return;
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true });
      s.getTracks().forEach((tr) => tr.stop());
      mediaGranted = true;
    } catch { /* abgelehnt — Diagnosezeile zeigt dann „verdeckt (mDNS)" */ }
  };

  /* ---------- QR-Scanner (BarcodeDetector, mit Einfüge-Fallback) ---------- */
  let scanStream = null;
  let scanTimer = null;

  const stopScan = () => {
    clearInterval(scanTimer);
    scanTimer = null;
    scanStream?.getTracks().forEach((tr) => tr.stop());
    scanStream = null;
    scanBox.hidden = true;
    scanBtn.textContent = 'Scan QR';
  };

  // Frame prüfen: BarcodeDetector (Chrome u. a.), sonst jsQR (u. a. iOS Safari)
  let scanDetector = null;
  let grabCanvas = null;
  const detectFrame = async () => {
    if (scanDetector) {
      const found = await scanDetector.detect(video);
      return found[0]?.rawValue ?? null;
    }
    if (!video.videoWidth) return null;
    grabCanvas ??= document.createElement('canvas');
    const scale = Math.min(1, 640 / video.videoWidth);
    grabCanvas.width = Math.round(video.videoWidth * scale);
    grabCanvas.height = Math.round(video.videoHeight * scale);
    const g = grabCanvas.getContext('2d', { willReadFrequently: true });
    g.drawImage(video, 0, 0, grabCanvas.width, grabCanvas.height);
    const img = g.getImageData(0, 0, grabCanvas.width, grabCanvas.height);
    return jsQR(img.data, img.width, img.height)?.data ?? null;
  };

  scanBtn.addEventListener('click', async () => {
    if (scanStream) { stopScan(); return; }
    if (!navigator.mediaDevices?.getUserMedia) {
      instructions.textContent =
        'This browser can\'t access the camera — paste the code below.';
      instructions.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
      return;
    }
    try {
      scanDetector = typeof BarcodeDetector !== 'undefined'
        ? new BarcodeDetector({ formats: ['qr_code'] })
        : null; // → jsQR-Fallback
      scanStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      });
      mediaGranted = true;
      video.srcObject = scanStream;
      await video.play();
      scanBox.hidden = false;
      scanBtn.textContent = 'Stop Scan';
      scanTimer = setInterval(async () => {
        try {
          const text = await detectFrame();
          if (text) {
            stopScan();
            applyCode(text);
          }
        } catch { /* Frame nicht lesbar — weiter versuchen */ }
      }, 250);
    } catch (err) {
      stopScan();
      instructions.textContent =
        'Camera unavailable (' + (err?.name ?? err) + ') — paste the code below.';
      instructions.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    }
  });

  /* Beat-LED: blinkt auf jeder Viertelnote, Taktanfang in Orange.
     Beide Geräte nebeneinander → gleichzeitiges Blinken = Sync steht.
     Geplant auf der Audio-Uhr (gleiche Zeitbasis wie die Noten). */
  const beatListener = {
    onStep(step, time) {
      if (step % 4 !== 0) return;
      const isBar = step % STEPS_PER_BAR === 0;
      const delay = Math.max(0, (time - engine.now) * 1000);
      setTimeout(() => {
        if (!jamlink.connected) return;
        beatLed.classList.add('is-on');
        beatLed.classList.toggle('is-bar', isBar);
        prjBtn.classList.add('is-beat');
        setTimeout(() => {
          beatLed.classList.remove('is-on');
          prjBtn.classList.remove('is-beat');
        }, 110);
      }, delay);
    },
  };

  const stopBeatLed = () => {
    transport.removeListener(beatListener);
    beatLed.classList.remove('is-on', 'is-bar');
    prjBtn.classList.remove('is-linked', 'is-beat');
  };

  const showStatus = () => {
    const ms = Math.max(1, Math.round(jamlink.rtt / 2));
    status.textContent = jamlink.role === 'host'
      ? `Connected as host (±${ms} ms) — this device controls Play/Stop and BPM.`
      : `Connected as guest (±${ms} ms) — the host controls Play/Stop and BPM.`;
  };

  jamlink.onstate = (event) => {
    if (event === 'open') {
      show('active');
      prjBtn.classList.add('is-linked');
      transport.addListener(beatListener);
      status.textContent = jamlink.role === 'host'
        ? 'Connected as host — measuring latency …'
        : 'Connected as guest — syncing clock …';
    } else if (event === 'sync') {
      showStatus();
    } else if (event === 'connecting') {
      instructions.textContent = 'Codes exchanged — devices connecting …';
    } else if (event === 'failed') {
      let msg = 'Connection failed: the devices couldn\'t reach each other. ';
      if (jamlink.remoteInfo?.mdns) {
        msg += 'The other side has hidden addresses [mDNS] — ALLOW the camera ' +
          'prompt there when joining, then try again. ';
      } else if (jamlink.localInfo?.mdns) {
        msg += 'This device has hidden addresses [mDNS] — ALLOW the camera ' +
          'prompt when creating/joining, then try again. ';
      } else {
        msg += 'Most reliable: both on the same Wi-Fi, or one on the ' +
          'other\'s personal hotspot. Then try again. ';
      }
      instructions.textContent = msg;
    } else if (event === 'unstable') {
      status.textContent = 'Connection unstable — trying to recover …';
    } else if (event === 'closed') {
      show('idle');
      stopBeatLed();
    }
  };

  jamlink.onProjectReceived = (data) => {
    try { importMachines(rack, data); } catch (err) { console.error(err); }
  };

  $('#btn-jam-host').addEventListener('click', async () => {
    if (!jamlink.supported) {
      instructions.textContent = 'WebRTC is not supported by this WebView.';
      show('setup');
      codeOut.hidden = codeIn.hidden = true;
      return;
    }
    show('setup');
    codeOut.hidden = codeIn.hidden = false;
    clearOwnCode();
    instructions.textContent =
      '1) The other device scans this QR with the camera app (or you share the link). ' +
      '2) Scan their reply QR here — or paste the reply code below.';
    codeOut.value = 'Generating code …';
    await unlockNetwork(); // real IPs in the code (important for hotspots)
    try { showOwnCode(await jamlink.createOffer()); } catch (err) { fail(err); }
  });

  $('#btn-jam-join').addEventListener('click', () => {
    if (!jamlink.supported) {
      instructions.textContent = 'WebRTC is not supported by this WebView.';
      show('setup');
      codeOut.hidden = codeIn.hidden = true;
      return;
    }
    show('setup');
    codeOut.hidden = codeIn.hidden = false;
    clearOwnCode();
    instructions.textContent =
      '1) Scan the host\'s QR — or paste their code below and Apply. ' +
      '2) Have the host scan your reply QR (or send the reply code back).';
  });

  const applyCode = async (raw) => {
    let code = raw.trim();
    // gescannte/geteilte App-URL → den eigentlichen Code herausziehen
    if (code.includes('#jam=')) code = code.split('#jam=')[1];
    if (!code) return;
    try {
      if (jamlink.pc && jamlink.role === 'host') {
        await jamlink.acceptAnswer(code);          // host: read the reply
        renderNetInfo();
        instructions.textContent = 'Reply applied — devices connecting …';
      } else {
        codeOut.value = 'Generating reply code …';
        await unlockNetwork(); // real IPs in the code (important for hotspots)
        showOwnCode(await jamlink.createAnswer(code)); // guest: build the reply
        instructions.textContent =
          'Have the host scan this reply QR — or share/copy the code.';
      }
      codeIn.value = '';
    } catch (err) { fail(err); }
  };

  $('#btn-jam-apply').addEventListener('click', () => applyCode(codeIn.value));

  /**
   * Beitritt über eine #jam=…-URL (Kamera-Scan/geteilter Link).
   * Bewusst NICHT vollautomatisch: Der Tipp auf »Übernehmen« ist eine
   * echte Nutzergeste — nur dann zeigt der Browser die Kamera-Abfrage
   * zuverlässig an, die die verdeckten mDNS-Adressen durch echte IPs
   * ersetzt (ohne die scheitert die Direktverbindung, s. Hotspot-Test).
   */
  const joinWithCode = (code) => {
    show('setup');
    codeOut.hidden = codeIn.hidden = false;
    clearOwnCode();
    codeIn.value = code;
    instructions.textContent =
      'Jam invite detected! Tap "Apply" — then allow the camera ' +
      'prompt: it unlocks the direct device connection.';
  };

  shareBtn.addEventListener('click', () => {
    const code = codeOut.value;
    if (!code || !navigator.share) return;
    const payload = jamlink.role === 'host'
      ? { title: 'RackWerk Jam', url: joinURL(code) }
      : { title: 'RackWerk Jam — Reply Code', text: code };
    navigator.share(payload).catch(() => { /* Nutzer hat abgebrochen */ });
  });

  $('#btn-jam-copy').addEventListener('click', () => {
    codeOut.select();
    navigator.clipboard?.writeText(codeOut.value).catch(() => {
      try { document.execCommand('copy'); } catch { /* Nutzer kopiert manuell */ }
    });
  });

  $('#btn-jam-cancel').addEventListener('click', () => {
    jamlink.close();
    stopScan();
    clearOwnCode();
    show('idle');
    stopBeatLed();
  });

  $('#btn-jam-send').addEventListener('click', () => {
    jamlink.sendProject(serializeProject(rack));
  });

  $('#btn-jam-leave').addEventListener('click', () => {
    jamlink.close();
    stopScan();
    clearOwnCode();
    show('idle');
    stopBeatLed();
  });

  return { joinWithCode };
}

/* ---------- Song-Timeline (freie Aufnahme von Pattern-Wechseln) ---------- */
function wireSongUI(rack) {
  const sheet = $('#song-sheet');
  const timeline = $('#song-timeline');
  const armBtn = $('#btn-song-arm');
  const playBtn = $('#btn-song-play');
  const prjBtn = $('#btn-projects'); // dient als Song-Aufnahme/-Play-Anzeige
  let playheads = [];

  const render = () => {
    timeline.innerHTML = '';
    playheads = [];
    const total = song.lengthSteps || 16;
    if (song.empty) {
      timeline.innerHTML = '<div class="song-empty">Nothing recorded yet — tap "● Record".</div>';
    } else {
      rack.machines.forEach((m, idx) => {
        const color = m.constructor.meta.color;
        const lane = document.createElement('div');
        lane.className = 'song-lane';
        const name = document.createElement('span');
        name.className = 'song-lane__name';
        name.style.setProperty('--lane-color', color);
        name.textContent = m.displayName;
        const track = document.createElement('div');
        track.className = 'song-track';
        const evs = song.events.filter((e) => e.m === idx).sort((a, b) => a.step - b.step);
        evs.forEach((e, k) => {
          const start = e.step;
          const end = k + 1 < evs.length ? evs[k + 1].step : total;
          if (end <= start) return;
          const block = document.createElement('div');
          block.className = 'song-block';
          block.style.left = `${(start / total) * 100}%`;
          block.style.width = `${((end - start) / total) * 100}%`;
          block.style.background = color;
          block.textContent = 'ABCD'[e.index] ?? '?';
          track.appendChild(block);
        });
        const ph = document.createElement('div');
        ph.className = 'song-ph';
        track.appendChild(ph);
        playheads.push(ph);
        lane.append(name, track);
        timeline.appendChild(lane);
      });
    }
    armBtn.classList.toggle('is-active', song.recording);
    playBtn.classList.toggle('is-active', song.playing);
    playBtn.textContent = song.playing ? '■ Stop' : '▶ Song';
    prjBtn.classList.toggle('is-songrec', song.recording);
    prjBtn.classList.toggle('is-songplay', song.playing);
  };

  song.onchange = render;
  song.onplayhead = (songStep) => {
    const total = song.lengthSteps || 16;
    for (const ph of playheads) {
      if (songStep == null) ph.classList.remove('is-on');
      else { ph.style.left = `${(songStep / total) * 100}%`; ph.classList.add('is-on'); }
    }
  };

  modeOpen.song = () => { render(); sheet.hidden = false; };
  sheet.querySelector('[data-close]').addEventListener('click', () => { sheet.hidden = true; });

  armBtn.addEventListener('click', () => {
    // scharf schalten, Seite schließen, Transport von vorn starten →
    // du spielst die Pattern-Wechsel live auf der Hauptansicht ein
    song.stop();
    song.arm(true);
    sheet.hidden = true;
    transport.play();
  });

  playBtn.addEventListener('click', () => {
    if (song.playing) { song.stop(); return; }
    if (song.empty) return;
    sheet.hidden = true;
    song.play();
  });

  $('#btn-song-clear').addEventListener('click', () => song.clear());
}

/* ---------- Mixer: Vollbild-Kanalzug pro Maschine/Master ----------
 * Steuert dieselben Werte, die auch die Maschinen-Panels selbst zeigen (eine
 * Quelle der Wahrheit über Machine.setLevel/setPan/setMuted/setSoloed) — der
 * Kanalzug ist eine zusätzliche, fokussierte Bedienoberfläche, kein zweiter
 * Pegel. Rendering/Navigation/Drum-Gruppen-Ausklappen sitzt komplett in
 * ui/channel-strip-view.js (analog zu initJamView/renderJamView) -- hier nur
 * das Verdrahten mit dem Sheet-Rahmen aus index.html + der Bottom-Bar. */
function wireChannelStripView(rack) {
  initChannelStripView(rack);
}

/* ---------- 2b) Jam-Ansicht (Sheet öffnen/schließen — Rendering + Takt-Listener in jam-view.js) ---------- */
function wireJamViewUI() {
  const sheet = $('#jam-sheet');
  modeOpen.jam = () => { renderJamView($('#jam-list'), $('#jam-scenes')); sheet.hidden = false; };
  sheet.querySelector('[data-close]').addEventListener('click', () => {
    sheet.hidden = true;
  });
  $('#btn-jam-stop-all').addEventListener('click', stopAllClips);
  // Jam verlassen (egal ob per ✕ hier oder per Bottom-Bar-Tab-Wechsel in
  // wireBottomBar(), die dasselbe hidden=true setzt) -> jede Spur wieder
  // auf ihr normales Pattern/hörbar zurückspringen lassen, s. jam-view.js#
  // exitJamMode (Nutzer-Bugreport: Rack liess sich nach einem Jam-Besuch
  // nicht mehr normal gemeinsam abspielen). Ein MutationObserver statt ein
  // zweiter Aufruf im Bottom-Bar-Handler, damit KEIN Schliessweg vergessen
  // werden kann.
  new MutationObserver(() => { if (sheet.hidden) exitJamMode(); })
    .observe(sheet, { attributes: true, attributeFilter: ['hidden'] });
}

/* ---------- 2c) Bottom-Bar: Rack/Song/Jam-Umschalter ----------
 * Öffnet/schließt dieselben Sheets, die vorher übers PRJ-Sheet erreichbar
 * waren (modeOpen.song/jam, s. wireSongUI/wireJamViewUI) — dupliziert also
 * keine Render-/Meter-Logik. Zusätzlich: Mutual Exclusion (nur eine
 * Konsole gleichzeitig offen) und Active-Tab-Sync per MutationObserver,
 * weil jede Konsole auch über ihren eigenen ✕-Button schließen kann, nicht
 * nur über die Bottom-Bar selbst. #mixer-sheet bleibt Teil von `sheets`
 * (Mutual-Exclusion + Desktop-Klick-ausserhalb-schliesst), obwohl es
 * keinen eigenen Bottom-Bar-Tab mehr gibt -- öffnet sich jetzt über einen
 * Button pro Rack-Zeile bzw. am Master-FX-Panel (s. rack.js/fx.js). */
function wireBottomBar(rack) {
  const sheets = { mix: $('#mixer-sheet'), song: $('#song-sheet'), jam: $('#jam-sheet') };
  const modeBtns = document.querySelectorAll('.bb-mode');

  const syncActive = () => {
    const openMode = Object.entries(sheets).find(([, s]) => !s.hidden)?.[0] ?? 'rack';
    modeBtns.forEach((btn) => btn.classList.toggle('is-active', btn.dataset.mode === openMode));
  };

  modeBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      closeAllOverlays(rack); // schliesst auch ein evtl. offenes Maschinen-Fokus/Add-Machine-Sheet
      if (mode !== 'rack') modeOpen[mode]();
      syncActive();
    });
  });

  for (const s of Object.values(sheets)) {
    new MutationObserver(syncActive).observe(s, { attributes: true, attributeFilter: ['hidden'] });
    // Klick auf den Rand ausserhalb des Konsolen-Panels schliesst es --
    // nur auf Desktop-Breiten sichtbar/klickbar (dort bekommt .sheet--console
    // erst per Breakpoint einen Hintergrund + pointer-events:auto, s.
    // app.css); auf Mobile deckt das Panel den ganzen Bereich ab, e.target
    // ist dort also nie das Sheet selbst.
    s.addEventListener('click', (e) => {
      if (e.target === s) s.hidden = true;
    });
  }
  syncActive();
}

/* ---------- 3) Transport-Leiste ---------- */
function wireTransportUI() {
  const btnPlay = $('#btn-play');
  const iconPlay = btnPlay.querySelector('.icon-play');
  const iconStop = btnPlay.querySelector('.icon-stop');
  const lcdBpm = $('#lcd-bpm');
  const lcdPos = $('#lcd-pos');

  btnPlay.addEventListener('click', () => transport.toggle());

  // REC schärfen/entschärfen — aufgenommen wird nur bei laufendem Transport
  const btnRec = $('#btn-rec');
  const bottomBarEl = $('#bottombar');
  btnRec.addEventListener('click', () => {
    automation.setArmed(!automation.armed);
    btnRec.classList.toggle('is-armed', automation.armed);
    // Periphere Leiste am Bildschirmrand (s. app.css) -- aus dem Augenwinkel
    // lesbar, im Gegensatz zum kleinen Button selbst (wichtig bei Live-
    // Nutzung/Bühnenlicht, s. UI-Review).
    bottomBarEl.classList.toggle('is-rec-armed', automation.armed);
    if (automation.armed) {
      hintOnce('rec-armed', () => showHintToast(
        'REC is armed: turn a knob to record automation, or play a note/pad to write it into the pattern.'
      ));
    }
  });

  // BPM: Tippen ±1, Halten wiederholt (Touch-freundlicher als ein Slider)
  const bindRepeat = (btn, delta) => {
    let timer = null;
    const change = () => transport.setBpm(transport.bpm + delta);
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      change();
      timer = setInterval(change, 90);
    });
    const stop = () => { clearInterval(timer); timer = null; };
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointercancel', stop);
    btn.addEventListener('pointerleave', stop);
  };
  bindRepeat($('#btn-bpm-down'), -1);
  bindRepeat($('#btn-bpm-up'), +1);

  // Transport-Status im UI spiegeln
  transport.addListener({
    onTransport(event, t) {
      if (event === 'bpm') lcdBpm.textContent = t.bpm.toFixed(1);
      if (event === 'play' || event === 'stop') {
        const playing = t.isPlaying;
        btnPlay.classList.toggle('is-playing', playing);
        // toggleAttribute statt .hidden = ... -- die `hidden`-IDL-Property
        // spiegelt auf <svg>-Elementen (anders als auf normalen HTML-
        // Elementen) das Attribut nicht zuverlässig, das Icon bliebe sonst
        // dauerhaft auf dem Anfangszustand aus dem Markup stehen, egal was
        // man zuweist (Play/Stop-Icon zeigen dann permanent beide zugleich).
        iconPlay.toggleAttribute('hidden', playing);
        iconStop.toggleAttribute('hidden', !playing);
        btnPlay.setAttribute('aria-label',
          playing ? 'Stop playback' : 'Start playback');
        if (!playing) lcdPos.textContent = '1.1';
      }
    },
  });

  // Positionsanzeige (reines UI-Polling, unabhängig vom Audio-Scheduler)
  setInterval(() => {
    if (transport.isPlaying) lcdPos.textContent = transport.positionLabel;
  }, 120);

  lcdBpm.textContent = transport.bpm.toFixed(1);
}

/* ---------- Undo-Toast ---------- */
/** Zeigt nach jeder destruktiven Aktion (Maschine entfernt, Pattern
 *  geleert, …) kurz einen Toast mit Rückgängig-Button — behebt versehent-
 *  liche Löschungen, ohne für jede Aktion eine Rückfrage einzubauen. */
function wireUndoUI() {
  let toastEl = null;
  let hideTimer = null;

  const hide = () => {
    clearTimeout(hideTimer);
    toastEl?.remove();
    toastEl = null;
  };

  undo.onChange((entry) => {
    hide();
    if (!entry) return;
    const el = document.createElement('div');
    el.className = 'undo-toast';
    el.innerHTML = `<span>${entry.label}</span>
      <button type="button" class="undo-toast__btn" data-undo>Undo</button>`;
    el.querySelector('[data-undo]').addEventListener('click', () => undo.trigger());
    document.body.appendChild(el);
    toastEl = el;
    hideTimer = setTimeout(hide, 8000);
  });
}

/* ---------- Tutorial: interaktive Tour in einer Wegwerf-Sandbox ----------
 * Statt einer reinen Text-Übersicht zeigt die Tour jetzt auf echte
 * UI-Elemente (Spotlight + Sprechblase) und verlangt die echte Aktion
 * (antippen, Modus wechseln, …), bevor es weitergeht -- "einmal durch die
 * App navigieren" statt nur lesen (s. Chat). Damit dabei NIE die echte
 * Session riskiert wird, läuft die Tour auf einer eigenen, temporären
 * Besetzung desselben `rack`-Objekts (BeatBox + SubSynth + Sampler, s.
 * enterSandbox) -- ein zweites Rack-Objekt ist nicht möglich, Rack ist an
 * die festen DOM-Container gebunden (s. rack.js). Backup/Restore nutzt
 * denselben serializeProject/loadProject-Weg wie das Laden im
 * Projects-Sheet. */

/** Winziges, synthetisches WAV (kurzer gedämpfter 440Hz-Blip, 8kHz mono) --
 *  dient einzig als vorab geladenes Demo-Sample fürs Sampler-Pad in der
 *  Sandbox (s. enterSandbox), damit der Sample-Editor-Schritt der Tour
 *  wirklich etwas zum Editieren hat. `Sampler.assignRecording()` erwartet
 *  einen echten dekodierbaren Audio-Blob (dieselbe Stelle, die auch eine
 *  Mikro-Aufnahme verarbeitet) -- ein von Hand gebautes WAV ist dafür der
 *  einfachste Weg, ganz ohne Mikro-Berechtigung oder Dateiauswahl. */
function makeDemoSampleBlob() {
  const sr = 8000;
  const n = Math.round(sr * 0.15);
  const buf = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buf);
  const writeStr = (offset, s) => { for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF'); view.setUint32(4, 36 + n * 2, true); writeStr(8, 'WAVE');
  writeStr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sr, true); view.setUint32(28, sr * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeStr(36, 'data'); view.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const s = Math.sin(2 * Math.PI * 440 * t) * Math.exp(-t * 12);
    view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 32767, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

const TOUR_STEPS = [
  {
    title: 'Welcome to RackWerk',
    body: 'This short tour walks you through the app step by step, on a throwaway demo setup — nothing you do here touches your own project. Perform the highlighted action on each screen to move on.',
  },
  {
    title: 'Step Sequencer',
    body: 'Every machine has a step pattern. <b>Tap any step</b> in the grid to turn it on.',
    run(ctx) {
      const panel = ctx.openMachine(0); // BeatBox
      const grid = panel?.querySelector('.stepseq__grid');
      if (!grid) return null;
      return { el: grid, container: grid, selector: '.cell', eventType: 'pointerdown' };
    },
  },
  {
    // Jede Maschine öffnet ihre Vollansicht auf demselben Weg -- ein Tipp
    // auf ihre Zeile im Rack. Am Sampler gezeigt (statt automatisch für den
    // Nutzer geöffnet wie bei BeatBox oben), weil das die einzige Stelle in
    // der Tour ist, an der diese grundlegende Navigation selbst geübt wird
    // (s. Chat-Feedback).
    title: 'Sampler',
    body: 'Every device opens its full view the same way — <b>tap its row in the Rack</b>. Try it on the Sampler.',
    run(ctx) {
      ctx.closeAllSheets();
      const row = ctx.rowFor(2); // Sampler (nach BeatBox+SubSynth angehängt)
      if (!row) return null;
      return { el: row, container: row, selector: '.rack-row', eventType: 'click' };
    },
    next: {
      body: '<b>Tap any pad</b> to trigger it.',
      run() {
        const pads = document.querySelector('.machine-focus:not([hidden]) .pads');
        if (!pads) return null;
        return { el: pads, container: pads, selector: '.pad', eventType: 'pointerdown' };
      },
      // Dritte Phase: erst ein echtes Öffnen des Sample-Editors zeigt die
      // eigentliche Klangformung (Trim/Hüllkurve/Filter), nicht nur den Pad-
      // Tap (s. Chat-Feedback) -- die Sandbox lädt dafür in enterSandbox()
      // vorab ein winziges Demo-Sample auf Pad 1, sonst gäbe es dort noch
      // nichts zu editieren. `retry:true`: das Menü existiert erst NACH der
      // Halten-Geste, deshalb wird alle 200ms erneut nachgeschaut, statt
      // nur einmal zu prüfen und aufzugeben.
      next: {
        body: '<b>Hold the pad</b> to open its menu, then tap <b>✏️ Edit</b> to see the sample editor (trim, envelope, filter).',
        retry: true,
        run() {
          const menu = document.querySelector('.pat-chip');
          const editBtn = menu && [...menu.querySelectorAll('.pat-chip__btn')].find((b) => b.textContent.includes('Edit'));
          if (!editBtn) return null;
          return { el: editBtn, container: editBtn, selector: '.pat-chip__btn', eventType: 'click' };
        },
      },
    },
  },
  {
    title: 'REC',
    body: '<b>Tap REC</b> to arm it — turn a knob to record automation, or play a note/pad to write it live into the pattern.',
    run(ctx) {
      ctx.closeAllSheets();
      const el = $('#btn-rec');
      return { el, container: el, selector: '#btn-rec', eventType: 'click' };
    },
  },
  {
    title: 'Pattern Bank',
    body: 'Each machine has 4 patterns (A–D). <b>Tap a letter</b> to switch — hold one for copy/paste/Jam-clip options.',
    run(ctx) {
      const panel = ctx.openMachine(0); // BeatBox
      const bank = panel?.querySelector('.patbank');
      if (!bank) return null;
      return { el: bank, container: bank, selector: '.patbank__btn', eventType: 'click' };
    },
  },
  {
    title: 'Song',
    body: '<b>Tap Song</b> — it records pattern switches over time so you can build an arrangement.',
    run(ctx) {
      ctx.closeAllSheets();
      const el = document.querySelector('.bb-mode[data-mode="song"]');
      return { el, container: el, selector: '.bb-mode[data-mode="song"]', eventType: 'click' };
    },
  },
  {
    title: 'Jam',
    body: '<b>Tap Jam</b> — launch clips live per track, with an X/Y pad for hands-on macro control while performing.',
    run(ctx) {
      ctx.closeAllSheets();
      const el = document.querySelector('.bb-mode[data-mode="jam"]');
      return { el, container: el, selector: '.bb-mode[data-mode="jam"]', eventType: 'click' };
    },
    // Zweite Phase desselben Schritts: das Öffnen der Jam-Ansicht allein
    // zeigt noch nicht die eigentliche Jam-Funktion (Clips live starten) --
    // erst ein echter Clip-Tap demonstriert das (s. Chat-Feedback). Läuft
    // auf dem frisch von der ersten Phase geöffneten #jam-list weiter.
    next: {
      body: 'Every pattern can launch live, even without being turned into a saved clip first. <b>Tap a clip letter</b> (A–D) in any column to fire it.',
      run() {
        const list = $('#jam-list');
        if (!list) return null;
        return { el: list, container: list, selector: '.clip, .proto-clip', eventType: 'click' };
      },
      // Dritte Phase: Scenes sind der andere Kernteil von Jam (ganze
      // Song-Abschnitte auf einen Tipp wiederherstellen), bisher in der Tour
      // gar nicht gezeigt worden (s. Chat-Feedback).
      next: {
        body: 'Scenes remember which clip is playing on every track at once, so you can jump back to a whole song section with one tap. <b>Tap "+ Save Scene"</b> to save the current state as one.',
        run() {
          const btn = document.querySelector('#jam-scenes .jam-scene-chip--add');
          if (!btn) return null;
          return { el: btn, container: btn, selector: '.jam-scene-chip--add', eventType: 'click' };
        },
      },
    },
  },
  {
    title: 'Projects',
    body: '<b>Tap PRJ</b> — this is where you save your work by name anytime.',
    run(ctx) {
      ctx.closeAllSheets();
      const el = $('#btn-projects');
      return { el, container: el, selector: '#btn-projects', eventType: 'click' };
    },
    isLast: true,
  },
];

function wireOnboardingUI(rack) {
  const sheet = $('#onboarding-sheet');
  const titleEl = sheet.querySelector('[data-tut-title]');
  const bodyEl = sheet.querySelector('[data-tut-body]');
  const countEl = sheet.querySelector('[data-tut-count]');
  const nextBtn = sheet.querySelector('[data-tut-next]');
  const doneBtn = sheet.querySelector('[data-tut-done]');
  const skipBtn = sheet.querySelector('[data-tut-skip]');

  // Spotlight (abgedunkelter Hintergrund mit "Loch" ums Ziel) + Sprechblase
  // (Titel/Text + Skip) -- über ALLEM (Sheets z-index:50, Machine-Focus
  // z-index:55), damit die reale Aktion auch bei geöffnetem Mixer/Sampler/…
  // sichtbar bleibt. Bewusst pointer-events:none auf dem Spotlight selbst:
  // eine echte Ausstanzung bräuchte eine zweite Maske/SVG-Clip-Path für
  // wenig zusätzlichen Nutzen -- die Sandbox macht ein Daneben-Tippen ohnehin
  // folgenlos.
  const spotlight = document.createElement('div');
  spotlight.className = 'tut-spotlight';
  spotlight.hidden = true;
  const callout = document.createElement('div');
  callout.className = 'tut-callout';
  callout.hidden = true;
  callout.innerHTML = `
    <div class="tut-callout__head">
      <span class="tut-callout__count" data-cnt></span>
      <button type="button" class="tut-callout__skip" data-skip>Skip Tour ✕</button>
    </div>
    <h3 class="tut-callout__title" data-title></h3>
    <p class="tut-callout__body" data-body></p>
  `;
  document.body.append(spotlight, callout);

  let step = 0;
  let cleanupStep = null;
  let posTimer = null;
  let calloutTarget = null;
  let tourBackup = null;

  const stopPositioning = () => { clearInterval(posTimer); posTimer = null; };

  const positionOverlay = () => {
    if (!calloutTarget || !document.body.contains(calloutTarget)) return;
    const r = calloutTarget.getBoundingClientRect();
    const pad = 6;
    spotlight.style.left = `${Math.max(0, r.left - pad)}px`;
    spotlight.style.top = `${Math.max(0, r.top - pad)}px`;
    spotlight.style.width = `${r.width + pad * 2}px`;
    spotlight.style.height = `${r.height + pad * 2}px`;

    const vh = window.innerHeight;
    const below = r.bottom < vh / 2;
    if (below) {
      callout.style.top = `${r.bottom + 14}px`;
      callout.style.bottom = '';
    } else {
      callout.style.top = '';
      callout.style.bottom = `${vh - r.top + 14}px`;
    }
  };

  // Delegiert an die app-weite Funktion (s. dort) -- eigener lokaler Name
  // bleibt erhalten, weil `ctx.closeAllSheets` an mehreren Tour-Schritten
  // hängt und diese hier nicht alle umbenannt werden müssen.
  const closeAllSheets = () => closeAllOverlays(rack);

  const openMachine = (idx) => {
    const m = rack.machines[idx];
    const view = m && rack.views.get(m);
    if (!view) return null;
    closeAllSheets();
    view.overlay.hidden = false;
    view.panel.scrollTop = 0;
    return view.panel;
  };

  /** DOM-Zeile einer Maschine im Rack -- fürs "Vollansicht per Rack-Tipp
   *  öffnen"-Beispiel (s. TOUR_STEPS.Sampler), das den echten Zeilen-Klick
   *  verlangt statt die Maschine wie sonst automatisch zu öffnen. */
  const rowFor = (idx) => {
    const m = rack.machines[idx];
    return m && rack.views.get(m)?.row;
  };

  const ctx = { closeAllSheets, openMachine, rowFor };

  const endInteractiveStep = () => {
    cleanupStep?.();
    cleanupStep = null;
    stopPositioning();
    calloutTarget = null;
    spotlight.hidden = true;
    callout.hidden = true;
  };

  const armAction = (container, selector, eventType, onDone) => {
    const handler = (e) => {
      if (!e.target.closest(selector)) return;
      container.removeEventListener(eventType, handler);
      onDone();
    };
    // Bewusst Bubble-Phase (kein capture:true): bei Zielen, die selbst
    // schon einen Klick-Handler haben (REC, Mix/Song/Jam, Projects), MUSS
    // der echte Handler zuerst laufen -- sonst würde z. B. am letzten
    // Schritt finishTour() (schliesst alle Sheets) VOR dem Öffnen des
    // Projects-Sheets laufen und dieses gleich wieder zulassen. Capture-
    // Phase-Listener feuern browserübergreifend IMMER vor Bubble-Phase-
    // Listenern auf demselben Ziel, unabhängig von der Registrierreihen-
    // folge (empirisch geprüft) -- genau das würde hier die Reihenfolge
    // kaputt machen.
    container.addEventListener(eventType, handler);
    return () => container.removeEventListener(eventType, handler);
  };

  const showWelcome = () => {
    endInteractiveStep();
    closeAllSheets();
    const s = TOUR_STEPS[0];
    titleEl.textContent = s.title;
    bodyEl.innerHTML = s.body;
    countEl.textContent = `1/${TOUR_STEPS.length}`;
    nextBtn.hidden = false;
    doneBtn.hidden = true;
    sheet.hidden = false;
  };

  const showStep = (i) => {
    step = i;
    sheet.hidden = true;
    closeAllSheets();
    showPhase(TOUR_STEPS[i], TOUR_STEPS[i]);
  };

  const renderCalloutText = (s, phase) => {
    callout.querySelector('[data-cnt]').textContent = `${step + 1}/${TOUR_STEPS.length}`;
    callout.querySelector('[data-title]').textContent = s.title;
    callout.querySelector('[data-body]').innerHTML = phase.body ?? s.body;
  };

  /** Ein Schritt kann aus mehreren Phasen bestehen (s. TOUR_STEPS.Jam/
   *  Sampler .next): z. B. erst die Jam-Ansicht öffnen, DANN einen echten
   *  Clip antippen -- alle Phasen zeigen denselben Zähler ("8/9"), nur
   *  Zieltext/Ziel-Element wechseln zwischen ihnen. */
  const showPhase = (s, phase) => {
    endInteractiveStep();
    attemptPhase(s, phase);
  };

  /** Von showPhase() einmal aufgerufen, danach von sich selbst erneut --
   *  aber NUR im retry-Fall (phase.retry), wenn das Ziel erst nach einer
   *  Geste entsteht, die nicht als DOM-Event abwartbar ist (z. B. das
   *  Pad-Menü, das erst nach einer Halten-Geste erscheint, s. TOUR_STEPS.
   *  Sampler). endInteractiveStep() läuft deshalb bewusst nur in
   *  showPhase(), nicht hier -- sonst würde jeder Poll-Tick die gerade
   *  gezeigte Sprechblase kurz verschwinden lassen. */
  const attemptPhase = (s, phase) => {
    const found = phase.run(ctx);
    if (!found?.el) {
      if (phase.retry) {
        renderCalloutText(s, phase);
        callout.hidden = false;
        spotlight.hidden = true;
        posTimer = setTimeout(() => attemptPhase(s, phase), 200);
        return;
      }
      // Ziel nicht gefunden und kein retry (z. B. Layout-Sonderfall) --
      // nicht hängenbleiben, direkt weiter.
      if (phase.next) showPhase(s, phase.next); else advance();
      return;
    }
    calloutTarget = found.el;
    renderCalloutText(s, phase);
    spotlight.hidden = false;
    callout.hidden = false;
    positionOverlay();
    posTimer = setInterval(positionOverlay, 200);
    // Kein "smooth" -- eine noch laufende Scroll-Animation würde die
    // Ziel-Koordinaten für einen Tipp kurzzeitig verschieben (das Element
    // "läuft vor dem Finger davon"); sofortiges Springen ist hier
    // vorhersagbarer als der optische Komfort einer Animation.
    found.el.scrollIntoView?.({ block: 'center' });
    cleanupStep = armAction(found.container, found.selector, found.eventType, () => {
      if (phase.next) { showPhase(s, phase.next); return; }
      if (s.isLast) { finishTour(); return; }
      advance();
    });
  };

  const advance = () => {
    const next = step + 1;
    if (next >= TOUR_STEPS.length) { finishTour(); return; }
    showStep(next);
  };

  const finishTour = () => {
    endInteractiveStep();
    closeAllSheets();
    step = TOUR_STEPS.length - 1;
    titleEl.textContent = 'All done!';
    bodyEl.innerHTML = 'You’ve toured every part of RackWerk. Tap Finish to leave the demo and return to your own project.';
    countEl.textContent = `${TOUR_STEPS.length}/${TOUR_STEPS.length}`;
    nextBtn.hidden = true;
    doneBtn.hidden = false;
    sheet.hidden = false;
  };

  // ---- Sandbox-Lebenszyklus ----
  const enterSandbox = async () => {
    tourBackup = serializeProject(rack);
    tutorialActive = true;
    undo.clear(); // kein Undo-Eintrag darf über die Sandbox-Grenze hinweg überleben
    newProject(rack); // Werkseinstellung: BeatBox + SubSynth
    const sampler = rack.addMachine(SAMPLER_CLASS); // + Sampler, damit dieser Schritt immer etwas zum Antippen hat
    // Pad 1 bekommt vorab ein winziges Demo-Sample -- sonst gäbe es im
    // Sample-Editor-Schritt (s. TOUR_STEPS.Sampler) nichts zum Editieren,
    // "Hold pad -> Edit" braucht ein bereits geladenes Sample (s. sampler.js
    // #openPadMenu, der Edit-Button existiert nur bei tr.buffer).
    await sampler.assignRecording(0, makeDemoSampleBlob());
  };
  const exitSandbox = () => {
    if (!tutorialActive) return;
    loadProject(rack, tourBackup);
    tourBackup = null;
    tutorialActive = false;
    undo.clear();
  };

  const startTour = async () => {
    if (!tutorialActive) await enterSandbox();
    step = 0;
    showWelcome();
  };
  const endTour = () => {
    endInteractiveStep();
    sheet.hidden = true;
    exitSandbox();
  };

  nextBtn.addEventListener('click', () => showStep(1));
  doneBtn.addEventListener('click', endTour);
  skipBtn.addEventListener('click', endTour);
  callout.querySelector('[data-skip]').addEventListener('click', endTour);

  hintOnce('onboarding-sheet', () => startTour());

  // "Show Tutorial" im Projects-Sheet -- bewusst NICHT über hintOnce (das
  // Flag ist ja längst gesetzt, ein zweiter hintOnce()-Aufruf wäre also
  // ein No-Op) -- startet die Tour direkt. Läuft die Tour schon (z. B.
  // versehentlicher Doppel-Tap), NICHT den Backup nochmal einfangen -- das
  // würde sonst den aktuellen Demo-Zustand statt der echten Session als
  // Rückkehrpunkt festschreiben.
  $('#btn-show-tutorial').addEventListener('click', () => {
    $('#project-sheet').hidden = true;
    startTour();
  });
}
