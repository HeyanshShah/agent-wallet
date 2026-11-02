# Changelog

## 1.1.0

Agent Wallet Cloud: anyone can sign up.

- **Hosted mode** (`HOSTED=1`): email and password accounts, one separate database per customer, agents routed by key, per-customer signing keys and public routes under `/t/<account>/`, one shared Lithic webhook routed by card, and account deletion.
- **Free early access** until the `FREE_UNTIL` date, shown on the sign-up screen and in the app.
- Push notifications now use per-wallet keys, so many wallets can share one server.
- The landing page has a "Start free" sign-up button and an early-access section.

## 1.0.0

Ready for real money.

- **Signed approvals.** Approved purchases include `approval_token`, an Ed25519-signed statement of who approved what and how (`auto`, `owner` or `owner_passkey`). Public keys at `/.well-known/jwks.json`, and `POST /verify` for stores. Agent Spend Protocol draft 0.2.
- **Real charges from Lithic.** `POST /webhooks/lithic` checks the webhook signature and timestamp, records each charge once, and alerts you if a used card is charged again.
- **Card details encrypted at rest** (AES-256-GCM, key from `WALLET_ENCRYPTION_KEY` or a key file), and deleted once a card is used. Existing databases are encrypted on first start.
- **Face ID locks your rules.** With a passkey set up, loosening rules, adding agents or changing security settings needs it. Pausing never does.
- **Tamper-evident activity log**, checked in the Activity tab.
- **Edit an agent's rules** in the app.
- Rate limits on failed sign-ins and purchase requests, a 64 KB body limit, security headers, and constant-time token checks.

## 0.3.0

Price checks, the launch kit, and the Agent Spend Protocol draft 0.1.

## 0.2.0

Scam radar, Face ID approvals, notification actions, Insights, and the OpenAPI spec.

## 0.1.0

Rules, phone approvals, one-time cards, and the MCP server.
