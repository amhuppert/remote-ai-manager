import type { CliEnv } from "./shared";

function parseHttpUrl(raw: string | undefined): URL | null {
  if (raw === undefined || raw.trim() === "") return null;

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function resolveSandboxProxyUrl(
  env: CliEnv,
  requestUrl: string,
): string | null {
  if (env["SANDBOX_RUNTIME"] !== "1") return null;

  const request = parseHttpUrl(requestUrl);
  if (request === null) return null;

  const candidates =
    request.protocol === "https:"
      ? [
          env["HTTPS_PROXY"],
          env["https_proxy"],
          env["HTTP_PROXY"],
          env["http_proxy"],
        ]
      : [env["HTTP_PROXY"], env["http_proxy"]];

  for (const candidate of candidates) {
    const proxy = parseHttpUrl(candidate);
    if (proxy !== null) return proxy.toString();
  }

  return null;
}
