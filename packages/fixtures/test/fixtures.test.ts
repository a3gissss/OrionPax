import { createPublicKey, sign, verify, createPrivateKey } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCAL_WALLETS_PATH,
  SOLANA_PROGRAMS,
  anvilDevAccounts,
  artifacts,
  assertLocalRpc,
  base58Decode,
  base58Encode,
  fundLocalWallets,
  generateSolanaKeypair,
  isLocalUrl,
  localEndpoints,
  solanaValidatorCloneArgs,
  solanaValidatorProgramArgs,
} from "../src/index.js";
// @ts-expect-error plain JS build script without type declarations
import { compileFixtures, OUT_FILE } from "../scripts/compile-contracts.mjs";

describe("anvilDevAccounts", () => {
  it("derives the well-known anvil accounts", () => {
    const accts = anvilDevAccounts(10);
    expect(accts).toHaveLength(10);
    expect(accts[0]!.address).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
    expect(accts[0]!.privateKey).toBe("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
    expect(accts[1]!.address).toBe("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
    expect(new Set(accts.map((a) => a.address)).size).toBe(10);
  });
  it("rejects bad n", () => {
    expect(() => anvilDevAccounts(0)).toThrow();
    expect(() => anvilDevAccounts(1.5)).toThrow();
  });
});

describe("local-only guard", () => {
  it("accepts local hosts and rejects public RPCs", () => {
    for (const u of ["http://127.0.0.1:8545", "http://localhost:8899", "http://[::1]:8545", "http://anvil.localhost", "http://x.test:1"]) {
      expect(isLocalUrl(u)).toBe(true);
    }
    for (const u of ["https://mainnet.base.org", "https://api.mainnet-beta.solana.com", "https://rpc.mainnet.chain.robinhood.com", "not a url"]) {
      expect(isLocalUrl(u)).toBe(false);
      expect(() => assertLocalRpc(u, {})).toThrow(/refuses non-local/);
    }
  });
  it("endpoints come from env with compose defaults", () => {
    expect(localEndpoints({}).base).toBe("http://127.0.0.1:8546");
    expect(localEndpoints({ E2E_BASE_RPC: "http://127.0.0.1:22346" }).base).toBe("http://127.0.0.1:22346");
    expect(localEndpoints({}).solanaWs).toBe("ws://127.0.0.1:8900");
  });
});

describe("base58", () => {
  it("round-trips and handles leading zeros", () => {
    const bytes = Uint8Array.from([0, 0, 1, 2, 3, 255]);
    expect(base58Decode(base58Encode(bytes))).toEqual(bytes);
    expect(base58Encode(new Uint8Array(32))).toBe("11111111111111111111111111111111"); // System Program
  });
  it("program ids decode to 32 bytes", () => {
    for (const id of Object.values(SOLANA_PROGRAMS)) expect(base58Decode(id)).toHaveLength(32);
  });
});

describe("solana keypairs", () => {
  it("produce solana-keygen format whose seed matches the public key", () => {
    const kp = generateSolanaKeypair();
    expect(kp.secretKey).toHaveLength(64);
    const pub = Buffer.from(kp.secretKey.slice(32));
    expect(base58Encode(pub)).toBe(kp.publicKey);
    // Rebuild a private key from the 32-byte seed (PKCS8 ed25519 prefix) and check sign/verify.
    const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(kp.secretKey.slice(0, 32))]);
    const priv = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
    const pubKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: pub.toString("base64url") }, format: "jwk" });
    const msg = Buffer.from("mint-engine");
    expect(verify(null, msg, pubKey, sign(null, msg, priv))).toBe(true);
  });
});

describe("solana validator args", () => {
  it("builds --upgradeable-program and clone flags", () => {
    const args = solanaValidatorProgramArgs("/programs/");
    expect(args).toContain("--upgradeable-program");
    expect(args).toContain(`/programs/mpl_core.so`);
    expect(args.filter((a) => a === "none")).toHaveLength(3);
    const clone = solanaValidatorCloneArgs();
    expect(clone.slice(0, 2)).toEqual(["--url", "devnet"]);
    expect(clone.filter((a) => a === "--clone-upgradeable-program")).toHaveLength(3);
  });
});

describe("fundLocalWallets (no chains)", () => {
  it("writes n throwaway wallets to the given path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fixtures-"));
    try {
      const path = join(dir, ".local-wallets.json");
      const res = await fundLocalWallets(3, { path });
      const file = JSON.parse(readFileSync(path, "utf8"));
      expect(file.wallets).toHaveLength(3);
      expect(file.wallets[0].evm.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(file.wallets[0].solana.secretKey).toHaveLength(64);
      expect(file.funded).toEqual({ evm: [], solana: null });
      expect(res.path).toBe(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("defaults to the gitignored repo-root fixtures/.local-wallets.json", () => {
    expect(DEFAULT_LOCAL_WALLETS_PATH.replace(/\\/g, "/")).toMatch(/\/fixtures\/\.local-wallets\.json$/);
    expect(DEFAULT_LOCAL_WALLETS_PATH.replace(/\\/g, "/")).not.toMatch(/packages\/fixtures\/fixtures/);
  });
  it("refuses to fund on public RPCs", async () => {
    await expect(fundLocalWallets(1, { path: join(tmpdir(), "never.json"), evmRpcUrls: ["https://mainnet.base.org"] })).rejects.toThrow(/refuses/);
  });
});

describe("contract artifacts", () => {
  it("expose the expected public-mint surfaces", () => {
    const fns = (abi: readonly { type: string; name?: string }[]) => abi.filter((x) => x.type === "function").map((x) => x.name);
    expect(fns(artifacts.FixtureERC721A.abi)).toEqual(expect.arrayContaining(["mint", "price", "maxPerWallet", "saleActive", "numberMinted", "setSaleActive"]));
    expect(artifacts.FixtureERC721A.abi.some((x) => x.type === "event" && x.name === "SaleStarted")).toBe(true);
    expect(fns(artifacts.BondingCurveLaunchpad.abi)).toEqual(expect.arrayContaining(["buy", "getBuyQuote", "isGraduated", "createToken"]));
    expect(fns(artifacts.Fixture1155.abi)).toEqual(expect.arrayContaining(["mint", "mintFee"]));
    expect(fns(artifacts.FixtureFixedPriceMinter.abi)).toEqual(expect.arrayContaining(["sale", "setSale", "requestMint"]));
    expect(artifacts.FixtureERC721A.bytecode.startsWith("0x60")).toBe(true);
  });
  it("checked-in artifacts match a fresh solc compile", () => {
    const fresh = compileFixtures() as string;
    expect(readFileSync(OUT_FILE as string, "utf8").replace(/\r\n/g, "\n")).toBe(fresh);
  }, 120_000);
});
