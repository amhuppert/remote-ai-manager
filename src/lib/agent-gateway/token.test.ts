import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetInstanceTokenCacheForTesting,
  bearerTokenFromHeader,
  createAgentAuth,
  ensureInstanceToken,
  getCachedInstanceToken,
} from "./token";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "cc-token-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("ensureInstanceToken", () => {
  it("creates <configDir>/api-token with mode 0600 and returns the token", async () => {
    const token = await ensureInstanceToken(dir);

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const onDisk = await readFile(path.join(dir, "api-token"), "utf-8");
    expect(onDisk.trim()).toBe(token);
    const mode = (await stat(path.join(dir, "api-token"))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("is idempotent — a second call returns the existing token unchanged", async () => {
    const first = await ensureInstanceToken(dir);
    const second = await ensureInstanceToken(dir);
    expect(second).toBe(first);
  });

  it("records the token in the process-level cache for sync consumers", async () => {
    _resetInstanceTokenCacheForTesting();
    expect(getCachedInstanceToken()).toBeNull();

    const token = await ensureInstanceToken(dir);
    expect(getCachedInstanceToken()).toBe(token);
  });

  it("exposes the cached token to a separately-loaded module instance", async () => {
    // Instrumentation provisions the token in one module graph; session-env
    // construction reads it (synchronously, without touching disk) in the
    // route-handler graph. A module-local cache is invisible across that split,
    // so the token must live in process-global state. Simulate the second graph
    // with a module registry reset + re-import.
    _resetInstanceTokenCacheForTesting();
    const token = await ensureInstanceToken(dir);

    vi.resetModules();
    const freshInstance = await import("./token");

    expect(freshInstance.getCachedInstanceToken()).toBe(token);
  });

  it("creates the config dir when missing", async () => {
    const nested = path.join(dir, "deeper", "cc");
    const token = await ensureInstanceToken(nested);
    expect(
      (await readFile(path.join(nested, "api-token"), "utf-8")).trim(),
    ).toBe(token);
  });
});

describe("bearerTokenFromHeader", () => {
  it("extracts the token from a Bearer header", () => {
    expect(bearerTokenFromHeader("Bearer abc123")).toBe("abc123");
  });

  it("returns null for missing or malformed headers", () => {
    expect(bearerTokenFromHeader(null)).toBeNull();
    expect(bearerTokenFromHeader("Basic abc123")).toBeNull();
    expect(bearerTokenFromHeader("Bearer")).toBeNull();
    expect(bearerTokenFromHeader("")).toBeNull();
  });
});

describe("createAgentAuth", () => {
  function requestWithAuth(header?: string): Request {
    return new Request("http://localhost/api/agent/handshake", {
      headers: header ? { authorization: header } : {},
    });
  }

  it("passes (returns null) for the expected token", async () => {
    await writeFile(path.join(dir, "api-token"), "secret-token\n", {
      mode: 0o600,
    });
    const auth = createAgentAuth({ configDir: dir });

    expect(
      await auth.requireToken(requestWithAuth("Bearer secret-token")),
    ).toBeNull();
  });

  it("rejects a missing Authorization header with 401", async () => {
    await writeFile(path.join(dir, "api-token"), "secret-token", {
      mode: 0o600,
    });
    const auth = createAgentAuth({ configDir: dir });

    const denied = await auth.requireToken(requestWithAuth());
    expect(denied?.status).toBe(401);
  });

  it("rejects a wrong token with 401", async () => {
    await writeFile(path.join(dir, "api-token"), "secret-token", {
      mode: 0o600,
    });
    const auth = createAgentAuth({ configDir: dir });

    const denied = await auth.requireToken(requestWithAuth("Bearer nope"));
    expect(denied?.status).toBe(401);
  });

  it("rejects when no token file exists (server never generated one)", async () => {
    const auth = createAgentAuth({ configDir: dir });

    const denied = await auth.requireToken(requestWithAuth("Bearer anything"));
    expect(denied?.status).toBe(401);
  });
});

describe("validateOptionalToken", () => {
  function requestWithAuth(header?: string): Request {
    return new Request("http://localhost/api/projects/p/conversations/c/read", {
      headers: header ? { authorization: header } : {},
    });
  }

  it("classifies a missing Authorization header as absent", async () => {
    await writeFile(path.join(dir, "api-token"), "secret-token\n", {
      mode: 0o600,
    });
    const auth = createAgentAuth({ configDir: dir });

    expect(await auth.validateOptionalToken(requestWithAuth())).toEqual({
      kind: "absent",
    });
  });

  it("classifies the expected bearer token as valid", async () => {
    await writeFile(path.join(dir, "api-token"), "secret-token\n", {
      mode: 0o600,
    });
    const auth = createAgentAuth({ configDir: dir });

    expect(
      await auth.validateOptionalToken(requestWithAuth("Bearer secret-token")),
    ).toEqual({ kind: "valid" });
  });

  it("classifies a wrong token as invalid", async () => {
    await writeFile(path.join(dir, "api-token"), "secret-token", {
      mode: 0o600,
    });
    const auth = createAgentAuth({ configDir: dir });

    expect(
      await auth.validateOptionalToken(requestWithAuth("Bearer nope")),
    ).toEqual({ kind: "invalid" });
  });

  it("classifies a malformed Authorization header as invalid", async () => {
    await writeFile(path.join(dir, "api-token"), "secret-token", {
      mode: 0o600,
    });
    const auth = createAgentAuth({ configDir: dir });

    expect(
      await auth.validateOptionalToken(requestWithAuth("Basic abc123")),
    ).toEqual({ kind: "invalid" });
  });

  it("classifies any presented token as invalid when no token file exists", async () => {
    const auth = createAgentAuth({ configDir: dir });

    expect(
      await auth.validateOptionalToken(requestWithAuth("Bearer anything")),
    ).toEqual({ kind: "invalid" });
  });
});
