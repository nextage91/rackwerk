/**
 * project — komplette Sessions serialisieren und wiederherstellen.
 *
 * Format (v1):
 * { v: 1, bpm, fx?, machines: [ { type, state, sends?, inserts?, clips?, lanes, label? } ] }
 *   - state: maschinenspezifisch (machine.serialize/deserialize)
 *   - label: Nutzer-Umbenennung der Maschine (Basisklasse), fehlt in
 *     alten Projekten → Typ-Name bleibt Default (s. machine.js#displayName)
 *   - sends: FX-Send-Pegel der Maschine (Basisklasse)
 *   - inserts: Insert-FX-Kette der Maschine (Basisklasse), fehlt in
 *     alten Projekten → leere Kette (wie sends: Sibling-Feld, nicht
 *     Teil des unterklassen-eigenen state)
 *   - modulators: Modulations-Kette der Maschine (LFO/Arpeggiator,
 *     Basisklasse), gleiches Sibling-Muster wie inserts — fehlt in
 *     alten Projekten → keine Modulatoren
 *   - clips: Jam-Clips der Maschine (Basisklasse), gleiches Sibling-
 *     Muster wie inserts — fehlt in alten Projekten → keine Clips
 *   - xySpring: Auto-Return-Schalter des Jam-X/Y-Pads (Basisklasse),
 *     fehlt in alten Projekten → Default false (aus)
 *   - fx:    Master-Effekte (Delay/Reverb) — fehlt in alten Projekten,
 *            dann bleiben die Defaults stehen
 *   - masterInserts: frei bestückbare Insert-Kette auf dem Master-Bus
 *            (s. fx.js), gleiches Sibling-Muster wie machines[].inserts
 *   - masterLanes: Automation der Master-Insert-Regler, Präfix 'master:'
 *            statt einer Maschinen-ID (s. automation.js)
 *   - lanes: Automation der Maschine, Schlüssel ohne Maschinen-ID
 *     (IDs werden beim Laden neu vergeben, deshalb nur der Suffix)
 */
import { transport } from './transport.js';
import { automation } from './automation.js';
import { masterFX } from './fx.js';
import { song } from './song.js';
import { REGISTRY } from '../rack/rack.js';

const BY_TYPE = Object.fromEntries(REGISTRY.map((M) => [M.meta.type, M]));

export function serializeProject(rack) {
  return {
    v: 1,
    bpm: transport.bpm,
    fx: masterFX.serialize(),
    masterInserts: masterFX.serializeInserts(),
    masterLanes: automation.exportLanesWithPrefix('master:'),
    song: song.serialize(),
    machines: rack.machines.map((m) => ({
      type: m.constructor.meta.type,
      state: m.serialize(),
      sends: { ...m.sends },
      inserts: m.serializeInserts(),
      modulators: m.serializeModulators(),
      clips: m.serializeClips(),
      xySpring: m.xySpring,
      lanes: automation.exportLanes(m.id),
      label: m.label,
    })),
  };
}

/**
 * Frische Session: alles auf Werkseinstellung — leeres Rack, 120 BPM,
 * Master-FX auf Default, dann die Startbesetzung (BeatBox + SubSynth
 * mit Demo-Groove). Entspricht dem allerersten App-Start.
 */
export function newProject(rack) {
  transport.stop();
  rack.clear();
  transport.setBpm(120);
  masterFX.reset();
  song.clear();
  rack.addMachine(BY_TYPE.beatbox).seedDemo();
  rack.addMachine(BY_TYPE.subsynth).seedDemo();
}

export function loadProject(rack, data) {
  if (!data || !Array.isArray(data.machines)) {
    throw new Error('Not a RackWerk project file (missing "machines" array)');
  }
  transport.stop();
  rack.clear();
  transport.setBpm(data.bpm ?? 120);
  masterFX.deserialize(data.fx); // fehlt bei alten Projekten → Defaults
  masterFX.deserializeInserts(data.masterInserts); // fehlt bei alten Projekten → leere Kette
  if (data.masterLanes) automation.importLanesWithPrefix('master:', data.masterLanes);
  masterFX.onLanesImported();

  let loaded = 0;
  for (const md of data.machines) {
    const MachineClass = BY_TYPE[md.type];
    if (!MachineClass) continue; // unbekannter Typ (z. B. ältere/neuere Version)
    // Eine einzelne kaputte Maschine (unerwartete Datenform in einer
    // beschädigten/handgebastelten Datei) darf den Rest des Ladens nicht
    // abreißen -- sonst bricht loadProject() MITTEN im schon per clear()
    // geleerten Rack ab, und der Autosave-Timer überschreibt kurz danach
    // die letzte GUTE Session mit diesem halb geladenen Zustand.
    try {
      const machine = rack.addMachine(MachineClass, md.state);
      if (md.sends) machine.setSends(md.sends);
      if (md.inserts) machine.deserializeInserts(md.inserts);
      if (md.modulators) machine.deserializeModulators(md.modulators);
      if (md.clips) machine.deserializeClips(md.clips);
      if (md.xySpring) machine.xySpring = true;
      if (md.label) machine.setLabel(md.label);
      automation.importLanes(machine.id, md.lanes);
      machine.onLanesImported?.();
      loaded++;
    } catch (err) {
      console.warn(`Machine "${md.type}" could not be loaded — skipped:`, err);
    }
  }
  // Die Pro-Maschine-Abschottung oben verhindert einen Crash, aber nicht
  // den Sonderfall "die Datei nannte Maschinen, aber JEDE einzelne ist
  // gescheitert" -- ohne diese Prüfung würde loadProject() dann klaglos
  // mit einem leeren Rack zurückkehren (kein Throw, also KEIN Rollback
  // in main.js), obwohl die vorherige Session gerade durch rack.clear()
  // oben schon verworfen wurde. Ein absichtlich leeres Projekt (data.
  // machines = []) bleibt davon unberührt -- das ist ein legitimes Ergebnis.
  if (loaded === 0 && data.machines.length > 0) {
    throw new Error('None of the machines in this file could be loaded');
  }
  song.deserialize(data.song); // nach den Maschinen (Events zeigen auf deren Position)
}

/**
 * Maschinen aus einem (fremden) Projekt ins laufende Rack übernehmen,
 * ohne die eigene Session anzutasten — die Grundlage fürs Jammen:
 * Das Master-Gerät importiert die Maschinen des anderen und spielt
 * alles lokal, sample-genau, ganz ohne Audio-Übertragung.
 */
export function importMachines(rack, data) {
  const added = [];
  for (const md of data?.machines ?? []) {
    const MachineClass = BY_TYPE[md.type];
    if (!MachineClass) continue;
    // Gleiche Abschottung wie loadProject() -- eine kaputte Maschine im
    // fremden (Jam-)Projekt darf die übrigen nicht mitreißen.
    try {
      const machine = rack.addMachine(MachineClass, md.state);
      if (md.sends) machine.setSends(md.sends);
      if (md.inserts) machine.deserializeInserts(md.inserts);
      if (md.modulators) machine.deserializeModulators(md.modulators);
      if (md.clips) machine.deserializeClips(md.clips);
      if (md.xySpring) machine.xySpring = true;
      if (md.label) machine.setLabel(md.label);
      automation.importLanes(machine.id, md.lanes);
      machine.onLanesImported?.();
      added.push(machine);
    } catch (err) {
      console.warn(`Machine "${md.type}" could not be imported — skipped:`, err);
    }
  }
  return added;
}
