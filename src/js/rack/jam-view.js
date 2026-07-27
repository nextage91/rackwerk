/**
 * jam-view — Live-Performance-Ansicht: Clips starten, Sound formen, mixen,
 * eine Spalte pro Instrument (wie ein Mischpult mit Clip-Slots obendrauf).
 *
 * Architektur:
 * - Clips laufen NEBEN den A/B/C/D-Pattern-Slots (s. machine.js#addClip,
 *   #bindClipData) — Starten überschreibt nie einen Slot.
 * - Alle Spuren teilen sich einen globalen Takt (den bestehenden
 *   Transport). Ein angetippter Clip wird nicht sofort scharf, sondern
 *   "queued" (wartet) und erst am nächsten Taktanfang (16tel-Vielfaches
 *   von STEPS_PER_BAR) tatsächlich eingeblendet — dieselbe Idee wie
 *   Ableton Live Session View, nur ohne eigenen Zähler pro Spur.
 * - Läuft der Transport gerade NICHT, wird sofort gebunden (kein Warten
 *   auf einen Taktanfang, der nicht kommt).
 * - Jede Spur hat einen EIGENEN, unabhängigen Stumm-Zustand (`stopped`,
 *   s. stateFor()/haltMachine()/resumeMachine()) — anders als früher NICHT
 *   mehr davon abhängig, ob irgendwo sonst im Rack ein Clip läuft (Nutzer-
 *   Anfrage: "wenn kein Clip läuft, spielen trotzdem alle Maschinen ihr
 *   Pattern — das sollte komplett stoppen können"). machine.setJamGate()
 *   (ein zusätzliches Gate neben Mute/Solo, kein persistenter Zustand)
 *   spiegelt exakt dieses Flag, s. refreshJamGate(). Eine unangetastete
 *   Spur bleibt beim Standard `stopped:false` und spielt wie gewohnt ihr
 *   normales A/B/C/D-Pattern — nur EXPLIZITES Stoppen (Stop-Button pro
 *   Spur, erneuter Tap auf den aktiven Clip, oder der globale "Stop All"-
 *   Button, s. stopAllClips()) macht sie still, ganz wie Ableton Live
 *   Session View: Stop heisst "keine Clips mehr auf dieser Spur", nicht
 *   "Transport anhalten" — der Takt läuft einfach weiter.
 * - Scenes (s. saveScene()/launchScene()) merken sich pro Maschine den
 *   gerade aktiven Clip als benannten Schnappschuss; ein Launch triggert
 *   exakt diese Clips neu UND stoppt jede Maschine, die beim Speichern
 *   KEINEN aktiven Clip hatte — "einen ganzen Song-Abschnitt mit einem Tap
 *   wechseln", das Ableton-Scene-Äquivalent. Rein Jam-Performance-Zustand
 *   wie activeClipId/stopped (s. unten) — nicht im Projekt gespeichert.
 * - Reglerwerte (Fader/Pan/Sends/Makro-Knobs) laufen über dieselben
 *   Setter/Custom-Elemente wie überall sonst in der App (x-knob/x-fader,
 *   setLevel/setSend/…) — keine Parallel-Implementierung.
 * - Makro-Knobs sind bewusst kuratiert (4 pro Instrument), nicht
 *   vollständig: Metadaten (Label/Bereich/Kurve) werden direkt vom
 *   ECHTEN Knob im Maschinen-Panel abgelesen (kein doppelt gepflegter
 *   Bereich) und per synthetischem `input`-Event auf genau diesem Knob
 *   angewendet — derselbe Weg, den auch die Automation für data-auto-
 *   Knobs nutzt.
 */
import { transport, STEPS_PER_BAR } from '../core/transport.js';
import { undo } from '../core/undo.js';

/** Kuratierte Makro-Parameter je Maschinentyp — bewusst 4, nicht alle.
 *  Bei BeatBox/AnalogKit sind das die SPUR-Regler (Tune/Decay/Level/Snap
 *  der gerade in der Maschine gewählten Spur, this.selected) — dieselben
 *  vier, die im eigenen Panel unter "Pattern" stehen. Kit-Lautstärke hat
 *  bereits den Fader, taucht hier bewusst nicht doppelt auf. */
const MACRO_PARAMS = {
  beatbox: ['tune', 'decay', 'level', 'snap'],
  analogkit: ['tune', 'decay', 'level', 'snap'],
  subsynth: ['cutoff', 'resonance', 'envAmt', 'fDecay'],
  polysynth: ['cutoff', 'resonance', 'envAmt', 'fDecay'],
  percsynth: ['ratio', 'fmAmt', 'sweep', 'decay'],
  sampler: ['tune', 'level', 'trackSendDelay', 'trackSendReverb'],
  fmsynth: ['ratio', 'fmAmount', 'feedback', 'cutoff'],
  acidbass: ['cutoff', 'resonance', 'envMod', 'accent'],
};
const TRACK_SCOPED_TYPES = new Set(['beatbox', 'analogkit', 'sampler']);

/** Bewegungsschwelle Tippen-vs-Ziehen (px) -- dieselbe wie step-seq.js'
 *  TAP_THRESHOLD für Pitch-Drag: ein echter Finger-Tap hat auf dem Handy
 *  fast immer ein paar Pixel unwillkürliches Zittern. Mit dem alten Wert
 *  von 6px kippte ein normaler Tap regelmäßig fälschlich in den Dragmodus
 *  (unterdrückt dann den Click, s. makeReorderable) -- genau das Symptom
 *  "Clip startet nicht beim Antippen" auf einem echten Gerät. */
const TAP_THRESHOLD = 8;

/** Halten auf einem Clip (wie A/B/C/D-Pattern-Slots, s. pattern-bank.js)
 *  öffnet den Löschen-Chip -- dieselbe Zeitschwelle wie dort. */
const CLIP_HOLD_MS = 500;

/** Ändert einen Parameter über den ECHTEN Knob im Maschinen-Panel — löst
 *  denselben `input`-Pfad aus, den auch Handbewegung/Automation nutzen
 *  (kein `knob-grab` davor, also greift auch kein Trim/keine Aufnahme).
 *  Nimmt den Knob als Referenz statt ihn selbst nachzuschlagen: beim
 *  Ziehen eines Jam-Makro-Reglers feuert das mehrfach pro Geste (jede
 *  Wertänderung), ein erneutes querySelector() ins volle Maschinen-Panel
 *  bei jedem Schritt wäre unnötige, auf älteren iPhones spürbare Arbeit. */
function nudgeParam(knob, value) {
  knob.value = value;
  knob.dispatchEvent(new CustomEvent('input', { detail: { value }, bubbles: true }));
}

/** Insert-Effekt-Regler haben KEIN data-p (mehrere Instanzen desselben Typs
 *  wären sonst nicht unterscheidbar) -- sie tragen stattdessen data-insert-
 *  id + data-insert-param (s. machine.js#renderInserts). Der X/Y-Pad-Key
 *  für so einen Regler ist deshalb ein zusammengesetzter String
 *  "insert:<id>:<param>", INSERT_KEY_RE trennt ihn wieder auf. */
const INSERT_KEY_RE = /^insert:(\d+):(.+)$/;
function resolveKnobEl(machine, key) {
  const m = INSERT_KEY_RE.exec(key);
  if (m) return machine.el?.querySelector(`x-knob[data-insert-id="${m[1]}"][data-insert-param="${m[2]}"]`) ?? null;
  return machine.el?.querySelector(`x-knob[data-p="${key}"]`) ?? null;
}
/** Label für einen Pad-Key + seinen (bereits aufgelösten) Knob -- für einen
 *  Insert-Parameter mit Effektname + Instanz-Nummer voran ("Algorithmic
 *  Reverb #3: Decay"), weil sonst z. B. der Reverb-eigene "Decay"-Regler
 *  nicht vom maschinen-eigenen Hüllkurven-"Decay" zu unterscheiden wäre,
 *  und weil ein Panel mehrere Instanzen desselben Insert-Typs enthalten
 *  kann. Einzige Stelle, die dieses Label baut -- Mapped-Liste, Add-Liste,
 *  Achsen-Chip und Range-Editor lesen alle über readKnobMeta()/
 *  availableXYParams() hiervon ab, sonst laufen sie auseinander. */
function labelFor(key, knob) {
  const m = INSERT_KEY_RE.exec(key);
  if (!m) return knob.getAttribute('label') || key;
  const insertName = knob.closest('.insert-module')?.querySelector('.machine__name')?.textContent ?? 'FX';
  return `${insertName} #${m[1]}: ${knob.getAttribute('label') || m[2]}`;
}
function readKnobMeta(machine, key) {
  const knob = resolveKnobEl(machine, key);
  if (!knob) return null;
  return {
    knob,
    label: labelFor(key, knob),
    min: knob.getAttribute('min') ?? '0',
    max: knob.getAttribute('max') ?? '1',
    curve: knob.getAttribute('curve'),
    unit: knob.getAttribute('unit'),
    value: String(knob.value),
  };
}

/** Jeder auf dem Maschinen-Panel sichtbare data-p-Knob ist ein möglicher
 *  X/Y-Pad-Ziel -- bewusst NICHT auf die 4 kuratierten Makros beschränkt
 *  (anders als buildMacros()): das Pad soll "frei" bespielbar sein, wie
 *  gewünscht. Reihenfolge = DOM-Reihenfolge im Panel (Sends zuerst, dann
 *  die maschinen-eigenen Regler), macht die Picker-Liste vorhersehbar.
 *  ZUSÄTZLICH alle Insert-Effekt-Regler (Reverb/Filter Delay/Resonator/…),
 *  s. labelFor() für deren Effektname-Präfix. */
function availableXYParams(machine) {
  const knobs = [...(machine.el?.querySelectorAll('x-knob[data-p]') ?? [])];
  const list = knobs.map((knob) => ({ key: knob.dataset.p, label: knob.getAttribute('label') || knob.dataset.p }));
  const insertKnobs = [...(machine.el?.querySelectorAll('x-knob[data-insert-id][data-insert-param]') ?? [])];
  for (const knob of insertKnobs) {
    const key = `insert:${knob.dataset.insertId}:${knob.dataset.insertParam}`;
    list.push({ key, label: labelFor(key, knob) });
  }
  return list;
}

/** Liefert den Mix-Key DESSELBEN Inserts, wenn `key` ein Insert-Regler
 *  ist, der NICHT selbst der Mix-Regler ist, und der Insert-Typ
 *  überhaupt einen Mix-Regler hat (Comp/EQ/Drive haben keinen -- sie sind
 *  immer voll "wet", ein Dry/Wet-Mix ergibt dort keinen Sinn). Grundlage
 *  für's automatische Mitmappen des Mix-Reglers beim Zuordnen eines
 *  anderen Insert-Parameters (s. Nutzer-Anfrage: sonst bewegt sich der
 *  Effekt-Parameter über die Achse, aber der Effekt bleibt bei Mix=0
 *  unhörbar). */
function siblingMixKey(machine, key) {
  const m = INSERT_KEY_RE.exec(key);
  if (!m || m[2] === 'mix') return null;
  const mixKey = `insert:${m[1]}:mix`;
  return readKnobMeta(machine, mixKey) ? mixKey : null;
}

/** Dieselbe Normalisierung wie <x-knob>#toNorm()/#fromNorm() (dort private,
 *  hier dupliziert statt exportiert -- kein Umbau der Komponente nötig).
 *  Sorgt dafür, dass eine Pad-Geste sich exakt so anfühlt wie dasselbe
 *  Ziel direkt am Regler zu drehen, log-Kurven eingeschlossen. */
function normFromValue(value, meta) {
  const min = parseFloat(meta.min), max = parseFloat(meta.max);
  if (meta.curve === 'log') return Math.log(value / min) / Math.log(max / min);
  return (value - min) / (max - min);
}
function valueFromNorm(norm, meta) {
  const min = parseFloat(meta.min), max = parseFloat(meta.max);
  const n = Math.min(1, Math.max(0, norm));
  return meta.curve === 'log' ? min * Math.pow(max / min, n) : min + n * (max - min);
}

/** Der Wert, der in der Pad-MITTE stehen soll -- beim Zuordnen aus dem
 *  damals aktuellen Reglerwert gemerkt (s. renderXYList/xyStateFor), NICHT
 *  die Bereichsmitte von [from,to] (Nutzer-Anfrage: das bisher im Rack
 *  erarbeitete Sound-Design darf durchs Zuordnen aufs Pad nicht kaputt
 *  gehen -- die Mitte des Pads MUSS deshalb exakt dieser Ausgangswert
 *  sein, für JEDEN Parameter, auch Sends/Insert-Mix, keine Ausnahme).
 *  Geklemmt in [from,to] (bzw. deren tatsächliche Reihenfolge, from>to ist
 *  erlaubt, s. xyStateFor-Kommentar) -- falls sich der Bereich nachträglich
 *  über den Range-Editor geändert hat. Ältere, vor diesem Feld gespeicherte
 *  Zuordnungen (kein `anchor`) fallen auf die alte Bereichsmitte zurück,
 *  bis man sie neu zuordnet -- kein Absturz, kein Datenverlust. */
function anchorFor(entry, meta) {
  const lo = Math.min(entry.from, entry.to), hi = Math.max(entry.from, entry.to);
  if (entry.anchor == null) {
    return meta.curve === 'log' && lo > 0 ? Math.sqrt(lo * hi) : (lo + hi) / 2;
  }
  return Math.min(hi, Math.max(lo, entry.anchor));
}

/* ---------- X/Y-Pad-Zuordnung (Sibling-Feld machine.xyMap, s. machine.js/
 * project.js -- Nutzer-Anfrage: eine mühsam eingestellte Pad-Zuordnung soll
 * ein Neuladen/Speichern überleben, nicht bei jeder Session neu auf den
 * Delay/Reverb-Default zurückfallen, genau wie xySpring). Jede Achse trägt
 * eine LISTE von Einträgen { key, from, to, anchor } statt eines einzelnen
 * Schlüssels -- "stacken" heisst einfach: mehr als ein Eintrag in der
 * Liste, jeder bekommt beim Ziehen dieselbe normalisierte Pad-Position, nur
 * auf sein eigenes [from,to] statt auf sein volles [min,max] abgebildet
 * (Regler-Kurve, s. normFromValue/valueFromNorm oben). from/to defaulten
 * auf den vollen Regler-Bereich (from=min, to=max) -- deckt sich exakt mit
 * dem alten, unbeschränkten Verhalten, bis jemand die Range aktiv einengt.
 * from>to ist bewusst erlaubt (kein Vertauschen erzwungen): dreht die
 * Zuordnung einfach um (Pad nach rechts -> Wert sinkt), ganz ohne
 * Sonderfall in der Mathematik. `anchor` (s. anchorFor() oben) ist der
 * Wert, der beim Zuordnen gerade eingestellt war -- die Pad-MITTE gibt für
 * JEDEN Parameter, ausnahmslos, genau diesen Wert zurück, damit ein im
 * Rack erarbeitetes Sound-Design durchs Zuordnen aufs Pad nicht überschrieben
 * wird (Nutzer-Anfrage). Default: Delay/Reverb-Send verankert am jeweils
 * aktuellen Send-Wert (im Regelfall 0, wie früher fest verdrahtet -- aber
 * eben nur dann, wenn tatsächlich noch nichts eingestellt wurde). `spring`
 * (Auto-Return) lebt bewusst NICHT hier, sondern direkt in machine.xySpring
 * -- eigenes Sibling-Feld statt Teil dieses Objekts, s. buildXYPad(). */
function xyStateFor(machine) {
  if (!machine.xyMap) {
    const delayMeta = readKnobMeta(machine, 'sendDelay');
    const reverbMeta = readKnobMeta(machine, 'sendReverb');
    machine.xyMap = {
      x: [{ key: 'sendDelay', from: 0, to: 1, anchor: parseFloat(delayMeta?.value ?? '0') }],
      y: [{ key: 'sendReverb', from: 0, to: 1, anchor: parseFloat(reverbMeta?.value ?? '0') }],
    };
  }
  return machine.xyMap;
}
const otherAxis = (axis) => (axis === 'x' ? 'y' : 'x');

/** Kurztext für eine Range-Zeile in der Mapped-Liste, z. B. "500 Hz –
 *  **3000 Hz** – 6000 Hz" -- der fett gesetzte mittlere Wert ist der Anker
 *  (s. anchorFor()), also der Wert, zu dem die Pad-Mitte zurückkehrt.
 *  Ganzzahlig gerundet ausser bei kleinen Bereichen (z. B. Tune 0.5..2,
 *  trotz Log-Kurve, oder Resonance 0..1), wo zwei Nachkommastellen den
 *  Unterschied zwischen den Griffen überhaupt noch erkennbar machen --
 *  bewusst NICHT an der Kurve (log/lin) festgemacht: Tune ist log-kurvig,
 *  aber klein-zahlig, Cutoff ist ebenfalls log-kurvig, aber gross-zahlig.
 *  Die tatsächliche Grössenordnung des Werts entscheidet, nicht die Kurve. */
function formatRangeText(from, to, anchor, meta) {
  const fmt = (v) => {
    const n = Math.abs(v) >= 10 ? Math.round(v) : Math.round(v * 100) / 100;
    return `${n}${meta.unit ? ' ' + meta.unit : ''}`;
  };
  return `${fmt(from)} – <strong class="xy-picker__row-anchor">${fmt(anchor)}</strong> – ${fmt(to)}`;
}

/** Achsen-Verwaltungsmenü: derselbe Popup-Baukasten wie openClipDeleteMenu
 *  (ein einzelnes, modulweites Chip, damit nie zwei gleichzeitig offen
 *  stehen), aber mit zwei Unteransichten INNERHALB desselben Popups
 *  (xyMenuView) statt eines einmaligen Auswahl-Klicks: eine Liste
 *  (gestackte Parameter + Hinzufügen-Liste) und ein Range-Editor pro
 *  Parameter, zwischen denen ein Zurück-Pfeil wechselt -- so bleibt
 *  Stacken/Entfernen/Range-Einstellen alles in derselben, an der
 *  Achsen-Beschriftung verankerten Fläche statt mehrerer Popups
 *  übereinander. */
let xyMenu = null;
let xyMenuView = { mode: 'list' };
const dismissXYMenu = () => {
  xyMenu?.remove();
  xyMenu = null;
  document.removeEventListener('pointerdown', onOutsideXYMenu, true);
};
const onOutsideXYMenu = (e) => { if (xyMenu && !xyMenu.contains(e.target)) dismissXYMenu(); };

function positionXYMenu(anchorEl) {
  const r = anchorEl.getBoundingClientRect();
  const left = Math.max(8, Math.min(
    window.innerWidth - xyMenu.offsetWidth - 8,
    r.left + r.width / 2 - xyMenu.offsetWidth / 2,
  ));
  const top = Math.max(8, Math.min(window.innerHeight - xyMenu.offsetHeight - 8, r.top - xyMenu.offsetHeight - 8));
  xyMenu.style.left = `${left}px`;
  xyMenu.style.top = `${top}px`;
}

function openXYPicker(machine, axis, anchorEl, onChange) {
  dismissXYMenu();
  xyMenuView = { mode: 'list' };
  xyMenu = document.createElement('div');
  xyMenu.className = 'xy-picker';
  document.body.appendChild(xyMenu);
  renderXYMenu(machine, axis, anchorEl, onChange);
  setTimeout(() => document.addEventListener('pointerdown', onOutsideXYMenu, true), 0);
}

function renderXYMenu(machine, axis, anchorEl, onChange) {
  xyMenu.innerHTML = '';
  if (xyMenuView.mode === 'range') {
    renderXYRangeEditor(machine, axis, anchorEl, onChange, xyMenuView.key);
  } else {
    renderXYList(machine, axis, anchorEl, onChange);
  }
  // Inhalt (und damit die Popup-Grösse) ändert sich mit jeder Aktion --
  // Position nach JEDEM Rendern neu einklemmen, nicht nur beim Öffnen.
  positionXYMenu(anchorEl);
}

function renderXYList(machine, axis, anchorEl, onChange) {
  const st = xyStateFor(machine);
  const entries = st[axis];
  const mappedKeys = new Set(entries.map((e) => e.key));
  const otherKeys = new Set(st[otherAxis(axis)].map((e) => e.key));

  const head = document.createElement('div');
  head.className = 'xy-picker__head';
  head.textContent = `${axis.toUpperCase()} axis`;
  xyMenu.appendChild(head);

  if (entries.length) {
    const mappedHead = document.createElement('div');
    mappedHead.className = 'xy-picker__subhead';
    mappedHead.textContent = 'Mapped';
    xyMenu.appendChild(mappedHead);

    for (const entry of entries) {
      const meta = readKnobMeta(machine, entry.key);
      const row = document.createElement('div');
      row.className = 'xy-picker__row';
      row.innerHTML = `
        <span class="xy-picker__row-main">
          <span class="xy-picker__row-label">${meta?.label ?? entry.key}</span>
          <span class="xy-picker__row-range">${meta ? formatRangeText(entry.from, entry.to, anchorFor(entry, meta), meta) : ''}</span>
        </span>
        <button type="button" class="xy-picker__row-btn" data-action="range">Range</button>
        <button type="button" class="xy-picker__row-btn xy-picker__row-btn--danger" data-action="remove">✕</button>
      `;
      row.querySelector('[data-action="range"]').addEventListener('click', () => {
        xyMenuView = { mode: 'range', key: entry.key };
        renderXYMenu(machine, axis, anchorEl, onChange);
      });
      row.querySelector('[data-action="remove"]').addEventListener('click', () => {
        st[axis] = entries.filter((e) => e.key !== entry.key);
        onChange();
        renderXYMenu(machine, axis, anchorEl, onChange);
      });
      xyMenu.appendChild(row);
    }
  }

  const addHead = document.createElement('div');
  addHead.className = 'xy-picker__subhead';
  addHead.textContent = entries.length ? 'Add another' : 'Add';
  xyMenu.appendChild(addHead);

  for (const { key, label } of availableXYParams(machine)) {
    if (mappedKeys.has(key)) continue; // schon auf DIESER Achse -- nicht doppelt anbieten
    const btn = document.createElement('button');
    btn.className = 'xy-picker__btn';
    btn.textContent = label;
    if (otherKeys.has(key)) {
      // Ausgegraut statt versteckt: sichtbar bleibt, DASS es diesen
      // Parameter gibt, nur eben schon auf der anderen Achse belegt --
      // verhindert versehentliches Doppel-Mapping (s. Nutzer-Anfrage),
      // ohne die Liste stumm zu verkürzen.
      btn.disabled = true;
      btn.classList.add('is-disabled');
    } else {
      btn.addEventListener('click', () => {
        const meta = readKnobMeta(machine, key);
        // Anker = der Wert, der GERADE JETZT eingestellt ist (Nutzer-
        // Anfrage: Pad-Mitte = das bereits erarbeitete Sound-Design, für
        // JEDEN Parameter ausnahmslos, auch Sends/Insert-Mix -- kein
        // Sonderfall mehr wie früher, s. anchorFor()/xyStateFor-Kommentar).
        const newEntries = [...entries, {
          key,
          from: parseFloat(meta?.min ?? '0'),
          to: parseFloat(meta?.max ?? '1'),
          anchor: parseFloat(meta?.value ?? meta?.min ?? '0'),
        }];
        // Mappt man einen Insert-Effekt-Parameter, der NICHT selbst Mix ist
        // (z. B. Reverb Decay), bleibt der Effekt bei Mix=0 unhörbar, obwohl
        // sich der Regler über die Achse bewegt -- deshalb den Mix-Regler
        // DESSELBEN Inserts automatisch mit auf dieselbe Achse stacken
        // (ebenfalls am aktuellen Mix-Wert verankert), sofern er nicht schon
        // irgendwo (dieser oder der anderen Achse) gemappt ist. Bleibt wie
        // jeder andere Stack-Eintrag über Range/✕ manuell anpassbar/entfernbar.
        const mixKey = siblingMixKey(machine, key);
        if (mixKey && !newEntries.some((e) => e.key === mixKey) && !otherKeys.has(mixKey)) {
          const mixMeta = readKnobMeta(machine, mixKey);
          newEntries.push({ key: mixKey, from: 0, to: parseFloat(mixMeta?.max ?? '1'), anchor: parseFloat(mixMeta?.value ?? '0') });
        }
        st[axis] = newEntries;
        onChange();
        renderXYMenu(machine, axis, anchorEl, onChange);
      });
    }
    xyMenu.appendChild(btn);
  }
}

/** Zwei-Griff-Range-Slider für einen einzelnen gestackten Parameter --
 *  fühlt sich fürs Eingrenzen eines Ausschnitts intuitiver an als zwei
 *  einzelne Drehregler (eher wie ein Foto-Zuschnitt/Preisfilter). Beide
 *  Griffe nutzen dieselbe normFromValue/valueFromNorm-Kurve wie das Pad
 *  selbst, nur bezogen auf den VOLLEN Regler-Bereich (nicht die aktuelle
 *  Einschränkung) -- der Track zeigt also immer den kompletten möglichen
 *  Bereich, die Füllung dazwischen die aktuell gewählte Einschränkung. */
function renderXYRangeEditor(machine, axis, anchorEl, onChange, key) {
  const st = xyStateFor(machine);
  const entry = st[axis].find((e) => e.key === key);
  const meta = readKnobMeta(machine, key);
  if (!entry || !meta) { xyMenuView = { mode: 'list' }; renderXYList(machine, axis, anchorEl, onChange); return; }

  const head = document.createElement('div');
  head.className = 'xy-picker__head xy-picker__head--nav';
  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'xy-picker__back';
  backBtn.textContent = '‹';
  backBtn.addEventListener('click', () => {
    xyMenuView = { mode: 'list' };
    renderXYMenu(machine, axis, anchorEl, onChange);
  });
  const headLabel = document.createElement('span');
  headLabel.textContent = `${meta.label} range`;
  head.append(backBtn, headLabel);
  xyMenu.appendChild(head);

  const wrap = document.createElement('div');
  wrap.className = 'xy-range';
  wrap.innerHTML = `
    <div class="xy-range__readout">
      <span class="xy-range__val xy-range__val--from"></span>
      <span class="xy-range__val xy-range__val--anchor"></span>
      <span class="xy-range__val xy-range__val--to"></span>
    </div>
    <div class="xy-range__track">
      <div class="xy-range__fill"></div>
      <div class="xy-range__anchor-mark"></div>
      <div class="xy-range__thumb xy-range__thumb--from"></div>
      <div class="xy-range__thumb xy-range__thumb--to"></div>
    </div>
  `;
  xyMenu.appendChild(wrap);

  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'xy-picker__btn xy-range__reset';
  resetBtn.textContent = 'Reset to full range';
  resetBtn.addEventListener('click', () => {
    entry.from = parseFloat(meta.min);
    entry.to = parseFloat(meta.max);
    onChange();
    syncThumbs();
  });
  xyMenu.appendChild(resetBtn);

  // Anker (Pad-Mitte, s. anchorFor()) neu am AKTUELLEN Reglerwert setzen --
  // z. B. wenn im Rack seit dem Zuordnen weitergetüftelt wurde und der
  // neue Stand das neue "Zuhause" werden soll.
  const anchorBtn = document.createElement('button');
  anchorBtn.type = 'button';
  anchorBtn.className = 'xy-picker__btn xy-range__reset';
  anchorBtn.textContent = 'Set center to current value';
  anchorBtn.addEventListener('click', () => {
    // meta.value ist eine beim Öffnen des Editors eingefrorene Kopie (s.
    // readKnobMeta) -- hier zählt der LIVE-Wert des echten Reglers, meta.knob.
    entry.anchor = parseFloat(meta.knob.value);
    onChange();
    syncThumbs();
  });
  xyMenu.appendChild(anchorBtn);

  const track = wrap.querySelector('.xy-range__track');
  const fill = wrap.querySelector('.xy-range__fill');
  const anchorMark = wrap.querySelector('.xy-range__anchor-mark');
  const fromThumb = wrap.querySelector('.xy-range__thumb--from');
  const toThumb = wrap.querySelector('.xy-range__thumb--to');
  const fromVal = wrap.querySelector('.xy-range__val--from');
  const anchorVal = wrap.querySelector('.xy-range__val--anchor');
  const toVal = wrap.querySelector('.xy-range__val--to');

  function syncThumbs() {
    const fromN = Math.min(1, Math.max(0, normFromValue(entry.from, meta)));
    const toN = Math.min(1, Math.max(0, normFromValue(entry.to, meta)));
    fromThumb.style.left = `${fromN * 100}%`;
    toThumb.style.left = `${toN * 100}%`;
    const lo = Math.min(fromN, toN), hi = Math.max(fromN, toN);
    fill.style.left = `${lo * 100}%`;
    fill.style.width = `${(hi - lo) * 100}%`;
    const anchorN = Math.min(1, Math.max(0, normFromValue(anchorFor(entry, meta), meta)));
    anchorMark.style.left = `${anchorN * 100}%`;
    const oneLine = (v) => (Math.abs(v) >= 10 ? Math.round(v) : Math.round(v * 100) / 100);
    fromVal.textContent = `${oneLine(entry.from)}${meta.unit ? ' ' + meta.unit : ''}`;
    anchorVal.textContent = `${oneLine(anchorFor(entry, meta))}${meta.unit ? ' ' + meta.unit : ''}`;
    toVal.textContent = `${oneLine(entry.to)}${meta.unit ? ' ' + meta.unit : ''}`;
  }
  syncThumbs();

  function makeThumbDraggable(thumbEl, which) {
    let dragging = false;
    thumbEl.addEventListener('pointerdown', (e) => {
      dragging = true;
      thumbEl.setPointerCapture(e.pointerId);
      e.stopPropagation();
    });
    thumbEl.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const r = track.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      entry[which] = valueFromNorm(frac, meta);
      onChange();
      syncThumbs();
    });
    const end = () => { dragging = false; };
    thumbEl.addEventListener('pointerup', end);
    thumbEl.addEventListener('pointercancel', end);
  }
  makeThumbDraggable(fromThumb, 'from');
  makeThumbDraggable(toThumb, 'to');
}

/* ---------- Jam-Wiedergabezustand (pro Maschine, nicht persistiert) ---------- */
const jamState = new WeakMap();
function stateFor(machine) {
  let st = jamState.get(machine);
  if (!st) { st = { activeClipId: null, queuedClipId: null, stopped: false, queuedStopped: null }; jamState.set(machine, st); }
  return st;
}

/** Der Stumm-Zustand, der als NÄCHSTES gilt -- ein bereits gequeuter
 *  Wechsel (s. queueStopChange() unten) zählt VOR dem aktuellen `stopped`,
 *  sonst würde ein zweiter Tap VOR dem nächsten Taktanfang sich fälschlich
 *  gegen den noch gar nicht angewendeten alten Zustand richten, statt die
 *  Warteschlange einfach umzudrehen. */
function pendingStopped(st) {
  return st.queuedStopped ?? st.stopped;
}

/** DOM-Referenzen der aktuell gerenderten Spalten — nur gültig, während
 *  das Jam-Sheet offen ist (renderJamView() baut sie neu). */
const columnEls = new WeakMap();

let boundRack = null;

/** Einmal beim App-Start aufrufen — merkt sich das Rack und registriert
 *  den EINEN globalen Takt-Listener, der Clips UND STOP/Resume quantisiert
 *  umschaltet (s. queueStopChange()). Läuft unabhängig davon, ob das
 *  Jam-Sheet gerade sichtbar ist (wie ein echter Clip-Launcher: einmal
 *  angetippt, wird er auch dann noch am nächsten Taktanfang scharf, wenn
 *  man zwischendurch wegnavigiert). */
export function initJamView(rack) {
  boundRack = rack;
  transport.addListener({
    onStep(step) {
      if (step % STEPS_PER_BAR !== 0) return;
      for (const machine of boundRack?.machines ?? []) {
        const st = stateFor(machine);
        if (st.queuedClipId != null) promoteQueuedClip(machine, st, step);
        if (st.queuedStopped != null) applyStopChange(machine, st, st.queuedStopped, step);
      }
    },
  });
}

/** Bindet den gequeuten Clip UND setzt machine.stepOffset auf genau diesen
 *  (immer taktanfangs-genauen) Schritt -- macht daraus den eigenen Takt-1
 *  des Clips (s. machine.js#stepOffset), egal wie lang er ist, statt
 *  irgendwo mitten im globalen Takt einzusteigen. */
function promoteQueuedClip(machine, st, step) {
  const clip = machine.clips.find((c) => c.id === st.queuedClipId);
  st.activeClipId = st.queuedClipId;
  st.queuedClipId = null;
  if (clip) machine.bindClipData(clip.data);
  machine.stepOffset = step;
  refreshClipStates(machine);
}

/** Wendet einen STOP/Resume-Wechsel tatsächlich an -- von queueStopChange()
 *  sofort (Transport steht) oder vom Takt-Listener oben (nächster
 *  Taktanfang) aufgerufen. Ein Resume setzt zusätzlich stepOffset (s.
 *  promoteQueuedClip()) auf denselben Schritt: die Spur steigt dadurch
 *  IMMER beim eigenen Takt-1 ihres gerade gebundenen Patterns/Clips wieder
 *  ein, nie mitten drin. */
function applyStopChange(machine, st, stopped, step) {
  st.stopped = stopped;
  st.queuedStopped = null;
  if (!stopped) machine.stepOffset = step;
  refreshClipStates(machine);
  refreshJamGate(machine);
}

/** Spiegelt `stopped` dieser EINEN Maschine aufs Jam-Gate — komplett
 *  unabhängig von allen anderen Spuren (s. Dateikopf-Kommentar). */
function refreshJamGate(machine) {
  machine.setJamGate(!stateFor(machine).stopped);
}

/** Beim (Wieder-)Öffnen des Sheets für ALLE Maschinen aufgerufen — fängt
 *  z. B. eine Maschine ab, die neu ins Rack kam, während das Sheet zu war
 *  (setJamGate() lief für sie noch nie). */
function refreshJamGates() {
  for (const m of boundRack?.machines ?? []) refreshJamGate(m);
}

/** STOP/Resume queuen (Transport läuft) oder sofort anwenden (Transport
 *  steht -- kein Taktanfang, auf den sich warten liesse, s. playClip() für
 *  dieselbe Ausnahme bei Clips). Quantisiert genau wie ein Clip-Antippen,
 *  damit nichts mehr mitten im Takt ein-/ausblendet (Nutzer-Bugreport). */
function queueStopChange(machine, stopped) {
  const st = stateFor(machine);
  if (!transport.isPlaying) {
    applyStopChange(machine, st, stopped, transport.currentStep);
    return;
  }
  st.queuedStopped = stopped;
  refreshClipStates(machine);
}

/** Diese EINE Spur stumm (quantisiert, s. queueStopChange) — unabhängig
 *  von allen anderen (s. Dateikopf-Kommentar). activeClipId/queuedClipId
 *  bleiben dabei bewusst UNVERÄNDERT (kein Rücksprung aufs normale
 *  Pattern): ein erneuter Tap auf denselben Clip, der Stop-Button selbst
 *  (Toggle, s. buildColumn), oder ein Scene-Recall macht exakt da weiter,
 *  wo die Spur stand, statt den gewählten Clip zu vergessen. */
function haltMachine(machine) {
  const st = stateFor(machine);
  if (pendingStopped(st)) return;
  queueStopChange(machine, true);
}

/** Gegenstück zu haltMachine() — macht die Spur wieder hörbar (quantisiert),
 *  ohne irgendetwas an der Clip-Auswahl zu ändern. */
function resumeMachine(machine) {
  const st = stateFor(machine);
  if (!pendingStopped(st)) return;
  queueStopChange(machine, false);
}

/** Globaler "Stop All Clips" (Button im Sheet-Kopf) — schaltet JEDE Spur
 *  unabhängig stumm, wie Ableton Live's "Stop Clips": der Transport/Takt
 *  läuft dabei einfach weiter, es wird nur still. */
export function stopAllClips() {
  for (const m of boundRack?.machines ?? []) haltMachine(m);
}

/** Einen Clip tatsächlich starten (Tap auf einen noch nicht aktiven Clip,
 *  Scene-Launch) — hebt `stopped` für diese Spur auf (ein Clip-Tap soll
 *  immer hörbar werden) und reiht den Clip quantisiert ein, oder bindet
 *  ihn sofort, wenn der Transport gerade steht. */
function playClip(machine, clipId) {
  resumeMachine(machine);
  const st = stateFor(machine);
  if (!transport.isPlaying) {
    st.queuedClipId = clipId;
    promoteQueuedClip(machine, st, transport.currentStep);
    return;
  }
  st.queuedClipId = clipId;
  refreshClipStates(machine);
}

/** Clip antippen: läuft er bereits UND ist die Spur (auch nach einem
 *  eventuell schon gequeuten Wechsel) hörbar, sofortiger Stop (kein Warten
 *  auf einen zweiten Taktanfang nötig, symmetrisch zum STOP-Button). Ist
 *  die Spur gerade gestoppt (auch wenn's derselbe Clip ist), macht ein Tap
 *  sie stattdessen wieder hörbar -- sonst liesse sich eine gestoppte Spur
 *  über ihren eigenen (weiterhin "aktiven") Clip gar nicht reaktivieren. */
function toggleClip(machine, clipId) {
  const st = stateFor(machine);
  if (st.activeClipId === clipId && !pendingStopped(st)) {
    haltMachine(machine);
    return;
  }
  playClip(machine, clipId);
}

/** Spiegelt den aktuellen Zustand (Clip-Farben, Stop-Button, Spalten-
 *  Dimmung) einer Maschine in ihre schon gerenderte Spalte -- läuft nach
 *  JEDER Zustandsänderung (Clip getippt, gestoppt, Scene gelauncht, …). */
function refreshClipStates(machine) {
  const cols = columnEls.get(machine);
  if (!cols) return; // Sheet gerade nicht offen -- nichts zu tun
  const st = stateFor(machine);
  // Zeigt den EFFEKTIVEN (ggf. schon gequeuten) Zustand -- derselbe Gedanke
  // wie ein frisch angetippter Clip, der auch sofort als "queued" pulsiert,
  // statt erst nach dem nächsten Taktanfang sichtbar zu reagieren.
  const effectiveStopped = pendingStopped(st);
  for (const el of cols.clipsEl.querySelectorAll('.clip')) {
    const id = Number(el.dataset.clipId);
    el.dataset.state = id !== st.activeClipId ? (id === st.queuedClipId ? 'queued' : 'filled')
      : effectiveStopped ? 'stopped' : 'playing';
  }
  cols.stopBtn.classList.toggle('is-active', st.stopped);
  cols.stopBtn.classList.toggle('is-pending', st.queuedStopped != null);
  cols.col.classList.toggle('is-stopped', st.stopped);
}

/** Zurück zum normalen A/B/C/D-Pattern der Maschine (der gelöschte Clip
 *  darf nicht weiter im Hintergrund gebunden bleiben) -- der Clip lief
 *  NEBEN patternIndex, ein erneutes setPatternIndex(patternIndex) bindet
 *  also einfach wieder das reguläre Pattern. Anders als haltMachine()
 *  bleibt die Spur dabei HÖRBAR (kein Grund, sie zusätzlich stumm zu
 *  schalten, nur ein Rücksprung auf den sicheren Default). */
function revertToPattern(machine) {
  const st = stateFor(machine);
  st.activeClipId = null;
  st.queuedClipId = null;
  machine.setPatternIndex(machine.patternIndex);
  machine.stepOffset = transport.currentStep;
  refreshClipStates(machine);
}

/** Entfernt einen Clip endgültig (mit Undo-Angebot, wie Pattern-Clear in
 *  step-seq.js). Läuft/wartet der gelöschte Clip gerade, springt die
 *  Maschine zuerst auf ihr normales Pattern zurück (revertToPattern --
 *  kein Sonderfall nötig). Undo fügt denselben Clip (gleiche id) an
 *  seiner ursprünglichen Position wieder ein, startet ihn aber nicht neu. */
function deleteClip(machine, clipId) {
  const idx = machine.clips.findIndex((c) => c.id === clipId);
  if (idx === -1) return;
  const clip = machine.clips[idx];

  const st = stateFor(machine);
  if (st.activeClipId === clipId || st.queuedClipId === clipId) revertToPattern(machine);

  machine.removeClip(clipId);
  const cols = columnEls.get(machine);
  if (cols) renderClips(machine, cols.clipsEl);

  undo.offer(`Clip "${clip.name}" deleted`, () => {
    machine.clips.splice(idx, 0, clip);
    const cols2 = columnEls.get(machine);
    if (cols2) renderClips(machine, cols2.clipsEl);
  });
}

/** Halten-Chip zum Löschen eines Clips -- ein einzelnes, modulweites
 *  Popup (wie pattern-bank.js' Kontext-Chip), da hier mehrere Spalten
 *  gleichzeitig Clips zeigen können: es soll trotzdem immer nur EIN Chip
 *  offen sein. */
let clipMenu = null;
const dismissClipMenu = () => {
  clipMenu?.remove();
  clipMenu = null;
  document.removeEventListener('pointerdown', onOutsideClipMenu, true);
};
const onOutsideClipMenu = (e) => { if (clipMenu && !clipMenu.contains(e.target)) dismissClipMenu(); };

function openClipDeleteMenu(machine, clipId, anchorEl) {
  dismissClipMenu();
  clipMenu = document.createElement('div');
  clipMenu.className = 'pat-chip';
  const delBtn = document.createElement('button');
  delBtn.className = 'pat-chip__btn pat-chip__btn--danger';
  delBtn.textContent = '🗑 Delete Clip';
  delBtn.addEventListener('click', () => {
    deleteClip(machine, clipId);
    dismissClipMenu();
  });
  clipMenu.appendChild(delBtn);
  document.body.appendChild(clipMenu);
  // über dem Clip platzieren, am Bildschirmrand einklemmen (wie pattern-bank.js)
  const r = anchorEl.getBoundingClientRect();
  const left = Math.max(8, Math.min(
    window.innerWidth - clipMenu.offsetWidth - 8,
    r.left + r.width / 2 - clipMenu.offsetWidth / 2,
  ));
  clipMenu.style.left = `${left}px`;
  clipMenu.style.top = `${Math.max(8, r.top - clipMenu.offsetHeight - 8)}px`;
  setTimeout(() => document.addEventListener('pointerdown', onOutsideClipMenu, true), 0);
  clearTimeout(clipMenu.dismissTimer);
  clipMenu.dismissTimer = setTimeout(dismissClipMenu, 4000);
}

/* ---------- Rendering ---------- */

/** Die A/B/C/D-Pattern-Slots, die noch KEINEN Clip haben, direkt als
 *  antippbare "Proto-Clips" zeigen, statt nur auf den Halten-Chip im Rack
 *  zu verweisen -- der schnellste Weg vom "ich habe ein Pattern" zum "es
 *  läuft als Clip im Jam", ganz ohne Rack-Umweg. Ein Tap legt den Clip an
 *  (addClipFromPattern, dieselbe Kopie wie "+ Add Clip" im Rack) UND
 *  startet/reiht ihn direkt ein, wie ein echter Clip-Launcher-Slot. Leere
 *  Pattern-Slots bleiben antippbar, wirken aber blass (kein Grund, sie zu
 *  sperren -- vielleicht will man bewusst einen stillen Clip).
 *  Bleibt (anders als früher) auch NACH dem ersten hinzugefügten Clip
 *  sichtbar -- verkürzt sich aber um jeden bereits belegten Buchstaben
 *  (`usedSlots`, aus den `sourceSlot`-Feldern der echten Clips, s.
 *  machine.js#addClip), damit man mehrere Pattern-Slots nacheinander mit
 *  je einem weiteren Tap in den Jam holen kann, ohne zwischendurch woanders
 *  hinzutippen. Sind alle vier Slots schon Clips, gibt es nichts mehr
 *  anzubieten -- liefert dann `''` (kein leerer Rest-Rahmen). */
function renderProtoClipsHtml(machine, usedSlots) {
  const remaining = [0, 1, 2, 3].filter((i) => !usedSlots.has(i));
  if (!remaining.length) return '';
  const hint = usedSlots.size ? 'Add another:' : 'Tap a pattern to launch it as a clip:';
  return `
    <p class="proto-clips__hint">${hint}</p>
    <div class="proto-clips">
      ${remaining.map((i) => `
        <button type="button" class="proto-clip${machine.hasPatternContent(i) ? '' : ' is-empty'}" data-slot="${i}">${'ABCD'[i]}</button>
      `).join('')}
    </div>
  `;
}

function renderClips(machine, clipsEl) {
  const st = stateFor(machine);
  const usedSlots = new Set(machine.clips.map((c) => c.sourceSlot).filter((s) => s != null));
  const clipsHtml = machine.clips.map((clip) => {
    const state = clip.id !== st.activeClipId ? (clip.id === st.queuedClipId ? 'queued' : 'filled')
      : pendingStopped(st) ? 'stopped' : 'playing';
    return `
      <div class="clip" data-clip-id="${clip.id}" data-state="${state}">
        <span class="clip__progress"></span>
        <span class="clip__label">${clip.name}</span>
      </div>
    `;
  }).join('');
  clipsEl.innerHTML = clipsHtml + renderProtoClipsHtml(machine, usedSlots);

  clipsEl.querySelectorAll('.clip').forEach((el) => {
    el.addEventListener('click', () => {
      if (el.dataset.suppressClick) return;
      toggleClip(machine, Number(el.dataset.clipId));
    });
  });
  if (machine.clips.length) makeReorderable(clipsEl, machine);

  clipsEl.querySelectorAll('.proto-clip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const clip = machine.addClipFromPattern(Number(btn.dataset.slot));
      renderClips(machine, clipsEl);
      toggleClip(machine, clip.id);
    });
  });
}

/** Clips innerhalb ihrer Spalte per Ziehen umsortieren (Pointer-Events,
 *  kein HTML5-Drag&Drop -- das funktioniert auf iPhone/Touch nicht
 *  zuverlässig). Tauscht bei Überschreiten der halben Nachbarhöhe mit
 *  dem direkten Nachbarn, reicht für die kurzen Listen hier völlig. */
function makeReorderable(clipsEl, machine) {
  let dragEl = null, pointerId = null, startY = 0;
  let holdTimer = null;
  // Bleibt über die ganze Geste bestehen (nicht per Timeout selbst wieder
  // gelöscht!) -- der Löschen-Chip kann beliebig lange offen stehen, bevor
  // der Finger tatsächlich losgelassen wird; suppressClick muss erst in
  // release() gesetzt werden, genau dann, wenn der Click-Handler ihn auch
  // wirklich prüft (sonst wäre ein zu früh selbst-löschendes Flag längst
  // wieder weg und der Loslasser würde den Clip zusätzlich starten/stoppen).
  let heldForDelete = false;

  const cancelHold = () => { clearTimeout(holdTimer); holdTimer = null; };

  clipsEl.addEventListener('pointerdown', (e) => {
    const clip = e.target.closest('.clip');
    if (!clip) return;
    dragEl = clip;
    pointerId = e.pointerId;
    startY = e.clientY;
    heldForDelete = false;
    // Halten (wie A/B/C/D-Slots, s. pattern-bank.js) öffnet den Löschen-
    // Chip -- bricht ab, sobald daraus ein echtes Ziehen wird (s. pointer-
    // move) oder der Finger vorher losgelassen wird.
    holdTimer = setTimeout(() => {
      holdTimer = null;
      heldForDelete = true;
      openClipDeleteMenu(machine, Number(clip.dataset.clipId), clip);
    }, CLIP_HOLD_MS);
  });

  clipsEl.addEventListener('pointermove', (e) => {
    if (!dragEl || e.pointerId !== pointerId) return;
    const dy = e.clientY - startY;
    if (!dragEl.classList.contains('is-dragging')) {
      if (Math.abs(dy) < TAP_THRESHOLD) return;
      cancelHold();
      dragEl.classList.add('is-dragging');
      dragEl.setPointerCapture(pointerId);
    }
    dragEl.style.transform = `translateY(${dy}px)`;

    // Nachbarn NUR unter echten .clip-Geschwistern suchen -- .clips kann
    // seit den immer sichtbaren Proto-Clip-Buttons (s. renderProtoClipsHtml)
    // zusätzlich eine .proto-clips__hint/.proto-clips-Sektion als weiteres
    // Geschwister enthalten. Ohne diese Einschränkung tauschte ein nach
    // unten gezogener letzter Clip fälschlich mit dieser Sektion statt mit
    // einem anderen Clip (oder gar nicht erst zu erkennen: reines Text-/
    // Grid-Element ohne data-clip-id).
    const h = dragEl.offsetHeight + 5; // Höhe + Lückenabstand (s. .clips gap)
    if (dy > h / 2) {
      const next = dragEl.nextElementSibling;
      if (next?.classList.contains('clip')) {
        clipsEl.insertBefore(next, dragEl);
        startY += h;
        dragEl.style.transform = `translateY(${dy - h}px)`;
      }
    } else if (dy < -h / 2) {
      const prev = dragEl.previousElementSibling;
      if (prev?.classList.contains('clip')) {
        clipsEl.insertBefore(dragEl, prev);
        startY -= h;
        dragEl.style.transform = `translateY(${dy + h}px)`;
      }
    }
  });

  const release = (e) => {
    if (!dragEl || e.pointerId !== pointerId) return;
    cancelHold();
    const wasDragging = dragEl.classList.contains('is-dragging');
    dragEl.classList.remove('is-dragging');
    dragEl.style.transform = '';
    if (wasDragging) {
      // NUR echte .clip-Kinder zählen (s. Kommentar oben) -- clipsEl.children
      // kann jetzt auch die Proto-Clip-Sektion enthalten, deren Elemente
      // kein data-clip-id tragen (Number(undefined) = NaN, .find() liefert
      // dafür undefined zurück -- machine.clips bekäme dadurch ungültige
      // undefined-Einträge, die jeden späteren .find()/.map() auf den Clips
      // zum Absturz bringen, s. Nutzer-Bugreport "Clip startet nicht mehr").
      const order = [...clipsEl.querySelectorAll(':scope > .clip')].map((el) => Number(el.dataset.clipId));
      machine.clips = order.map((id) => machine.clips.find((c) => c.id === id));
    }
    if (wasDragging || heldForDelete) {
      // Eigene lokale Referenz auf DIESES Element -- `dragEl` selbst wird
      // gleich unten auf null gesetzt (Ende jeder Geste), und zum Zeitpunkt,
      // an dem dieser Timeout 80ms später feuert, ist diese Zuweisung
      // (synchron, noch in diesem Aufruf) immer schon passiert. Der Check
      // `if (dragEl)` im Callback prüfte bisher fälschlich die ÄUSSERE,
      // längst genullte Variable statt des konkreten Chips -- das Flag
      // wurde dadurch NIE wieder entfernt, und der betroffene Clip blieb
      // dauerhaft unklickbar (bis die Liste neu gerendert wird), obwohl
      // gar nicht mehr gezogen/gehalten wurde. Reales Symptom (Nutzer-
      // Bugreport): "ich tippe auf einen Clip und nichts passiert" --
      // reproduzierbar mit jedem Clip, der auch nur kurz gehalten (Löschen-
      // Menü geöffnet, aber NICHT gelöscht) oder gezogen wurde.
      const el = dragEl;
      el.dataset.suppressClick = '1';
      setTimeout(() => { delete el.dataset.suppressClick; }, 80);
    }
    dragEl = null; pointerId = null;
  };
  clipsEl.addEventListener('pointerup', release);
  clipsEl.addEventListener('pointercancel', release);
}

/** Frei belegbares X/Y-Pad: jede Achse trägt eine LISTE gestackter data-p-
 *  Knobs, jeweils mit einer eigenen [from,to]-Einschränkung UND einem
 *  Anker (Tippen auf das Achsen-Label öffnet die Verwaltung, s.
 *  openXYPicker). Die Pad-Mitte entspricht dem ERSTEN gestackten Eintrags
 *  eigenem Anker -- dem Wert, der beim Zuordnen gerade eingestellt war
 *  (normFromValue/valueFromNorm, dieselbe Kurven-Mathematik wie <x-knob>,
 *  s. axisNorm/applyAxis) -- NICHT der Bereichsmitte: das im Rack bereits
 *  erarbeitete Sound-Design darf durchs Zuordnen aufs Pad nicht verändert
 *  werden, und Zurückziehen in die Mitte kehrt IMMER exakt dorthin zurück
 *  (Nutzer-Anfrage). Default bleibt je 1 Eintrag Delay/Reverb, verankert
 *  am jeweils aktuellen Send-Wert. */
function buildXYPad(machine) {
  const wrap = document.createElement('div');
  wrap.className = 'xy-wrap';
  wrap.innerHTML = `
    <div class="xy-axes">
      <button type="button" class="xy-axis-btn xy-axis-btn--x">
        <span class="xy-axis-btn__tag">X</span><span class="xy-axis-btn__label"></span>
      </button>
      <button type="button" class="xy-axis-btn xy-axis-btn--y">
        <span class="xy-axis-btn__tag">Y</span><span class="xy-axis-btn__label"></span>
      </button>
      <button type="button" class="xy-spring-btn" title="Auto-return to center" aria-label="Auto-return to center">⟲</button>
    </div>
    <div class="xypad">
      <div class="xypad__grid"></div>
      <div class="xypad__dot"></div>
    </div>
  `;
  const pad = wrap.querySelector('.xypad');
  const dot = pad.querySelector('.xypad__dot');
  const xBtn = wrap.querySelector('.xy-axis-btn--x');
  const yBtn = wrap.querySelector('.xy-axis-btn--y');
  const springBtn = wrap.querySelector('.xy-spring-btn');
  const st = xyStateFor(machine);
  springBtn.classList.toggle('is-active', machine.xySpring);
  springBtn.addEventListener('click', () => {
    machine.xySpring = !machine.xySpring;
    springBtn.classList.toggle('is-active', machine.xySpring);
  });

  const axisLabel = (axis) => {
    const entries = st[axis];
    if (!entries.length) return '—';
    const first = (readKnobMeta(machine, entries[0].key)?.label ?? entries[0].key).toUpperCase();
    const suffix = entries.length > 1 ? ` +${entries.length - 1}` : '';
    return `${first}${suffix}`;
  };
  const syncLabels = () => {
    xBtn.querySelector('.xy-axis-btn__label').textContent = axisLabel('x');
    yBtn.querySelector('.xy-axis-btn__label').textContent = axisLabel('y');
  };
  // Normalisierte Pad-Position einer Achse: der ERSTE gestackte Eintrag ist
  // der visuelle "Anker" -- bei mehreren gestackten Parametern mit ggf.
  // unterschiedlichem aktuellem Stand liesse sich sonst kein einzelner
  // sinnvoller Punkt mehr zeigen. Zwei-Segment-Rückrechnung (s. applyAxis
  // für die Hinrichtung): liegt der aktuelle Wert auf der from-Seite des
  // Ankers (Segment 1 ergibt einen Fortschritt <= 1), zeigt die untere
  // Pad-Hälfte, sonst die obere -- funktioniert unabhängig davon, ob
  // from < anchor < to oder umgekehrt (from>to ist erlaubt, s. Kommentar
  // bei xyStateFor).
  const axisNorm = (axis) => {
    const entry = st[axis][0];
    if (!entry) return 0.5;
    const meta = readKnobMeta(machine, entry.key);
    if (!meta) return 0.5;
    const anchor = anchorFor(entry, meta);
    const value = parseFloat(meta.value);
    const tLower = normFromValue(value, { ...meta, min: String(entry.from), max: String(anchor) });
    if (tLower <= 1) return Math.min(1, Math.max(0, tLower)) * 0.5;
    const tUpper = normFromValue(value, { ...meta, min: String(anchor), max: String(entry.to) });
    return 0.5 + Math.min(1, Math.max(0, tUpper)) * 0.5;
  };
  const syncDot = () => {
    const x = Math.min(1, Math.max(0, axisNorm('x')));
    const y = Math.min(1, Math.max(0, axisNorm('y')));
    dot.style.left = `${x * 100}%`;
    dot.style.top = `${(1 - y) * 100}%`;
  };
  syncLabels();
  syncDot();

  // Wendet die normalisierte Pad-Position auf ALLE gestackten Einträge
  // einer Achse an -- jeder auf sein eigenes [from,to] bezogen, nicht auf
  // sein volles [min,max] (genau das ist die Bereichs-Einschränkung). Pad-
  // Mitte (norm=0.5) liefert IMMER exakt den Anker zurück (Nutzer-Anfrage:
  // das im Rack erarbeitete Sound-Design darf durchs Zuordnen aufs Pad
  // nicht kaputtgehen) -- untere Pad-Hälfte interpoliert von `from` zum
  // Anker, obere vom Anker zu `to`, beide mit derselben Kurven-Mathematik
  // wie <x-knob> (log/linear, s. valueFromNorm). */
  const applyAxis = (axis, norm) => {
    for (const entry of st[axis]) {
      const meta = readKnobMeta(machine, entry.key);
      if (!meta) continue;
      const anchor = anchorFor(entry, meta);
      const value = norm <= 0.5
        ? valueFromNorm(norm / 0.5, { ...meta, min: String(entry.from), max: String(anchor) })
        : valueFromNorm((norm - 0.5) / 0.5, { ...meta, min: String(anchor), max: String(entry.to) });
      nudgeParam(meta.knob, value);
    }
  };

  // Die Achsen-Buttons sitzen jetzt in einer eigenen Reihe ÜBER dem Pad
  // (nicht mehr als überlappende Ecken-Labels IM Pad), daher kann jeder
  // Pointerdown aufs Pad sofort und uneingeschränkt zum Drag werden -- kein
  // Tap-vs-Drag-Schwellwert und keine target-Prüfung mehr nötig.
  const setFromEvent = (e) => {
    const r = pad.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    dot.style.left = `${x * 100}%`;
    dot.style.top = `${y * 100}%`;
    applyAxis('x', x);
    applyAxis('y', 1 - y);
  };
  let dragging = false;
  pad.addEventListener('pointerdown', (e) => {
    dragging = true;
    pad.setPointerCapture(e.pointerId);
    setFromEvent(e);
  });
  pad.addEventListener('pointermove', (e) => {
    if (dragging) setFromEvent(e);
  });
  // Auto-Return (.xy-spring-btn, s. oben): springt der Punkt beim Loslassen
  // sofort zurück auf die Pad-Mitte -- direkt auf 50%/50% gesetzt statt über
  // syncDot()/axisNorm() zurückgerechnet, damit es exakt die Mitte trifft
  // (keine Rundungs-Abweichung durch die Norm<->Wert-Rückrechnung). Jeder
  // Eintrag landet dabei exakt bei seinem Anker (s. anchorFor()) -- kurz
  // antippen/ziehen = Ausflug vom Sound-Design, loslassen = zurück dorthin.
  const releasePad = () => {
    dragging = false;
    if (machine.xySpring) {
      applyAxis('x', 0.5);
      applyAxis('y', 0.5);
      dot.style.left = '50%';
      dot.style.top = '50%';
    }
  };
  pad.addEventListener('pointerup', releasePad);
  pad.addEventListener('pointercancel', releasePad);

  const onAxisChange = () => { syncLabels(); syncDot(); };
  xBtn.addEventListener('click', () => openXYPicker(machine, 'x', xBtn, onAxisChange));
  yBtn.addEventListener('click', () => openXYPicker(machine, 'y', yBtn, onAxisChange));

  return wrap;
}

function buildMacros(machine) {
  const type = machine.constructor.meta.type;
  const params = MACRO_PARAMS[type] ?? [];
  const wrap = document.createElement('div');
  wrap.className = 'macros';
  for (const key of params) {
    const meta = readKnobMeta(machine, key);
    if (!meta) continue;
    const knob = document.createElement('x-knob');
    knob.setAttribute('label', meta.label);
    knob.setAttribute('min', meta.min);
    knob.setAttribute('max', meta.max);
    if (meta.curve) knob.setAttribute('curve', meta.curve);
    if (meta.unit) knob.setAttribute('unit', meta.unit);
    knob.setAttribute('value', meta.value);
    knob.addEventListener('input', (e) => nudgeParam(meta.knob, e.detail.value));
    wrap.appendChild(knob);
  }
  return wrap;
}

function buildColumn(machine) {
  const { color } = machine.constructor.meta;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  const col = document.createElement('div');
  col.className = 'channel';
  col.style.setProperty('--ch-color', color);
  col.style.setProperty('--ch-glow', `rgba(${r},${g},${b},.5)`);

  col.innerHTML = `
    <div class="channel__head">
      <span class="channel__stripe"></span>
      <div class="channel__name">${machine.displayName}<small>#${machine.id}</small></div>
    </div>
    <div class="clips"></div>
    <button type="button" class="clip-stop">STOP</button>
  `;
  col.classList.toggle('is-stopped', stateFor(machine).stopped);
  const stopBtn = col.querySelector('.clip-stop');
  stopBtn.classList.toggle('is-active', stateFor(machine).stopped);
  stopBtn.classList.toggle('is-pending', stateFor(machine).queuedStopped != null);
  // Toggle statt reinem Stop -- ein zweiter Tap auf den Button macht die
  // Spur wieder hörbar (Gegenstück zu haltMachine(), s. dort), genau wie
  // ein erneuter Tap auf ihren eigenen aktiven Clip (s. toggleClip()).
  // Richtet sich nach dem EFFEKTIVEN (ggf. schon gequeuten) Zustand, sonst
  // würde ein zweiter Tap vor dem nächsten Taktanfang den alten statt den
  // gerade erst gequeuten Wechsel umkehren.
  stopBtn.addEventListener('click', () => {
    if (pendingStopped(stateFor(machine))) resumeMachine(machine); else haltMachine(machine);
  });

  const clipsEl = col.querySelector('.clips');
  renderClips(machine, clipsEl);

  col.appendChild(buildXYPad(machine));

  // Makro-Knobs sitzen hinter einem Tap-Button statt dauerhaft sichtbar
  // neben dem Fader -- bei der jetzt responsiven, schmaleren Spaltenbreite
  // (3 statt 2 Spuren gleichzeitig sichtbar, s. .channel in app.css) ist
  // kein Platz mehr für 4 Knobs nebeneinander UND ein ordentlich grosses
  // X/Y-Pad. buildMacros() bleibt unverändert (dieselben ans echte Ziel
  // weitergereichten Proxy-Regler) -- openMacroPopup() ruft sie bei JEDEM
  // Öffnen frisch auf, zeigt bei Drum-Maschinen also immer die gerade
  // gewählte Spur, nicht einen veralteten Stand vom Sheet-Öffnen. Der
  // Button-Text zeigt dieselbe Spur schon vorab an (z. B. "••• Kick"),
  // damit vor dem Antippen klar ist, wessen Regler sich dahinter verbergen.
  const trackLabel = TRACK_SCOPED_TYPES.has(machine.constructor.meta.type)
    ? (machine.tracks[machine.selected]?.name ?? '')
    : '';
  const macroBtn = document.createElement('button');
  macroBtn.type = 'button';
  macroBtn.className = 'macro-toggle';
  macroBtn.textContent = trackLabel ? `••• ${trackLabel}` : '•••';
  macroBtn.setAttribute('aria-label', 'Macro knobs');
  macroBtn.addEventListener('click', () => openMacroPopup(machine, macroBtn));
  col.appendChild(macroBtn);

  // Fader wächst in den restlichen Platz der Spalte (vorher: feste 142px
  // neben den Makro-Knobs). Reihenfolge von oben nach unten jetzt: Clips,
  // Stop, X/Y-Pad, Makro-Button, Fader, Solo/Mute GANZ UNTEN -- vorher
  // blieb unter dem Pad ungenutzter Leerraum stehen, weil der Fader nur
  // eine feste Höhe hatte.
  const faderRow = document.createElement('div');
  faderRow.className = 'fader-row';
  const fader = document.createElement('x-fader');
  fader.setAttribute('default', '1');
  fader.setAttribute('value', String(machine.level));
  fader.addEventListener('input', (e) => machine.setLevel(e.detail.value));
  faderRow.appendChild(fader);
  col.appendChild(faderRow);

  const stripRow = document.createElement('div');
  stripRow.className = 'strip__row';
  stripRow.innerHTML = `
    <button type="button" class="msbtn is-solo${machine.soloed ? ' is-active' : ''}">SOLO</button>
    <button type="button" class="msbtn is-mute${machine.muted ? ' is-active' : ''}">MUTE</button>
  `;
  const soloBtn = stripRow.querySelector('.is-solo');
  const muteBtn = stripRow.querySelector('.is-mute');
  soloBtn.addEventListener('click', () => { machine.setSoloed(!machine.soloed); soloBtn.classList.toggle('is-active', machine.soloed); });
  muteBtn.addEventListener('click', () => { machine.setMuted(!machine.muted); muteBtn.classList.toggle('is-active', machine.muted); });
  col.appendChild(stripRow);

  columnEls.set(machine, { col, clipsEl, stopBtn });
  return col;
}

/** Makro-Knobs-Popup (Tap auf ".macro-toggle") -- ein einzelnes, modul-
 *  weites Popup wie clipMenu/xyMenu (nie mehr als eines gleichzeitig
 *  offen), gleiche Positionierungs-/Einklemm-Logik wie openXYPicker.
 *  Kein Auto-Dismiss-Timer (anders als openClipDeleteMenu): die Knobs
 *  darin sollen tatsächlich bedient werden, nicht nur kurz angetippt. */
let macroPop = null;
const dismissMacroPop = () => {
  macroPop?.remove();
  macroPop = null;
  document.removeEventListener('pointerdown', onOutsideMacroPop, true);
};
const onOutsideMacroPop = (e) => { if (macroPop && !macroPop.contains(e.target)) dismissMacroPop(); };

function openMacroPopup(machine, anchorEl) {
  dismissMacroPop();
  macroPop = document.createElement('div');
  macroPop.className = 'macro-pop';

  const head = document.createElement('div');
  head.className = 'macro-pop__head';
  const title = document.createElement('span');
  title.className = 'macro-pop__title';
  title.textContent = machine.displayName;
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'macro-pop__close';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', dismissMacroPop);
  head.append(title, closeBtn);
  macroPop.appendChild(head);
  macroPop.appendChild(buildMacros(machine));

  document.body.appendChild(macroPop);
  const r = anchorEl.getBoundingClientRect();
  const left = Math.max(8, Math.min(
    window.innerWidth - macroPop.offsetWidth - 8,
    r.left + r.width / 2 - macroPop.offsetWidth / 2,
  ));
  const top = Math.max(8, Math.min(window.innerHeight - macroPop.offsetHeight - 8, r.top - macroPop.offsetHeight - 8));
  macroPop.style.left = `${left}px`;
  macroPop.style.top = `${top}px`;
  setTimeout(() => document.addEventListener('pointerdown', onOutsideMacroPop, true), 0);
}

/* ---------- Scenes (Ableton-Style Song-Abschnitt launchen) ----------
 * Rein Jam-Performance-Zustand wie activeClipId/stopped oben -- lebt nur
 * für die Dauer der Session (nicht im Projekt gespeichert), ein Neuladen
 * setzt die Liste zurück wie jeden anderen Jam-Zustand auch. `entries`
 * merkt sich pro Maschinen-ID (nicht Objekt-Referenz -- Scenes müssen
 * einfache, GC-unabhängige Daten bleiben) den Clip, der beim Speichern
 * aktiv war. Verweist eine Scene auf eine inzwischen entfernte Maschine
 * oder einen gelöschten Clip, läuft launchScene() einfach am betroffenen
 * Eintrag vorbei (dieselbe "stale Referenz = No-Op"-Toleranz wie beim
 * X/Y-Pad-Mapping, s. dort) -- kein Aufräumen nötig. */
let scenes = [];
let nextSceneId = 1;
let scenesEl = null;

/** Schnappschuss: für jede Maschine mit einem gerade HÖRBAREN aktiven Clip
 *  (nicht gestoppt) wird dessen Clip-ID gemerkt. Maschinen ohne aktiven
 *  Clip (oder gerade gestoppt) bekommen bewusst KEINEN Eintrag -- beim
 *  späteren Launch werden sie darüber erkannt und mitgestoppt (s.
 *  launchScene()), damit ein Recall wirklich "genau dieser Song-Abschnitt"
 *  reproduziert, nicht nur eine Teilmenge davon nachspielt. */
function saveScene() {
  const entries = {};
  for (const m of boundRack?.machines ?? []) {
    const st = stateFor(m);
    if (st.activeClipId != null && !pendingStopped(st)) entries[m.id] = st.activeClipId;
  }
  scenes.push({ id: nextSceneId++, name: `Scene ${scenes.length + 1}`, entries });
  renderScenes();
}

/** Eine Scene launchen: jede Maschine MIT Eintrag bekommt ihren gemerkten
 *  Clip (neu) gestartet, jede Maschine OHNE Eintrag wird gestoppt -- exakt
 *  der Zustand, der beim Speichern galt, deterministisch reproduziert
 *  (s. Kommentar oben "genau dieser Song-Abschnitt", das eigentliche
 *  Ableton-Scene-Äquivalent). */
function launchScene(scene) {
  for (const m of boundRack?.machines ?? []) {
    const clipId = scene.entries[m.id];
    if (clipId != null && m.clips.some((c) => c.id === clipId)) playClip(m, clipId);
    else haltMachine(m);
  }
}

function deleteScene(id) {
  const idx = scenes.findIndex((s) => s.id === id);
  if (idx === -1) return;
  scenes.splice(idx, 1);
  renderScenes();
}

/** Halten-Chip zum Löschen einer Scene -- dasselbe modulweite Ein-Chip-
 *  Popup-Muster wie clipMenu/xyMenu oben (nie mehr als eines offen). */
let sceneMenu = null;
const dismissSceneMenu = () => {
  sceneMenu?.remove();
  sceneMenu = null;
  document.removeEventListener('pointerdown', onOutsideSceneMenu, true);
};
const onOutsideSceneMenu = (e) => { if (sceneMenu && !sceneMenu.contains(e.target)) dismissSceneMenu(); };

function openSceneDeleteMenu(scene, anchorEl) {
  dismissSceneMenu();
  sceneMenu = document.createElement('div');
  sceneMenu.className = 'pat-chip';
  const delBtn = document.createElement('button');
  delBtn.className = 'pat-chip__btn pat-chip__btn--danger';
  delBtn.textContent = '🗑 Delete Scene';
  delBtn.addEventListener('click', () => {
    deleteScene(scene.id);
    dismissSceneMenu();
  });
  sceneMenu.appendChild(delBtn);
  document.body.appendChild(sceneMenu);
  const r = anchorEl.getBoundingClientRect();
  const left = Math.max(8, Math.min(
    window.innerWidth - sceneMenu.offsetWidth - 8,
    r.left + r.width / 2 - sceneMenu.offsetWidth / 2,
  ));
  sceneMenu.style.left = `${left}px`;
  sceneMenu.style.top = `${Math.max(8, r.top - sceneMenu.offsetHeight - 8)}px`;
  setTimeout(() => document.addEventListener('pointerdown', onOutsideSceneMenu, true), 0);
  clearTimeout(sceneMenu.dismissTimer);
  sceneMenu.dismissTimer = setTimeout(dismissSceneMenu, 4000);
}

/** Tap launcht, Halten (wie Clips/A-B-C-D-Slots) öffnet den Löschen-Chip. */
function wireSceneChip(chip, scene) {
  let holdTimer = null;
  let held = false;
  chip.addEventListener('pointerdown', () => {
    held = false;
    holdTimer = setTimeout(() => {
      holdTimer = null;
      held = true;
      openSceneDeleteMenu(scene, chip);
    }, CLIP_HOLD_MS);
  });
  const cancelHold = () => { clearTimeout(holdTimer); holdTimer = null; };
  chip.addEventListener('pointerup', cancelHold);
  chip.addEventListener('pointercancel', cancelHold);
  chip.addEventListener('pointerleave', cancelHold);
  chip.addEventListener('click', () => {
    if (held) { held = false; return; }
    launchScene(scene);
  });
}

function renderScenes() {
  if (!scenesEl) return;
  scenesEl.innerHTML = '';
  for (const scene of scenes) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'jam-scene-chip';
    chip.textContent = scene.name;
    wireSceneChip(chip, scene);
    scenesEl.appendChild(chip);
  }
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'jam-scene-chip jam-scene-chip--add';
  addBtn.textContent = '+ Save Scene';
  addBtn.addEventListener('click', saveScene);
  scenesEl.appendChild(addBtn);
}

/** Baut die komplette Jam-Ansicht neu — beim Öffnen des Sheets aufgerufen
 *  (wie Mixer#render()), damit sie immer den aktuellen Rack-Zustand
 *  zeigt (Maschinen hinzugefügt/entfernt, Namen/Farben etc.). `scenesContainerEl`
 *  ist optional (nur gesetzt, wenn die Jam-Ansicht auch eine Scenes-Leiste
 *  hat, s. main.js). */
export function renderJamView(listEl, scenesContainerEl) {
  listEl.innerHTML = '';
  for (const machine of boundRack?.machines ?? []) {
    listEl.appendChild(buildColumn(machine));
  }
  // Fängt z. B. eine Maschine ab, die WÄHREND laufender Clip-Wiedergabe neu
  // ins Rack kam (setJamGate() lief für sie noch nie) — beim (Wieder-)
  // Öffnen des Sheets bekommt jede Maschine garantiert den aktuell
  // korrekten Gate-Zustand.
  refreshJamGates();
  if (scenesContainerEl) {
    scenesEl = scenesContainerEl;
    renderScenes();
  }
}
