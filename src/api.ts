export interface ApiConfig {
  baseUrl: string;
  token: string;
  storeId: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | undefined>;

// Thin client for the Kustomer Suite REST API. Every response is wrapped as
// {success, data} or {success: false, error}.
export class KustomerApi {
  private readonly base: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly cfg: ApiConfig) {
    this.base = cfg.baseUrl.replace(/\/+$/, "");
    this.doFetch = cfg.fetch ?? fetch;
  }

  get storeId(): string {
    return this.cfg.storeId;
  }

  get<T>(path: string, query: Query = {}): Promise<T> {
    return this.request<T>("GET", path, query);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, {}, body);
  }

  private async request<T>(method: string, path: string, query: Query, body?: unknown): Promise<T> {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const res = await this.doFetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.cfg.token}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 15_000),
    });
    let payload: { success?: boolean; data?: T; error?: string } = {};
    try {
      payload = (await res.json()) as typeof payload;
    } catch {
      // A non-JSON body (proxy error page) is reported by status below.
    }
    if (!res.ok || payload.success === false) {
      throw new ApiError(res.status, payload.error ?? `HTTP ${res.status}`);
    }
    return payload.data as T;
  }
}
