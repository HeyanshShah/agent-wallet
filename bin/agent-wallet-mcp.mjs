#!/usr/bin/env node
// MCP server for agents: `npx -y -p github:HeyanshShah/agent-wallet agent-wallet-mcp`
import { register } from "tsx/esm/api";

register();
await import("../src/mcp.ts");
