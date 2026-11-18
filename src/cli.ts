#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createServer } from "./server.js";

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`kustomer-mcp: ${name} is not set`);
    process.exit(1);
  }
  return v;
}

const server = createServer({
  baseUrl: required("KUSTOMER_API_URL"),
  token: required("KUSTOMER_TOKEN"),
  storeId: required("KUSTOMER_STORE_ID"),
});
await server.connect(new StdioServerTransport());
