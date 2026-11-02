# Agent Spend Protocol (draft 0.2)

An open, vendor-neutral way for an AI agent to ask a person's wallet for money, and for the wallet to answer with a decision and a payment credential.

Agent Wallet is the reference implementation. Anyone can implement either side: an agent framework, a bank, a card issuer, or a password manager.

## Why

Agents can browse and check out, but there is no common way for an agent to ask "may I spend $89 at Best Buy?" and get a safe answer back. Today each payment network and each agent vendor builds its own path. The result is that people either hand agents their real card or get locked into one company's ecosystem.

This protocol covers only the conversation between an **agent** and the **wallet** that acts for one **owner** (a person or team). How the wallet then pays, whether through a virtual card, a network token, Google AP2 mandates, Visa Intelligent Commerce, Mastercard Agent Pay or stablecoins, is a credential type the wallet advertises. That lets the protocol sit on top of any payment rail instead of competing with it.

## Roles

- **Owner:** the person whose money it is. Sets the rules and approves.
- **Agent:** software acting for the owner. Holds an agent key, never the owner's payment details.
- **Wallet:** the service holding the rules. It decides, asks the owner when needed, and issues credentials.

## Discovery

A wallet publishes `GET /.well-known/agent-spend`:

```json
{
  "protocol": "agent-spend",
  "version": "0.2",
  "issuer": "https://wallet.example",
  "purchases_endpoint": "https://wallet.example/v1/purchases",
  "limits_endpoint": "https://wallet.example/v1/me",
  "openapi": "https://wallet.example/openapi.json",
  "jwks_uri": "https://wallet.example/.well-known/jwks.json",
  "verify_endpoint": "https://wallet.example/verify",
  "auth": ["bearer"],
  "credential_types": ["one_time_card"],
  "approval_token_type": "agent-spend-approval+jwt",
  "features": ["risk_flags", "price_check", "idempotency", "owner_approval", "passkey_approval", "signed_approvals"]
}
```

## Authentication

Each agent gets its own key from the owner, sent as `Authorization: Bearer <key>`. One key per agent means the owner can pause or limit each agent separately, and the log shows which agent did what. Keys must never be the owner's own credentials.

## Requesting a purchase

`POST {purchases_endpoint}`, optionally with an `Idempotency-Key` header. A retry with the same key must return the original request and must not create a second one.

```json
{
  "amount_cents": 8900,
  "merchant": "Best Buy",
  "category": "electronics",
  "reason": "Noise-cancelling headphones for your flight",
  "product": "Sony WH-CH720N headphones",
  "product_url": "https://www.bestbuy.com/..."
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `amount_cents` | yes | Total in the wallet's currency (USD in 0.1), including tax and shipping |
| `merchant` | yes | Store name or domain, as the agent will pay it |
| `reason` | yes | One sentence written for the owner to read |
| `category` | no | Free text, e.g. `travel`, `groceries`. Wallets may enforce allowed categories |
| `product`, `product_url` | no | Enables price checks |

## Responses

Every response has the same shape, and `status` says what happens next:

| `status` | HTTP | Meaning | Agent should |
| --- | --- | --- | --- |
| `auto_approved` | 201 | Within rules, approved instantly | Pay with `credential` |
| `pending` | 201 | Waiting for the owner | Poll `GET {purchases_endpoint}/{id}` (2 s or slower) until it changes or `expires_at` passes |
| `approved` | 200 | Owner approved | Pay with `credential` |
| `denied` | 200 | Owner said no | Stop. Don't retry without asking the owner |
| `blocked` | 403 | Against the owner's rules | Stop. **Never** retry with a different amount, merchant or category to get around a rule |
| `expired` | 200 | Owner didn't answer in time | Ask the owner before trying again |
| `completed` | 200 | Credential was charged | Nothing |

```json
{
  "id": "4f1c…",
  "status": "approved",
  "amount_cents": 8900,
  "merchant": "Best Buy",
  "decision_reason": "Approved by you.",
  "risk_flags": [{ "level": "info", "code": "new_merchant", "message": "First purchase at Best Buy." }],
  "cheaper_option": { "merchant": "Target", "price": "$72.98", "savings": "$16.02" },
  "message": "Approved. Use the one-time card below for this purchase only.",
  "approval_token": "eyJhbGciOiJFZERTQSIs…",
  "card": { "number": "4000…", "cvv": "123", "exp_month": 11, "exp_year": 2027, "limit": "$89.00" }
}
```

The credential is the `card` object (type `one_time_card`). A later draft will generalize it to `credential: { type, ... }`, so wallets can return network tokens instead.

## Signed approvals (new in 0.2)

An approved response includes `approval_token`: a compact JWS with header `{ "alg": "EdDSA", "typ": "agent-spend-approval+jwt", "kid": "…" }`, signed with an Ed25519 key published at `jwks_uri`. Its claims:

| Claim | Meaning |
| --- | --- |
| `iss` | The wallet's `issuer` |
| `sub` | The agent the money was approved for |
| `jti` | The purchase request id |
| `amount` | `{ "value": <cents>, "currency": "USD" }`, the most that was approved |
| `merchant` | The store it was approved for |
| `approval` | `auto` (within the owner's rules), `owner` (the owner tapped Approve) or `owner_passkey` (the owner approved with a passkey) |
| `risk` | Risk codes the owner was shown, if any |
| `card_last4` | Last four digits of the one-time card, so the payment can be matched to the approval |
| `iat`, `exp` | Issued and expiry times (seconds). Wallets should keep `exp` within 24 hours |

This lets a party that doesn't trust the agent, such as a store, a bank or a payment network, check that a real person's wallet approved this exact purchase, and how strongly. Verifiers must check the signature, `typ`, `exp`, and that `amount` and `merchant` match the payment. Wallets should also offer `POST {verify_endpoint}` with `{ "token": "…" }`, answering `{ "valid": true, "claims": {…} }` or `{ "valid": false, "error": "…" }`.

The claims deliberately mirror what card network agent programs and Google AP2 mandates carry (who, how much, where, and proof of user presence), so a wallet can translate one into the other.

### Risk flags

Wallets should explain why a purchase looks risky, so agents and owners see the same thing:

| `level` | Meaning | Wallet must |
| --- | --- | --- |
| `high` | Likely scam (lookalike store, gift card or crypto payment) | Never auto-approve |
| `medium` | Unusual (duplicate, far above typical spend) | Show the owner |
| `info` | Context (first purchase at this store) | Nothing |

Codes defined so far: `lookalike_merchant`, `scam_pattern`, `duplicate`, `unusual_amount`, `new_merchant`. Unknown codes must be ignored.

## Requirements for wallets

1. **Credentials are single-use and capped** at the approved amount.
2. **Rules are re-checked at approval time.** A budget lowered while a request waits still applies.
3. **High-risk requests always reach the owner**, whatever the auto-approve limit.
4. **The owner sees what the agent wrote.** The `reason` is shown verbatim, never rewritten.
5. **Everything is logged** and visible to the owner.
6. **Strong approval for big amounts.** Wallets should support passkey (WebAuthn) confirmation for large or risky approvals, bound to the specific request.
7. **Rules are protected as strongly as approvals.** If approving needs a passkey, so does loosening the rules. Pausing an agent must stay one step.
8. **Payment details are protected at rest** and deleted once a credential can no longer be used.

## Limits

`GET {limits_endpoint}` returns the agent's own rules and remaining budget, so it can plan before asking:

```json
{ "monthly_budget": "$500.00", "remaining_this_month": "$411.00", "per_purchase_cap": "$300.00", "auto_approve_up_to": "$25.00", "allowed_categories": "any" }
```

## Status

This is a draft. Feedback is welcome as issues on [github.com/HeyanshShah/agent-wallet](https://github.com/HeyanshShah/agent-wallet).

Changes in 0.2: signed approvals (`approval_token`, `jwks_uri`, `verify_endpoint`) and wallet requirements 7 and 8. Fully compatible with 0.1 agents, which can ignore the new fields.

Planned for 0.3:

- Generalized `credential` types: `network_token`, `ap2_mandate`, `stablecoin`
- Webhooks to agents instead of polling
- Multi-currency amounts
