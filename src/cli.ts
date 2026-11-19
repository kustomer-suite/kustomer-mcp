#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig } from "./config.js";
import { createProxy, ProxyError } from "./proxy.js";

try {
  const proxy = await createProxy(loadConfig(process.env));
  await proxy.server.connect(new StdioServerTransport());
} catch (err) {
  console.error(`kustomersuite-mcp: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(err instanceof ProxyError ? 2 : 1);
}
