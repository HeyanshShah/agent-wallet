# Agent Wallet

Spending rules, phone approvals and one-time cards for AI agents.

AI agents can now browse and check out, but handing one your real card is a bad idea. Agent Wallet sits between the agent and your money:

1. **You set rules per agent:** a monthly budget, a cap per purchase, allowed categories, blocked stores, and an auto-approve limit.
2. **The agent asks** through an MCP tool (`request_purchase`) or the REST API.
3. **The rules decide:** small purchases are approved instantly, bigger ones buzz your phone for a tap, and anything that breaks a rule is blocked.
4. **Approved purchases get a one-time card** locked to the approved amount. The agent never sees your real card.
5. **Everything is logged** in the Activity tab.

What makes it different:

- **Scam radar.** Every request is checked for lookalike stores (`amaz0n-deals.com`, `paypa1.com`), scam payment patterns (gift cards, crypto, wire transfers), double purchases, and amounts far above the agent's usual. A flagged purchase is never approved automatically, however small.
- **Face ID approvals.** With a passkey set up, risky purchases and anything over an amount you choose need Face ID or your fingerprint. A stolen password alone can't approve them.
- **One-tap from the notification.** On Android and desktop, approve or deny right from the push notification without opening the app.
- **Insights.** See spending by agent, category and store, the last 6 months, and how much money your rules stopped.
- **Works with any agent.** One-line install for Claude and any MCP client, plus an OpenAPI spec for everything else. See [docs/INTEGRATE.md](docs/INTEGRATE.md).

## Quick start

Requires Node.js 22.13 or newer.

```bash
npm install
cp .env.example .env
npm start
```

The first start prints an **owner token**. Open http://localhost:3000, paste the token, and you're in the approval app.

To see all three outcomes, run the demo in a second terminal and approve the $89 request when it appears:

```bash
OWNER_TOKEN=aw_owner_... npm run demo
```

Or run it without cloning:

```bash
npx github:HeyanshShah/agent-wallet
```

## Deploy (so your phone can reach it)

Phone notifications and Face ID need HTTPS. The easiest route is [Render](https://render.com/deploy?repo=https://github.com/HeyanshShah/agent-wallet), which reads `render.yaml`: it builds the Dockerfile, adds a disk for the database, and generates your `OWNER_TOKEN` (find it under the service's Environment tab). Set `PUBLIC_URL` to the address Render gives you.

Any Docker host works too:

```bash
docker build -t agent-wallet .
docker run -p 3000:3000 -v wallet-data:/data -e OWNER_TOKEN=pick-a-long-secret -e PUBLIC_URL=https://your-domain agent-wallet
```

## Connect Claude (or any MCP agent)

In the app, go to **Agents → Add an agent**. Copy the key it shows (it is only shown once). For Claude Code:

```bash
claude mcp add agent-wallet -e WALLET_URL=http://localhost:3000 -e WALLET_AGENT_KEY=aw_agent_... \
  -- npx -y -p github:HeyanshShah/agent-wallet agent-wallet-mcp
```

For Claude Desktop and other MCP clients, add this to the config (for example `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "agent-wallet": {
      "command": "npx",
      "args": ["-y", "-p", "github:HeyanshShah/agent-wallet", "agent-wallet-mcp"],
      "env": {
        "WALLET_URL": "http://localhost:3000",
        "WALLET_AGENT_KEY": "aw_agent_..."
      }
    }
  }
}
```

The agent gets three tools:

| Tool | What it does |
| --- | --- |
| `check_budget` | Shows the agent its rules and what's left this month |
| `request_purchase` | Asks for money. Waits up to 2 minutes for your tap, and returns a one-time card if approved |
| `get_purchase_status` | Checks on a request that was still pending |

## Phone notifications

The approval app is a PWA. On your phone, open the server's URL, then **Add to Home Screen**, open it from there, and tap **Notifications**. iPhone needs iOS 16.4 or newer, and push only works over HTTPS. For a quick test from your phone, put the server behind a tunnel such as `cloudflared tunnel --url http://localhost:3000` or ngrok, and set `PUBLIC_URL` to the tunnel's address.

On Android and desktop Chrome, the notification has **Approve** and **Deny** buttons. iPhone doesn't support notification buttons, so tapping the notification opens the app. Purchases that need Face ID always open the app.

## Face ID approvals

Go to **Agents → Set up Face ID**. Once a passkey is set up, risky purchases always need it, and you can also require it over an amount. Passkeys are tied to the server's address, so set `PUBLIC_URL` to the exact URL you open the app at.

## Cards

| `CARD_ISSUER` | What happens |
| --- | --- |
| `mock` (default) | Fake, Luhn-valid test cards. No money moves. `POST /v1/cards/:id/charge` pretends to be a store charging the card |
| `lithic` | Real virtual cards from [Lithic](https://lithic.com). Use the sandbox key and `LITHIC_BASE_URL=https://sandbox.lithic.com` first. Cards are `SINGLE_USE` with a per-transaction limit equal to the approved amount |

> **Before real money:** the Lithic connector has not been tested against a live account yet, and card numbers are stored in the local database for convenience. Before going live, stop storing card numbers (fetch them from Lithic when needed), add Lithic webhooks to record charges, and put the server behind HTTPS.

## API

Agent endpoints use `Authorization: Bearer <agent key>`:

- `GET /v1/me`: the agent's rules and remaining budget
- `POST /v1/purchases` `{ amount_cents, merchant, category?, reason }`: returns `auto_approved` (with `card`), `pending`, or `blocked` (HTTP 403)
- `GET /v1/purchases/:id`: poll a request. `card` appears once it's approved

Owner endpoints use `Authorization: Bearer <owner token>`:

- `GET/POST /api/agents`, `PATCH /api/agents/:id`
- `GET /api/requests?status=pending`, `POST /api/requests/:id/approve`, `POST /api/requests/:id/deny`
- `GET /api/events` (activity log), `GET /api/insights`, `GET /api/stream` (live updates over SSE)
- `GET/PATCH /api/settings`, `POST /api/passkeys/register/options`, `POST /api/passkeys/register/verify`, `POST /api/requests/:id/approve/options`

The full agent API is described in [`public/openapi.json`](public/openapi.json), which is also served at `/openapi.json`.

## How the rules work

The rule checks run in this order, and the first one that fails blocks the purchase: agent paused → blocked store → category not allowed → over the per-purchase cap → over the remaining monthly budget. If none fail, the purchase is auto-approved when it's at or under the auto-approve limit; otherwise it waits for you. When you tap Approve, the rules run again, so a budget you lowered in the meantime still applies. Unanswered requests expire after 15 minutes.

Risk checks run alongside the rules, in [`src/risk.ts`](src/risk.ts). They never block a purchase on their own. Instead they make sure you see it, with the warning, and that big ones need Face ID.

Both are pure functions, so they're easy to test and change.

## Development

```bash
npm test          # rules + API tests
npm run typecheck
npm run dev       # restart on changes
```

| File | What's in it |
| --- | --- |
| `src/rules.ts` | Rules engine |
| `src/risk.ts` | Scam and anomaly checks |
| `src/passkeys.ts` | Face ID / fingerprint approvals |
| `src/wallet.ts` | Agents, requests, approvals, cards, activity log |
| `src/cards.ts` | Mock and Lithic card issuers |
| `src/app.ts` | HTTP API |
| `src/mcp.ts` | MCP server for agents |
| `src/notify.ts` | Live updates and web push |
| `public/` | The approval app |

## Next steps

- Lithic webhooks for real charge events, and merchant-locked cards
- Price checks before you approve ("this is $20 cheaper elsewhere")
- Require Face ID to change rules, not just to approve
- Multiple users with real sign-in
- Signed approvals that work with Google AP2, Visa Intelligent Commerce and Mastercard Agent Pay
