/**
 * Skylight Authentication
 * Handles the browser-style OAuth login flow used by Skylight web.
 */

import { createHash, randomUUID } from "node:crypto";
import { SKYLIGHT_API_VERSION, SKYLIGHT_BASE_URL, SKYLIGHT_WEB_APP_URL } from "./constants.js";

const REDIRECT_URI = `${SKYLIGHT_WEB_APP_URL}/welcome`;
const CLIENT_ID = "skylight-mobile";
const SCOPE = "everything";
const WEB_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:149.0) Gecko/20100101 Firefox/149.0";

export interface OAuthTokenResponse {
  access_token?: string;
  token?: string;
  token_type?: string;
  scope?: string;
  refresh_token?: string;
  expires_in?: number;
  created_at?: number;
  [key: string]: unknown;
}

export interface AuthResult {
  email: string;
  token: string;
  subscriptionStatus: string | null;
  refreshToken?: string;
  /** Epoch ms when the access token expires, if known. */
  expiresAt?: number;
}

export interface TokenSet {
  token: string;
  refreshToken?: string;
  expiresAt?: number;
}

/**
 * Thrown when Skylight's Cloudflare front end rejects the request outright
 * (bot protection / rate limiting), as opposed to a credentials problem.
 */
export class SkylightBlockedError extends Error {
  constructor(step: string, status: number, rayId: string | null) {
    super(
      `Skylight ${step} was blocked by Cloudflare (HTTP ${status}${rayId ? `, Ray ID ${rayId}` : ""}). ` +
        "This is bot protection, not a bad password - usually triggered by repeated logins. " +
        "Wait a while before retrying, or set SKYLIGHT_TOKEN to a token copied from a browser session."
    );
    this.name = "SkylightBlockedError";
  }
}

function isCloudflareBlock(response: Response, body: string): boolean {
  if (response.status !== 403 && response.status !== 429 && response.status !== 503) {
    return false;
  }
  const server = response.headers.get("server")?.toLowerCase() ?? "";
  return (
    server.includes("cloudflare") ||
    response.headers.has("cf-ray") ||
    /cloudflare|cf-error-details|attention required|just a moment/i.test(body)
  );
}

function getCloudflareRayId(response: Response, body: string): string | null {
  const header = response.headers.get("cf-ray");
  if (header) {
    return header;
  }
  const match = body.match(/Ray ID:?\s*(?:<[^>]+>\s*)*([0-9a-f]{12,})/i);
  return match ? match[1] : null;
}

function summarizeErrorBody(body: string): string {
  const title = body.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim();
  return title ? `"${title}"` : body.slice(0, 200);
}

class CookieJar {
  private cookies = new Map<string, string>();

  setFromResponse(response: Response): void {
    const headerValues =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie().flatMap((headerValue) => splitSetCookieHeader(headerValue))
        : splitSetCookieHeader(response.headers.get("set-cookie"));

    for (const header of headerValues) {
      const [cookiePair] = header.split(";", 1);
      const separatorIndex = cookiePair.indexOf("=");
      if (separatorIndex <= 0) {
        continue;
      }

      const name = cookiePair.slice(0, separatorIndex).trim();
      const value = cookiePair.slice(separatorIndex + 1).trim();
      if (name && value) {
        this.cookies.set(name, value);
      }
    }
  }

  toHeader(): string | undefined {
    if (this.cookies.size === 0) {
      return undefined;
    }

    return Array.from(this.cookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }
}

function splitSetCookieHeader(headerValue: string | null): string[] {
  if (!headerValue) {
    return [];
  }

  const cookies: string[] = [];
  let current = "";
  let inExpiresAttribute = false;

  for (let index = 0; index < headerValue.length; index += 1) {
    const char = headerValue[index];
    const remainingHeader = headerValue.slice(index).toLowerCase();

    if (!inExpiresAttribute && remainingHeader.startsWith("expires=")) {
      inExpiresAttribute = true;
    }

    if (char === "," && !inExpiresAttribute) {
      cookies.push(current.trim());
      current = "";
      continue;
    }

    if (inExpiresAttribute && char === ";") {
      inExpiresAttribute = false;
    }

    current += char;
  }

  if (current.trim()) {
    cookies.push(current.trim());
  }

  return cookies;
}

function createPkceVerifier(): string {
  return randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
}

function createPkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function createState(): string {
  return randomUUID().replace(/-/g, "").slice(0, 10);
}

function buildAuthorizeUrl(params: { state: string; codeChallenge: string; prompt?: "login" }): string {
  const url = new URL("/oauth/authorize", SKYLIGHT_BASE_URL);
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("state", params.state);

  if (params.prompt) {
    url.searchParams.set("prompt", params.prompt);
  }

  return url.toString();
}

function parseAuthenticityToken(html: string): string {
  const match = html.match(/name=["']authenticity_token["'][^>]*value=["']([^"']+)["']/i);
  if (!match) {
    throw new Error("Could not find authenticity token in Skylight login form");
  }
  return match[1];
}

function parseAuthorizationCode(location: string, expectedState: string): string {
  const url = new URL(location);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");

  if (!code) {
    throw new Error("OAuth redirect did not include an authorization code");
  }

  if (state !== expectedState) {
    throw new Error("OAuth state mismatch during Skylight login");
  }

  return code;
}

function getDeviceMetadata(): Record<string, string> {
  const platform =
    process.platform === "darwin" ? "Macintosh" :
    process.platform === "win32" ? "Windows" :
    process.platform === "linux" ? "Linux" :
    process.platform;

  return {
    skylight_api_client_device_fingerprint: randomUUID(),
    skylight_api_client_device_platform: "web",
    skylight_api_client_device_name: "unknown",
    skylight_api_client_device_os_version: "unknown",
    skylight_api_client_device_app_version: "unknown",
    skylight_api_client_device_hardware: platform,
  };
}

async function fetchWithCookies(
  url: string,
  init: RequestInit,
  cookieJar: CookieJar
): Promise<Response> {
  const headers = new Headers(init.headers);
  const cookieHeader = cookieJar.toHeader();

  if (cookieHeader) {
    headers.set("Cookie", cookieHeader);
  }

  const response = await fetch(url, {
    ...init,
    headers,
    redirect: "manual",
  });

  cookieJar.setFromResponse(response);
  return response;
}

async function beginOAuthFlow(state: string, codeChallenge: string, cookieJar: CookieJar): Promise<string> {
  const response = await fetchWithCookies(
    buildAuthorizeUrl({ state, codeChallenge, prompt: "login" }),
    {
      method: "GET",
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "User-Agent": WEB_USER_AGENT,
        Referer: `${SKYLIGHT_WEB_APP_URL}/`,
      },
    },
    cookieJar
  );

  const location = response.headers.get("location");
  if (response.status !== 302 || !location) {
    response.body?.cancel();
    throw new Error(`Unexpected authorize response: HTTP ${response.status}`);
  }

  response.body?.cancel();
  return new URL(location).toString();
}

async function loadLoginForm(loginUrl: string, cookieJar: CookieJar): Promise<string> {
  const response = await fetchWithCookies(
    loginUrl,
    {
      method: "GET",
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "User-Agent": WEB_USER_AGENT,
        Referer: `${SKYLIGHT_WEB_APP_URL}/`,
      },
    },
    cookieJar
  );

  if (!response.ok) {
    response.body?.cancel();
    throw new Error(`Failed to load Skylight login form: HTTP ${response.status}`);
  }

  return response.text();
}

async function submitLoginForm(
  email: string,
  password: string,
  authenticityToken: string,
  cookieJar: CookieJar
): Promise<string> {
  const body = new URLSearchParams({
    authenticity_token: authenticityToken,
    email,
    password,
  });

  const response = await fetchWithCookies(
    `${SKYLIGHT_BASE_URL}/auth/session`,
    {
      method: "POST",
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: SKYLIGHT_BASE_URL,
        Referer: `${SKYLIGHT_BASE_URL}/auth/session/new`,
        "User-Agent": WEB_USER_AGENT,
      },
      body,
    },
    cookieJar
  );

  const location = response.headers.get("location");
  if (response.status === 302 && location) {
    response.body?.cancel();
    return new URL(location, SKYLIGHT_BASE_URL).toString();
  }

  const errorBody = await response.text();
  if (response.status === 401 || response.status === 422) {
    throw new Error("Invalid email or password. Please check your SKYLIGHT_EMAIL and SKYLIGHT_PASSWORD environment variables.");
  }

  if (isCloudflareBlock(response, errorBody)) {
    throw new SkylightBlockedError("login form submission", response.status, getCloudflareRayId(response, errorBody));
  }

  throw new Error(`Skylight login form submission failed: HTTP ${response.status}${errorBody ? ` - ${summarizeErrorBody(errorBody)}` : ""}`);
}

async function authorizeAuthenticatedSession(authorizeUrl: string, cookieJar: CookieJar): Promise<string> {
  const response = await fetchWithCookies(
    authorizeUrl,
    {
      method: "GET",
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        Referer: `${SKYLIGHT_BASE_URL}/auth/session/new`,
        "User-Agent": WEB_USER_AGENT,
      },
    },
    cookieJar
  );

  const location = response.headers.get("location");
  if (response.status !== 302 || !location) {
    response.body?.cancel();
    throw new Error(`Unexpected post-login authorize response: HTTP ${response.status}`);
  }

  response.body?.cancel();
  return location;
}

function toTokenSet(data: OAuthTokenResponse): TokenSet {
  const token = data.access_token ?? data.token;
  if (!token) {
    throw new Error("OAuth token response did not include an access token");
  }

  let expiresAt: number | undefined;
  if (typeof data.expires_in === "number") {
    const issuedAtMs = typeof data.created_at === "number" ? data.created_at * 1000 : Date.now();
    expiresAt = issuedAtMs + data.expires_in * 1000;
  }

  return {
    token,
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : undefined,
    expiresAt,
  };
}

async function exchangeAuthorizationCode(code: string, codeVerifier: string): Promise<TokenSet> {
  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    scope: SCOPE,
    redirect_uri: REDIRECT_URI,
    code,
    code_verifier: codeVerifier,
    ...getDeviceMetadata(),
  });

  const response = await fetch(`${SKYLIGHT_BASE_URL}/oauth/token`, {
    method: "POST",
    headers: {
      Accept: "application/json, text/javascript; q=0.01",
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: SKYLIGHT_WEB_APP_URL,
      Referer: `${SKYLIGHT_WEB_APP_URL}/`,
      "User-Agent": WEB_USER_AGENT,
    },
    body: tokenBody,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`OAuth token exchange failed: HTTP ${response.status}${errorBody ? ` - ${errorBody.slice(0, 200)}` : ""}`);
  }

  return toTokenSet((await response.json()) as OAuthTokenResponse);
}

/**
 * Exchange a refresh token for a new access token.
 * Hits only the JSON token endpoint, never the HTML login form.
 */
export async function refreshAccessToken(refreshToken: string): Promise<TokenSet> {
  const response = await fetch(`${SKYLIGHT_BASE_URL}/oauth/token`, {
    method: "POST",
    headers: {
      Accept: "application/json, text/javascript; q=0.01",
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: SKYLIGHT_WEB_APP_URL,
      Referer: `${SKYLIGHT_WEB_APP_URL}/`,
      "User-Agent": WEB_USER_AGENT,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    if (isCloudflareBlock(response, errorBody)) {
      throw new SkylightBlockedError("token refresh", response.status, getCloudflareRayId(response, errorBody));
    }
    throw new Error(`OAuth token refresh failed: HTTP ${response.status}${errorBody ? ` - ${summarizeErrorBody(errorBody)}` : ""}`);
  }

  const tokens = toTokenSet((await response.json()) as OAuthTokenResponse);
  // Some servers don't rotate refresh tokens; keep using the old one then.
  return { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken };
}

export async function detectSubscriptionStatus(token: string): Promise<string | null> {
  try {
    const response = await fetch(`${SKYLIGHT_BASE_URL}/api/plus_access`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        Origin: SKYLIGHT_WEB_APP_URL,
        Referer: `${SKYLIGHT_WEB_APP_URL}/`,
        "Skylight-Api-Version": SKYLIGHT_API_VERSION,
        "User-Agent": "SkylightMobile (web)",
      },
    });

    if (response.status === 401 || response.status === 403 || response.status === 404) {
      response.body?.cancel();
      return "free";
    }

    if (!response.ok) {
      response.body?.cancel();
      return null;
    }

    const rawBody = await response.text();
    if (!rawBody.trim()) {
      return "plus";
    }

    const body = JSON.parse(rawBody) as unknown;
    const text = JSON.stringify(body).toLowerCase();
    if (text.includes("\"subscription_status\":\"plus\"") || text.includes("\"plus\":true") || text.includes("\"has_access\":true")) {
      return "plus";
    }
    if (text.includes("\"subscription_status\":\"free\"") || text.includes("\"plus\":false") || text.includes("\"has_access\":false")) {
      return "free";
    }

    return "plus";
  } catch {
    return null;
  }
}

/**
 * Login to Skylight with email and password.
 * Replays the same browser OAuth flow observed from Skylight web.
 */
export async function login(email: string, password: string): Promise<AuthResult> {
  console.error("[auth] Starting OAuth login.");

  const cookieJar = new CookieJar();
  const state = createState();
  const codeVerifier = createPkceVerifier();
  const codeChallenge = createPkceChallenge(codeVerifier);

  const loginUrl = await beginOAuthFlow(state, codeChallenge, cookieJar);
  const loginHtml = await loadLoginForm(loginUrl, cookieJar);
  const authenticityToken = parseAuthenticityToken(loginHtml);
  const authorizeUrl = await submitLoginForm(email, password, authenticityToken, cookieJar);
  const callbackLocation = await authorizeAuthenticatedSession(authorizeUrl, cookieJar);
  const authorizationCode = parseAuthorizationCode(callbackLocation, state);
  const { token, refreshToken, expiresAt } = await exchangeAuthorizationCode(authorizationCode, codeVerifier);
  const subscriptionStatus = await detectSubscriptionStatus(token);

  console.error("[auth] OAuth login successful.");

  return {
    email,
    token,
    subscriptionStatus,
    refreshToken,
    expiresAt,
  };
}
