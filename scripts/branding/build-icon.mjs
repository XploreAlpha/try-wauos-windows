#!/usr/bin/env node
// Rebuilds app/icon.ico and app/rsrc_windows_amd64.syso from app/WauIcon.svg.
//
// The icon in the shipped executable comes from app/rsrc_windows_amd64.syso, a
// pre-compiled COFF resource object that Go's linker embeds as-is. The .rc file
// and the .ico are only inputs to that object, and nothing in the build
// regenerates it, so editing app/WauIcon.svg or app/icon.ico on its own
// changes nothing in the executable. This script does the whole chain.
//
//   node scripts/branding/build-icon.mjs
//
// Options:
//   --svg <file>     source artwork        (default app/WauIcon.svg)
//   --ico <file>     icon to write         (default app/icon.ico)
//   --syso <file>    resource object       (default app/rsrc_windows_amd64.syso)
//   --rc <file>      resource script       (default app/versioninfo.rc)
//   --llvm-bin <dir> directory holding llvm-rc and llvm-cvtres
//   --ico-only       write the .ico and stop, leaving the .syso alone
//
// Requirements:
//   - Node 18 or newer.
//   - A Chromium browser for rendering (Microsoft Edge or Google Chrome).
//   - llvm-rc and llvm-cvtres from the LLVM toolchain, unless --ico-only.
//
// The .syso step runs the same two commands the header of versioninfo.rc
// documents, and the script checks the result instead of trusting it: a stale
// or half-written resource object fails loudly.

import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const appDir = path.join(repoRoot, "app");

const SIZES = [16, 32, 48, 256];
const DIB_SIZES = [16, 32, 48];

function parseArgs(argv) {
  const options = {
    svg: path.join(appDir, "WauIcon.svg"),
    ico: path.join(appDir, "icon.ico"),
    syso: path.join(appDir, "rsrc_windows_amd64.syso"),
    rc: path.join(appDir, "versioninfo.rc"),
    llvmBin: process.env.LLVM_BIN || "",
    icoOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--ico-only") {
      options.icoOnly = true;
    } else if (arg === "--svg" || arg === "--ico" || arg === "--syso" || arg === "--rc" || arg === "--llvm-bin") {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      options[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    } else {
      throw new Error(`unknown option ${arg}`);
    }
  }
  return options;
}

function fail(message) {
  console.error(`build-icon: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------- rendering

function findBrowser() {
  const candidates = [];
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);
  const programFiles = [process.env["ProgramFiles"], process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA];
  const relative = [
    ["Microsoft", "Edge", "Application", "msedge.exe"],
    ["Google", "Chrome", "Application", "chrome.exe"],
    ["Chromium", "Application", "chrome.exe"],
  ];
  for (const root of programFiles) {
    if (!root) continue;
    for (const parts of relative) candidates.push(path.join(root, ...parts));
  }
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// The page draws the artwork into a canvas at each size and reports both the
// PNG and the raw pixels. Handing the raw pixels to this script avoids having
// to decode a PNG here.
function renderPage(svgBase64) {
  return `<!doctype html>
<meta charset="utf-8">
<body><pre id="out"></pre>
<script>
const svg = "data:image/svg+xml;base64,${svgBase64}";
const sizes = ${JSON.stringify(SIZES)};
// The markers are assembled at run time so that this script's own source does
// not contain the text the reader looks for.
const open = ["BEGIN", "RESULTS"].join("_");
const close = ["END", "RESULTS"].join("_");
const image = new Image();
image.onload = () => {
  const results = [];
  for (const size of sizes) {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, size, size);
    context.drawImage(image, 0, 0, size, size);
    const entry = { size, png: canvas.toDataURL("image/png").split(",")[1] };
    if (size !== 256) {
      const pixels = context.getImageData(0, 0, size, size).data;
      let raw = "";
      const chunk = 0x8000;
      for (let offset = 0; offset < pixels.length; offset += chunk) {
        raw += String.fromCharCode.apply(null, pixels.subarray(offset, offset + chunk));
      }
      entry.rgba = btoa(raw);
    }
    results.push(entry);
  }
  document.getElementById("out").textContent = open + JSON.stringify(results) + close;
};
image.onerror = () => {
  document.getElementById("out").textContent = open + JSON.stringify([{ error: "the artwork could not be loaded" }]) + close;
};
image.src = svg;
</script>
</body>`;
}

function render(svgPath) {
  const browser = findBrowser();
  if (!browser) {
    fail("no Chromium browser found. Install Microsoft Edge or Google Chrome, or set CHROME_PATH.");
  }
  const svgBase64 = fs.readFileSync(svgPath).toString("base64");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "wau-icon-"));
  const page = path.join(work, "render.html");
  const profile = path.join(work, "profile");
  fs.writeFileSync(page, renderPage(svgBase64));
  let dom;
  try {
    dom = execFileSync(
      browser,
      [
        "--headless",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--hide-scrollbars",
        "--virtual-time-budget=20000",
        `--user-data-dir=${profile}`,
        "--dump-dom",
        `file:///${page.replace(/\\/g, "/")}`,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 },
    );
  } catch (error) {
    fail(`the browser failed to render the artwork: ${error.message}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  const match = /<pre id="out">([\s\S]*?)<\/pre>/.exec(dom);
  if (!match) {
    fail("the browser did not report a rendered image. Try opening the artwork in a browser to check it is valid.");
  }
  const body = match[1]
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  const inner = /^BEGIN_RESULTS([\s\S]*)END_RESULTS$/.exec(body);
  if (!inner) {
    fail("the browser did not report a rendered image. Try opening the artwork in a browser to check it is valid.");
  }
  let results;
  try {
    results = JSON.parse(inner[1]);
  } catch (error) {
    fail(`the browser reported unreadable results: ${error.message}`);
  }
  if (results[0] && results[0].error) fail(results[0].error);
  const bySize = new Map(results.map((entry) => [entry.size, entry]));
  for (const size of SIZES) {
    if (!bySize.has(size)) fail(`the browser did not render the ${size} pixel size`);
  }
  return bySize;
}

// ------------------------------------------------------------------- the ico

// A 32bpp icon entry: the BITMAPINFOHEADER, the colour data bottom-up as
// BGRA, and the 1-bit AND mask that marks the transparent pixels. Windows
// reads the mask when it draws the icon on older surfaces, so it is filled in
// rather than left empty.
function dibEntry(width, height, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(width, 4);
  header.writeInt32LE(height * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(width * height * 4, 20);

  const xor = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const source = (height - 1 - y) * width * 4;
    for (let x = 0; x < width; x++) {
      const from = source + x * 4;
      const to = (y * width + x) * 4;
      xor[to] = rgba[from + 2];
      xor[to + 1] = rgba[from + 1];
      xor[to + 2] = rgba[from];
      xor[to + 3] = rgba[from + 3];
    }
  }

  const maskStride = Math.ceil(width / 32) * 4;
  const mask = Buffer.alloc(maskStride * height);
  for (let y = 0; y < height; y++) {
    const source = (height - 1 - y) * width * 4;
    for (let x = 0; x < width; x++) {
      if (rgba[source + x * 4 + 3] < 128) {
        mask[y * maskStride + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }
  return Buffer.concat([header, xor, mask]);
}

function buildIco(rendered) {
  const entries = [];
  for (const size of DIB_SIZES) {
    const rgba = Buffer.from(rendered.get(size).rgba, "base64");
    if (rgba.length !== size * size * 4) {
      fail(`the ${size} pixel image has ${rgba.length} bytes of colour data, expected ${size * size * 4}`);
    }
    entries.push({ size, data: dibEntry(size, size, rgba) });
  }
  entries.push({ size: 256, data: Buffer.from(rendered.get(256).png, "base64") });

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const directory = Buffer.alloc(16 * entries.length);
  let offset = header.length + directory.length;
  entries.forEach((entry, index) => {
    const at = index * 16;
    directory[at] = entry.size === 256 ? 0 : entry.size;
    directory[at + 1] = entry.size === 256 ? 0 : entry.size;
    directory.writeUInt16LE(1, at + 4);
    directory.writeUInt16LE(32, at + 6);
    directory.writeUInt32LE(entry.data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += entry.data.length;
  });
  return Buffer.concat([header, directory, ...entries.map((entry) => entry.data)]);
}

// ------------------------------------------------------------------- the syso

function findLlvmTool(name, llvmBin) {
  const roots = [];
  if (llvmBin) roots.push(llvmBin);
  if (process.env.LLVM_ROOT) roots.push(path.join(process.env.LLVM_ROOT, "bin"));
  for (const root of roots) {
    for (const candidate of [path.join(root, `${name}.exe`), path.join(root, name)]) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const candidate of [path.join(dir, `${name}.exe`), path.join(dir, name)]) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function rebuildSyso(options) {
  const rc = findLlvmTool("llvm-rc", options.llvmBin);
  const cvtres = findLlvmTool("llvm-cvtres", options.llvmBin);
  if (!rc) fail("llvm-rc was not found. Install the LLVM toolchain or pass --llvm-bin.");
  if (!cvtres) fail("llvm-cvtres was not found. Install the LLVM toolchain or pass --llvm-bin.");

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "wau-res-"));
  const res = path.join(work, "rsrc.res");
  try {
    // The .rc names icon.ico relatively, so the compiler runs in app/.
    execFileSync(rc, ["/FO", res, path.basename(options.rc)], { cwd: path.dirname(options.rc), stdio: "inherit" });
    execFileSync(cvtres, ["/MACHINE:X64", `/OUT:${options.syso}`, res], { cwd: path.dirname(options.rc), stdio: "inherit" });
  } catch (error) {
    fail(`the resource object could not be built: ${error.message}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------- checks

// The checks below are the reason this script is worth running: a resource
// object that does not carry the new artwork and the new strings would ship
// an old icon without any error.
function verifySyso(sysoPath, icoPath, rcPath) {
  const syso = fs.readFileSync(sysoPath);
  const ico = fs.readFileSync(icoPath);

  const fixedFileInfo = Buffer.from([0xbd, 0x04, 0xef, 0xfe]);
  if (!syso.includes(fixedFileInfo)) {
    fail("the rebuilt resource object carries no version information.");
  }

  const rc = fs.readFileSync(rcPath, "utf8");
  const described = [...rc.matchAll(/VALUE "(FileDescription|ProductName)", "([^"]*)"/g)].map((m) => m[2]);
  for (const value of described) {
    const encoded = Buffer.from(value + "\0", "utf16le");
    if (!syso.includes(encoded)) {
      fail(`the rebuilt resource object does not carry ${JSON.stringify(value)}.`);
    }
  }

  // The 16 pixel icon entry must be inside the resource object, unchanged.
  const dib = ico.subarray(ico.readUInt32LE(6 + 12), ico.readUInt32LE(6 + 8) + ico.readUInt32LE(6 + 12));
  if (dib.length === 0 || !syso.includes(dib)) {
    fail("the rebuilt resource object does not carry the new 16 pixel icon.");
  }
  console.log("build-icon: the resource object carries the new icon and strings.");
}

function verifyIco(icoPath) {
  const ico = fs.readFileSync(icoPath);
  if (ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) {
    fail("the written icon is not an icon file.");
  }
  const count = ico.readUInt16LE(4);
  const found = new Set();
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 16;
    const width = ico[at] === 0 ? 256 : ico[at];
    found.add(width);
  }
  for (const size of SIZES) {
    if (!found.has(size)) fail(`the written icon has no ${size} pixel entry.`);
  }
  console.log(`build-icon: wrote an icon with ${count} entries.`);
}

// --------------------------------------------------------------------- main

const options = parseArgs(process.argv.slice(2));

if (!fs.existsSync(options.svg)) fail(`the artwork ${options.svg} does not exist.`);
console.log(`build-icon: rendering ${path.relative(repoRoot, options.svg)}`);
const rendered = render(options.svg);
const ico = buildIco(rendered);
fs.mkdirSync(path.dirname(options.ico), { recursive: true });
fs.writeFileSync(options.ico, ico);
verifyIco(options.ico);
console.log(`build-icon: wrote ${path.relative(repoRoot, options.ico)} (${ico.length} bytes)`);

if (options.icoOnly) {
  console.log("build-icon: --ico-only was given, so the resource object was left alone.");
  console.log("build-icon: the executable still shows the old icon until it is rebuilt.");
  process.exit(0);
}

rebuildSyso(options);
verifySyso(options.syso, options.ico, options.rc);
console.log(`build-icon: wrote ${path.relative(repoRoot, options.syso)}`);
console.log("build-icon: done. Run 'go build ./...' to pick it up.");
