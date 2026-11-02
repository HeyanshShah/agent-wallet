// Lithic sends card transaction events as webhooks, signed the Svix way
// (https://docs.svix.com/receiving/verifying-payloads/how-manual). This is how real charges reach the wallet.
import { createHmac, timingSafeEqual } from "node:crypto";

const TOLERANCE_SECONDS = 5 * 60;

export function verifyWebhookSignature(
  secret: string,
  headers: { id?: string; timestamp?: string; signature?: string },
  body: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > TOLERANCE_SECONDS) return false;
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest();
  // The header can hold several signatures ("v1,<sig> v1,<sig>") while secrets rotate.
  return signature.split(" ").some((part) => {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) return false;
    const given = Buffer.from(sig, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

export interface CardCharge {
  transactionToken: string;
  cardToken: string;
  amountCents: number;
  merchant: string;
}

/**
 * Pulls an approved charge out of a Lithic transaction event. Returns undefined for anything else
 * (declines, voids, other event types), which the wallet just acknowledges.
 */
export function chargeFromLithicEvent(event: any): CardCharge | undefined {
  const type: string = event?.event_type ?? "";
  if (!/^(card_transaction|transaction)\.(created|updated)$/.test(type)) return undefined;
  const tx = event.payload ?? event;
  if (!tx?.card_token || !tx?.token) return undefined;
  if (tx.result && tx.result !== "APPROVED") return undefined;
  if (!["PENDING", "SETTLED"].includes(tx.status)) return undefined;
  const amount = Number(tx.authorization_amount ?? tx.amount ?? tx.settled_amount);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  return {
    transactionToken: String(tx.token),
    cardToken: String(tx.card_token),
    amountCents: Math.round(amount),
    merchant: String(tx.merchant?.descriptor ?? "the store").trim(),
  };
}
