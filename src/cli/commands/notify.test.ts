import { describe, expect, it } from "vitest";
import { runCli } from "../core";
import type { CliEnv, CliHost, FetchInit } from "../shared";

const baseEnv: CliEnv = {
  CC_SERVER_URL: "http://127.0.0.1:3000",
  CC_API_TOKEN: "env-token",
  CC_PROJECT: "cc",
  CC_SESSION: "my-session",
  CC_CONVERSATION_ID: "conv-1",
};

interface RecordedRequest {
  url: string;
  init: FetchInit;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeHost(
  respond: (req: RecordedRequest) => Response,
): CliHost & { requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  return {
    requests,
    async fetch(url, init) {
      const req = { url, init };
      requests.push(req);
      return respond(req);
    },
    async readTextFile() {
      return null;
    },
    async readFileBytes() {
      return null;
    },
    async sleep() {},
    platform: "darwin",
    homedir: "/Users/test",
  };
}

describe("cctl notify", () => {
  it("POSTs the message to the session notifications endpoint and exits 0", async () => {
    const host = makeHost(() => jsonResponse({ ok: true }));
    const result = await runCli(["notify", "Build finished"], baseEnv, host);

    expect(result.exitCode).toBe(0);
    const request = host.requests[0];
    expect(request).toBeDefined();
    if (!request) return;
    expect(new URL(request.url).pathname).toBe(
      "/api/projects/cc/sessions/my-session/notifications",
    );
    expect(request.init.method).toBe("POST");
    expect(request.init.headers["authorization"]).toBe("Bearer env-token");
    expect(JSON.parse(request.init.body ?? "{}")).toEqual({
      message: "Build finished",
    });
  });

  it("threads --title into the request body", async () => {
    const host = makeHost(() => jsonResponse({ ok: true }));
    await runCli(["notify", "Done", "--title", "Heads up"], baseEnv, host);
    expect(JSON.parse(host.requests[0]?.init.body ?? "{}")).toEqual({
      message: "Done",
      title: "Heads up",
    });
  });

  it("emits NO hint on success (a notification is terminal)", async () => {
    const host = makeHost(() => jsonResponse({ ok: true }));
    const text = await runCli(["notify", "hi"], baseEnv, host);
    expect(text.stdout).not.toContain("hint:");

    const json = await runCli(["notify", "hi", "--json"], baseEnv, host);
    const envelope = JSON.parse(json.stdout);
    expect(envelope.ok).toBe(true);
    expect("hint" in envelope).toBe(false);
  });

  it("exits 1 with the server's one-line reason when push is unconfigured (409)", async () => {
    const host = makeHost(() =>
      jsonResponse({ error: "Push notifications are not configured" }, 409),
    );
    const result = await runCli(["notify", "hi"], baseEnv, host);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.split("\n")[0]).toContain(
      "Push notifications are not configured",
    );
    expect(result.stderr).not.toContain("hint:");
  });

  it("exits 3 when the server rejects the token", async () => {
    const host = makeHost(() => jsonResponse({ error: "nope" }, 401));
    const result = await runCli(["notify", "hi"], baseEnv, host);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("token");
  });

  it("exits 2 when no message is provided", async () => {
    const host = makeHost(() => jsonResponse({ ok: true }));
    const result = await runCli(["notify"], baseEnv, host);
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });

  it("exits 2 naming CC_SESSION when session identity is missing", async () => {
    const host = makeHost(() => jsonResponse({ ok: true }));
    const env: CliEnv = { ...baseEnv };
    delete env["CC_SESSION"];
    const result = await runCli(["notify", "hi"], env, host);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("CC_SESSION");
    expect(host.requests).toHaveLength(0);
  });

  it("rejects unknown flags with exit 2", async () => {
    const host = makeHost(() => jsonResponse({ ok: true }));
    const result = await runCli(["notify", "hi", "--frob", "x"], baseEnv, host);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--frob");
  });
});
