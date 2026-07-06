import type { TokenManager } from "./auth.js";

const API_BASE = "https://m.np.playstation.com/api";

export class PsnApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "PsnApiError";
  }
}

export interface RequestOptions {
  method?: "GET" | "POST";
  /** Query string parameters; undefined values are dropped. */
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON body for POST requests. */
  body?: unknown;
  /** Extra headers merged over the defaults. */
  headers?: Record<string, string>;
}

/** Authenticated JSON client for the m.np.playstation.com API. */
export class PsnHttpClient {
  constructor(private readonly tokens: TokenManager) {}

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const accessToken = await this.tokens.getAccessToken();

    const url = new URL(`${API_BASE}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const res = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Accept-Language": "en-US",
        ...(options.body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
        ...options.headers,
      },
      body:
        options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });

    if (!res.ok) {
      let body: unknown;
      let message = `PSN API request to ${path} failed with HTTP ${res.status}`;
      try {
        body = await res.json();
        const err = (body as { error?: { message?: string } }).error;
        if (err?.message) message += `: ${err.message}`;
      } catch {
        // Non-JSON error body; keep the generic message.
      }
      if (res.status === 403) {
        message +=
          ". The target profile may be private, or your account may not be allowed to view it.";
      }
      throw new PsnApiError(message, res.status, body);
    }

    // A few endpoints return 204 / empty bodies.
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }
}
