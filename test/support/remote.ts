import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { createServer } from "../../src/server.js";
import type { ApiConfig } from "../../src/api.js";

export interface Remote {
  url: string;
  hits: () => { total: number; unauthorized: number };
  close(): Promise<void>;
}

// A stand-in for the hosted server: the TypeScript reference server behind
// stateless Streamable HTTP, answering 401 to any other token, the way the
// hosted one does.
export async function startRemote(token: string, api: ApiConfig): Promise<Remote> {
  let total = 0;
  let unauthorized = 0;
  const http: HttpServer = createHttpServer(async (req, res) => {
    total++;
    if (req.headers.authorization !== `Bearer ${token}`) {
      unauthorized++;
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid token" }));
      return;
    }
    const server = createServer(api);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    hits: () => ({ total, unauthorized }),
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
  };
}
