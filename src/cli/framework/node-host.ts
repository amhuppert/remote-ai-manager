import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  fetch as undiciFetch,
  ProxyAgent,
  type Dispatcher,
  type RequestInit as UndiciRequestInit,
} from "undici";
import { createLogger } from "@/lib/logging";
import { sleep } from "@/lib/shared/sleep";
import { resolveSandboxProxyUrl } from "../sandbox-proxy";

import type { CliEnv, CliHost } from "../transport";

const logger = createLogger("cli.transport");
const sandboxProxyDispatchers = new Map<string, Dispatcher>();
let loggedUnavailableSandboxProxy = false;

function sandboxProxyDispatcherFor(
  env: CliEnv,
  url: string,
): Dispatcher | undefined {
  const proxyUrl = resolveSandboxProxyUrl(env, url);
  if (proxyUrl === null) {
    if (env["SANDBOX_RUNTIME"] === "1" && !loggedUnavailableSandboxProxy) {
      loggedUnavailableSandboxProxy = true;
      logger.warn("cli.transport.sandbox_proxy_unavailable", {
        hasHttpProxy:
          env["HTTP_PROXY"] !== undefined || env["http_proxy"] !== undefined,
        hasHttpsProxy:
          env["HTTPS_PROXY"] !== undefined || env["https_proxy"] !== undefined,
      });
    }
    return undefined;
  }

  const existing = sandboxProxyDispatchers.get(proxyUrl);
  if (existing !== undefined) return existing;

  const dispatcher = new ProxyAgent(proxyUrl);
  sandboxProxyDispatchers.set(proxyUrl, dispatcher);
  const parsedProxyUrl = new URL(proxyUrl);
  logger.info("cli.transport.sandbox_proxy_enabled", {
    protocol: parsedProxyUrl.protocol,
    host: parsedProxyUrl.hostname,
  });
  return dispatcher;
}

export function createNodeCliHost(env: CliEnv, signal: AbortSignal): CliHost {
  return {
    fetch: (url, init) => {
      const { timeoutMs, cleanupTimeoutMs, rawBody, ...requestInit } = init;
      if (
        cleanupTimeoutMs !== undefined &&
        (!Number.isSafeInteger(cleanupTimeoutMs) ||
          cleanupTimeoutMs < 1 ||
          cleanupTimeoutMs > 5_000)
      ) {
        throw new RangeError(
          "Cleanup requests require a deadline between 1 and 5000ms.",
        );
      }
      const requestSignal =
        cleanupTimeoutMs === undefined
          ? signal
          : AbortSignal.timeout(cleanupTimeoutMs);
      const sandboxProxyDispatcher = sandboxProxyDispatcherFor(env, url);
      const nativeInit = {
        ...requestInit,
        ...(rawBody !== undefined ? { body: rawBody } : {}),
        signal:
          timeoutMs === undefined
            ? requestSignal
            : AbortSignal.any([requestSignal, AbortSignal.timeout(timeoutMs)]),
        ...(sandboxProxyDispatcher !== undefined
          ? { dispatcher: sandboxProxyDispatcher }
          : {}),
      } satisfies UndiciRequestInit;
      return undiciFetch(url, nativeInit) as unknown as Promise<Response>;
    },
    async readTextFile(filePath) {
      try {
        return await readFile(filePath, "utf-8");
      } catch {
        return null;
      }
    },
    async readFileBytes(filePath) {
      try {
        return new Uint8Array(await readFile(filePath));
      } catch {
        return null;
      }
    },
    async writePrivateTextFile(filePath, content) {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, content, { encoding: "utf-8", mode: 0o600 });
      await chmod(filePath, 0o600);
    },
    async removeFile(filePath) {
      try {
        await unlink(filePath);
      } catch (error) {
        if (
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          error.code !== "ENOENT"
        ) {
          throw error;
        }
      }
    },
    sleep,
    now: Date.now,
    platform: os.platform(),
    homedir: os.homedir(),
  };
}
