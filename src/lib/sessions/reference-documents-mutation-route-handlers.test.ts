import { describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import type { AgentAuth } from "@/lib/agent-gateway/token";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import {
  createReferenceDocumentMutationHandlers,
  resolveInsideWorktree,
  type ReferenceDocumentMutationDeps,
} from "./reference-documents-route-handlers";

const PROJECT_PATH = "/repos/cc";
const SESSION = "sess";
const WORKTREE = `${PROJECT_PATH}/.worktrees/${SESSION}`;

function authAllows(): AgentAuth {
  return {
    async requireToken() {
      return null;
    },
    async validateOptionalToken() {
      return { kind: "valid" };
    },
  };
}

function authDenies(): AgentAuth {
  return {
    async requireToken() {
      return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    },
    async validateOptionalToken() {
      return { kind: "invalid" };
    },
  };
}

/**
 * Build deps backed by a real `:memory:` store so register/delete exercise a
 * genuine SQLite round-trip (the persistence-fixture requirement for these
 * tests). `getReferenceDocuments` reads back through the same store.
 */
function makeFixtureDeps(
  overrides: Partial<ReferenceDocumentMutationDeps> = {},
) {
  const fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT_PATH);
  fixture.seedSession(PROJECT_PATH, SESSION, { worktreePath: WORKTREE });

  const deleteFile = vi.fn(async () => {});
  const deps: ReferenceDocumentMutationDeps = {
    auth: authAllows(),
    async resolveProjectPath() {
      return PROJECT_PATH;
    },
    getSession: fixture.store.getSession,
    createReferenceDocument: fixture.store.createReferenceDocument,
    deleteReferenceDocument: fixture.store.deleteReferenceDocument,
    deleteFile,
    ...overrides,
  };
  return { fixture, deps, deleteFile };
}

function postRequest(body: unknown): Request {
  return new Request(
    `http://127.0.0.1/api/projects/cc/sessions/${SESSION}/reference-documents`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
  );
}

function deleteRequest(): Request {
  return new Request(
    `http://127.0.0.1/api/projects/cc/sessions/${SESSION}/reference-documents/x`,
    { method: "DELETE" },
  );
}

const postParams = Promise.resolve({ name: "cc", session: SESSION });
function deleteParams(id: string) {
  return Promise.resolve({ name: "cc", session: SESSION, id });
}

describe("resolveInsideWorktree", () => {
  it("resolves a relative path against the worktree", () => {
    expect(resolveInsideWorktree("/repos/cc/wt", "docs/a.md")).toBe(
      "/repos/cc/wt/docs/a.md",
    );
  });

  it("accepts an absolute path inside the worktree", () => {
    expect(
      resolveInsideWorktree("/repos/cc/wt", "/repos/cc/wt/docs/a.md"),
    ).toBe("/repos/cc/wt/docs/a.md");
  });

  it("rejects a relative path that escapes the worktree", () => {
    expect(
      resolveInsideWorktree("/repos/cc/wt", "../../etc/passwd"),
    ).toBeNull();
  });

  it("rejects an absolute path outside the worktree", () => {
    expect(resolveInsideWorktree("/repos/cc/wt", "/etc/passwd")).toBeNull();
  });
});

describe("POST reference-documents", () => {
  it("registers a document and it round-trips through the store", async () => {
    const { fixture, deps } = makeFixtureDeps();
    const { POST } = createReferenceDocumentMutationHandlers(deps);

    const res = await POST(
      postRequest({ filePath: "docs/a.md", description: "why it matters" }),
      { params: postParams },
    );

    expect(res.status).toBe(200);
    const stored = await fixture.store.getReferenceDocuments(
      PROJECT_PATH,
      SESSION,
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      filePath: "docs/a.md",
      description: "why it matters",
    });
    fixture.close();
  });

  it("upserts (no duplicate) when the same path is registered twice", async () => {
    const { fixture, deps } = makeFixtureDeps();
    const { POST } = createReferenceDocumentMutationHandlers(deps);

    await POST(postRequest({ filePath: "docs/a.md", description: "first" }), {
      params: postParams,
    });
    await POST(postRequest({ filePath: "docs/a.md", description: "second" }), {
      params: postParams,
    });

    const stored = await fixture.store.getReferenceDocuments(
      PROJECT_PATH,
      SESSION,
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]?.description).toBe("second");
    fixture.close();
  });

  it("rejects a worktree-escaping path with 400 and stores nothing", async () => {
    const { fixture, deps } = makeFixtureDeps();
    const { POST } = createReferenceDocumentMutationHandlers(deps);

    const res = await POST(
      postRequest({ filePath: "../../etc/passwd", description: "evil" }),
      { params: postParams },
    );

    expect(res.status).toBe(400);
    const stored = await fixture.store.getReferenceDocuments(
      PROJECT_PATH,
      SESSION,
    );
    expect(stored).toHaveLength(0);
    fixture.close();
  });

  it("returns 400 for an empty description", async () => {
    const { fixture, deps } = makeFixtureDeps();
    const { POST } = createReferenceDocumentMutationHandlers(deps);

    const res = await POST(
      postRequest({ filePath: "docs/a.md", description: "" }),
      { params: postParams },
    );

    expect(res.status).toBe(400);
    fixture.close();
  });

  it("rejects a missing/invalid token with 401 and stores nothing", async () => {
    const { fixture, deps } = makeFixtureDeps({ auth: authDenies() });
    const { POST } = createReferenceDocumentMutationHandlers(deps);

    const res = await POST(
      postRequest({ filePath: "docs/a.md", description: "why" }),
      { params: postParams },
    );

    expect(res.status).toBe(401);
    const stored = await fixture.store.getReferenceDocuments(
      PROJECT_PATH,
      SESSION,
    );
    expect(stored).toHaveLength(0);
    fixture.close();
  });

  it("returns 404 when the session does not exist", async () => {
    const { fixture, deps } = makeFixtureDeps({
      async getSession() {
        return null;
      },
    });
    const { POST } = createReferenceDocumentMutationHandlers(deps);

    const res = await POST(
      postRequest({ filePath: "docs/a.md", description: "why" }),
      { params: postParams },
    );

    expect(res.status).toBe(404);
    fixture.close();
  });
});

describe("DELETE reference-documents/[id]", () => {
  it("deletes a registered document and removes its file", async () => {
    const { fixture, deps, deleteFile } = makeFixtureDeps();
    const { POST, DELETE } = createReferenceDocumentMutationHandlers(deps);

    await POST(postRequest({ filePath: "docs/a.md", description: "why" }), {
      params: postParams,
    });
    const [doc] = await fixture.store.getReferenceDocuments(
      PROJECT_PATH,
      SESSION,
    );
    const id = doc!.id;

    const res = await DELETE(deleteRequest(), { params: deleteParams(id) });

    expect(res.status).toBe(200);
    const stored = await fixture.store.getReferenceDocuments(
      PROJECT_PATH,
      SESSION,
    );
    expect(stored).toHaveLength(0);
    expect(deleteFile).toHaveBeenCalledWith(`${WORKTREE}/docs/a.md`);
    fixture.close();
  });

  it("returns 404 when the document id is unknown", async () => {
    const { fixture, deps, deleteFile } = makeFixtureDeps();
    const { DELETE } = createReferenceDocumentMutationHandlers(deps);

    const res = await DELETE(deleteRequest(), {
      params: deleteParams("nope"),
    });

    expect(res.status).toBe(404);
    expect(deleteFile).not.toHaveBeenCalled();
    fixture.close();
  });

  it("rejects a missing/invalid token with 401 and never deletes", async () => {
    const { fixture, deps, deleteFile } = makeFixtureDeps({
      auth: authDenies(),
    });
    const { DELETE } = createReferenceDocumentMutationHandlers(deps);

    const res = await DELETE(deleteRequest(), {
      params: deleteParams("any"),
    });

    expect(res.status).toBe(401);
    expect(deleteFile).not.toHaveBeenCalled();
    fixture.close();
  });
});
