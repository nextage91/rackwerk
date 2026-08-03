/**
 * build-resonator-worklet.mjs -- (re)compiles src/faust/resonator.dsp to
 * WebAssembly and writes src/js/core/resonator-worklet.js, a self-
 * contained AudioWorkletProcessor source (no runtime dependency on the
 * @grame/faustwasm library or the Faust compiler) -- same embedding
 * pattern as core/onepole-worklet.js (RackWerk ships as one bundled
 * index.html, no separate script files, so the worklet is loaded from a
 * Blob URL built from this string at runtime).
 *
 * Runs the ACTUAL @grame/faustwasm code generation inside a real browser
 * (Playwright) rather than hand-reimplementing its internal, non-exported
 * classes (FaustSensors, FaustAudioWorkletCommunicator, etc. aren't part
 * of the package's public API) -- guaranteed correct against whatever
 * version is installed, since it's the library's own template.
 *
 * Usage:  npm install && node tools/build-resonator-worklet.mjs
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const dspPath = path.join(repoRoot, 'src/faust/resonator.dsp');
const outPath = path.join(repoRoot, 'src/js/core/resonator-worklet.js');
const bundlePath = path.join(repoRoot, 'node_modules/@grame/faustwasm/dist/esm-bundle/index.js');
const libfaustJsPath = path.join(repoRoot, 'node_modules/@grame/faustwasm/libfaust-wasm/libfaust-wasm.js');

if (!fs.existsSync(bundlePath)) {
  console.error('node_modules/@grame/faustwasm not found -- run `npm install` first.');
  process.exit(1);
}

const dspCode = fs.readFileSync(dspPath, 'utf8');

// A tiny local static server so the browser can `import()` the ESM bundle
// (dynamic import of a file:// module from a non-file:// page is blocked;
// serving it makes MIME types/relative paths behave exactly like a real
// deployment would).
import http from 'node:http';
import { createReadStream } from 'node:fs';
const mimeFor = (p) => (p.endsWith('.js') ? 'text/javascript' : p.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream');
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>build</title>'); return; }
  const filePath = path.join(repoRoot, urlPath);
  if (!filePath.startsWith(repoRoot) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': mimeFor(filePath) });
  createReadStream(filePath).pipe(res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(`${base}/`);

const bundleRel = path.relative(repoRoot, bundlePath).split(path.sep).join('/');
const libfaustRel = path.relative(repoRoot, libfaustJsPath).split(path.sep).join('/');

const result = await page.evaluate(async ({ dspCode, bundleUrl, libfaustJsUrl }) => {
  const FaustWasm = await import(bundleUrl);
  const { instantiateFaustModuleFromFile, LibFaust, FaustCompiler, FaustMonoDspGenerator } = FaustWasm;

  const faustModule = await instantiateFaustModuleFromFile(libfaustJsUrl);
  const libFaust = new LibFaust(faustModule);
  const compiler = new FaustCompiler(libFaust);
  const generator = new FaustMonoDspGenerator();
  const dsp = await generator.compile(compiler, 'resonator', dspCode, '-ftz 2');
  if (!dsp) throw new Error('Faust compile failed');

  let capturedBlob = null;
  const origCreateObjectURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (blob) => {
    if (blob.type === 'text/javascript' && !capturedBlob) capturedBlob = blob;
    return origCreateObjectURL(blob);
  };
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  await generator.createNode(ctx, 'resonator', dsp.factory);
  URL.createObjectURL = origCreateObjectURL;
  if (!capturedBlob) throw new Error('Did not capture the generated worklet processor source');

  const processorCode = await capturedBlob.text();
  const wasmBytes = dsp.factory.code;
  let binary = '';
  for (let i = 0; i < wasmBytes.length; i++) binary += String.fromCharCode(wasmBytes[i]);
  const wasmBase64 = btoa(binary);

  return { processorCode, wasmBase64, metaJson: dsp.factory.json };
}, { dspCode, bundleUrl: `${base}/${bundleRel}`, libfaustJsUrl: `${base}/${libfaustRel}` });

await browser.close();
server.close();

if (errors.length) {
  console.error('Page errors during compilation:', errors);
  process.exit(1);
}

// The generated processor source embeds a content-hash processor name
// (factory.shaKey) -- swap it for a stable, readable one matching the
// rest of the project's worklet naming (rackwerk-onepole etc.), so the
// runtime code in inserts.js can reference a fixed constant instead of
// needing to know the hash.
const PROCESSOR_NAME = 'rackwerk-resonator';
const nameMatch = result.processorCode.match(/"processorName":"([^"]+)"/);
if (!nameMatch) throw new Error('Could not find processorName in generated source');
const hashName = nameMatch[1];
const processorCode = result.processorCode.split(hashName).join(PROCESSOR_NAME);

const meta = JSON.parse(result.metaJson);
const params = [];
const collect = (item) => {
  if (item.type === 'hslider' || item.type === 'vslider' || item.type === 'nentry') {
    params.push({ address: item.address, init: item.init, min: item.min, max: item.max });
  }
};
const walk = (items) => items.forEach((it) => (it.items ? walk(it.items) : collect(it)));
walk(meta.ui);

const header = `/**
 * resonator-worklet.js -- GENERATED, do not hand-edit. Regenerate with:
 *   npm install && node tools/build-resonator-worklet.mjs
 * after changing src/faust/resonator.dsp.
 *
 * Modal-synthesis resonator core, compiled from Faust (pm.modalModel) to
 * WebAssembly and embedded as a self-contained AudioWorkletProcessor --
 * same pattern as onepole-worklet.js: RackWerk ships as one bundled
 * index.html, so the processor source is loaded from a Blob URL at
 * runtime (s. core/inserts.js#ensureResonatorWorklet), no separate
 * script files or a runtime dependency on the Faust compiler/@grame/
 * faustwasm library itself (only needed at BUILD time, by this script).
 *
 * RESONATOR_PARAMS lists the exposed hslider addresses (pitch/resonance/
 * damping) -- these become genuine native AudioParams on the resulting
 * AudioWorkletNode (node.parameters.get(address)), settable exactly like
 * any built-in Web Audio param (setTargetAtTime etc.).
 */
export const RESONATOR_PROCESSOR_NAME = '${PROCESSOR_NAME}';

export const RESONATOR_PARAMS = ${JSON.stringify(params, null, 2)};

// Full Faust meta JSON, needed verbatim as \`factory.json\` when
// constructing a node (FaustWasmInstantiator reads more from it than just
// the UI param list extracted into RESONATOR_PARAMS above).
export const RESONATOR_META_JSON = ${JSON.stringify(result.metaJson)};

export const RESONATOR_WASM_BASE64 = '${result.wasmBase64}';

// JSON.stringify (not a template literal) -- the generated processor
// source itself contains backticks and \${...} template-literal syntax,
// which would otherwise prematurely close/break an outer template string.
export const RESONATOR_WORKLET_SRC = ${JSON.stringify(processorCode)};
`;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, header);
console.log(`Wrote ${path.relative(repoRoot, outPath)} (${(header.length / 1024).toFixed(1)} KB)`);
console.log('Params:', params.map((p) => p.address).join(', '));
