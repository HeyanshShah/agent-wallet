// Passkeys let the owner approve with Face ID, Touch ID or a fingerprint.
// Big or risky purchases can require one, so a stolen owner token alone can't approve them.
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { type Db, getSetting, setSetting } from "./db.js";

const CHALLENGE_TTL_MS = 5 * 60_000;

export interface PasskeyConfig {
  rpID: string;
  rpName: string;
  origin: string;
}

export function passkeyConfigFromUrl(publicUrl: string): PasskeyConfig {
  const url = new URL(publicUrl);
  return { rpID: url.hostname, rpName: "Agent Wallet", origin: url.origin };
}

export class Passkeys {
  private readonly challenges = new Map<string, { challenge: string; expires: number }>();

  constructor(
    private readonly db: Db,
    private readonly config: PasskeyConfig,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS passkeys (
      id TEXT PRIMARY KEY,
      public_key TEXT NOT NULL,
      counter INTEGER NOT NULL,
      transports TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    )`);
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM passkeys").get() as { n: number }).n;
  }

  /** Purchases above this amount need a passkey. Undefined means the check is off. */
  get requiredOverCents(): number | undefined {
    const v = getSetting(this.db, "passkey_required_over_cents");
    return v === undefined || v === "" ? undefined : Number(v);
  }

  set requiredOverCents(cents: number | undefined) {
    setSetting(this.db, "passkey_required_over_cents", cents === undefined ? "" : String(cents));
  }

  /** Big purchases (over the threshold) and risky ones need a passkey, once one is set up. */
  isRequired(amountCents: number, highRisk: boolean): boolean {
    if (this.count() === 0) return false;
    const over = this.requiredOverCents;
    return highRisk || (over !== undefined && amountCents > over);
  }

  private remember(key: string, challenge: string) {
    this.challenges.set(key, { challenge, expires: Date.now() + CHALLENGE_TTL_MS });
  }

  private take(key: string): string | undefined {
    const entry = this.challenges.get(key);
    this.challenges.delete(key);
    return entry && entry.expires > Date.now() ? entry.challenge : undefined;
  }

  private credentials() {
    return (this.db.prepare("SELECT id, public_key, counter, transports FROM passkeys").all() as any[]).map((r) => ({
      id: r.id as string,
      publicKey: new Uint8Array(Buffer.from(r.public_key, "base64")),
      counter: r.counter as number,
      transports: JSON.parse(r.transports),
    }));
  }

  async registrationOptions() {
    const options = await generateRegistrationOptions({
      rpName: this.config.rpName,
      rpID: this.config.rpID,
      userName: "owner",
      userDisplayName: "Agent Wallet owner",
      attestationType: "none",
      excludeCredentials: this.credentials().map((c) => ({ id: c.id, transports: c.transports })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    });
    this.remember("register", options.challenge);
    return options;
  }

  async verifyRegistration(response: RegistrationResponseJSON): Promise<boolean> {
    const challenge = this.take("register");
    if (!challenge) return false;
    const result = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: this.config.origin,
      expectedRPID: this.config.rpID,
      requireUserVerification: true,
    }).catch(() => undefined);
    if (!result?.verified) return false;
    const { credential } = result.registrationInfo;
    this.db
      .prepare("INSERT INTO passkeys (id, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(
        credential.id,
        Buffer.from(credential.publicKey).toString("base64"),
        credential.counter,
        JSON.stringify(credential.transports ?? []),
        new Date().toISOString(),
      );
    return true;
  }

  /** `purpose` binds the challenge to one action, e.g. approving one request. */
  async authenticationOptions(purpose: string) {
    const options = await generateAuthenticationOptions({
      rpID: this.config.rpID,
      allowCredentials: this.credentials().map((c) => ({ id: c.id, transports: c.transports })),
      userVerification: "required",
    });
    this.remember(`auth:${purpose}`, options.challenge);
    return options;
  }

  async verifyAuthentication(purpose: string, response: AuthenticationResponseJSON): Promise<boolean> {
    const challenge = this.take(`auth:${purpose}`);
    const credential = this.credentials().find((c) => c.id === response?.id);
    if (!challenge || !credential) return false;
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: this.config.origin,
      expectedRPID: this.config.rpID,
      credential,
      requireUserVerification: true,
    }).catch(() => undefined);
    if (!result?.verified) return false;
    this.db.prepare("UPDATE passkeys SET counter = ? WHERE id = ?").run(result.authenticationInfo.newCounter, credential.id);
    return true;
  }
}
