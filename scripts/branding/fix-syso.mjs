// Repair the resource object that MSVC's cvtres produced so that Go's linker
// accepts it.
//
// Go's PE loader (cmd/link/internal/loadpe/ldpe.go) rejects any symbol whose
// section number is negative unless the symbol is the absolute "@feat.00"
// marker. MSVC's cvtres emits an absolute "@comp.id" symbol for its debug
// section, which trips that check with "sectnum < 0!". Dropping the symbol
// and renumbering the relocation indices that point past it is enough.
//
// The .rsrc sections also get MEM_WRITE from cvtres; the linker emits them
// read-only, so the characteristics are normalised to match a stock object.

import fs from "node:fs";

const input = process.argv[2];
const output = process.argv[3];
if (!input || !output) {
  console.error("usage: fix-syso.mjs <in.syso> <out.syso>");
  process.exit(1);
}

const b = fs.readFileSync(input);
const sectionCount = b.readUInt16LE(2);
const symbolCount = b.readUInt32LE(12);
const symbolOffset = b.readUInt32LE(8);

const symbolName = (at) => b.toString("ascii", at, at + 8).replace(/\0/g, "");

let dropped = -1;
for (let i = 0; i < symbolCount; i++) {
  if (symbolName(symbolOffset + i * 18) === "@comp.id") {
    dropped = i;
    break;
  }
}
if (dropped < 0) {
  console.log("fix-syso: no @comp.id symbol to drop.");
  fs.writeFileSync(output, b);
  process.exit(0);
}

// The relocation entries refer to symbols by index, so every index after the
// dropped one moves down by one.
const out = Buffer.from(b);
for (let i = 0; i < sectionCount; i++) {
  const at = 20 + i * 40;
  const relocOffset = b.readUInt32LE(at + 24);
  const relocCount = b.readUInt16LE(at + 32);
  for (let j = 0; j < relocCount; j++) {
    const at2 = relocOffset + j * 10;
    const index = b.readUInt32LE(at2 + 4);
    if (index > dropped) out.writeUInt32LE(index - 1, at2 + 4);
  }
  const name = symbolName(at);
  if (name.startsWith(".rsrc")) {
    // IMAGE_SCN_CNT_INITIALIZED_DATA | IMAGE_SCN_MEM_READ
    out.writeUInt32LE(0x40000040, at + 36);
  }
}

// Rebuild the tail of the file: the symbol table without the dropped symbol,
// followed by the string table.
const symbols = [];
for (let i = 0; i < symbolCount; i++) {
  if (i === dropped) continue;
  symbols.push(b.subarray(symbolOffset + i * 18, symbolOffset + i * 18 + 18));
}
const stringTable = b.subarray(symbolOffset + symbolCount * 18);

const header = out.subarray(0, symbolOffset);
const newHeader = Buffer.from(header);
newHeader.writeUInt32LE(symbolCount - 1, 12);

const result = Buffer.concat([newHeader, ...symbols, stringTable]);
fs.writeFileSync(output, result);
console.log(
  `fix-syso: dropped @comp.id, ${symbols.length} symbols remain, ${result.length} bytes.`,
);
