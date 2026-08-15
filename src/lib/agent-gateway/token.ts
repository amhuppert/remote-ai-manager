import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { getConfigDirPath } from "@/lib/config/loader";
import { createLogger } from "@/lib/logging";
import {
  deleteGlobalValue,
  getGlobalValue,
  setGlobalValue,
} from "@/lib/shared/global-singleton";
import {
  CONVERSATION_CAPABILITY_HEADER,
  mintConversationCapability,
  verifyConversationCapability,
  type ConversationCapabilityScope,
  type ConversationCapabilityVerification,
} from "./conversation-capability";
import {
  LANE_CAPABILITY_HEADER,
  mintLaneCapability,
  verifyLaneCapability,
  type LaneCapabilityScope,
  type LaneCapabilityVerification,
} from "./lane-capability";

const log = createLogger("agent-gateway");

const TOKEN_FILE = "api-token";

/**
 * The signing key for BOTH capability families — conversation (D11) and
 * implementer lane (D4 R7) — deliberately a SEPARATE file from `api-token`.
 *
 * The api token is exported into every agent environment as `CC_API_TOKEN`, so
 * a capability signed with it is caller-computable: any agent could mint one
 * naming any conversation or any lane, and the signature would authenticate
 * "some cctl on this machine" rather than the principal the mutation routes
 * authorize against. Signing with a secret the verifier shares with every
 * caller verifies nothing, so this key is never placed in an agent environment.
 *
 * Provisioned at startup like the instance token. A server that somehow has
 * none mints nothing and verifies everything as `no_secret`, so callers fall
 * back to unverified rather than to a claim — fail-closed in both directions.
 */
const CAPABILITY_KEY_FILE = "capability-key";

// Cached on globalThis for the same reason the instance token is: startup
// provisions it in one Next.js bundle graph and session-env construction reads
// it synchronously in another.
const CAPABILITY_KEY_CACHE = "__cc_capability_signing_key";

// Stored on globalThis, not a module-local variable: instrumentation provisions
// the token in one Next.js bundle graph, and session-env construction reads it
// (synchronously) in the route-handler graph — a module-local cache is null
// across that split.
const INSTANCE_TOKEN_KEY = "__cc_instance_token";

/**
 * Ensure the instance token exists at <configDir>/api-token (mode 0600) and
 * return it. Generated once at server startup; the CLI reads the same file
 * as its lowest-priority token source. The result is cached so sync call
 * sites (session env construction) can read it via getCachedInstanceToken.
 */
export async function ensureInstanceToken(
  configDir: string,
  fileOps: OwnerOnlySecretFileOps = ownerOnlySecretFileOps,
): Promise<string> {
  const tokenPath = path.join(configDir, TOKEN_FILE);

  try {
    const { secret, generated } = await ensureOwnerOnlySecret(
      configDir,
      tokenPath,
      fileOps,
    );
    if (generated) log.info("agent-gateway.token_generated", { tokenPath });
    setGlobalValue(INSTANCE_TOKEN_KEY, secret);
    return secret;
  } catch (error) {
    deleteGlobalValue(INSTANCE_TOKEN_KEY);
    throw error;
  }
}

/** The token provisioned at startup, or null if startup has not run. */
export function getCachedInstanceToken(): string | null {
  return getGlobalValue<string>(INSTANCE_TOKEN_KEY) ?? null;
}

export function _resetInstanceTokenCacheForTesting(): void {
  deleteGlobalValue(INSTANCE_TOKEN_KEY);
}

/**
 * Ensure the capability signing key exists at <configDir>/capability-key
 * (mode 0600) and cache it (D11, D4 R7).
 *
 * Same provisioning shape as the instance token above, and deliberately a
 * DIFFERENT file: this key must never be exported to an agent environment, so
 * it cannot be the api token that every agent already holds. Nothing outside
 * this module reads it — capabilities are minted and verified server-side, and
 * holders only ever see the opaque token.
 *
 * An existing key is REUSED rather than regenerated, so rotating the key is an
 * operator act (replace the file, restart) and every capability minted under
 * the previous key stops verifying at once, which is the intended blast radius.
 * Its permissions are re-asserted on every reuse rather than trusted, because a
 * key that arrived by rotation, restore, or a permissive umask never passed
 * through the creating write that would have set them.
 */
export async function ensureCapabilitySigningKey(
  configDir: string,
  fileOps: OwnerOnlySecretFileOps = ownerOnlySecretFileOps,
): Promise<string> {
  const keyPath = path.join(configDir, CAPABILITY_KEY_FILE);

  try {
    const { secret, generated } = await ensureOwnerOnlySecret(
      configDir,
      keyPath,
      fileOps,
    );
    // Path only — the key itself must never reach the logs.
    if (generated)
      log.info("agent-gateway.capability_key_generated", { keyPath });
    setGlobalValue(CAPABILITY_KEY_CACHE, secret);
    return secret;
  } catch (error) {
    deleteGlobalValue(CAPABILITY_KEY_CACHE);
    throw error;
  }
}

/** The capability key provisioned at startup, or null if startup has not run. */
export function getCachedCapabilitySigningKey(): string | null {
  return getGlobalValue<string>(CAPABILITY_KEY_CACHE) ?? null;
}

export function _resetCapabilitySigningKeyCacheForTesting(): void {
  deleteGlobalValue(CAPABILITY_KEY_CACHE);
}

/**
 * Mint the capability injected into an ordinary session conversation's
 * environment (D11). `null` when startup has not provisioned a key — the
 * conversation then runs without one and its launches are refused, which is the
 * correct fail-closed behaviour for a server with no secret to sign with.
 */
export function mintSessionConversationCapability(
  scope: ConversationCapabilityScope,
  issuedAt: number = Date.now(),
): string | null {
  const secret = getCachedCapabilitySigningKey();
  if (secret === null) return null;
  return mintConversationCapability(scope, secret, issuedAt);
}

async function readTokenFile(tokenPath: string): Promise<string | null> {
  try {
    const raw = await readFile(tokenPath, "utf-8");
    const token = raw.trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

const OWNER_ONLY = 0o600;

export interface OwnerOnlySecretFileOps {
  stat(secretPath: string): Promise<Stats>;
  chmod(secretPath: string, mode: number): Promise<void>;
}

const ownerOnlySecretFileOps: OwnerOnlySecretFileOps = {
  stat(secretPath) {
    return stat(secretPath);
  },
  chmod(secretPath, mode) {
    return chmod(secretPath, mode);
  },
};

/**
 * Make a provisioned secret file owner-only, whatever it was before.
 *
 * `writeFile`'s `mode` governs only an inode it CREATES, so it cannot speak for
 * a file that arrived some other way — an operator rotation, a restore from
 * backup, a packaging step, or a rewrite over a pre-existing empty inode.
 * Provisioning therefore repairs what it finds rather than assuming it. The
 * bytes are left alone: the verifiers read these paths lazily, so rewriting a
 * key that is already correct would race them for nothing.
 *
 * A filesystem that cannot establish or prove the mode is refused. Continuing
 * would make capability signatures caller-computable by every local process
 * that can read the key, defeating the identity boundary the key exists for.
 */
async function enforceOwnerOnlyMode(
  secretPath: string,
  fileOps: OwnerOnlySecretFileOps,
): Promise<void> {
  try {
    const { mode } = await fileOps.stat(secretPath);
    if ((mode & 0o777) === OWNER_ONLY) return;
    await fileOps.chmod(secretPath, OWNER_ONLY);
    const repairedMode = (await fileOps.stat(secretPath)).mode & 0o777;
    if (repairedMode !== OWNER_ONLY) {
      throw new Error(`mode remained ${repairedMode.toString(8)}`);
    }
    log.info("agent-gateway.secret_file_mode_repaired", {
      secretPath,
      previousMode: (mode & 0o777).toString(8),
    });
  } catch (error) {
    log.warn("agent-gateway.secret_file_mode_repair_failed", {
      secretPath,
      errorCode:
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        typeof error.code === "string"
          ? error.code
          : "unknown",
    });
    throw new Error(
      `Unable to establish owner-only permissions for secret file at ${secretPath}`,
      { cause: error },
    );
  }
}

/**
 * Provision a 256-bit hex secret at `secretPath`, reusing whatever is already
 * there. Either way the file ends up owner-only — see
 * {@link enforceOwnerOnlyMode} for why creating it with `mode` is not enough.
 */
async function ensureOwnerOnlySecret(
  configDir: string,
  secretPath: string,
  fileOps: OwnerOnlySecretFileOps,
): Promise<{ secret: string; generated: boolean }> {
  const existing = await readTokenFile(secretPath);
  if (existing !== null) {
    await enforceOwnerOnlyMode(secretPath, fileOps);
    return { secret: existing, generated: false };
  }

  await mkdir(configDir, { recursive: true });
  const secret = randomBytes(32).toString("hex");
  await writeFile(secretPath, `${secret}\n`, {
    encoding: "utf-8",
    mode: OWNER_ONLY,
  });
  await enforceOwnerOnlyMode(secretPath, fileOps);
  return { secret, generated: true };
}

async function readOwnerOnlySecretFile(
  secretPath: string,
): Promise<string | null> {
  try {
    const { mode } = await stat(secretPath);
    if ((mode & 0o777) !== OWNER_ONLY) return null;
    return await readTokenFile(secretPath);
  } catch {
    return null;
  }
}

/**
 * Mint the lane capability injected into an implementer lane's environment at
 * dispatch (D4 R7). Keyed on the server-only capability key — NOT the instance
 * token, which every lane already holds as `CC_API_TOKEN` and could therefore
 * re-sign with to claim any other lane's execution/context binding. `null` when
 * startup has not provisioned a key — the lane then runs without a capability
 * and its mutations are refused, which is the correct fail-closed behaviour for
 * a server that has no secret to authenticate anything with.
 */
export function mintImplementerLaneCapability(
  scope: Omit<LaneCapabilityScope, "laneKind">,
  issuedAt: number = Date.now(),
): string | null {
  const secret = getCachedCapabilitySigningKey();
  if (secret === null) return null;
  return mintLaneCapability(
    { laneKind: "implementer", ...scope },
    secret,
    issuedAt,
  );
}

/**
 * Classify the graph-workflow lane capability a request presents (D4 R7). The
 * instance token proves "a cctl on this machine"; this proves WHICH lane is
 * calling, which is what lane-scoped mutation authorizes against — so it is
 * keyed on the server-only capability key, never the token the lane holds.
 *
 * Deliberately NOT a method on {@link AgentAuth}: only the lane routes ask this
 * question, and the returned scope is a CLAIM about the binding at mint time,
 * not a gate — the caller still re-checks it against current state inside the
 * serialized mutation, so it must not look like the bearer-token gate.
 */
export function createLaneCapabilityVerifier(
  deps: AgentAuthDeps = {},
): (request: Request) => Promise<LaneCapabilityVerification> {
  const keyPath = path.join(
    deps.configDir ?? getConfigDirPath(),
    CAPABILITY_KEY_FILE,
  );
  let secret: Promise<string | null> | null = null;

  return async (request) => {
    secret ??= readOwnerOnlySecretFile(keyPath);
    return verifyLaneCapability(
      request.headers.get(LANE_CAPABILITY_HEADER),
      await secret,
    );
  };
}

/**
 * Classify the conversation capability a request presents (D7 R9.4/D11). This
 * is what lets a launch derive its origin conversation from a signature rather
 * than from the caller's own claim.
 *
 * Keyed on the dedicated capability key, never the instance token, so a holder
 * of `CC_API_TOKEN` cannot mint one. A missing key file resolves to `no_secret`
 * rather than throwing: a server with no secret to authenticate with must treat
 * every caller as unverified, not crash the launch path.
 */
export function createConversationCapabilityVerifier(
  deps: AgentAuthDeps = {},
): (request: Request) => Promise<ConversationCapabilityVerification> {
  const keyPath = path.join(
    deps.configDir ?? getConfigDirPath(),
    CAPABILITY_KEY_FILE,
  );
  let secret: Promise<string | null> | null = null;

  return async (request) => {
    secret ??= readOwnerOnlySecretFile(keyPath);
    return verifyConversationCapability(
      request.headers.get(CONVERSATION_CAPABILITY_HEADER),
      await secret,
    );
  };
}

/** Extract the token from an `Authorization: Bearer <token>` header value. */
export function bearerTokenFromHeader(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/.exec(header);
  return match?.[1] ?? null;
}

export interface AgentAuthDeps {
  configDir?: string;
}

/**
 * Classification of an optional bearer token. The instance token carries no
 * per-caller identity (it is one shared secret), so the valid variant has no
 * payload — caller identity travels in request headers/bodies instead.
 */
export type OptionalTokenValidation =
  | { kind: "absent" }
  | { kind: "valid" }
  | { kind: "invalid" };

export interface AgentAuth {
  /**
   * Token gate for agent-facing endpoints: resolves to null when the request
   * carries the expected bearer token, otherwise a ready-to-return 401.
   */
  requireToken(request: Request): Promise<Response | null>;
  /**
   * Soft gate for browser-facing endpoints that agents also call: a request
   * without an Authorization header is `absent` (serve it un-gated), the
   * expected bearer token is `valid`, and anything else — malformed header,
   * wrong token, or no token file to validate against — is `invalid` (the
   * caller should return 401).
   */
  validateOptionalToken(request: Request): Promise<OptionalTokenValidation>;
}

/**
 * Reusable bearer-token check for all agent-facing endpoints. The expected
 * token is read from <configDir>/api-token on first use and cached for the
 * process lifetime (the token never rotates while the server runs).
 */
export function createAgentAuth(deps: AgentAuthDeps = {}): AgentAuth {
  const configDir = deps.configDir ?? getConfigDirPath();
  const tokenPath = path.join(configDir, TOKEN_FILE);
  let expectedToken: Promise<string | null> | null = null;

  return {
    async requireToken(request: Request): Promise<Response | null> {
      expectedToken ??= readTokenFile(tokenPath);
      const expected = await expectedToken;
      const provided = bearerTokenFromHeader(
        request.headers.get("authorization"),
      );

      if (expected !== null && provided === expected) {
        return null;
      }

      log.warn("agent-gateway.auth_rejected", {
        path: new URL(request.url).pathname,
        reason:
          expected === null
            ? "no_token_file"
            : provided === null
              ? "missing_bearer"
              : "wrong_token",
      });
      return NextResponse.json(
        { error: "Invalid or missing Command Center API token" },
        { status: 401 },
      );
    },

    async validateOptionalToken(
      request: Request,
    ): Promise<OptionalTokenValidation> {
      const header = request.headers.get("authorization");
      if (header === null) return { kind: "absent" };

      expectedToken ??= readTokenFile(tokenPath);
      const expected = await expectedToken;
      const provided = bearerTokenFromHeader(header);

      if (expected !== null && provided === expected) {
        return { kind: "valid" };
      }

      log.warn("agent-gateway.optional_auth_rejected", {
        path: new URL(request.url).pathname,
        reason:
          expected === null
            ? "no_token_file"
            : provided === null
              ? "malformed_bearer"
              : "wrong_token",
      });
      return { kind: "invalid" };
    },
  };
}
