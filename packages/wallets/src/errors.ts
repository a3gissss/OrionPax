// Error types for the wallet vault. Messages never include secret material,
// passphrases, or raw user-supplied key input.

export class VaultError extends Error {
  constructor(message: string, readonly code: VaultErrorCode) {
    super(message);
    this.name = "VaultError";
  }
}

export type VaultErrorCode =
  | "WRONG_PASSPHRASE"
  | "LOCKED"
  | "VAULT_FULL"
  | "NOT_FOUND"
  | "DUPLICATE"
  | "INVALID_KEY"
  | "INVALID_INPUT"
  | "CORRUPT"
  | "EXISTS"
  | "FAMILY_MISMATCH"
  | "SIGNING"
  | "RPC";

export class WrongPassphraseError extends VaultError {
  constructor() {
    super("Incorrect passphrase: unable to decrypt the wallet keystore (or the file was modified)", "WRONG_PASSPHRASE");
    this.name = "WrongPassphraseError";
  }
}

export class VaultLockedError extends VaultError {
  constructor() {
    super("Wallet vault is locked; unlock it with the passphrase first", "LOCKED");
    this.name = "VaultLockedError";
  }
}
