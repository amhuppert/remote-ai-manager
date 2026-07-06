import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { getConfigDirPath } from "@/lib/config/loader";
import { createLogger } from "@/lib/logging";
import {
  deleteGlobalValue,
  getGlobalValue,
  setGlobalValue,
} from "@/lib/shared/global-singleton";

const log = createLogger("agent-gateway");

const TOKEN_FILE = "api-token";

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
export async function ensureInstanceToken(configDir: string): Promise<string> {
  const tokenPath = path.join(configDir, TOKEN_FILE);

  const existing = await readTokenFile(tokenPath);
  if (existing !== null) {
    setGlobalValue(INSTANCE_TOKEN_KEY, existing);
    return existing;
  }

  await mkdir(configDir, { recursive: true });
  const token = randomBytes(32).toString("hex");
  await writeFile(tokenPath, `${token}\n`, { encoding: "utf-8", mode: 0o600 });
  log.info("agent-gateway.token_generated", { tokenPath });
  setGlobalValue(INSTANCE_TOKEN_KEY, token);
  return token;
}

/** The token provisioned at startup, or null if startup has not run. */
export function getCachedInstanceToken(): string | null {
  return getGlobalValue<string>(INSTANCE_TOKEN_KEY) ?? null;
}

export function _resetInstanceTokenCacheForTesting(): void {
  deleteGlobalValue(INSTANCE_TOKEN_KEY);
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
