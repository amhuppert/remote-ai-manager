import { createHmac } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONVERSATION_CAPABILITY_HEADER,
  CONVERSATION_CAPABILITY_PREFIX,
  mintConversationCapability,
  verifyConversationCapability,
} from "./conversation-capability";
import {
  LANE_CAPABILITY_HEADER,
  LANE_CAPABILITY_PREFIX,
  mintLaneCapability,
  verifyLaneCapability,
} from "./lane-capability";
import {
  _resetCapabilitySigningKeyCacheForTesting,
  _resetInstanceTokenCacheForTesting,
  bearerTokenFromHeader,
  createAgentAuth,
  createConversationCapabilityVerifier,
  createLaneCapabilityVerifier,
  ensureCapabilitySigningKey,
  ensureInstanceToken,
  getCachedCapabilitySigningKey,
  getCachedInstanceToken,
  mintImplementerLaneCapability,
  mintSessionConversationCapability,
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

/**
 * The server-only capability signing key (D7 R9.4, decision D11).
 *
 * The property under test is that this key is NOT the instance token. The
 * instance token is exported into every agent environment as `CC_API_TOKEN`, so
 * any capability keyed on it is caller-computable: an agent holding the token
 * can mint a capability naming any conversation or any lane, which makes the
 * signature prove nothing about who is calling. Both capability families must
 * therefore verify against a key no agent environment ever receives.
 */
describe("ensureCapabilitySigningKey", () => {
  /** Forge a capability in the module's own wire format under `secret`. */
  function forgeCapability(
    prefix: string,
    payload: unknown,
    secret: string,
  ): string {
    const encoded = Buffer.from(JSON.stringify(payload), "utf-8").toString(
      "base64url",
    );
    const signature = createHmac("sha256", secret)
      .update(`${prefix}.${encoded}`)
      .digest("base64url");
    return `${prefix}.${encoded}.${signature}`;
  }

  beforeEach(() => {
    _resetCapabilitySigningKeyCacheForTesting();
    _resetInstanceTokenCacheForTesting();
  });

  afterEach(() => {
    _resetCapabilitySigningKeyCacheForTesting();
    _resetInstanceTokenCacheForTesting();
  });

  it("creates <configDir>/capability-key with mode 0600, separate from the api token", async () => {
    const apiToken = await ensureInstanceToken(dir);
    const key = await ensureCapabilitySigningKey(dir);

    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toBe(apiToken);
    const onDisk = await readFile(path.join(dir, "capability-key"), "utf-8");
    expect(onDisk.trim()).toBe(key);
    const mode = (await stat(path.join(dir, "capability-key"))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("is idempotent — a second call reuses the existing key", async () => {
    const first = await ensureCapabilitySigningKey(dir);
    const second = await ensureCapabilitySigningKey(dir);

    expect(second).toBe(first);
  });

  it("repairs an existing key file that is readable beyond its owner", async () => {
    // `mode` on writeFile only applies to a NEWLY CREATED inode, so it cannot
    // speak for a key that arrived some other way — an operator rotation, a
    // restore, a permissive umask, a file precreated by a packaging step. The
    // key confers the authority every conversation and lane principal is
    // derived from, so a world-readable one hands minting power to any local
    // reader; ensuring it means ensuring its permissions, not just its bytes.
    const keyPath = path.join(dir, "capability-key");
    const rotated = `${"a".repeat(63)}1`;
    await writeFile(keyPath, `${rotated}\n`, { mode: 0o644 });
    expect((await stat(keyPath)).mode & 0o777).toBe(0o644);

    const key = await ensureCapabilitySigningKey(dir);

    expect(key).toBe(rotated);
    expect((await stat(keyPath)).mode & 0o777).toBe(0o600);
  });

  it("leaves an already-private key file untouched", async () => {
    const keyPath = path.join(dir, "capability-key");
    const first = await ensureCapabilitySigningKey(dir);
    const before = await stat(keyPath);

    expect(await ensureCapabilitySigningKey(dir)).toBe(first);
    const after = await stat(keyPath);
    expect(after.mode & 0o777).toBe(0o600);
    // Reuse must not rewrite the file: a rewrite would race a concurrent
    // reader (the verifiers read this path lazily) for no gain.
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("regenerates an empty key file at mode 0600", async () => {
    // An empty file is treated as "no key", but the inode already exists, so
    // the replacement write inherits ITS mode rather than the requested one.
    const keyPath = path.join(dir, "capability-key");
    await writeFile(keyPath, "", { mode: 0o644 });

    const key = await ensureCapabilitySigningKey(dir);

    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect((await readFile(keyPath, "utf-8")).trim()).toBe(key);
    expect((await stat(keyPath)).mode & 0o777).toBe(0o600);
  });

  it("exposes the cached key to a separately-loaded module instance", async () => {
    // Same module-graph split the instance token has: startup provisions the
    // key in the instrumentation graph and session-env mints from it
    // synchronously in the route-handler graph.
    const key = await ensureCapabilitySigningKey(dir);

    vi.resetModules();
    const freshInstance = await import("./token");

    expect(freshInstance.getCachedCapabilitySigningKey()).toBe(key);
  });

  it("creates the config dir when missing", async () => {
    const nested = path.join(dir, "deeper", "cc");
    const key = await ensureCapabilitySigningKey(nested);

    expect(
      (await readFile(path.join(nested, "capability-key"), "utf-8")).trim(),
    ).toBe(key);
  });

  it("reports no key until startup has provisioned one", async () => {
    expect(getCachedCapabilitySigningKey()).toBeNull();

    const key = await ensureCapabilitySigningKey(dir);
    expect(getCachedCapabilitySigningKey()).toBe(key);
  });

  it("mints a conversation capability the verifier accepts, without leaking key bytes", async () => {
    const key = await ensureCapabilitySigningKey(dir);
    const capability = mintSessionConversationCapability({
      sessionName: "my-session",
      conversationId: "conv-1",
    });
    expect(capability).not.toBeNull();
    if (capability === null) return;
    // The holder receives an opaque token; the signing key itself must never
    // appear in the material handed to an agent environment.
    expect(capability).not.toContain(key);

    const verify = createConversationCapabilityVerifier({ configDir: dir });
    const verification = await verify(
      new Request("http://localhost/api/x", {
        headers: { [CONVERSATION_CAPABILITY_HEADER]: capability },
      }),
    );

    expect(verification).toEqual({
      kind: "valid",
      scope: { sessionName: "my-session", conversationId: "conv-1" },
      issuedAt: expect.any(Number),
    });
  });

  it("mints a lane capability the verifier accepts, without leaking key bytes", async () => {
    const key = await ensureCapabilitySigningKey(dir);
    const capability = mintImplementerLaneCapability({
      executionId: "exec-1",
      contextId: "context-1",
      conversationId: "lane-conv-1",
    });
    expect(capability).not.toBeNull();
    if (capability === null) return;
    expect(capability).not.toContain(key);

    const verify = createLaneCapabilityVerifier({ configDir: dir });
    const verification = await verify(
      new Request("http://localhost/api/x", {
        headers: { [LANE_CAPABILITY_HEADER]: capability },
      }),
    );

    expect(verification).toEqual({
      kind: "valid",
      scope: {
        laneKind: "implementer",
        executionId: "exec-1",
        contextId: "context-1",
        conversationId: "lane-conv-1",
      },
      issuedAt: expect.any(Number),
    });
  });

  it("mints nothing for either capability family when startup provisioned no key", async () => {
    await ensureInstanceToken(dir);

    expect(
      mintSessionConversationCapability({
        sessionName: "s",
        conversationId: "c",
      }),
    ).toBeNull();
    expect(
      mintImplementerLaneCapability({
        executionId: "e",
        contextId: "c",
        conversationId: "v",
      }),
    ).toBeNull();
  });

  it("refuses a conversation capability forged with the exported instance token", async () => {
    const apiToken = await ensureInstanceToken(dir);
    await ensureCapabilitySigningKey(dir);
    const forged = forgeCapability(
      CONVERSATION_CAPABILITY_PREFIX,
      { s: "my-session", v: "victim-conversation", i: 1 },
      apiToken,
    );

    const verify = createConversationCapabilityVerifier({ configDir: dir });
    const verification = await verify(
      new Request("http://localhost/api/x", {
        headers: { [CONVERSATION_CAPABILITY_HEADER]: forged },
      }),
    );

    expect(verification).toEqual({ kind: "invalid", reason: "bad_signature" });
  });

  it("refuses a lane capability forged with the exported instance token", async () => {
    // Every agent environment carries CC_API_TOKEN, so a lane capability keyed
    // on it is one an agent can compute for any execution/context it can name —
    // the signature would authenticate the machine, never the lane.
    const apiToken = await ensureInstanceToken(dir);
    await ensureCapabilitySigningKey(dir);
    const forged = forgeCapability(
      LANE_CAPABILITY_PREFIX,
      {
        k: "implementer",
        e: "exec-1",
        c: "victim-context",
        v: "victim-conversation",
        i: 1,
      },
      apiToken,
    );

    const verify = createLaneCapabilityVerifier({ configDir: dir });
    const verification = await verify(
      new Request("http://localhost/api/x", {
        headers: { [LANE_CAPABILITY_HEADER]: forged },
      }),
    );

    expect(verification).toEqual({ kind: "invalid", reason: "bad_signature" });
  });

  it("invalidates both capability families when the key is rotated on disk", async () => {
    const original = await ensureCapabilitySigningKey(dir);
    const conversationCapability = mintSessionConversationCapability({
      sessionName: "s",
      conversationId: "c",
    });
    const laneCapability = mintImplementerLaneCapability({
      executionId: "e",
      contextId: "x",
      conversationId: "v",
    });

    const rotated = `${"f".repeat(63)}0`;
    expect(rotated).not.toBe(original);
    await writeFile(path.join(dir, "capability-key"), `${rotated}\n`, {
      mode: 0o600,
    });

    expect(
      verifyConversationCapability(conversationCapability, rotated),
    ).toEqual({ kind: "invalid", reason: "bad_signature" });
    expect(verifyLaneCapability(laneCapability, rotated)).toEqual({
      kind: "invalid",
      reason: "bad_signature",
    });

    // A key already on disk is reused rather than regenerated, so the rotated
    // value is what subsequent mints sign with.
    _resetCapabilitySigningKeyCacheForTesting();
    expect(await ensureCapabilitySigningKey(dir)).toBe(rotated);
  });

  /**
   * A filesystem that refuses the repair. Injected rather than simulated,
   * because the case is exactly the one a real filesystem will not reproduce on
   * demand: the process owns the file, so it can always chmod it here.
   */
  const refusingModeOps = {
    stat: (secretPath: string) => stat(secretPath),
    chmod: async (): Promise<never> => {
      throw Object.assign(new Error("chmod not permitted"), { code: "EPERM" });
    },
  };

  it("refuses to provision a key whose owner-only mode cannot be established", async () => {
    // Fail CLOSED. The alternative — warn and carry on — signs and verifies both
    // capability families with a key any local reader holds, which is precisely
    // the caller-computable signature the dedicated key exists to prevent. A
    // server with no key refuses every agent principal and keeps the human UI;
    // a server with a readable key hands out forgeable authority.
    const keyPath = path.join(dir, "capability-key");
    await writeFile(keyPath, `${"b".repeat(64)}\n`, { mode: 0o644 });

    await expect(
      ensureCapabilitySigningKey(dir, refusingModeOps),
    ).rejects.toThrow(/owner-only/i);

    expect(getCachedCapabilitySigningKey()).toBeNull();
    expect(
      mintSessionConversationCapability({
        sessionName: "s",
        conversationId: "c",
      }),
    ).toBeNull();
    expect(
      mintImplementerLaneCapability({
        executionId: "e",
        contextId: "c",
        conversationId: "v",
      }),
    ).toBeNull();
  });

  it("drops an already-cached key when a later provision cannot re-establish the mode", async () => {
    const key = await ensureCapabilitySigningKey(dir);
    expect(getCachedCapabilitySigningKey()).toBe(key);
    await chmod(path.join(dir, "capability-key"), 0o644);

    await expect(
      ensureCapabilitySigningKey(dir, refusingModeOps),
    ).rejects.toThrow(/owner-only/i);

    expect(getCachedCapabilitySigningKey()).toBeNull();
  });

  it("refuses to provision an api token whose owner-only mode cannot be established", async () => {
    await writeFile(path.join(dir, "api-token"), "token-from-elsewhere\n", {
      mode: 0o644,
    });

    await expect(ensureInstanceToken(dir, refusingModeOps)).rejects.toThrow(
      /owner-only/i,
    );
    expect(getCachedInstanceToken()).toBeNull();
  });

  it.each([
    [
      "conversation",
      (configDir: string) =>
        createConversationCapabilityVerifier({ configDir }),
      CONVERSATION_CAPABILITY_HEADER,
      (secret: string) =>
        mintConversationCapability(
          { sessionName: "s", conversationId: "c" },
          secret,
          1,
        ),
    ],
    [
      "lane",
      (configDir: string) => createLaneCapabilityVerifier({ configDir }),
      LANE_CAPABILITY_HEADER,
      (secret: string) =>
        mintLaneCapability(
          {
            laneKind: "implementer",
            executionId: "e",
            contextId: "x",
            conversationId: "v",
          },
          secret,
          1,
        ),
    ],
  ] as const)(
    "verifies no %s capability against a key file readable beyond its owner",
    async (_family, makeVerifier, header, mint) => {
      // Verification is the other half of fail-closed. Provisioning can refuse a
      // readable key, but the verifiers read the path themselves and lazily, so
      // a key that turned readable after startup — or one this process never
      // provisioned — would keep authenticating principals from a secret every
      // local reader can sign with.
      const secret = "a".repeat(64);
      await writeFile(path.join(dir, "capability-key"), `${secret}\n`, {
        mode: 0o644,
      });

      const verification = await makeVerifier(dir)(
        new Request("http://localhost/api/x", {
          headers: { [header]: mint(secret) },
        }),
      );

      expect(verification).toEqual({ kind: "invalid", reason: "no_secret" });
    },
  );

  it("verifies as no_secret rather than throwing when the key file is absent", async () => {
    const conversationVerify = createConversationCapabilityVerifier({
      configDir: dir,
    });
    const laneVerify = createLaneCapabilityVerifier({ configDir: dir });

    expect(
      await conversationVerify(
        new Request("http://localhost/api/x", {
          headers: { [CONVERSATION_CAPABILITY_HEADER]: "cccc1.aaa.bbb" },
        }),
      ),
    ).toEqual({ kind: "invalid", reason: "no_secret" });
    expect(
      await laneVerify(
        new Request("http://localhost/api/x", {
          headers: { [LANE_CAPABILITY_HEADER]: "cclc1.aaa.bbb" },
        }),
      ),
    ).toEqual({ kind: "invalid", reason: "no_secret" });
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
