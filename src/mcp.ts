// MCP server that lets an AI agent (Claude Desktop, Claude Code, or any MCP client)
// ask the wallet for money. Run it with WALLET_URL and WALLET_AGENT_KEY set.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const WALLET_URL = (process.env.WALLET_URL ?? "http://localhost:3000").replace(/\/$/, "");
const AGENT_KEY = process.env.WALLET_AGENT_KEY;
const WAIT_SECONDS = Number(process.env.WALLET_APPROVAL_WAIT_SECONDS ?? 120);

if (!AGENT_KEY) {
  console.error("WALLET_AGENT_KEY is not set. Create an agent in the approval app and paste its key.");
  process.exit(1);
}

async function call(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${WALLET_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${AGENT_KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok && res.status !== 403) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

const text = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

async function waitForDecision(id: string): Promise<any> {
  const deadline = Date.now() + WAIT_SECONDS * 1000;
  let data = await call("GET", `/v1/purchases/${id}`);
  while (data.status === "pending" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    data = await call("GET", `/v1/purchases/${id}`);
  }
  return data;
}

const server = new McpServer({ name: "agent-wallet", version: "0.1.0" });

server.registerTool(
  "check_budget",
  {
    title: "Check spending limits",
    description: "Shows this agent's spending rules and how much budget is left this month. Call this before planning a purchase.",
    inputSchema: {},
  },
  async () => text(await call("GET", "/v1/me")),
);

server.registerTool(
  "request_purchase",
  {
    title: "Request money for a purchase",
    description:
      "Ask the owner's wallet for a one-time card to pay for something. Small purchases may be approved instantly; " +
      "bigger ones wait for the owner to tap Approve on their phone (this tool waits for up to two minutes). " +
      "If approved, the result includes a card number, CVV and expiry that work once, for at most the approved amount. " +
      "If blocked or denied, do not try to get around the rules; tell the owner instead.",
    inputSchema: {
      amount_usd: z.number().positive().describe("Total price including tax and shipping, in US dollars"),
      merchant: z.string().describe("Store or website name, e.g. 'Amazon' or 'united.com'"),
      category: z.string().optional().describe("Kind of purchase, e.g. travel, groceries, electronics, software"),
      reason: z.string().describe("One sentence the owner will read: what you are buying and why"),
    },
  },
  async ({ amount_usd, merchant, category, reason }) => {
    const created = await call("POST", "/v1/purchases", {
      amount_cents: Math.round(amount_usd * 100),
      merchant,
      category,
      reason,
    });
    return text(created.status === "pending" ? await waitForDecision(created.id) : created);
  },
);

server.registerTool(
  "get_purchase_status",
  {
    title: "Check a purchase request",
    description: "Checks whether a pending purchase request was approved, and returns the card if it was.",
    inputSchema: { id: z.string().describe("The request id returned by request_purchase") },
  },
  async ({ id }) => text(await call("GET", `/v1/purchases/${id}`)),
);

await server.connect(new StdioServerTransport());
