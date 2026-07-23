/**
 * main.js — verdrahtet Engine, Transport, Rack und die Transport-Leiste.
 */
import './ui/knob.js';                       // registriert <x-knob>
import './ui/fader.js';                      // registriert <x-fader>
import { drawQR } from './ui/qr.js';
import { jsQR } from './vendor/jsqr.js';
import { engine } from './core/audio-engine.js';
import { transport, STEPS_PER_BAR } from './core/transport.js';
import { automation } from './core/automation.js';
import { store } from './core/store.js';
import { serializeProject, loadProject, importMachines, newProject } from './core/project.js';
import { recorder } from './core/recorder.js';
import { jamlink } from './core/jamlink.js';
import { masterFX } from './core/fx.js';
import { song } from './core/song.js';
import { undo } from './core/undo.js';
import { hintOnce, showHintToast } from './core/hints.js';
import { Rack } from './rack/rack.js';
import { initJamView, renderJamView } from './rack/jam-view.js';

const $ = (sel) => document.querySelector(sel);

/** Öffnen-Funktionen für Mix/Song/Jam, von wireMixerUI/wireSongUI/
 *  wireJamViewUI befüllt -- die Bottom-Bar (wireBottomBar) ruft sie auf,
 *  ohne die jeweilige Sheet-Logik zu duplizieren. */
const modeOpen = {};

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
window.addEventListener('resize', () => { syncTransportHeight(); syncBottomBarHeight(); });
window.addEventListener('orientationchange', () => { syncTransportHeight(); syncBottomBarHeight(); });
syncTransportHeight();
syncBottomBarHeight();

/* ---------- 2) App-Start, sobald Audio bereit ist ---------- */
function boot() {
  const rack = new Rack($('#rack'), $('#machine-sheet'));
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
  wireMixerUI(rack);
  initJamView(rack);
  wireJamViewUI();
  wireBottomBar(); // braucht modeOpen.{mix,song,jam}, also NACH den drei wireXUI oben
  wireUndoUI();
  wireOnboardingUI();

  // Per Kamera-Scan geöffnet? (#jam=Code in der URL) → direkt beitreten.
  // Hash sofort entfernen, damit ein Reload nicht erneut beitritt.
  const jamCode = location.hash.match(/#jam=(.+)$/);
  if (jamCode) {
    history.replaceState(null, '', location.pathname + location.search);
    $('#project-sheet').hidden = false;
    jam.joinWithCode(jamCode[1]);
  }

  // Autosave: alle 3 s den kompletten Zustand sichern
  setInterval(() => {
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
        // Snapshot der laufenden Session VOR dem Laden -- loadProject()
        // leert das Rack sofort (rack.clear()); scheitert das Parsen/
        // Deserialisieren mittendrin, bliebe ohne Rollback ein halb
        // geleertes Rack stehen, das der Autosave 3s später über die
        // letzte gute Session schreibt (stiller Datenverlust).
        const backup = serializeProject(rack);
        try {
          loadProject(rack, JSON.parse(store.get(`project:${name}`)));
          nameInput.value = name;
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
    refreshList();
    sheet.hidden = false;
  });
  sheet.querySelector('[data-close]').addEventListener('click', () => {
    sheet.hidden = true;
  });

  $('#btn-save-project').addEventListener('click', () => {
    const name = nameInput.value.trim() || 'Untitled';
    store.set(`project:${name}`, JSON.stringify(serializeProject(rack)));
    refreshList();
  });

  $('#btn-new-session').addEventListener('click', () => {
    // Verwirft die aktuelle Session (Autosave überschreibt sie gleich) —
    // deshalb einmal nachfragen.
    if (!window.confirm('Start a new session? The current setup will be ' +
      'discarded (unsaved changes will be lost).')) return;
    newProject(rack);
    nameInput.value = '';
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

  $('#btn-export').addEventListener('click', () => {
    const name = (nameInput.value.trim() || 'session').replace(/[^\wäöüÄÖÜß-]+/g, '_');
    const json = JSON.stringify(serializeProject(rack), null, 2);
    download(`rackwerk-${name}.json`, new Blob([json], { type: 'application/json' }));
  });

  const fileInput = $('#file-input');
  let importMode = 'replace';
  $('#btn-import-replace').addEventListener('click', () => { importMode = 'replace'; fileInput.click(); });
  $('#btn-import-merge').addEventListener('click', () => { importMode = 'merge'; fileInput.click(); });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
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
        name.textContent = m.constructor.meta.name;
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

/* ---------- Mixer: Breitbild-Konsole mit Channel-Strips ----------
 * Steuert dieselben Werte, die auch die Maschinen-Panels selbst zeigen (eine
 * Quelle der Wahrheit über Machine.setLevel/setPan/setMuted/setSoloed) — der
 * Mixer ist eine zusätzliche, zentrale Bedienoberfläche, kein zweiter Pegel.
 * Layout: horizontal scrollende Kanalzüge mit echten Fadern (dB-Skala) und
 * live mitlaufenden VU-Metern; die BeatBox läuft als klappbare Gruppe
 * (Gesamt-Fader + acht Drum-Spuren, einklappbar auf den Gruppen-Fader). */
function wireMixerUI(rack) {
  const sheet = $('#mixer-sheet');
  const list = $('#mixer-list');

  /* Ein gemeinsamer rAF-Ticker treibt alle sichtbaren VU-Meter — nur
     während der Mixer offen ist, sonst unnötige Dauerlast im Hintergrund. */
  const FLOOR_DB = -45;
  let meterEntries = [];
  let meterRAF = null;
  const meterTick = () => {
    for (const m of meterEntries) {
      m.analyser.getFloatTimeDomainData(m.buf);
      let sum = 0;
      for (let i = 0; i < m.buf.length; i++) sum += m.buf[i] ** 2;
      const rms = Math.sqrt(sum / m.buf.length);
      const db = 20 * Math.log10(Math.max(1e-6, rms));
      const lit = Math.round(((Math.max(FLOOR_DB, Math.min(0, db)) - FLOOR_DB) / -FLOOR_DB) * m.segs.length);
      if (lit !== m.lastLit) {
        m.segs.forEach((s, i) => s.classList.toggle('is-lit', i < lit));
        m.lastLit = lit;
      }
    }
    meterRAF = requestAnimationFrame(meterTick);
  };
  const startMeters = () => { if (!meterRAF) meterRAF = requestAnimationFrame(meterTick); };
  const stopMeters = () => { if (meterRAF) cancelAnimationFrame(meterRAF); meterRAF = null; };

  /** Ein Kanalzug (Fader + VU-Meter + Pan + Sends + Mute/Solo) für eine
   *  Maschine ODER eine einzelne Drum-Spur — beide teilen sich dieselben
   *  Setter-Namen (setLevel/setPan/setSend/level/pan/sends/getMeterAnalyser). */
  const buildStrip = (target, { name, withButtons = true, compact = false } = {}) => {
    const strip = document.createElement('div');
    strip.className = 'chstrip' + (compact ? ' chstrip--sub' : '');
    strip.innerHTML = `
      <div class="chstrip__head">
        <span class="chstrip__stripe"></span>
        <span class="chstrip__name">${name}</span>
      </div>
      <div class="chstrip__knobs">
        <x-knob label="Pan" min="-1" max="1" default="0" value="${target.pan}" data-k="pan"></x-knob>
        <x-knob label="Dly" min="0" max="1" value="${target.sends.delay}" data-k="sendDelay"></x-knob>
        <x-knob label="Rev" min="0" max="1" value="${target.sends.reverb}" data-k="sendReverb"></x-knob>
      </div>
      <div class="chstrip__meters">
        <div class="chstrip__vu" data-vu>${Array.from({ length: 12 }, () => '<span class="vu__seg"></span>').join('')}</div>
        <x-fader default="1" value="${target.level}" data-k="level"></x-fader>
      </div>
      ${withButtons ? `
      <div class="chstrip__buttons">
        <button class="m-btn m-btn--solo${target.soloed ? ' is-active' : ''}" data-solo>SOLO</button>
        <button class="m-btn m-btn--mute${target.muted ? ' is-active' : ''}" data-mute>MUTE</button>
      </div>` : ''}
    `;
    strip.querySelector('[data-k="level"]').addEventListener('input', (e) => target.setLevel(e.detail.value));
    strip.querySelector('[data-k="pan"]').addEventListener('input', (e) => target.setPan(e.detail.value));
    strip.querySelector('[data-k="sendDelay"]').addEventListener('input', (e) => target.setSend('delay', e.detail.value));
    strip.querySelector('[data-k="sendReverb"]').addEventListener('input', (e) => target.setSend('reverb', e.detail.value));
    if (withButtons) {
      const muteBtn = strip.querySelector('[data-mute]');
      const soloBtn = strip.querySelector('[data-solo]');
      muteBtn.addEventListener('click', () => target.setMuted(!target.muted));
      soloBtn.addEventListener('click', () => target.setSoloed(!target.soloed));
      // Header-Buttons der Maschine bleiben die Referenz — hält den Mixer
      // synchron, falls der Zustand von dort (oder programmatisch) ändert
      target.onMixerChange = () => {
        muteBtn.classList.toggle('is-active', target.muted);
        soloBtn.classList.toggle('is-active', target.soloed);
      };
    }

    const analyser = target.getMeterAnalyser?.();
    if (analyser && typeof analyser.getFloatTimeDomainData === 'function') {
      meterEntries.push({
        analyser,
        buf: new Float32Array(analyser.fftSize),
        segs: strip.querySelectorAll('.vu__seg'),
        lastLit: -1,
      });
    }
    return strip;
  };

  const render = () => {
    list.innerHTML = '';
    meterEntries = [];
    if (!rack.machines.length) {
      list.innerHTML = '<p class="mixer-empty">No machines in the rack.</p>';
      return;
    }
    for (const m of rack.machines) {
      const { name, color } = m.constructor.meta;
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));

      if (Array.isArray(m.tracks)) {
        // Jede Multi-Spur-Maschine (BeatBox, AnalogKit, …) läuft als Gruppe:
        // Gesamt-Kanalzug (Kit-Bus) + einklappbare Einzel-Spuren. Duck-typed
        // auf m.tracks statt auf einen bestimmten type -- jede künftige
        // Multi-Spur-Maschine bekommt das automatisch, ohne main.js
        // anzufassen (Voraussetzung: dieselben Setter wie BeatBox/AnalogKit:
        // setTrackLevel/setTrackPan/setTrackSend/getTrackMeterAnalyser).
        const group = document.createElement('div');
        group.className = 'mixer-group';
        group.style.setProperty('--m-color', color);
        group.style.setProperty('--m-color-tint', `rgba(${r},${g},${b},.1)`);
        group.appendChild(buildStrip(m, { name }));

        const toggle = document.createElement('button');
        toggle.className = 'mixer-group__toggle';
        toggle.setAttribute('aria-label', 'Toggle drum tracks');
        toggle.addEventListener('click', () => group.classList.toggle('is-collapsed'));
        group.appendChild(toggle);

        const subtracks = document.createElement('div');
        subtracks.className = 'mixer-group__subtracks';
        m.tracks.forEach((tr, i) => {
          const sub = buildStrip(
            {
              level: tr.level, pan: tr.pan, sends: { delay: tr.sendDelay, reverb: tr.sendReverb },
              setLevel: (v) => m.setTrackLevel(i, v), setPan: (v) => m.setTrackPan(i, v),
              setSend: (which, v) => m.setTrackSend(i, which, v),
              getMeterAnalyser: () => m.getTrackMeterAnalyser(i),
            },
            { name: tr.name, withButtons: false, compact: true },
          );
          subtracks.appendChild(sub);
        });
        group.appendChild(subtracks);
        list.appendChild(group);
        continue;
      }

      const strip = buildStrip(m, { name });
      strip.style.setProperty('--m-color', color);
      list.appendChild(strip);
    }
  };

  modeOpen.mix = () => { render(); sheet.hidden = false; startMeters(); };
  sheet.querySelector('[data-close]').addEventListener('click', () => {
    sheet.hidden = true;
    stopMeters();
  });
}

/* ---------- 2b) Jam-Ansicht (Sheet öffnen/schließen — Rendering + Takt-Listener in jam-view.js) ---------- */
function wireJamViewUI() {
  const sheet = $('#jam-sheet');
  modeOpen.jam = () => { renderJamView($('#jam-list')); sheet.hidden = false; };
  sheet.querySelector('[data-close]').addEventListener('click', () => {
    sheet.hidden = true;
  });
}

/* ---------- 2c) Bottom-Bar: Rack/Mix/Song/Jam-Umschalter ----------
 * Öffnet/schließt dieselben Sheets, die vorher übers PRJ-Sheet erreichbar
 * waren (modeOpen.mix/song/jam, s. wireMixerUI/wireSongUI/wireJamViewUI) —
 * dupliziert also keine Render-/Meter-Logik. Zusätzlich: Mutual Exclusion
 * (nur eine Konsole gleichzeitig offen) und Active-Tab-Sync per
 * MutationObserver, weil jede Konsole auch über ihren eigenen ✕-Button
 * schließen kann, nicht nur über die Bottom-Bar selbst. */
function wireBottomBar() {
  const sheets = { mix: $('#mixer-sheet'), song: $('#song-sheet'), jam: $('#jam-sheet') };
  const modeBtns = document.querySelectorAll('.bb-mode');

  const syncActive = () => {
    const openMode = Object.entries(sheets).find(([, s]) => !s.hidden)?.[0] ?? 'rack';
    modeBtns.forEach((btn) => btn.classList.toggle('is-active', btn.dataset.mode === openMode));
  };

  modeBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      $('#project-sheet').hidden = true;
      for (const [m, s] of Object.entries(sheets)) if (m !== mode) s.hidden = true;
      if (mode !== 'rack') modeOpen[mode]();
      syncActive();
    });
  });

  for (const s of Object.values(sheets)) {
    new MutationObserver(syncActive).observe(s, { attributes: true, attributeFilter: ['hidden'] });
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

/* ---------- Erste-Hilfe-Sheet (einmalig) ---------- */
/** Kurzer Überblick über die wichtigsten Gesten, einmalig beim aller-
 *  ersten Start gezeigt (hintOnce-Flag) — ergänzt die kontextuellen
 *  Einzel-Hinweise (REC, Long-Press), die erst im jeweiligen Moment
 *  greifen, um eine Gesamtübersicht direkt am Anfang. */
function wireOnboardingUI() {
  const sheet = $('#onboarding-sheet');
  sheet.querySelectorAll('[data-close]').forEach((el) =>
    el.addEventListener('click', () => { sheet.hidden = true; }));
  hintOnce('onboarding-sheet', () => { sheet.hidden = false; });
}
