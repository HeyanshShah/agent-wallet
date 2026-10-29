# Agent Wallet

Spending rules, phone approvals and one-time cards for AI agents.

AI agents can now browse and check out, but handing one your real card is a bad idea. Agent Wallet sits between the agent and your money:

1. **You set rules per agent:** a monthly budget, a cap per purchase, allowed categories, blocked stores, and an auto-approve limit.
2. **The agent asks** through an MCP tool (`request_purchase`) or the REST API.
3. **The rules decide:** small purchases are approved instantly, bigger ones buzz your phone for a tap, and anything that breaks a rule is blocked.
4. **Approved purchases get a one-time card** locked to the approved amount. The agent never sees your real card.
5. **Everything is logged** in the Activity tab.

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

## Connect Claude (or any MCP agent)

In the app, go to **Agents → Add an agent**. Copy the key it shows (it is only shown once), then add this to your MCP client config, for example `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "agent-wallet": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/agent-wallet/src/mcp.ts"],
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

The approval app is a PWA. On your phone, open the server's URL, then **Add to Home Screen**, open it from there, and tap **Notifications**. iPhone needs iOS 16.4 or newer, and push only works over HTTPS. For a quick test from your phone, put the server behind a tunnel such as `cloudflared tunnel --url http://localhost:3000` or ngrok.

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
- `GET /api/events` (activity log), `GET /api/stream` (live updates over SSE)

## How the rules work

The checks run in this order, and the first one that fails blocks the purchase: agent paused → blocked store → category not allowed → over the per-purchase cap → over the remaining monthly budget. If none fail, the purchase is auto-approved when it's at or under the auto-approve limit; otherwise it waits for you. When you tap Approve, the rules run again, so a budget you lowered in the meantime still applies. Unanswered requests expire after 15 minutes.

The logic lives in [`src/rules.ts`](src/rules.ts) as one pure function.

## Development

```bash
npm test          # rules + API tests
npm run typecheck
npm run dev       # restart on changes
```

| File | What's in it |
| --- | --- |
| `src/rules.ts` | Rules engine |
| `src/wallet.ts` | Agents, requests, approvals, cards, activity log |
| `src/cards.ts` | Mock and Lithic card issuers |
| `src/app.ts` | HTTP API |
| `src/mcp.ts` | MCP server for agents |
| `src/notify.ts` | Live updates and web push |
| `public/` | The approval app |

## Next steps

- Lithic webhooks for real charge events, and merchant-locked cards
- A native Expo app with Face ID approval
- Multiple users with real sign-in
- Signed approvals that work with Google AP2, Visa Intelligent Commerce and Mastercard Agent Pay
