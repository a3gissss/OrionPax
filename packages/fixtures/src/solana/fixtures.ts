// Solana local fixtures: the Metaplex Core + Core Candy Machine programs are not part of a fresh
// solana-test-validator genesis. They have to be loaded at validator start, either by
//   (a) cloning from a cluster when the validator boots:
//         solana-test-validator --reset --url devnet \
//           --clone-upgradeable-program CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d ...
//   (b) dumping the .so once (`solana program dump -u devnet <id> <file>.so`) and loading offline:
//         solana-test-validator --reset --upgradeable-program <id> <file>.so none ...
// (b) is preferred for tests: no network at test time, reproducible. See scripts/solana-programs.sh.
import { localEndpoints } from "../env.js";
import { solanaRpc, waitForSolanaValidator } from "./rpc.js";

/** Program ids (identical on mainnet-beta and devnet). Sources: metaplex-foundation/mpl-core and mpl-core-candy-machine READMEs. */
export const SOLANA_PROGRAMS = {
  mplCore: "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d",
  coreCandyMachine: "CMACYFENjoBMHzapRXyo1JZkVS6EtaDDzkjMrmQLvr4J",
  coreCandyGuard: "CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ",
} as const;

export type SolanaProgramName = keyof typeof SOLANA_PROGRAMS;

/** File names used by scripts/solana-programs.sh dump. */
export const SOLANA_PROGRAM_FILES: Record<SolanaProgramName, string> = {
  mplCore: "mpl_core.so",
  coreCandyMachine: "mpl_core_candy_machine.so",
  coreCandyGuard: "mpl_core_candy_guard.so",
};

/**
 * Extra solana-test-validator args that load the dumped programs from `programsDir`
 * (a path as seen by the validator, e.g. a docker volume mount like /programs).
 */
export function solanaValidatorProgramArgs(programsDir: string): string[] {
  const dir = programsDir.replace(/\/+$/, "");
  return (Object.keys(SOLANA_PROGRAMS) as SolanaProgramName[]).flatMap((name) => [
    "--upgradeable-program",
    SOLANA_PROGRAMS[name],
    `${dir}/${SOLANA_PROGRAM_FILES[name]}`,
    "none",
  ]);
}

/** Alternative: clone at boot from a non-mainnet cluster (needs network when the validator starts). */
export function solanaValidatorCloneArgs(cluster: "devnet" | "testnet" = "devnet"): string[] {
  return ["--url", cluster, ...Object.values(SOLANA_PROGRAMS).flatMap((id) => ["--clone-upgradeable-program", id])];
}

export interface SolanaFixtures {
  rpcUrl: string;
  wsUrl: string;
  solanaCore: string;
  programs: typeof SOLANA_PROGRAMS;
  /** Whether each program account exists and is executable on the local validator. */
  loaded: Record<SolanaProgramName, boolean>;
  notes: string[];
}

/**
 * Waits for the local validator, then reports which Metaplex programs are loaded.
 * It does not start a validator itself (the validator runs in Docker); it tells you how if programs are missing.
 */
export async function startSolanaFixtures(opts: { rpcUrl?: string; wsUrl?: string; timeoutMs?: number } = {}): Promise<SolanaFixtures> {
  const ep = localEndpoints();
  const rpcUrl = opts.rpcUrl ?? ep.solanaRpc;
  const wsUrl = opts.wsUrl ?? ep.solanaWs;
  const { solanaCore } = await waitForSolanaValidator(rpcUrl, opts.timeoutMs ?? 60_000);

  const names = Object.keys(SOLANA_PROGRAMS) as SolanaProgramName[];
  const infos = await solanaRpc<{ value: Array<{ executable: boolean } | null> }>(rpcUrl, "getMultipleAccounts", [
    names.map((n) => SOLANA_PROGRAMS[n]),
    { encoding: "base64", dataSlice: { offset: 0, length: 0 } },
  ]);
  const loaded = Object.fromEntries(names.map((n, i) => [n, infos.value[i]?.executable === true])) as Record<SolanaProgramName, boolean>;

  const notes: string[] = [];
  if (!Object.values(loaded).every(Boolean)) {
    notes.push(
      "Metaplex Core / Core Candy Machine programs are not loaded on this validator.",
      "Dump once:  bash packages/fixtures/scripts/solana-programs.sh dump   (reads program bytes from devnet into packages/fixtures/.programs/)",
      "Then start: bash packages/fixtures/scripts/solana-programs.sh run    (solana-test-validator with --upgradeable-program flags)",
      `Validator args: ${solanaValidatorProgramArgs("/programs").join(" ")}`,
    );
  }
  return { rpcUrl, wsUrl, solanaCore, programs: SOLANA_PROGRAMS, loaded, notes };
}
