// Regenerates verifier/src/abi.ts from forge output. Run after `forge build`.
const fs = require("fs");
const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const fb = read("contracts/out/FlatBallot.sol/FlatBallot.json");
const vb = read("contracts/out/VoteBox.sol/VoteBox.json");
const mw = read("contracts/out/Mocks.sol/MockWIF.json");
const out =
  "// AUTO-GENERATED from contracts/out by scripts/gen-abi.cjs — do not edit.\n" +
  `export const flatBallotAbi = ${JSON.stringify(fb.abi)} as const;\n` +
  `export const voteBoxAbi = ${JSON.stringify(vb.abi)} as const;\n` +
  `export const mockWifAbi = ${JSON.stringify(mw.abi)} as const;\n` +
  `export const flatBallotBytecode = "${fb.bytecode.object}" as const;\n` +
  `export const mockWifBytecode = "${mw.bytecode.object}" as const;\n`;
fs.writeFileSync("verifier/src/abi.ts", out);
console.log("wrote verifier/src/abi.ts");
