// Wallet vault CLI. Secrets and passphrases are read from a hidden prompt, never from
// command-line arguments (which end up in shell history).
//
//   npm run vault -w @mint-engine/server -- <command> [args]   (vault path: --vault <file>,
//   or vaultPath from --config / MINT_ENGINE_CONFIG, default ./wallets.keystore)
//
//   init                          create a new encrypted vault
//   list                          list wallets (no passphrase needed)
//   generate <solana|evm> [label] create a new wallet
//   import <solana|evm> [label]   import a private key (prompted, hidden)
//   label <walletId> <label>      rename a wallet
//   remove <walletId>             delete a wallet from the vault

import { existsSync } from "node:fs";
import { MIN_PASSPHRASE_LENGTH, WalletVault } from "@mint-engine/wallets";
import { loadConfig } from "./real.js";

// Piped (non-TTY) input: one shared line buffer, so several prompts can read successive
// lines from the same pipe. A prompt with no line left fails instead of hanging.
let pipeLines: Promise<string[]> | undefined;
function readPipedLines(): Promise<string[]> {
  pipeLines ??= new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d: string) => { buf += d; });
    process.stdin.on("end", () => resolve(buf.split(/\r?\n/)));
    process.stdin.on("error", reject);
  });
  return pipeLines;
}

function hiddenPrompt(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) {
      stdout.write(question);
      readPipedLines().then((lines) => {
        const line = lines.shift();
        stdout.write("\n");
        if (line === undefined || (line === "" && lines.length === 0)) reject(new Error("no input for prompt (stdin ended)"));
        else resolve(line);
      }, reject);
      return;
    }
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n") {
          stdin.setRawMode(false); stdin.pause(); stdin.off("data", onData); stdout.write("\n");
          resolve(value); return;
        }
        if (c === "\u0003") { stdin.setRawMode(false); stdout.write("\n"); process.exit(130); }
        if (c === "\u007f" || c === "\b") value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on("data", onData);
  });
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function vaultPath(): Promise<string> {
  const explicit = flag("--vault");
  if (explicit) return explicit;
  const cfg = flag("--config") ?? process.env.MINT_ENGINE_CONFIG;
  if (cfg) return (await loadConfig(cfg)).vaultPath;
  return "wallets.keystore";
}

async function openUnlocked(path: string): Promise<WalletVault> {
  const v = await WalletVault.open(path);
  await v.unlock(await hiddenPrompt("Vault passphrase: "));
  return v;
}

const family = (s: string | undefined): "solana" | "evm" => {
  if (s === "solana" || s === "evm") return s;
  throw new Error(`family must be "solana" or "evm", got ${s ?? "(none)"}`);
};

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !(all[i - 1]?.startsWith("--")));
  const [cmd, a1, a2] = args;
  const path = await vaultPath();

  switch (cmd) {
    case "init": {
      if (existsSync(path)) throw new Error(`${path} already exists; refusing to overwrite`);
      const p1 = await hiddenPrompt(`New passphrase (min ${MIN_PASSPHRASE_LENGTH} chars): `);
      const p2 = await hiddenPrompt("Repeat passphrase: ");
      if (p1 !== p2) throw new Error("passphrases don't match");
      await WalletVault.create(path, p1);
      console.log(`Created ${path}. Back up this file AND your passphrase; there is no recovery.`);
      return;
    }
    case "list": {
      const v = await WalletVault.open(path);
      const ws = v.list();
      if (!ws.length) console.log("(no wallets)");
      for (const w of ws) console.log(`${w.id}\t${w.family}\t${w.address}\t${w.label}`);
      return;
    }
    case "generate": {
      const v = await openUnlocked(path);
      const w = await v.generate(family(a1), a2);
      console.log(`Generated ${w.family} wallet ${w.id} ${w.address} (${w.label})`);
      v.lock();
      return;
    }
    case "import": {
      const fam = family(a1);
      const v = await openUnlocked(path);
      const secret = await hiddenPrompt(fam === "evm" ? "Private key (0x hex): " : "Secret key (base58 or JSON byte array): ");
      const raw = fam === "solana" && secret.trim().startsWith("[") ? (JSON.parse(secret) as number[]) : secret.trim();
      const w = fam === "evm" ? await v.importEvm(raw as string, a2) : await v.importSolana(raw, a2);
      console.log(`Imported ${w.family} wallet ${w.id} ${w.address} (${w.label})`);
      v.lock();
      return;
    }
    case "label": {
      if (!a1 || !a2) throw new Error("usage: label <walletId> <label>");
      const v = await openUnlocked(path);
      await v.setLabel(a1, a2);
      console.log(`Renamed ${a1} to "${a2}"`);
      v.lock();
      return;
    }
    case "remove": {
      if (!a1) throw new Error("usage: remove <walletId>");
      const v = await openUnlocked(path);
      await v.remove(a1);
      console.log(`Removed ${a1}. Its key is gone from the vault; make sure you have a backup if it holds funds.`);
      v.lock();
      return;
    }
    default:
      console.log("commands: init | list | generate <solana|evm> [label] | import <solana|evm> [label] | label <id> <label> | remove <id>");
      console.log("options:  --vault <file> | --config <mint-engine.config.json>");
      if (cmd) process.exitCode = 1;
  }
}

main().catch((e: unknown) => {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
