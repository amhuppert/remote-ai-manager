import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDocumentsRouteHandlers,
  type DocumentsRouteDeps,
} from "./route-handlers";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";

const PROJECT_PATH = "/proj";
const PROJECT_NAME = "proj";
const WORKTREE = `${PROJECT_PATH}/.worktrees/sess`;

function enoent(): NodeJS.ErrnoException {
  const err = new Error("ENOENT") as NodeJS.ErrnoException;
  err.code = "ENOENT";
  return err;
}

function depsFromFixture(
  fx: PersistenceFixture,
  files: Record<string, string>,
): { deps: DocumentsRouteDeps; readPaths: string[] } {
  const readPaths: string[] = [];
  const deps: DocumentsRouteDeps = {
    resolveProjectPath: async (name) =>
      name === PROJECT_NAME ? PROJECT_PATH : null,
    getSession: fx.store.getSession,
    getSessionMarkdownDocuments: fx.store.getSessionMarkdownDocuments,
    isSessionMarkdownDocumentIndexed: fx.store.isSessionMarkdownDocumentIndexed,
    readFile: async (absPath) => {
      readPaths.push(absPath);
      const content = files[absPath];
      if (content === undefined) throw enoent();
      return content;
    },
  };
  return { deps, readPaths };
}

function get(path: string | null): Request {
  const base = `http://localhost/api/projects/${PROJECT_NAME}/sessions/sess/document-content`;
  const url = path === null ? base : `${base}?path=${encodeURIComponent(path)}`;
  return new Request(url);
}

const params = {
  params: Promise.resolve({ name: PROJECT_NAME, session: "sess" }),
};

describe("documents content route handler", () => {
  let fx: PersistenceFixture;

  beforeEach(() => {
    fx = createPersistenceFixture();
    fx.seedProject(PROJECT_PATH);
    fx.seedSession(PROJECT_PATH, "sess");
  });

  afterEach(() => {
    fx.close();
  });

  it("returns { content, docPath } for a valid worktree-relative .md path", async () => {
    const { deps, readPaths } = depsFromFixture(fx, {
      [`${WORKTREE}/docs/guide.md`]: "# Guide",
    });
    const handlers = createDocumentsRouteHandlers(deps);
    const res = await handlers.GET(get("docs/guide.md"), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      content: "# Guide",
      docPath: "docs/guide.md",
    });
    expect(readPaths).toEqual([`${WORKTREE}/docs/guide.md`]);
  });

  it("normalizes an absolute-inside path to a worktree-relative docPath", async () => {
    const { deps } = depsFromFixture(fx, {
      [`${WORKTREE}/docs/guide.md`]: "# Guide",
    });
    const handlers = createDocumentsRouteHandlers(deps);
    const res = await handlers.GET(get(`${WORKTREE}/docs/guide.md`), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      content: "# Guide",
      docPath: "docs/guide.md",
    });
  });

  it("returns 404 for a missing file", async () => {
    const { deps } = depsFromFixture(fx, {});
    const handlers = createDocumentsRouteHandlers(deps);
    const res = await handlers.GET(get("docs/missing.md"), params);
    expect(res.status).toBe(404);
  });

  it("returns 404 for an absolute path outside the worktree (no read attempted)", async () => {
    const { deps, readPaths } = depsFromFixture(fx, {});
    const handlers = createDocumentsRouteHandlers(deps);
    const res = await handlers.GET(get("/etc/secret.md"), params);
    expect(res.status).toBe(404);
    expect(readPaths).toEqual([]);
  });

  it("reads an indexed absolute path outside the worktree", async () => {
    await fx.store.upsertSessionMarkdownDocuments(PROJECT_PATH, "sess", [
      {
        docPath: "/shared/runbook.md",
        origin: "read",
        firstSeenAt: "2026-07-11T10:00:00.000Z",
        lastSeenAt: "2026-07-11T10:00:00.000Z",
      },
    ]);
    const { deps, readPaths } = depsFromFixture(fx, {
      "/shared/runbook.md": "# Runbook",
    });
    const handlers = createDocumentsRouteHandlers(deps);

    const res = await handlers.GET(get("/shared/runbook.md"), params);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      content: "# Runbook",
      docPath: "/shared/runbook.md",
    });
    expect(readPaths).toEqual(["/shared/runbook.md"]);
  });

  it("reads a registered absolute path outside the worktree", async () => {
    await fx.store.createReferenceDocument(
      PROJECT_PATH,
      "sess",
      "/shared/registered.md",
      "Shared document",
    );
    const { deps } = depsFromFixture(fx, {
      "/shared/registered.md": "# Registered",
    });
    const handlers = createDocumentsRouteHandlers(deps);

    const res = await handlers.GET(get("/shared/registered.md"), params);

    expect(res.status).toBe(200);
  });

  it("returns the unified Markdown list", async () => {
    await fx.store.upsertSessionMarkdownDocuments(PROJECT_PATH, "sess", [
      {
        docPath: "docs/plan.md",
        origin: "edit",
        firstSeenAt: "2026-07-11T10:00:00.000Z",
        lastSeenAt: "2026-07-11T11:00:00.000Z",
      },
    ]);
    await fx.store.createReferenceDocument(
      PROJECT_PATH,
      "sess",
      "/shared/registered.md",
      "Shared document",
    );
    const { deps } = depsFromFixture(fx, {});
    const handlers = createDocumentsRouteHandlers(deps);

    const res = await handlers.LIST(new Request("http://localhost"), params);

    expect(res.status).toBe(200);
    expect((await res.json()) as unknown[]).toHaveLength(2);
  });

  it("returns 400 for a non-markdown path", async () => {
    const { deps } = depsFromFixture(fx, {});
    const handlers = createDocumentsRouteHandlers(deps);
    const res = await handlers.GET(get("docs/guide.txt"), params);
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unindexed relative path outside the worktree", async () => {
    const { deps, readPaths } = depsFromFixture(fx, {});
    const handlers = createDocumentsRouteHandlers(deps);
    const res = await handlers.GET(get("../../etc/secret.md"), params);
    expect(res.status).toBe(404);
    expect(readPaths).toEqual([]);
  });

  it("returns 400 when the path query is missing", async () => {
    const { deps } = depsFromFixture(fx, {});
    const handlers = createDocumentsRouteHandlers(deps);
    const res = await handlers.GET(get(null), params);
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown project", async () => {
    const { deps } = depsFromFixture(fx, {});
    const handlers = createDocumentsRouteHandlers(deps);
    const res = await handlers.GET(get("docs/guide.md"), {
      params: Promise.resolve({ name: "nope", session: "sess" }),
    });
    expect(res.status).toBe(404);
  });
});
