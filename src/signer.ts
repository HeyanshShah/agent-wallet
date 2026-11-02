// Signed approvals: every approved purchase comes with a short token, signed by this wallet,
// that says who approved what. A store, bank or payment network can check it offline against
// the wallet's public key at /.well-known/jwks.json, without trusting the agent.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { type Db, getSetting, setSetting } from "./db.js";
import type { Vault } from "./vault.js";

export const APPROVAL_TOKEN_TYPE = "agent-spend-approval+jwt";

export type ApprovalMethod = "auto" | "owner" | "owner_passkey";

export interface ApprovalClaims {
  iss: string;
  /** The agent the money was approved for. */
  sub: string;
  /** The purchase request id. */
  jti: string;
  iat: number;
  exp: number;
  amount: { value: number; currency: "USD" };
  merchant: string;
  approval: ApprovalMethod;
  /** Risk codes the owner was shown before approving. */
  risk?: string[];
  /** Last four digits of the one-time card, so a store can match the token to the payment. */
  card_last4?: string;
}

export interface Jwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  kid: string;
  alg: "EdDSA";
  use: "sig";
}

const b64url = (data: Buffer | string) => Buffer.from(data).toString("base64url");

export class ApprovalSigner {
  private readonly privateKey: KeyObject;
  readonly jwk: Jwk;

  constructor(db: Db, vault: Vault) {
    let stored = getSetting(db, "approval_signing_key");
    if (!stored) {
      const { privateKey } = generateKeyPairSync("ed25519");
      stored = vault.encrypt(privateKey.export({ type: "pkcs8", format: "pem" }).toString());
      setSetting(db, "approval_signing_key", stored);
    }
    this.privateKey = createPrivateKey(vault.decrypt(stored));
    const x = createPublicKey(this.privateKey).export({ format: "jwk" }).x!;
    this.jwk = { kty: "OKP", crv: "Ed25519", x, kid: createHash("sha256").update(x).digest("base64url").slice(0, 16), alg: "EdDSA", use: "sig" };
  }

  sign(claims: ApprovalClaims): string {
    const header = b64url(JSON.stringify({ alg: "EdDSA", typ: APPROVAL_TOKEN_TYPE, kid: this.jwk.kid }));
    const body = b64url(JSON.stringify(claims));
    const signature = sign(null, Buffer.from(`${header}.${body}`), this.privateKey);
    return `${header}.${body}.${b64url(signature)}`;
  }
}

export type VerifyResult = { valid: true; claims: ApprovalClaims } | { valid: false; error: string };

/**
 * Checks an approval token against a wallet's published keys. Has no dependencies on the rest
 * of Agent Wallet, so stores can copy it as is.
 */
export function verifyApproval(token: string, jwks: { keys: Jwk[] }, now = Date.now()): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 3) return { valid: false, error: "Not a signed token." };
  let header: any;
  let claims: ApprovalClaims;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  } catch {
    return { valid: false, error: "Token can't be read." };
  }
  if (header.alg !== "EdDSA" || header.typ !== APPROVAL_TOKEN_TYPE) return { valid: false, error: "Not an approval token." };
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) return { valid: false, error: "Signed with an unknown key." };
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: jwk.x }, format: "jwk" });
  const ok = verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], "base64url"));
  if (!ok) return { valid: false, error: "Signature doesn't match." };
  if (claims.exp * 1000 < now) return { valid: false, error: "Approval has expired." };
  return { valid: true, claims };
}
