// zod schemas mirroring the core request types.

import { z } from "zod";
import { CHAIN_FAMILY, MAX_WALLETS_PER_JOB, type ChainId, type CreateJobRequest } from "@mint-engine/core";

export const CHAIN_IDS = Object.keys(CHAIN_FAMILY) as [ChainId, ...ChainId[]];
const chainId = z.enum(CHAIN_IDS);
const decimal = z.string().regex(/^\d{1,78}$/, "must be a non-negative integer decimal string");
const nonEmpty = z.string().min(1).max(256);

const nftTarget = z
  .object({
    kind: z.literal("nft"),
    chain: chainId,
    address: nonEmpty,
    quantity: z.number().int().min(1).max(1000),
    style: z.enum(["core-candy-machine", "seadrop", "zora-1155", "erc721a", "custom"]).optional(),
    tokenId: z.string().max(80).optional(),
    customFunction: z.object({ signature: nonEmpty, args: z.array(z.unknown()).max(32) }).strict().optional(),
  })
  .strict();

const tokenTarget = z
  .object({
    kind: z.literal("token"),
    chain: chainId,
    tokenAddress: nonEmpty,
    launchpadAddress: nonEmpty,
    spendPerWallet: decimal,
    slippageBps: z.number().int().min(0).max(10_000),
  })
  .strict();

const fees = z
  .object({
    priorityFee: decimal.optional(),
    maxFee: decimal.optional(),
    jitoTip: decimal.optional(),
    maxTotalFee: decimal.optional(),
    privateSubmission: z.boolean().optional(),
  })
  .strict();

const posInt = z.number().int().nonnegative();
const trigger = z.discriminatedUnion("type", [
  z.object({ type: z.literal("now") }).strict(),
  z.object({ type: z.literal("time"), at: posInt }).strict(),
  z.object({ type: z.literal("state-poll"), intervalMs: z.number().int().min(50).max(3_600_000) }).strict(),
  z.object({ type: z.literal("event"), signature: z.string().max(256).optional() }).strict(),
  z.object({ type: z.literal("slot-or-block"), at: posInt }).strict(),
]);

export const createJobSchema = z
  .object({
    target: z.discriminatedUnion("kind", [nftTarget, tokenTarget]),
    walletIds: z
      .array(nonEmpty)
      .min(1)
      .max(MAX_WALLETS_PER_JOB)
      .refine((ids) => new Set(ids).size === ids.length, "walletIds must be unique"),
    fees,
    trigger,
    maxRetries: z.number().int().min(0).max(10).optional(),
  })
  .strict();

export const unlockSchema = z.object({ passphrase: z.string().min(1).max(1024) }).strict();

// Compile-time check that the schema output is assignable to the core type.
export type _CreateJobCheck = z.infer<typeof createJobSchema> extends CreateJobRequest ? true : never;
const _check: _CreateJobCheck = true;
void _check;

/** Issues as {path, message} only: never echo the received input. */
export function formatIssues(err: z.ZodError): Array<{ path: string; message: string }> {
  return err.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message }));
}
