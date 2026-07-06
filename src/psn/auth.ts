/**
 * PlayStation Network authentication.
 *
 * PSN has no public developer API. Access works the same way the official
 * PlayStation mobile app authenticates: an NPSSO token (obtained by the user
 * from their browser session) is exchanged for an OAuth authorization code,
 * which is then exchanged for a bearer access token + refresh token.
 *
 * The client id/secret below are the public constants baked into the
 * official PlayStation Android app and are required for the token exchange.
 */

const AUTH_BASE = "https://ca.account.sony.com/api/authz/v3/oauth";
const CLIENT_ID = "09515159-7237-4370-9b40-3806e67c0891";
const CLIENT_SECRET = "ucPjka5tntB2KqsP";
const REDIRECT_URI = "com.scee.psxandroid.scecompcall://redirect";
const SCOPE = "psn:mobile.v2.core psn:clientapp";

export interface TokenSet {
  accessToken: string;
  /** Epoch ms after which the access token is no longer valid. */
  expiresAt: number;
  refreshToken: string;
  /** Epoch ms after which the refresh token is no longer valid. */
  refreshExpiresAt: number;
}

export class PsnAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PsnAuthError";
  }
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  refresh_token_expires_in: number;
  scope: string;
}

/** Exchange an NPSSO token for an OAuth authorization code. */
async function exchangeNpssoForCode(npsso: string): Promise<string> {
  const params = new URLSearchParams({
    access_type: "offline",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPE,
  });

  const res = await fetch(`${AUTH_BASE}/authorize?${params}`, {
    method: "GET",
    headers: { Cookie: `npsso=${npsso}` },
    redirect: "manual",
  });

  const location = res.headers.get("location");
  if (!location || !location.includes("code=")) {
    throw new PsnAuthError(
      "Failed to obtain an authorization code from the NPSSO token. " +
        "The token is most likely expired or invalid - fetch a fresh one from " +
        "https://ca.account.sony.com/api/v1/ssocookie while signed in to PlayStation."
    );
  }

  const code = new URL(location).searchParams.get("code");
  if (!code) {
    throw new PsnAuthError("Authorization redirect did not contain a code parameter.");
  }
  return code;
}

async function requestToken(body: URLSearchParams): Promise<TokenSet> {
  const res = await fetch(`${AUTH_BASE}/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new PsnAuthError(`Token request failed with HTTP ${res.status}: ${text}`);
  }

  const data = (await res.json()) as TokenResponse;
  const now = Date.now();
  return {
    accessToken: data.access_token,
    expiresAt: now + data.expires_in * 1000,
    refreshToken: data.refresh_token,
    refreshExpiresAt: now + data.refresh_token_expires_in * 1000,
  };
}

/** Full NPSSO -> authorization code -> access token exchange. */
export async function authenticateWithNpsso(npsso: string): Promise<TokenSet> {
  const code = await exchangeNpssoForCode(npsso);
  return requestToken(
    new URLSearchParams({
      code,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code",
      token_format: "jwt",
    })
  );
}

export async function refreshTokens(refreshToken: string): Promise<TokenSet> {
  return requestToken(
    new URLSearchParams({
      refresh_token: refreshToken,
      grant_type: "refresh_token",
      scope: SCOPE,
      token_format: "jwt",
    })
  );
}

/**
 * Manages the token lifecycle: authenticates lazily on first use, refreshes
 * ahead of expiry, and falls back to a fresh NPSSO exchange if the refresh
 * token itself has expired.
 */
export class TokenManager {
  private tokens: TokenSet | null = null;
  private pending: Promise<TokenSet> | null = null;

  constructor(private readonly npsso: string) {
    if (!npsso) {
      throw new PsnAuthError(
        "No NPSSO token configured. Set the PSN_NPSSO environment variable. " +
          "Sign in at https://www.playstation.com, then visit " +
          "https://ca.account.sony.com/api/v1/ssocookie to copy your token."
      );
    }
  }

  /** Returns a valid access token, authenticating or refreshing as needed. */
  async getAccessToken(): Promise<string> {
    // 60s of headroom so a token can't expire mid-request.
    const margin = 60_000;
    if (this.tokens && this.tokens.expiresAt - margin > Date.now()) {
      return this.tokens.accessToken;
    }
    if (!this.pending) {
      this.pending = this.renew().finally(() => {
        this.pending = null;
      });
    }
    this.tokens = await this.pending;
    return this.tokens.accessToken;
  }

  private async renew(): Promise<TokenSet> {
    const margin = 60_000;
    if (this.tokens && this.tokens.refreshExpiresAt - margin > Date.now()) {
      try {
        return await refreshTokens(this.tokens.refreshToken);
      } catch {
        // Refresh failed (revoked, etc.) - fall through to a full re-auth.
      }
    }
    return authenticateWithNpsso(this.npsso);
  }
}
