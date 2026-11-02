#!/usr/bin/env node
// Starts the Agent Wallet server: `npx github:HeyanshShah/agent-wallet`
import { register } from "tsx/esm/api";

register();
await import("../src/server.ts");
