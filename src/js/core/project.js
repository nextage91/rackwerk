/**
 * project — komplette Sessions serialisieren und wiederherstellen.
 *
 * Format (v1):
 * { v: 1, bpm, machines: [ { type, state, lanes } ] }
 *   - state: maschinenspezifisch (machine.serialize/deserialize)
 *   - lanes: Automation der Maschine, Schlüssel ohne Maschinen-ID
 *     (IDs werden beim Laden neu vergeben, deshalb nur der Suffix)
 */
import { transport } from './transport.js';
import { automation } from './automation.js';
import { REGISTRY } from '../rack/rack.js';

const BY_TYPE = Object.fromEntries(REGISTRY.map((M) => [M.meta.type, M]));

export function serializeProject(rack) {
  return {
    v: 1,
    bpm: transport.bpm,
    machines: rack.machines.map((m) => ({
      type: m.constructor.meta.type,
      state: m.serialize(),
      lanes: automation.exportLanes(m.id),
    })),
  };
}

export function loadProject(rack, data) {
  transport.stop();
  rack.clear();
  transport.setBpm(data.bpm ?? 120);

  for (const md of data.machines ?? []) {
    const MachineClass = BY_TYPE[md.type];
    if (!MachineClass) continue; // unbekannter Typ (z. B. ältere/neuere Version)
    const machine = rack.addMachine(MachineClass, md.state);
    automation.importLanes(machine.id, md.lanes);
    machine.onLanesImported?.();
  }
}

/**
 * Maschinen aus einem (fremden) Projekt ins laufende Rack übernehmen,
 * ohne die eigene Session anzutasten — die Grundlage fürs Jammen:
 * Das Master-Gerät importiert die Maschinen des anderen und spielt
 * alles lokal, sample-genau, ganz ohne Audio-Übertragung.
 */
export function importMachines(rack, data) {
  const added = [];
  for (const md of data.machines ?? []) {
    const MachineClass = BY_TYPE[md.type];
    if (!MachineClass) continue;
    const machine = rack.addMachine(MachineClass, md.state);
    automation.importLanes(machine.id, md.lanes);
    machine.onLanesImported?.();
    added.push(machine);
  }
  return added;
}
