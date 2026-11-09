// Compiles Fixtures.sol with solc-js (npm). Test-only helper.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Abi, Hex } from "viem";

const require = createRequire(import.meta.url);

export interface Compiled { abi: Abi; bytecode: Hex }

export function compileFixtures(): Record<string, Compiled> {
  const solc = require("solc") as { compile(input: string): string };
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "Fixtures.sol"), "utf8");
  const input = {
    language: "Solidity",
    sources: { "Fixtures.sol": { content: source } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "paris", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input))) as {
    errors?: Array<{ severity: string; formattedMessage: string }>;
    contracts: Record<string, Record<string, { abi: Abi; evm: { bytecode: { object: string } } }>>;
  };
  const errors = (out.errors ?? []).filter((e) => e.severity === "error");
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join("\n"));
  const res: Record<string, Compiled> = {};
  for (const [name, c] of Object.entries(out.contracts["Fixtures.sol"] ?? {})) {
    res[name] = { abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` as Hex };
  }
  return res;
}
