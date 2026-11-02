// Encrypts secrets at rest (card numbers, CVVs, the approval signing key) with AES-256-GCM.
// A copied database file alone is useless without the key, which lives outside it.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const PREFIX = "enc:v1:";

export class Vault {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error("The encryption key must be 32 bytes.");
  }

  /** A throwaway key, for tests and in-memory databases. */
  static ephemeral(): Vault {
    return new Vault(randomBytes(32));
  }

  /**
   * Uses WALLET_ENCRYPTION_KEY (64 hex characters or base64) when set. Otherwise reads, or creates,
   * a key file next to the database, readable only by this user.
   */
  static fromEnv(env: NodeJS.ProcessEnv, databasePath: string): Vault {
    const fromEnv = env.WALLET_ENCRYPTION_KEY?.trim();
    if (fromEnv) return new Vault(parseKey(fromEnv));
    if (databasePath === ":memory:") return Vault.ephemeral();
    const keyPath = env.WALLET_KEY_FILE ?? `${dirname(databasePath)}/wallet.key`;
    if (existsSync(keyPath)) return new Vault(parseKey(readFileSync(keyPath, "utf8").trim()));
    mkdirSync(dirname(keyPath), { recursive: true });
    const key = randomBytes(32);
    writeFileSync(keyPath, key.toString("hex") + "\n", { mode: 0o600 });
    chmodSync(keyPath, 0o600);
    console.log(`  Created an encryption key at ${keyPath}. Back it up: without it, stored card details can't be read.`);
    return new Vault(key);
  }

  static isEncrypted(value: string): boolean {
    return value.startsWith(PREFIX);
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
  }

  decrypt(value: string): string {
    if (!Vault.isEncrypted(value)) return value; // Written before encryption existed.
    const raw = Buffer.from(value.slice(PREFIX.length), "base64url");
    const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  }
}

function parseKey(s: string): Buffer {
  const key = /^[0-9a-f]{64}$/i.test(s) ? Buffer.from(s, "hex") : Buffer.from(s, "base64");
  if (key.length !== 32) throw new Error("WALLET_ENCRYPTION_KEY must be 32 bytes, as 64 hex characters or base64.");
  return key;
}
