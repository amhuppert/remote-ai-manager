import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cctlInstallPath } from "./install-cli";
import { createAgentGatewayHandlers } from "./route-handlers";

const SERVER_BUILD = "abc1234-2026-07-02T10:00:00.000Z";
const TOKEN = "test-instance-token";
const BOOT_NONCE = "nonce-1234";

let dir: string;
let handlers: ReturnType<typeof createAgentGatewayHandlers>;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "cc-gateway-"));
  await writeFile(path.join(dir, "api-token"), `${TOKEN}\n`, { mode: 0o600 });
  handlers = createAgentGatewayHandlers({
    configDir: dir,
    getServerBuildStamp: () => SERVER_BUILD,
    getBootNonce: () => BOOT_NONCE,
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function handshakeRequest(options?: {
  token?: string | null;
  cliBuild?: string;
  query?: string;
}): Request {
  const headers = new Headers();
  const token = options?.token === undefined ? TOKEN : options.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  if (options?.cliBuild) headers.set("x-cc-cli-build", options.cliBuild);
  return new Request(
    `http://localhost/api/agent/handshake${options?.query ?? ""}`,
    { headers },
  );
}

describe("GET /api/agent/handshake", () => {
  it("returns server build, echoed identity, and tokenValid for a valid token", async () => {
    const res = await handlers.handshakeGET(
      handshakeRequest({
        query: "?project=cc&session=my-session&conversation=conv-1",
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      serverBuild: SERVER_BUILD,
      identity: {
        project: "cc",
        session: "my-session",
        conversation: "conv-1",
      },
      tokenValid: true,
      // The recovery for a build mismatch is this server's own binary, so the
      // handshake has to name it rather than leave the caller guessing.
      cliPath: cctlInstallPath(dir),
      // Two CC instances are distinguishable only by the state they own, and
      // this is that identity: same config dir means same DB, logs, and
      // transcripts. It is the tell for "my CLI and the UI disagree".
      configDir: dir,
    });
  });

  it("returns null identity fields when query params are absent", async () => {
    const res = await handlers.handshakeGET(handshakeRequest());
    const body = await res.json();
    expect(body.identity).toEqual({
      project: null,
      session: null,
      conversation: null,
    });
  });

  it("rejects a missing token with 401", async () => {
    const res = await handlers.handshakeGET(handshakeRequest({ token: null }));
    expect(res.status).toBe(401);
  });

  it("rejects a wrong token with 401", async () => {
    const res = await handlers.handshakeGET(
      handshakeRequest({ token: "wrong" }),
    );
    expect(res.status).toBe(401);
  });

  it("adds a build-mismatch warning header when the CLI stamp differs", async () => {
    const res = await handlers.handshakeGET(
      handshakeRequest({ cliBuild: "old0000-2026-01-01T00:00:00.000Z" }),
    );

    expect(res.status).toBe(200);
    const warning = res.headers.get("x-cc-build-mismatch");
    expect(warning).toContain(SERVER_BUILD);
    expect(warning).toContain("old0000-2026-01-01T00:00:00.000Z");
  });

  it("adds no mismatch header when the CLI stamp matches", async () => {
    const res = await handlers.handshakeGET(
      handshakeRequest({ cliBuild: SERVER_BUILD }),
    );
    expect(res.headers.get("x-cc-build-mismatch")).toBeNull();
  });
});

describe("GET /api/agent/identity", () => {
  it("returns the boot nonce and build stamp without any token", async () => {
    const res = await handlers.identityGET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      instanceNonce: BOOT_NONCE,
      serverBuild: SERVER_BUILD,
    });
  });

  it("responds with a null nonce (not an error) before boot records one", async () => {
    const unbooted = createAgentGatewayHandlers({
      configDir: dir,
      getServerBuildStamp: () => SERVER_BUILD,
      getBootNonce: () => null,
    });

    const res = await unbooted.identityGET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      instanceNonce: null,
      serverBuild: SERVER_BUILD,
    });
  });
});
