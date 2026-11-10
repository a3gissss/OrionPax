// @mint-engine/fixtures: reusable LOCAL-ONLY test fixtures (EVM contracts, Solana programs, throwaway wallets).
export { localEndpoints, isLocalUrl, assertLocalRpc, type LocalEndpoints } from "./env.js";
export {
  ANVIL_MNEMONIC,
  ANVIL_FUNDED_ACCOUNTS,
  anvilDevAccounts,
  deployEvmFixtures,
  setErc721aSaleActive,
  setEvmBalance,
  evmChain,
  evmClients,
  fixtureAbis,
  type DevAccount,
  type EvmClients,
  type EvmFixtureOptions,
  type EvmFixtures,
} from "./evm.js";
export { fundLocalWallets, DEFAULT_LOCAL_WALLETS_PATH, type FundOptions, type LocalWallet, type LocalWalletsFile } from "./wallets.js";
export {
  SOLANA_PROGRAMS,
  SOLANA_PROGRAM_FILES,
  startSolanaFixtures,
  solanaValidatorProgramArgs,
  solanaValidatorCloneArgs,
  type SolanaFixtures,
  type SolanaProgramName,
} from "./solana/fixtures.js";
export { generateSolanaKeypair, solanaRpc, getSolanaBalance, airdropAndConfirm, waitForSolanaValidator, type SolanaKeypair } from "./solana/rpc.js";
export { base58Encode, base58Decode } from "./solana/base58.js";
export * as artifacts from "./artifacts.generated.js";
