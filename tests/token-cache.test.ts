import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearCachedToken,
  isTokenUsable,
  readCachedToken,
  withLoginLock,
  writeCachedToken,
  type CachedToken,
} from "../src/api/token-cache.js";

const sample: CachedToken = {
  email: "User@Example.com",
  accessToken: "access-1",
  refreshToken: "refresh-1",
  expiresAt: Date.now() + 60 * 60 * 1000,
  subscriptionStatus: "plus",
  savedAt: Date.now(),
};

describe("token cache", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "skylight-cache-"));
    path = join(dir, "nested", "token.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips a token and matches email case-insensitively", async () => {
    await writeCachedToken(sample, path);
    expect(await readCachedToken("user@example.com", path)).toEqual(sample);
    expect(await readCachedToken("someone-else@example.com", path)).toBeNull();
  });

  it("returns null for a missing or corrupt cache", async () => {
    expect(await readCachedToken("user@example.com", path)).toBeNull();
    await writeCachedToken(sample, path);
    await writeFile(path, "{not json");
    expect(await readCachedToken("user@example.com", path)).toBeNull();
  });

  it("treats tokens near expiry as unusable", () => {
    const now = Date.now();
    expect(isTokenUsable({ ...sample, expiresAt: undefined }, now)).toBe(true);
    expect(isTokenUsable({ ...sample, expiresAt: now + 60 * 60 * 1000 }, now)).toBe(true);
    expect(isTokenUsable({ ...sample, expiresAt: now + 60 * 1000 }, now)).toBe(false);
  });

  it("only clears the cache when it still holds the given token", async () => {
    await writeCachedToken(sample, path);
    await clearCachedToken("some-other-token", path);
    expect(await readCachedToken(sample.email, path)).not.toBeNull();
    await clearCachedToken(sample.accessToken, path);
    expect(await readCachedToken(sample.email, path)).toBeNull();
  });

  it("serializes concurrent logins so only one runs at a time", async () => {
    let active = 0;
    let maxActive = 0;
    const run = () =>
      withLoginLock(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 50));
        active -= 1;
      }, path);

    await Promise.all([run(), run(), run()]);
    expect(maxActive).toBe(1);
  });
});
