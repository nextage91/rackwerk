/**
 * main.js — verdrahtet Engine, Transport, Rack und die Transport-Leiste.
 */
import './ui/knob.js';                       // registriert <x-knob>
import { engine } from './core/audio-engine.js';
import { transport, STEPS_PER_BAR } from './core/transport.js';
import { automation } from './core/automation.js';
import { store } from './core/store.js';
import { serializeProject, loadProject, importMachines } from './core/project.js';
import { recorder } from './core/recorder.js';
import { jamlink } from './core/jamlink.js';
import { Rack } from './rack/rack.js';
import { SubSynth } from './machines/subsynth.js';
import { BeatBox } from './machines/beatbox.js';

const $ = (sel) => document.querySelector(sel);

/* ---------- 1) Audio-Unlock (Pflicht-Geste auf iOS/Android) ---------- */
$('#btn-unlock').addEventListener('click', async () => {
  const hint = $('#btn-unlock small');
  try {
    const ok = await engine.unlock();
    if (!ok) {
      hint.textContent = 'Audio blockiert — bitte erneut tippen';
      return;
    }
  } catch (err) {
    console.error('Audio-Unlock fehlgeschlagen:', err);
    hint.textContent = 'Audio nicht verfügbar: ' + err.message;
    return;
  }

  $('#unlock-overlay').hidden = true;
  boot();
});

/* ---------- 2) App-Start, sobald Audio bereit ist ---------- */
function boot() {
  const rack = new Rack($('#rack'), $('#machine-sheet'));

  // Letzte Session wiederherstellen; sonst Startbesetzung mit Demo-Groove
  let restored = false;
  const autosave = store.get('autosave');
  if (autosave) {
    try {
      loadProject(rack, JSON.parse(autosave));
      restored = true;
    } catch (err) {
      console.warn('Autosave nicht ladbar, starte frisch:', err);
    }
  }
  if (!restored) {
    rack.addMachine(BeatBox);
    rack.addMachine(SubSynth);
  }

  wireTransportUI();
  wireProjectUI(rack);
  wireJamUI(rack);

  // Autosave: alle 3 s den kompletten Zustand sichern
  setInterval(() => {
    try {
      store.set('autosave', JSON.stringify(serializeProject(rack)));
    } catch (err) {
      console.warn('Autosave fehlgeschlagen:', err);
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
      list.innerHTML = '<p class="sheet__empty">Noch keine gespeicherten Projekte.</p>';
      return;
    }
    for (const name of names) {
      const item = document.createElement('div');
      item.className = 'sheet__item sheet__item--project';
      item.innerHTML = `
        <button class="project__load">${name}</button>
        <button class="project__delete" aria-label="Projekt löschen">✕</button>
      `;
      item.querySelector('.project__load').addEventListener('click', () => {
        try {
          loadProject(rack, JSON.parse(store.get(`project:${name}`)));
          nameInput.value = name;
          sheet.hidden = true;
        } catch (err) {
          console.error('Projekt nicht ladbar:', err);
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
    const name = nameInput.value.trim() || 'Ohne Titel';
    store.set(`project:${name}`, JSON.stringify(serializeProject(rack)));
    refreshList();
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
      console.error('Download nicht möglich:', err);
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
        console.error('Import fehlgeschlagen:', err);
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
        recResult.textContent = 'Aufnahme wird von diesem WebView leider nicht unterstützt.';
        return;
      }
      if (!recorder.start()) return;
      recBtn.textContent = '■ Stopp & Speichern';
      recTime.hidden = false;
      prjBtn.classList.add('is-recording');
      recTimer = setInterval(() => { recTime.textContent = fmtTime(recorder.elapsed); }, 500);
    } else {
      clearInterval(recTimer);
      const result = await recorder.stop();
      recBtn.textContent = '● Aufnahme starten';
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
              textContent: 'Wiedergabe wird hier blockiert — bitte Download/Teilen nutzen oder in Safari testen.',
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
        shareBtn.textContent = '⇪ Teilen / Sichern …';
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

  const show = (phase) => {
    idle.hidden = phase !== 'idle';
    setup.hidden = phase !== 'setup';
    active.hidden = phase !== 'active';
  };

  const fail = (err) => {
    console.error('Jam-Fehler:', err);
    instructions.textContent = 'Verbindung fehlgeschlagen: ' + (err?.message ?? err);
  };

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
      ? `Verbunden als Host (±${ms} ms) — dieses Gerät steuert Play/Stop und BPM.`
      : `Verbunden als Gast (±${ms} ms) — Play/Stop und BPM steuert der Host.`;
  };

  jamlink.onstate = (event) => {
    if (event === 'open') {
      show('active');
      prjBtn.classList.add('is-linked');
      transport.addListener(beatListener);
      status.textContent = jamlink.role === 'host'
        ? 'Verbunden als Host — messe Laufzeit …'
        : 'Verbunden als Gast — Uhr wird abgeglichen …';
    } else if (event === 'sync') {
      showStatus();
    } else if (event === 'connecting') {
      instructions.textContent = 'Codes ausgetauscht — Geräte verbinden sich …';
    } else if (event === 'failed') {
      instructions.textContent =
        'Verbindung fehlgeschlagen: Die Geräte konnten sich nicht erreichen. ' +
        'Am zuverlässigsten klappt es, wenn beide im selben WLAN sind — ' +
        'oder eines den persönlichen Hotspot des anderen nutzt. Dann neu versuchen.';
    } else if (event === 'unstable') {
      status.textContent = 'Verbindung instabil — versuche wiederherzustellen …';
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
      instructions.textContent = 'WebRTC wird von diesem WebView nicht unterstützt.';
      show('setup');
      codeOut.hidden = codeIn.hidden = true;
      return;
    }
    show('setup');
    codeOut.hidden = codeIn.hidden = false;
    instructions.textContent =
      '1) Diesen Code ans andere Gerät schicken (dort: Beitreten → einfügen → Übernehmen). ' +
      '2) Dessen Antwort-Code unten einfügen und Übernehmen.';
    codeOut.value = 'Erzeuge Code …';
    try { codeOut.value = await jamlink.createOffer(); } catch (err) { fail(err); }
  });

  $('#btn-jam-join').addEventListener('click', () => {
    if (!jamlink.supported) {
      instructions.textContent = 'WebRTC wird von diesem WebView nicht unterstützt.';
      show('setup');
      codeOut.hidden = codeIn.hidden = true;
      return;
    }
    show('setup');
    codeOut.hidden = codeIn.hidden = false;
    instructions.textContent =
      '1) Code des Hosts unten einfügen und Übernehmen. ' +
      '2) Den hier erscheinenden Antwort-Code zurück an den Host schicken.';
    codeOut.value = '';
  });

  $('#btn-jam-apply').addEventListener('click', async () => {
    const code = codeIn.value.trim();
    if (!code) return;
    try {
      if (jamlink.pc && jamlink.role === 'host') {
        await jamlink.acceptAnswer(code);          // Host: Antwort einlesen
      } else {
        codeOut.value = 'Erzeuge Antwort-Code …';
        codeOut.value = await jamlink.createAnswer(code); // Gast: Antwort bauen
      }
      codeIn.value = '';
    } catch (err) { fail(err); }
  });

  $('#btn-jam-copy').addEventListener('click', () => {
    codeOut.select();
    navigator.clipboard?.writeText(codeOut.value).catch(() => {
      try { document.execCommand('copy'); } catch { /* Nutzer kopiert manuell */ }
    });
  });

  $('#btn-jam-cancel').addEventListener('click', () => {
    jamlink.close();
    show('idle');
    stopBeatLed();
  });

  $('#btn-jam-send').addEventListener('click', () => {
    jamlink.sendProject(serializeProject(rack));
  });

  $('#btn-jam-leave').addEventListener('click', () => {
    jamlink.close();
    show('idle');
    stopBeatLed();
  });
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
          playing ? 'Wiedergabe stoppen' : 'Wiedergabe starten');
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
