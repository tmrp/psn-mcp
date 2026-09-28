import type { TokenManager } from "./auth.js";

const API_BASES = {
  mobile: "https://m.np.playstation.com/api",
  web: "https://web.np.playstation.com/api",
};

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
  /** Sony API host; account REST endpoints use mobile, library GraphQL uses web. */
  api?: keyof typeof API_BASES;
  method?: "GET" | "POST";
  /** Query string parameters; undefined values are dropped. */
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON body for POST requests. */
  body?: unknown;
  /** Extra headers merged over the defaults. */
  headers?: Record<string, string>;
}

/** Authenticated JSON client for Sony's mobile and web APIs. */
export class PsnHttpClient {
  constructor(private readonly tokens: TokenManager) {}

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const accessToken = await this.tokens.getAccessToken();

    const url = new URL(`${API_BASES[options.api ?? "mobile"]}${path}`);
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
        const errorBody = body as {
          error?: { message?: unknown };
          errors?: { message?: unknown }[];
        };
        const restMessage = errorBody?.error?.message;
        const detail =
          typeof restMessage === "string" && restMessage.trim()
            ? restMessage
            : Array.isArray(errorBody?.errors)
              ? errorBody.errors
                  .map((error) => error?.message)
                  .filter(
                    (message): message is string =>
                      typeof message === "string" && message.trim().length > 0,
                  )
                  .join("; ")
              : undefined;
        if (detail) message += `: ${detail}`;
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
