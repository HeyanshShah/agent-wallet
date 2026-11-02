# Connect any agent to Agent Wallet

First, create an agent in the approval app (**Agents → Add an agent**) and copy its key. Then pick the way your agent talks to tools.

## Claude Code

```bash
claude mcp add agent-wallet \
  -e WALLET_URL=https://your-wallet.example.com \
  -e WALLET_AGENT_KEY=aw_agent_... \
  -- npx -y -p github:HeyanshShah/agent-wallet agent-wallet-mcp
```

## Claude Desktop, Cursor, or any MCP client

```json
{
  "mcpServers": {
    "agent-wallet": {
      "command": "npx",
      "args": ["-y", "-p", "github:HeyanshShah/agent-wallet", "agent-wallet-mcp"],
      "env": {
        "WALLET_URL": "https://your-wallet.example.com",
        "WALLET_AGENT_KEY": "aw_agent_..."
      }
    }
  }
}
```

The agent gets `check_budget`, `request_purchase` and `get_purchase_status`. `request_purchase` waits up to 2 minutes for your tap. To change that, set `WALLET_APPROVAL_WAIT_SECONDS`.

## Any other agent (plain HTTP)

The spec is at `/openapi.json` on your server. Most agent frameworks (OpenAI tools, LangChain, custom GPT actions) can import it directly.

```python
import time, requests

WALLET = "https://your-wallet.example.com"
KEY = {"Authorization": "Bearer aw_agent_..."}

r = requests.post(f"{WALLET}/v1/purchases", headers=KEY, json={
    "amount_cents": 8900, "merchant": "Best Buy", "category": "electronics",
    "reason": "Noise-cancelling headphones for the flight",
}).json()

while r["status"] == "pending":          # waiting for the owner's tap
    time.sleep(2)
    r = requests.get(f"{WALLET}/v1/purchases/{r['id']}", headers=KEY).json()

if r.get("card"):
    pay_with(r["card"])                  # one-time card, capped at the approved amount
else:
    print(r["message"], r.get("decision_reason"))
```

```ts
const res = await fetch(`${WALLET}/v1/purchases`, {
  method: "POST",
  headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ amount_cents: 1999, merchant: "Amazon", reason: "Phone case" }),
});
const purchase = await res.json(); // status: auto_approved | pending | blocked
```

## Rules for agents

- Never retry a `blocked` or `denied` purchase with a different amount or store to get around the owner's rules.
- Read `risk_flags`. If one is `high`, tell the owner what you saw.
- Each card works **once**, for at most the approved amount. Ask again for the next purchase.
