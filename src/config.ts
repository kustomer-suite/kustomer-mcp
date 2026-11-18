// The hosted server is the only endpoint: it is a constant, not a setting, so a
// token can never be sent to a host the user typed (or a typo'd, or hostile) URL.
export const ENDPOINT = "https://mcp.kustomersuite.com/mcp";
export const TOKEN_PREFIX = "ksm_";

export interface ProxyConfig {
  token: string;
  endpoint: string;
}

// The token is the only input. It is bound to one store on the server, so the
// store is not configured here either.
export function loadConfig(env: NodeJS.ProcessEnv): ProxyConfig {
  const token = env.KUSTOMER_TOKEN?.trim();
  if (!token) throw new Error("KUSTOMER_TOKEN is not set");
  if (!token.startsWith(TOKEN_PREFIX)) {
    throw new Error(`KUSTOMER_TOKEN is not a Kustomer Suite MCP token (they start with ${TOKEN_PREFIX})`);
  }
  return { token, endpoint: ENDPOINT };
}
