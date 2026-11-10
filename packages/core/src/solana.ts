// Solana constants shared by the Solana adapters and router (plain strings, no Solana deps here).

/**
 * Jito mainnet tip accounts. Any one works; picking one at random spreads write-lock contention.
 * The live list is also available from the block engine (`getTipAccounts`).
 *
 * The tip is a plain SystemProgram transfer that must be INSIDE the signed transaction, so the
 * chain adapters add it in `prepare` (before any signer, including asset keypairs, signs).
 * Place it before mint instructions: Core Candy Machine's botTax charges any mint that is not
 * the transaction's last instruction.
 */
export const JITO_TIP_ACCOUNTS: readonly string[] = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

export function pickJitoTipAccount(accounts: readonly string[] = JITO_TIP_ACCOUNTS, random: () => number = Math.random): string {
  const a = accounts[Math.floor(random() * accounts.length)];
  if (!a) throw new Error("no Jito tip accounts");
  return a;
}
