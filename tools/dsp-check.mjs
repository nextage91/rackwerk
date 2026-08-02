#!/usr/bin/env node
/**
 * dsp-check.mjs — Runner für die DSP-/Regressionstests in tools/dsp-tests/.
 *
 * Baut das Bundle (ausser bei --no-build), startet einen eigenen, isolierten
 * lokalen Server für die Dauer des Laufs (kollidiert nicht mit einem
 * bereits laufenden Dev-Server auf 8900/8901), führt jede Testdatei in
 * tools/dsp-tests/ als eigenen Prozess aus und fasst das Ergebnis zusammen.
 *
 * Jede Testdatei ist eigenständig lauffähig (`node tools/dsp-tests/x.mjs
 * [baseUrl]`) -- dieser Runner ist nur die bequeme "alles auf einmal"-
 * Variante, kein Test-Framework.
 *
 *   node tools/dsp-check.mjs              # baut + testet
 *   node tools/dsp-check.mjs --no-build   # nutzt das vorhandene index.html
 *
 * Braucht Playwright als Dev-Abhängigkeit, wie tools/layout-check.mjs
 * (`npm i playwright`; die App selbst bleibt abhängigkeitsfrei).
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TESTS_DIR = path.join(ROOT, 'tools', 'dsp-tests');
const PORT = 8987; // eigener, isolierter Port -- kollidiert nicht mit manuell laufenden 8900/8901
const BASE_URL = `http://127.0.0.1:${PORT}/index.html`;

const skipBuild = process.argv.includes('--no-build');

function buildBundle() {
  console.log('Baue Bundle (python3 src/build-preview.py) …');
  const build = spawnSync('python3', ['build-preview.py'], { cwd: path.join(ROOT, 'src'), stdio: 'inherit' });
  if (build.status !== 0) {
    console.error('\nBundle-Build fehlgeschlagen -- Tests würden gegen ein veraltetes index.html laufen, abgebrochen.');
    process.exit(1);
  }
  const preview = fs.readFileSync(path.join(ROOT, 'src', 'rackwerk-preview.html'), 'utf8');
  const shipped = preview.replace('<title>Preview — RackWerk — Groovebox</title>', '<title>RackWerk — Groovebox</title>');
  fs.writeFileSync(path.join(ROOT, 'index.html'), shipped);
  console.log('index.html aktualisiert.\n');
}

function waitForServer(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  const tryOnce = () => fetch(url).then((r) => r.ok || r.status === 404).catch(() => false);
  return new Promise((resolve, reject) => {
    (async function poll() {
      if (await tryOnce()) return resolve();
      if (Date.now() > deadline) return reject(new Error(`Server unter ${url} kam nicht rechtzeitig hoch.`));
      setTimeout(poll, 150);
    })();
  });
}

if (!skipBuild) buildBundle();

console.log(`Starte lokalen Server auf Port ${PORT} (Repo-Root) …`);
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', ROOT], { stdio: 'ignore' });
server.on('error', (err) => { console.error('Server konnte nicht gestartet werden:', err.message); process.exit(1); });

try {
  await waitForServer(BASE_URL);

  const files = fs.readdirSync(TESTS_DIR)
    .filter((f) => f.endsWith('.mjs') && !f.startsWith('_'))
    .sort();

  console.log(`\n${files.length} Testdateien gefunden in tools/dsp-tests/\n`);

  const outcomes = [];
  for (const file of files) {
    const full = path.join(TESTS_DIR, file);
    console.log(`\n========== ${file} ==========`);
    const res = spawnSync('node', [full, BASE_URL], { stdio: 'inherit' });
    outcomes.push({ file, ok: res.status === 0 });
  }

  console.log('\n========== Zusammenfassung ==========');
  for (const { file, ok } of outcomes) {
    console.log(`${ok ? '✓' : '✗'} ${file}`);
  }
  const failed = outcomes.filter((o) => !o.ok);
  console.log(failed.length === 0
    ? `\nAlle ${outcomes.length} Suiten grün.`
    : `\n${failed.length}/${outcomes.length} Suite(n) fehlgeschlagen: ${failed.map((f) => f.file).join(', ')}`);

  process.exitCode = failed.length === 0 ? 0 : 1;
} finally {
  server.kill();
}
