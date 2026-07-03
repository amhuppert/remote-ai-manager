import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentAuth } from "@/lib/agent-gateway/token";
import { createReferenceDocumentMutationHandlers } from "@/lib/sessions/reference-documents-route-handlers";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { runCli } from "../core";
import type { CliEnv, CliHost } from "../shared";

/**
 * Contract layer per doc 01 §8: the real CLI core driving the real reference-
 * document POST/DELETE route handlers in-process over a real :memory: store,
 * so register → list → delete is a genuine SQLite round-trip. The GET leaf is a
 * thin fixture-backed shim returning the production array shape (the list route
 * is a pre-existing, non-DI GET; the two NEW endpoints — POST and DELETE — run
 * as production handlers here).
 */

const PROJECT_PATH = "/repos/cc";
const SESSION = "sess";
const WORKTREE = `${PROJECT_PATH}/.worktrees/${SESSION}`;
const TOKEN = "contract-token";

let dir: string;
let fixture: ReturnType<typeof createPersistenceFixture>;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "cctl-docs-"));
  await writeFile(path.join(dir, "api-token"), `${TOKEN}\n`, { mode: 0o600 });
  fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT_PATH);
  fixture.seedSession(PROJECT_PATH, SESSION, { worktreePath: WORKTREE });
});

afterEach(async () => {
  fixture.close();
  await rm(dir, { recursive: true, force: true });
});

function makeHost(): CliHost {
  const handlers = createReferenceDocumentMutationHandlers({
    auth: createAgentAuth({ configDir: dir }),
    async resolveProjectPath() {
      return PROJECT_PATH;
    },
    getSession: fixture.store.getSession,
    createReferenceDocument: fixture.store.createReferenceDocument,
    deleteReferenceDocument: fixture.store.deleteReferenceDocument,
    // File deletion is exercised by the route-handler test; here it is inert.
    async deleteFile() {},
  });

  return {
    async fetch(url, init) {
      const parsed = new URL(url);
      const segments = parsed.pathname.split("/").filter(Boolean);
      // /api/projects/<name>/sessions/<session>/reference-documents[/<id>]
      const name = decodeURIComponent(segments[2] ?? "");
      const session = decodeURIComponent(segments[4] ?? "");
      const id = segments[6] ? decodeURIComponent(segments[6]) : undefined;
      const request = new Request(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
      });

      if (init.method === "GET") {
        const docs = await fixture.store.getReferenceDocuments(
          PROJECT_PATH,
          session,
        );
        return NextResponse.json(docs);
      }
      if (init.method === "DELETE") {
        return handlers.DELETE(request, {
          params: Promise.resolve({ name, session, id: id ?? "" }),
        });
      }
      return handlers.POST(request, {
        params: Promise.resolve({ name, session }),
      });
    },
    async readTextFile(filePath) {
      try {
        return await readFile(filePath, "utf-8");
      } catch {
        return null;
      }
    },
    async sleep() {},
    platform: os.platform(),
    homedir: os.homedir(),
  };
}

function makeEnv(overrides: CliEnv = {}): CliEnv {
  return {
    CC_SERVER_URL: "http://127.0.0.1:4999",
    CC_API_TOKEN: TOKEN,
    CC_PROJECT: "cc",
    CC_SESSION: SESSION,
    ...overrides,
  };
}

describe("cctl docs against the real reference-document handlers", () => {
  it("register → list → delete round-trips through the real store", async () => {
    const host = makeHost();

    const registered = await runCli(
      ["docs", "register", "docs/a.md", "--description", "why it matters"],
      makeEnv(),
      host,
    );
    expect(registered.exitCode).toBe(0);

    const listed = await runCli(["docs", "list", "--json"], makeEnv(), host);
    const envelope = JSON.parse(listed.stdout);
    expect(envelope.documents).toHaveLength(1);
    expect(envelope.documents[0].filePath).toBe("docs/a.md");
    const id = envelope.documents[0].id as string;

    const deleted = await runCli(["docs", "delete", id], makeEnv(), host);
    expect(deleted.exitCode).toBe(0);

    const afterDelete = await runCli(
      ["docs", "list", "--json"],
      makeEnv(),
      host,
    );
    expect(JSON.parse(afterDelete.stdout).documents).toHaveLength(0);
  });

  it("re-registering the same path does not duplicate (idempotent upsert)", async () => {
    const host = makeHost();
    await runCli(
      ["docs", "register", "docs/a.md", "--description", "first"],
      makeEnv(),
      host,
    );
    await runCli(
      ["docs", "register", "docs/a.md", "--description", "second"],
      makeEnv(),
      host,
    );

    const listed = await runCli(["docs", "list", "--json"], makeEnv(), host);
    const envelope = JSON.parse(listed.stdout);
    expect(envelope.documents).toHaveLength(1);
    expect(envelope.documents[0].description).toBe("second");
  });

  it("exits 2 on a worktree-escaping path via the real guard", async () => {
    const result = await runCli(
      ["docs", "register", "../../etc/passwd", "--description", "evil"],
      makeEnv(),
      makeHost(),
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("worktree");
  });

  it("exits 3 when the real token gate rejects a wrong token", async () => {
    const result = await runCli(
      ["docs", "register", "docs/a.md", "--description", "why"],
      makeEnv({ CC_API_TOKEN: "wrong" }),
      makeHost(),
    );
    expect(result.exitCode).toBe(3);
  });
});
