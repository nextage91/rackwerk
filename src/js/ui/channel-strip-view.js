/**
 * Vollbild-Kanalzug -- ersetzt die alte Mixer-Listenansicht (Nutzer-
 * Anfrage, s. Chat: horizontal gescrollte 124px-Spalten waren auf dem
 * Phone kaum präzise bedienbar; stattdessen ein Ziel nach dem anderen,
 * mit einem richtig grossen Fader). Reicht von main.js#wireChannelStripView
 * (öffnet/schliesst den Sheet-Rahmen aus index.html, s. dort) hierher durch.
 *
 * Ziel-Objekte sind entweder eine Machine-Instanz (rack.machines) oder der
 * masterFX-Singleton -- fest ans Ende des Prev/Next-Zyklus gehängt, exakt
 * dieselbe Ring-Reihenfolge, die jam-view.js#buildMasterColumn für den
 * Master-Kanal in der Jam-Ansicht schon nutzt ("fix ganz am Ende").
 * masterFX hat dafür dieselben Setter-/Getter-Namen wie eine Machine
 * bekommen (level/setLevel/getMeterAnalyser, s. core/fx.js), aber weder
 * Pan noch Sends noch Mute/Solo -- buildStrip() blendet diese Regler-
 * gruppen darum aus, wenn sie am Ziel fehlen (withPan/withSends/
 * withMuteSolo).
 */
import { computeLevels } from './meter.js';
import { masterFX } from '../core/fx.js';

let rackRef = null;
let titleEl, prevBtn, nextBtn, bodyEl;
let currentTarget = null;

/** Welche Drum-Gruppen (BeatBox/AnalogKit) gerade aufgeklappt sind -- ein
 *  WeakSet statt Array/Objekt, damit eine aus dem Rack entfernte Maschine
 *  automatisch mit rausfällt, ohne dass wir das selbst aufräumen müssen
 *  (gleiches Muster wie main.js#wireMixerUI vorher für das alte Mixer-
 *  Sheet). Modul-weiter Zustand statt pro Öffnen neu -- Nutzer-Anfrage:
 *  der Auf-/Zu-Zustand soll die Session überleben, nicht nur den aktuell
 *  offenen Kanalzug. */
const expandedGroups = new WeakSet();

/* Ein gemeinsamer rAF-Ticker treibt alle sichtbaren VU-Meter dieses
   Kanalzugs (Hauptspur + ggf. aufgeklappte Drum-Unterspuren) -- nur
   während der Kanalzug offen ist. */
let meterEntries = [];
let meterRAF = null;
const meterTick = () => {
  for (const m of meterEntries) {
    const { rmsDb, peakDb } = computeLevels(m.analyser, m.buf);
    m.el.update(rmsDb, peakDb);
  }
  meterRAF = requestAnimationFrame(meterTick);
};
const startMeters = () => { if (!meterRAF) meterRAF = requestAnimationFrame(meterTick); };
const stopMeters = () => { if (meterRAF) cancelAnimationFrame(meterRAF); meterRAF = null; };

function cycleOrder() {
  return [...rackRef.machines, masterFX];
}

function displayNameOf(target) {
  return target === masterFX ? 'Master' : target.displayName;
}

/** Ein Kanalzug (Fader + VU-Meter + optional Pan/Sends/Solo/Mute) für eine
 *  Maschine, eine einzelne Drum-Spur ODER Master -- alle drei teilen sich
 *  dieselben Setter-Namen (setLevel/setPan/setSend/level/pan/sends/
 *  getMeterAnalyser), s. Dateikopf-Kommentar. `big` schaltet auf die
 *  vollbild-grosse CSS-Variante (Haupt-Kanalzug), `compact` auf die kleine
 *  (Drum-Unterspuren) -- identische Grössen-Sprache wie vorher im Mixer-
 *  Sheet (main.js), nur ohne die 124px-Spaltenbreite drumherum. */
function buildStrip(target, { name, big = false, compact = false, withPan = true, withSends = true, withMuteSolo = true } = {}) {
  const strip = document.createElement('div');
  strip.className = 'chstrip' + (big ? ' chstrip--big' : '') + (compact ? ' chstrip--sub' : '');
  strip.innerHTML = `
    <div class="chstrip__head">
      <span class="chstrip__stripe"></span>
      <span class="chstrip__name">${name}</span>
    </div>
    ${(withPan || withSends) ? `
    <div class="chstrip__knobs">
      ${withPan ? `<x-knob label="Pan" min="-1" max="1" default="0" value="${target.pan}" data-k="pan"></x-knob>` : ''}
      ${withSends ? `
      <x-knob label="Dly" min="0" max="1" value="${target.sends.delay}" data-k="sendDelay"></x-knob>
      <x-knob label="Rev" min="0" max="1" value="${target.sends.reverb}" data-k="sendReverb"></x-knob>` : ''}
    </div>` : ''}
    <div class="chstrip__meters">
      <!-- compact bleibt IMMER an, auch im grossen Haupt-Kanalzug: ohne
           compact rendert x-meter zusätzlich seine eigene dB-Skala, die
           bei vertical (x-meter selbst ist dann flex-direction:column)
           als Geschwister-Element ÜBER dem LED-Balken steht und sich mit
           ihm die Höhe teilt -- der LED-Balken füllt dann nur noch die
           halbe Fader-Höhe, und die Skala des Faders daneben (components.
           css) macht eine zweite, redundante Skala nur noch verwirrender.
           compact+vertical ist die einzige Kombination, die im Rest der
           App je benutzt wurde (Maschinen-Kopfzeile, Insert-Zeile) --
           genau deshalb ist es hier auch bewusst kein Unterschied
           zwischen "big" und den kleineren Varianten. -->
      <x-meter compact vertical></x-meter>
      <x-fader default="1" value="${target.level}" data-k="level"></x-fader>
    </div>
    ${withMuteSolo ? `
    <div class="chstrip__buttons">
      <button class="m-btn m-btn--solo${target.soloed ? ' is-active' : ''}" data-solo>SOLO</button>
      <button class="m-btn m-btn--mute${target.muted ? ' is-active' : ''}" data-mute>MUTE</button>
    </div>` : ''}
  `;
  strip.querySelector('[data-k="level"]').addEventListener('input', (e) => target.setLevel(e.detail.value));
  if (withPan) strip.querySelector('[data-k="pan"]').addEventListener('input', (e) => target.setPan(e.detail.value));
  if (withSends) {
    strip.querySelector('[data-k="sendDelay"]').addEventListener('input', (e) => target.setSend('delay', e.detail.value));
    strip.querySelector('[data-k="sendReverb"]').addEventListener('input', (e) => target.setSend('reverb', e.detail.value));
  }
  if (withMuteSolo) {
    const muteBtn = strip.querySelector('[data-mute]');
    const soloBtn = strip.querySelector('[data-solo]');
    muteBtn.addEventListener('click', () => target.setMuted(!target.muted));
    soloBtn.addEventListener('click', () => target.setSoloed(!target.soloed));
    // Gleicher lose Push-Hook wie vorher im Mixer-Sheet -- hält diesen
    // Button synchron, falls Mute/Solo von woanders geändert wird (z. B.
    // dem Vollbild-Editor derselben Maschine), während dieser Kanalzug
    // offen ist. Zeigt nach dem Weiterblättern (Prev/Next) auf ein
    // inzwischen aus dem DOM entferntes Element -- harmlos (classList.
    // toggle auf einem losgelösten Element tut nichts), wird beim
    // nächsten Öffnen dieses Ziels ohnehin frisch neu gesetzt.
    target.onMixerChange = () => {
      muteBtn.classList.toggle('is-active', target.muted);
      soloBtn.classList.toggle('is-active', target.soloed);
    };
  }
  const analyser = target.getMeterAnalyser?.();
  if (analyser && typeof analyser.getFloatTimeDomainData === 'function') {
    meterEntries.push({ analyser, buf: new Float32Array(analyser.fftSize), el: strip.querySelector('x-meter') });
  }
  return strip;
}

function renderCurrent() {
  bodyEl.innerHTML = '';
  meterEntries = [];
  const target = currentTarget;
  const name = displayNameOf(target);
  titleEl.textContent = name;

  if (target === masterFX) {
    bodyEl.appendChild(buildStrip(target, { name, big: true, withPan: false, withSends: false, withMuteSolo: false }));
    return;
  }

  const { color } = target.constructor.meta;

  if (Array.isArray(target.tracks)) {
    // Drum-Gruppe (BeatBox/AnalogKit): Kit-Bus-Kanalzug + Ausklapp-Toggle,
    // die Spuren erscheinen beim Ausklappen RECHTS DANEBEN im selben
    // horizontalen Scroll-Fluss statt in einer neuen Zeile darunter
    // (Nutzer-Anfrage, 2. Anlauf: "auch das Aufklappen seitlich, nicht nach
    // unten") -- .cs-group__main bündelt Kit-Bus+Toggle als erste "Seite"
    // dieses Scrolls, s. app.css für die Layout-Begründung.
    const wrap = document.createElement('div');
    wrap.className = 'cs-group';
    wrap.style.setProperty('--m-color', color);
    if (!expandedGroups.has(target)) wrap.classList.add('is-collapsed');

    const mainCol = document.createElement('div');
    mainCol.className = 'cs-group__main';

    const main = buildStrip(target, { name, big: true });

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'cs-group__toggle';
    toggle.setAttribute('aria-label', 'Toggle drum tracks');
    toggle.addEventListener('click', () => {
      const collapsed = wrap.classList.toggle('is-collapsed');
      if (collapsed) expandedGroups.delete(target); else expandedGroups.add(target);
    });

    mainCol.appendChild(main);
    mainCol.appendChild(toggle);

    const subtracks = document.createElement('div');
    subtracks.className = 'cs-group__subtracks';
    target.tracks.forEach((tr, i) => {
      const sub = buildStrip(
        {
          level: tr.level, pan: tr.pan, sends: { delay: tr.sendDelay, reverb: tr.sendReverb },
          setLevel: (v) => target.setTrackLevel(i, v), setPan: (v) => target.setTrackPan(i, v),
          setSend: (which, v) => target.setTrackSend(i, which, v),
          getMeterAnalyser: () => target.getTrackMeterAnalyser(i),
        },
        { name: tr.name, compact: true, withMuteSolo: false },
      );
      subtracks.appendChild(sub);
    });

    wrap.appendChild(mainCol);
    wrap.appendChild(subtracks);
    bodyEl.appendChild(wrap);
    return;
  }

  const strip = buildStrip(target, { name, big: true });
  strip.style.setProperty('--m-color', color);
  bodyEl.appendChild(strip);
}

function openChannelStrip(target) {
  // Gleicher Hook wie rack.js#openFocus -- schliesst Projekt-/Song-/Jam-
  // Sheet und ein offenes Maschinen-Fokus-/Add-Sheet, BEVOR dieser Sheet
  // sich zeigt. Ohne das blieb z. B. das Song-Sheet im Hintergrund offen
  // liegen, wenn man über den Rack-Zeilen-Button direkt in den Kanalzug
  // sprang, statt über die (inzwischen entfernte) Bottom-Bar-Mix-Taste,
  // die diesen Schritt vorher immer miterledigt hat (s. main.js#
  // wireBottomBar) -- verletzt die App-weite "nur eine Ebene gleichzeitig
  // offen"-Regel (main.js#closeAllOverlays).
  rackRef.onBeforeOpenOverlay?.();
  currentTarget = target;
  renderCurrent();
  document.getElementById('mixer-sheet').hidden = false;
  startMeters();
}

/** Prev/Next -- zyklt durch rack.machines in Rack-Reihenfolge, Master fix
 *  am Ende, mit Wrap-Around in beide Richtungen (Nutzer-Anfrage: "gleich
 *  zur nächsten Maschinen-Mix-View springen ohne wieder zurück über das
 *  Rack zu müssen"). */
function step(dir) {
  const order = cycleOrder();
  let idx = order.indexOf(currentTarget);
  if (idx === -1) idx = 0;
  idx = (idx + dir + order.length) % order.length;
  openChannelStrip(order[idx]);
}

export function initChannelStripView(rack) {
  rackRef = rack;
  const sheet = document.getElementById('mixer-sheet');
  titleEl = document.getElementById('cs-title');
  prevBtn = document.getElementById('btn-cs-prev');
  nextBtn = document.getElementById('btn-cs-next');
  bodyEl = document.getElementById('channel-strip');

  prevBtn.addEventListener('click', () => step(-1));
  nextBtn.addEventListener('click', () => step(1));
  sheet.querySelector('[data-close]').addEventListener('click', () => {
    sheet.hidden = true;
    stopMeters();
  });

  // Einstiegspunkte: ein Button pro Rack-Zeile (rack.js) + einer im
  // Master-FX-Panel-Header (fx.js) -- beide rufen nur diesen Hook, kein
  // direkter Import von rack.js/fx.js hier nötig.
  rack.onOpenChannelStrip = (machine) => openChannelStrip(machine);
  masterFX.onOpenChannelStrip = () => openChannelStrip(masterFX);
}
