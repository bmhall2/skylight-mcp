import { getConfig, usesEmailAuth, type Config } from "../config.js";
import { detectSubscriptionStatus, login, refreshAccessToken } from "./auth.js";
import {
  clearCachedToken,
  isTokenUsable,
  readCachedToken,
  withLoginLock,
  writeCachedToken,
  type CachedToken,
} from "./token-cache.js";
import { SKYLIGHT_API_VERSION, SKYLIGHT_BASE_URL } from "./constants.js";
import {
  AuthenticationError,
  NotFoundError,
  RateLimitError,
  SkylightError,
} from "../utils/errors.js";

/**
 * Skylight subscription status types
 */
export type SubscriptionStatus = "plus" | "free" | "trial" | null;

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  params?: Record<string, string | boolean | number | undefined>;
  body?: unknown;
}

/**
 * Skylight API Client
 * Handles authentication and HTTP requests to the Skylight API
 */
export class SkylightClient {
  private config: Config;
  private resolvedToken: string | null = null;
  private loginPromise: Promise<{ token: string }> | null = null;
  private subscriptionStatus: SubscriptionStatus = null;
  /** When the token in use was obtained (epoch ms), for email auth. */
  private tokenSavedAt = 0;

  /** A 401 this soon after getting a token is not a stale-token problem. */
  private static readonly FRESH_TOKEN_WINDOW_MS = 5 * 60 * 1000;

  constructor(config?: Config) {
    this.config = config ?? getConfig();
  }

  /**
   * Get the authentication credentials
   * If using email/password auth, will login first
   */
  private async getCredentials(): Promise<{ token: string }> {
    // If we already have a resolved token, use it
    if (this.resolvedToken) {
      return { token: this.resolvedToken };
    }

    // If using token-based auth, use the configured token
    if (!usesEmailAuth(this.config)) {
      return { token: this.config.token! };
    }

    // If already logging in, wait for that to complete
    if (this.loginPromise) {
      return this.loginPromise;
    }

    // Login with email/password
    this.loginPromise = this.performLogin();
    try {
      const result = await this.loginPromise;
      this.resolvedToken = result.token;
      return result;
    } finally {
      this.loginPromise = null;
    }
  }

  private useCachedToken(cached: CachedToken): { token: string } {
    this.subscriptionStatus = cached.subscriptionStatus as SubscriptionStatus;
    this.tokenSavedAt = cached.savedAt;
    return { token: cached.accessToken };
  }

  /**
   * Resolve a token for email/password auth, in order of preference:
   *   1. a valid token cached on disk (shared by every server process)
   *   2. the cached refresh token
   *   3. a full browser-style form login (the step Cloudflare is touchy about)
   * Steps 2-3 run under a cross-process lock so concurrent starts log in once.
   */
  private async performLogin(): Promise<{ token: string }> {
    const { email, password } = this.config;
    if (!email || !password) {
      throw new AuthenticationError("Email and password are required for login");
    }

    const cached = await readCachedToken(email);
    if (cached && isTokenUsable(cached)) {
      console.error("[auth] Using cached Skylight token.");
      return this.useCachedToken(cached);
    }

    return withLoginLock(async () => {
      // Another process may have logged in while we waited for the lock.
      const latest = await readCachedToken(email);
      if (latest && isTokenUsable(latest)) {
        console.error("[auth] Using Skylight token obtained by another server process.");
        return this.useCachedToken(latest);
      }

      if (latest?.refreshToken) {
        try {
          console.error("[auth] Refreshing Skylight token...");
          const refreshed = await refreshAccessToken(latest.refreshToken);
          const subscriptionStatus =
            (await detectSubscriptionStatus(refreshed.token)) ?? latest.subscriptionStatus;
          const entry: CachedToken = {
            email,
            accessToken: refreshed.token,
            refreshToken: refreshed.refreshToken,
            expiresAt: refreshed.expiresAt,
            subscriptionStatus,
            savedAt: Date.now(),
          };
          await writeCachedToken(entry);
          return this.useCachedToken(entry);
        } catch (error) {
          console.error(`[auth] Token refresh failed, falling back to full login: ${(error as Error).message}`);
        }
      }

      console.error("Logging in to Skylight...");
      const result = await login(email, password);
      const entry: CachedToken = {
        email,
        accessToken: result.token,
        refreshToken: result.refreshToken,
        expiresAt: result.expiresAt,
        subscriptionStatus: result.subscriptionStatus,
        savedAt: Date.now(),
      };
      await writeCachedToken(entry);
      console.error(`Logged in as ${result.email}${result.subscriptionStatus ? ` (${result.subscriptionStatus})` : ""}`);
      return this.useCachedToken(entry);
    });
  }

  /**
   * Build the Authorization header
   * Email/password auth now resolves to an OAuth bearer token.
   * Manual token auth still respects the configured auth type.
   */
  private async getAuthHeader(): Promise<string> {
    const { token } = await this.getCredentials();

    if (usesEmailAuth(this.config)) {
      return `Bearer ${token}`;
    }

    // For manual token config, respect the authType setting
    if (this.config.authType === "basic") {
      return `Basic ${token}`;
    }
    return `Bearer ${token}`;
  }

  /**
   * Build URL with query parameters
   */
  private buildUrl(endpoint: string, params?: Record<string, string | boolean | number | undefined>): string {
    const url = new URL(endpoint, SKYLIGHT_BASE_URL);

    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    return url.toString();
  }

  /**
   * Handle API response errors
   */
  private async handleResponseError(response: Response, url: string): Promise<never> {
    const status = response.status;

    if (status === 401) {
      // Clear cached credentials on auth failure
      this.resolvedToken = null;
      console.error(`[client] 401 Unauthorized for ${url}`);

      if (usesEmailAuth(this.config)) {
        throw new AuthenticationError(
          "API request returned 401. This may indicate your frame ID is incorrect or doesn't belong to this account. " +
            "Please verify your SKYLIGHT_FRAME_ID environment variable."
        );
      }
      throw new AuthenticationError();
    }

    if (status === 404) {
      throw new NotFoundError("Resource");
    }

    if (status === 429) {
      const retryAfter = response.headers.get("Retry-After");
      throw new RateLimitError(retryAfter ? parseInt(retryAfter, 10) : undefined);
    }

    // Try to get error details from response
    let errorMessage = `HTTP ${status}`;
    try {
      const errorBody = await response.text();
      if (errorBody) {
        errorMessage += `: ${errorBody.slice(0, 200)}`;
      }
    } catch {
      // Ignore parse errors
    }

    throw new SkylightError(errorMessage, "HTTP_ERROR", status, status >= 500);
  }

  /**
   * Make an authenticated request to the Skylight API
   */
  async request<T>(endpoint: string, options: RequestOptions = {}, isRetry = false): Promise<T> {
    const { method = "GET", params, body } = options;

    // Replace {frameId} placeholder with actual frame ID
    const resolvedEndpoint = endpoint.replace("{frameId}", this.config.frameId);
    const url = this.buildUrl(resolvedEndpoint, params);

    console.error(`[client] ${method} ${url}`);

    const headers: Record<string, string> = {
      Authorization: await this.getAuthHeader(),
      Accept: "application/json",
      "User-Agent": "SkylightMobile (web)",
      "Skylight-Api-Version": SKYLIGHT_API_VERSION,
    };

    if (body) {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    console.error(`[client] Response: ${response.status}`);

    if (!response.ok) {
      // For email/password auth, try re-login once on 401 - but only if the
      // token is old enough to plausibly have expired. A 401 on a brand-new
      // token means something else is wrong (e.g. frame ID), and re-running
      // the login form on every request is what gets us blocked by Cloudflare.
      const tokenIsFresh = Date.now() - this.tokenSavedAt < SkylightClient.FRESH_TOKEN_WINDOW_MS;
      if (response.status === 401 && usesEmailAuth(this.config) && !isRetry && !tokenIsFresh) {
        console.error("[client] Got 401, discarding cached token and re-authenticating...");
        if (this.resolvedToken) {
          await clearCachedToken(this.resolvedToken);
        }
        this.resolvedToken = null;
        response.body?.cancel();
        return this.request<T>(endpoint, options, true);
      }
      await this.handleResponseError(response, url);
    }

    // Handle 304 Not Modified
    if (response.status === 304) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  /**
   * GET request helper
   */
  async get<T>(endpoint: string, params?: Record<string, string | boolean | number | undefined>): Promise<T> {
    return this.request<T>(endpoint, { method: "GET", params });
  }

  /**
   * POST request helper
   */
  async post<T>(endpoint: string, body: unknown): Promise<T> {
    return this.request<T>(endpoint, { method: "POST", body });
  }

  /**
   * Get the frame ID from config
   */
  get frameId(): string {
    return this.config.frameId;
  }

  /**
   * Get the timezone from config
   */
  get timezone(): string {
    return this.config.timezone;
  }

  /**
   * Check if user has Plus subscription
   */
  hasPlus(): boolean {
    return this.subscriptionStatus === "plus";
  }

  /**
   * Get the subscription status
   */
  getSubscriptionStatus(): SubscriptionStatus {
    return this.subscriptionStatus;
  }

  /**
   * Initialize the client (triggers login if using email/password auth)
   */
  async initialize(): Promise<void> {
    await this.getCredentials();
  }
}

// Singleton instance
let clientInstance: SkylightClient | null = null;

export function getClient(): SkylightClient {
  if (!clientInstance) {
    clientInstance = new SkylightClient();
  }
  return clientInstance;
}

/**
 * Initialize the client singleton and return it
 * This triggers login if using email/password auth
 */
export async function initializeClient(): Promise<SkylightClient> {
  const client = getClient();
  await client.initialize();
  return client;
}
