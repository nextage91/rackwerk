/**
 * main.js — verdrahtet Engine, Transport, Rack und die Transport-Leiste.
 */
import './ui/knob.js';                       // registriert <x-knob>
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
import { Rack } from './rack/rack.js';

const $ = (sel) => document.querySelector(sel);

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

/* ---------- 2) App-Start, sobald Audio bereit ist ---------- */
function boot() {
  const rack = new Rack($('#rack'), $('#machine-sheet'));
  song.bind(rack); // Song-Wiedergabe/-Aufnahme braucht Zugriff aufs Rack

  // Master-Effekte: Ketten an die Send-Busse hängen, Panel ans Rack-Ende
  masterFX.init();
  $('#rack').appendChild(masterFX.render());

  // Kurzwahl-Module: Mixer/Song-Timeline direkt aus dem Rack öffnen,
  // ohne den Umweg über das Projekte-Sheet.
  $('#rack').appendChild(buildRackShortcut({
    icon: '🎚️', label: 'Mixer', color: '#7fd6a0',
    onOpen: () => $('#btn-open-mixer').click(),
  }));
  $('#rack').appendChild(buildRackShortcut({
    icon: '🎬', label: 'Song Timeline', color: '#ff4d3d',
    onOpen: () => $('#btn-open-song').click(),
  }));

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

/** Kompaktes Rack-Modul, das nur einen bestehenden Öffnen-Mechanismus
 *  antriggert (Mixer-/Song-Sheet) — dupliziert keine Logik, ruft nur
 *  den Klick auf den jeweils schon verdrahteten Sheet-Öffner-Button. */
function buildRackShortcut({ icon, label, color, onOpen }) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'machine rack-shortcut';
  el.style.setProperty('--m-color', color);
  el.style.setProperty('--m-color-glow', `rgba(${r},${g},${b},.45)`);
  el.innerHTML = `
    <span class="machine__stripe"></span>
    <span class="rack-shortcut__icon">${icon}</span>
    <span class="rack-shortcut__label">${label}</span>
    <span class="rack-shortcut__chev">›</span>
  `;
  el.addEventListener('click', onOpen);
  return el;
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
        try {
          loadProject(rack, JSON.parse(store.get(`project:${name}`)));
          nameInput.value = name;
          sheet.hidden = true;
        } catch (err) {
          console.error('Project could not be loaded:', err);
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
      try {
        const data = JSON.parse(reader.result);
        if (importMode === 'replace') loadProject(rack, data);
        else importMachines(rack, data);
        sheet.hidden = true;
      } catch (err) {
        console.error('Import failed:', err);
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

  $('#btn-open-song').addEventListener('click', () => {
    $('#project-sheet').hidden = true; // vom Projekte-Sheet aus geöffnet
    render();
    sheet.hidden = false;
  });
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

/* ---------- Mixer: Pegel/Panorama/Mute/Solo aller Maschinen im Überblick ----------
 * Steuert dieselben Werte, die auch die Maschinen-Panels selbst zeigen (eine
 * Quelle der Wahrheit über Machine.setLevel/setPan/setMuted/setSoloed) — der
 * Mixer ist eine zusätzliche, zentrale Bedienoberfläche, kein zweiter Pegel. */
function wireMixerUI(rack) {
  const sheet = $('#mixer-sheet');
  const list = $('#mixer-list');

  /** Ein Kanalzug (Level/Pan/Mute/Solo) für eine Maschine ODER eine
   *  einzelne Drum-Spur — beide teilen sich dieselben Setter-Namen
   *  (setLevel/setPan/level/pan), nur Mute/Solo gibt es nur maschinenweit. */
  const buildStrip = (target, { name, withButtons = true, compact = false } = {}) => {
    const strip = document.createElement('div');
    strip.className = 'mixer-strip' + (compact ? ' mixer-substrip' : '');
    const head = compact
      ? `<span class="mixer-substrip__name">${name}</span>`
      : `<div class="mixer-strip__head">
           <span class="mixer-strip__stripe"></span>
           <span class="mixer-strip__name">${name}</span>
         </div>`;
    strip.innerHTML = `
      ${head}
      <div class="mixer-strip__knobs">
        <x-knob label="Level" min="0" max="1" value="${target.level}" data-k="level"></x-knob>
        <x-knob label="Pan" min="-1" max="1" default="0" value="${target.pan}" data-k="pan"></x-knob>
      </div>
      ${withButtons ? `
      <div class="mixer-strip__buttons">
        <button class="m-btn m-btn--solo${target.soloed ? ' is-active' : ''}" data-solo>SOLO</button>
        <button class="m-btn m-btn--mute${target.muted ? ' is-active' : ''}" data-mute>MUTE</button>
      </div>` : ''}
    `;
    strip.querySelector('[data-k="level"]').addEventListener('input', (e) => target.setLevel(e.detail.value));
    strip.querySelector('[data-k="pan"]').addEventListener('input', (e) => target.setPan(e.detail.value));
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
    return strip;
  };

  const render = () => {
    list.innerHTML = '';
    if (!rack.machines.length) {
      list.innerHTML = '<p class="sheet__empty">No machines in the rack.</p>';
      return;
    }
    for (const m of rack.machines) {
      const { name, color, type } = m.constructor.meta;
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));

      if (type === 'beatbox') {
        // Gruppe: Gesamt-Kanalzug (Kit-Bus) + eine Zeile je Drum-Spur
        const group = document.createElement('div');
        group.className = 'mixer-group';
        group.style.setProperty('--m-color', color);
        group.style.setProperty('--m-color-dim', `rgba(${r},${g},${b},.3)`);
        group.appendChild(buildStrip(m, { name }));

        const subtracks = document.createElement('div');
        subtracks.className = 'mixer-subtracks';
        m.tracks.forEach((tr, i) => {
          const sub = buildStrip(
            { level: tr.level, pan: tr.pan,
              setLevel: (v) => m.setTrackLevel(i, v), setPan: (v) => m.setTrackPan(i, v) },
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

  $('#btn-open-mixer').addEventListener('click', () => {
    $('#project-sheet').hidden = true; // vom Projekte-Sheet aus geöffnet
    render();
    sheet.hidden = false;
  });
  sheet.querySelector('[data-close]').addEventListener('click', () => { sheet.hidden = true; });
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
  btnRec.addEventListener('click', () => {
    automation.setArmed(!automation.armed);
    btnRec.classList.toggle('is-armed', automation.armed);
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
        iconPlay.hidden = playing;
        iconStop.hidden = !playing;
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
