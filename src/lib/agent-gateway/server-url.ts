/**
 * The server's own base URL, recorded once at boot. CC has no runtime URL
 * awareness elsewhere (config/loader.ts resolves paths only); the env
 * contract (CC_SERVER_URL) and future agent-facing features read it from
 * here instead of re-deriving it per call site.
 *
 * All boot state is stored on globalThis, not in module-local variables:
 * Next.js bundles instrumentation (which records it at boot) separately from
 * the route-handler runtime (which reads it when spawning a session's env),
 * so a module-local value recorded in one graph reads back as null in the
 * other.
 *
 * The recorded URL is a guess (`next dev -p <port>` sets the port without
 * exporting PORT, so the PORT-derived fallback can point at a DIFFERENT CC
 * instance). A deferred self-probe against GET /api/agent/identity compares
 * the responder's boot nonce with this process's; only a live server
 * answering with a wrong/absent nonce flips getServerBaseUrl() to null
 * (refuse-to-inject) — unreachable/unverified keeps the URL, since a
 * transient probe failure must not break every healthy boot.
 */

import { z } from "zod";
import { createLogger } from "@/lib/logging";
import { sleep } from "@/lib/shared/sleep";
import {
  deleteGlobalValue,
  getGlobalValue,
  setGlobalValue,
} from "@/lib/shared/global-singleton";

const log = createLogger("agent-gateway");

const SERVER_BASE_URL_KEY = "__cc_server_base_url";
const BOOT_NONCE_KEY = "__cc_server_boot_nonce";
const URL_SOURCE_KEY = "__cc_server_base_url_source";
const PORT_FALLBACK_URL_KEY = "__cc_server_port_fallback_url";
const VERIFICATION_STATE_KEY = "__cc_server_url_verification_state";
const VERIFICATION_PROMISE_KEY = "__cc_server_url_verification_promise";

const PROBE_MAX_ATTEMPTS = 10;
const PROBE_RETRY_DELAY_MS = 1500;
const PROBE_TIMEOUT_MS = 2000;

type ServerUrlSource = "cc_server_url_env" | "port_env" | "default";

type VerificationState = "verified" | "mismatch" | "unverified";

const identityBodySchema = z.object({
  instanceNonce: z.string().nullable(),
  serverBuild: z.string().nullable().optional(),
});

interface ResolvedServerBaseUrl {
  url: string;
  source: ServerUrlSource;
  portFallbackUrl: string;
}

function resolveServerBaseUrlWithSource(
  env: Record<string, string | undefined>,
): ResolvedServerBaseUrl {
  const portFallbackUrl = `http://127.0.0.1:${env["PORT"] || "3000"}`;
  const explicit = env["CC_SERVER_URL"]?.trim();
  if (explicit) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(explicit);
    } catch {
      log.warn("server-url.invalid_cc_server_url", {
        value: explicit,
        reason: "unparseable",
      });
    }
    if (parsed !== null) {
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return {
          url: explicit.replace(/\/+$/, ""),
          source: "cc_server_url_env",
          portFallbackUrl,
        };
      }
      log.warn("server-url.invalid_cc_server_url", {
        value: explicit,
        reason: "unsupported_protocol",
      });
    }
  }
  return {
    url: portFallbackUrl,
    source: env["PORT"] ? "port_env" : "default",
    portFallbackUrl,
  };
}

export function resolveServerBaseUrl(
  env: Record<string, string | undefined>,
): string {
  return resolveServerBaseUrlWithSource(env).url;
}

/** Record the base URL at boot from the env. Returns the recorded URL. */
export function recordServerBaseUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  const resolved = resolveServerBaseUrlWithSource(env);
  setGlobalValue(SERVER_BASE_URL_KEY, resolved.url);
  setGlobalValue(URL_SOURCE_KEY, resolved.source);
  setGlobalValue(PORT_FALLBACK_URL_KEY, resolved.portFallbackUrl);
  setGlobalValue(BOOT_NONCE_KEY, crypto.randomUUID());
  deleteGlobalValue(VERIFICATION_STATE_KEY);
  deleteGlobalValue(VERIFICATION_PROMISE_KEY);
  return resolved.url;
}

/**
 * The base URL recorded at boot; null if startup has not run yet OR the
 * self-probe confirmed the URL belongs to a different CC instance (in which
 * case injecting nothing — cctl exit-2 usage error — beats misdirecting
 * agents at a foreign server).
 */
export function getServerBaseUrl(): string | null {
  if (getGlobalValue<VerificationState>(VERIFICATION_STATE_KEY) === "mismatch")
    return null;
  return getGlobalValue<string>(SERVER_BASE_URL_KEY) ?? null;
}

/** Per-process boot nonce, or null if startup has not recorded it. */
export function getServerBootNonce(): string | null {
  return getGlobalValue<string>(BOOT_NONCE_KEY) ?? null;
}

export interface VerifyServerBaseUrlDeps {
  fetchImpl(url: string, init: RequestInit): Promise<Response>;
  delay(ms: number): Promise<void>;
}

const defaultVerifyDeps: VerifyServerBaseUrlDeps = {
  fetchImpl: (url, init) => fetch(url, init),
  delay: sleep,
};

/**
 * Probe the recorded URL's /api/agent/identity endpoint and compare its boot
 * nonce with this process's. Memoized process-wide: concurrent/lazy callers
 * share one probe. Retries absorb the pre-listen window (register() completes
 * before the HTTP server accepts connections).
 */
export function verifyRecordedServerBaseUrl(
  deps?: Partial<VerifyServerBaseUrlDeps>,
): Promise<void> {
  const existing = getGlobalValue<Promise<void>>(VERIFICATION_PROMISE_KEY);
  if (existing !== undefined) return existing;
  const promise = runVerification({ ...defaultVerifyDeps, ...deps });
  setGlobalValue(VERIFICATION_PROMISE_KEY, promise);
  return promise;
}

async function runVerification(deps: VerifyServerBaseUrlDeps): Promise<void> {
  const recordedUrl = getGlobalValue<string>(SERVER_BASE_URL_KEY) ?? null;
  const localNonce = getServerBootNonce();
  if (recordedUrl === null || localNonce === null) return;
  const source = getGlobalValue<ServerUrlSource>(URL_SOURCE_KEY) ?? null;
  const portFallbackUrl = getGlobalValue<string>(PORT_FALLBACK_URL_KEY) ?? null;
  const probeUrl = `${recordedUrl}/api/agent/identity`;

  for (let attempt = 1; attempt <= PROBE_MAX_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await deps.fetchImpl(probeUrl, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
    } catch {
      if (attempt < PROBE_MAX_ATTEMPTS) await deps.delay(PROBE_RETRY_DELAY_MS);
      continue;
    }

    let remoteNonce: string | null = null;
    let remoteBuild: string | null = null;
    if (response.ok) {
      const parsed = identityBodySchema.safeParse(
        await response.json().catch(() => null),
      );
      if (parsed.success) {
        remoteNonce = parsed.data.instanceNonce;
        remoteBuild = parsed.data.serverBuild ?? null;
      }
    }

    if (response.ok && remoteNonce === localNonce) {
      setGlobalValue<VerificationState>(VERIFICATION_STATE_KEY, "verified");
      log.info("server-url.identity_verified", {
        recordedUrl,
        source,
        attempt,
      });
      return;
    }

    setGlobalValue<VerificationState>(VERIFICATION_STATE_KEY, "mismatch");
    log.error("server-url.identity_mismatch", {
      recordedUrl,
      portFallbackUrl,
      source,
      localNonce,
      remoteNonce,
      remoteStatus: response.status,
      remoteBuild,
    });
    return;
  }

  setGlobalValue<VerificationState>(VERIFICATION_STATE_KEY, "unverified");
  log.warn("server-url.identity_unverified", {
    recordedUrl,
    portFallbackUrl,
    source,
    attempts: PROBE_MAX_ATTEMPTS,
  });
}

export function _resetServerBaseUrlForTesting(): void {
  deleteGlobalValue(SERVER_BASE_URL_KEY);
  deleteGlobalValue(BOOT_NONCE_KEY);
  deleteGlobalValue(URL_SOURCE_KEY);
  deleteGlobalValue(PORT_FALLBACK_URL_KEY);
  deleteGlobalValue(VERIFICATION_STATE_KEY);
  deleteGlobalValue(VERIFICATION_PROMISE_KEY);
}
