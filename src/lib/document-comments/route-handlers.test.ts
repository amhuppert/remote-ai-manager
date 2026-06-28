import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDocumentCommentsRouteHandlers,
  type DocumentCommentsRouteDeps,
} from "./route-handlers";
import type { CommentAnchor } from "./schemas";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";

const PROJECT_PATH = "/proj";
const PROJECT_NAME = "proj";

function anchor(overrides: Partial<CommentAnchor> = {}): CommentAnchor {
  return {
    sectionId: "overview",
    headingLabel: "1. Overview",
    line: 12,
    charStart: 4,
    charEnd: 18,
    quote: "selected words",
    prefix: "the ",
    suffix: " here",
    docRevision: "rev-1",
    ...overrides,
  };
}

/** Build route deps from a real-store fixture; only project resolution + the
 * id/clock are stubbed (filesystem/config + nondeterminism boundaries). */
function depsFromFixture(
  fx: PersistenceFixture,
  ids: string[],
): DocumentCommentsRouteDeps {
  let i = 0;
  return {
    resolveProjectPath: async (name) =>
      name === PROJECT_NAME ? PROJECT_PATH : null,
    getSession: fx.store.getSession,
    getDocumentComments: fx.store.getDocumentComments,
    getDocumentCommentInScope: fx.store.getDocumentCommentInScope,
    upsertDocumentComment: fx.store.upsertDocumentComment,
    deleteDocumentComment: fx.store.deleteDocumentComment,
    now: () => "2026-02-02T00:00:00.000Z",
    newId: () => ids[i++] ?? `auto-${i}`,
  };
}

function postRequest(body: unknown): Request {
  return new Request(
    `http://localhost/api/projects/${PROJECT_NAME}/sessions/sess-a/document-comments`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function params(extra: Record<string, string>) {
  return { params: Promise.resolve({ name: PROJECT_NAME, ...extra }) };
}

describe("document-comments route handlers", () => {
  let fx: PersistenceFixture;

  beforeEach(() => {
    fx = createPersistenceFixture();
    fx.seedProject(PROJECT_PATH);
    fx.seedSession(PROJECT_PATH, "sess-a");
    fx.seedSession(PROJECT_PATH, "sess-b");
  });

  afterEach(() => {
    fx.close();
  });

  async function createComment(
    deps: DocumentCommentsRouteDeps,
    session: string,
    body: { docPath: string; anchor: CommentAnchor; note: string },
  ) {
    const handlers = createDocumentCommentsRouteHandlers(deps);
    const res = await handlers.POST(
      new Request(
        `http://localhost/api/projects/${PROJECT_NAME}/sessions/${session}/document-comments`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      ),
      params({ session }),
    );
    return res;
  }

  it("POST creates a comment scoped to the route, round-tripping through the repo", async () => {
    const deps = depsFromFixture(fx, ["comment-1"]);
    const handlers = createDocumentCommentsRouteHandlers(deps);

    const res = await handlers.POST(
      postRequest({
        docPath: "docs/guide.md",
        anchor: anchor(),
        note: "fix this heading",
      }),
      params({ session: "sess-a" }),
    );

    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created).toMatchObject({
      id: "comment-1",
      projectPath: PROJECT_PATH,
      sessionName: "sess-a",
      docPath: "docs/guide.md",
      note: "fix this heading",
      status: "pending",
      sentAt: null,
    });

    const persisted = await fx.store.getDocumentComments(
      PROJECT_PATH,
      "sess-a",
      "docs/guide.md",
    );
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.id).toBe("comment-1");
    expect(persisted[0]?.anchor.quote).toBe("selected words");
  });

  it("POST ignores body-supplied scope and uses the route's project/session", async () => {
    const deps = depsFromFixture(fx, ["comment-1"]);
    const handlers = createDocumentCommentsRouteHandlers(deps);

    const res = await handlers.POST(
      postRequest({
        docPath: "docs/guide.md",
        anchor: anchor(),
        note: "n",
        // attacker-supplied scope that must be ignored
        projectPath: "/evil",
        sessionName: "sess-b",
      }),
      params({ session: "sess-a" }),
    );
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.projectPath).toBe(PROJECT_PATH);
    expect(created.sessionName).toBe("sess-a");
  });

  it("POST normalizes an absolute-inside path to the worktree-relative docPath", async () => {
    const deps = depsFromFixture(fx, ["comment-1"]);
    const handlers = createDocumentCommentsRouteHandlers(deps);

    const res = await handlers.POST(
      postRequest({
        docPath: `${PROJECT_PATH}/.worktrees/sess-a/docs/guide.md`,
        anchor: anchor(),
        note: "n",
      }),
      params({ session: "sess-a" }),
    );
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.docPath).toBe("docs/guide.md");
  });

  it("POST rejects a non-markdown path with 400", async () => {
    const deps = depsFromFixture(fx, ["comment-1"]);
    const handlers = createDocumentCommentsRouteHandlers(deps);
    const res = await handlers.POST(
      postRequest({ docPath: "docs/guide.txt", anchor: anchor(), note: "n" }),
      params({ session: "sess-a" }),
    );
    expect(res.status).toBe(400);
  });

  it("POST rejects a malformed body with 400", async () => {
    const deps = depsFromFixture(fx, ["comment-1"]);
    const handlers = createDocumentCommentsRouteHandlers(deps);
    const res = await handlers.POST(
      postRequest({ docPath: "docs/guide.md", note: "n" }),
      params({ session: "sess-a" }),
    );
    expect(res.status).toBe(400);
  });

  it("POST rejects charStart > charEnd with 400", async () => {
    const deps = depsFromFixture(fx, ["comment-1"]);
    const handlers = createDocumentCommentsRouteHandlers(deps);
    const res = await handlers.POST(
      postRequest({
        docPath: "docs/guide.md",
        anchor: anchor({ charStart: 20, charEnd: 4 }),
        note: "n",
      }),
      params({ session: "sess-a" }),
    );
    expect(res.status).toBe(400);
  });

  it("POST returns 404 for an unknown project", async () => {
    const deps = depsFromFixture(fx, ["comment-1"]);
    const handlers = createDocumentCommentsRouteHandlers(deps);
    const res = await handlers.POST(
      new Request(
        `http://localhost/api/projects/nope/sessions/sess-a/document-comments`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            docPath: "docs/guide.md",
            anchor: anchor(),
            note: "n",
          }),
        },
      ),
      { params: Promise.resolve({ name: "nope", session: "sess-a" }) },
    );
    expect(res.status).toBe(404);
  });

  it("GET lists comments for a docPath", async () => {
    const deps = depsFromFixture(fx, ["c1", "c2"]);
    await createComment(deps, "sess-a", {
      docPath: "docs/guide.md",
      anchor: anchor(),
      note: "first",
    });
    await createComment(deps, "sess-a", {
      docPath: "docs/other.md",
      anchor: anchor(),
      note: "elsewhere",
    });

    const handlers = createDocumentCommentsRouteHandlers(deps);
    const res = await handlers.GET(
      new Request(
        `http://localhost/api/projects/${PROJECT_NAME}/sessions/sess-a/document-comments?docPath=docs/guide.md`,
      ),
      params({ session: "sess-a" }),
    );
    expect(res.status).toBe(200);
    const list = await res.json();
    expect(list).toHaveLength(1);
    expect(list[0].note).toBe("first");
  });

  it("GET without a docPath query returns 400", async () => {
    const deps = depsFromFixture(fx, []);
    const handlers = createDocumentCommentsRouteHandlers(deps);
    const res = await handlers.GET(
      new Request(
        `http://localhost/api/projects/${PROJECT_NAME}/sessions/sess-a/document-comments`,
      ),
      params({ session: "sess-a" }),
    );
    expect(res.status).toBe(400);
  });

  it("PATCH updates note and flips status to sent, stamping sentAt", async () => {
    const deps = depsFromFixture(fx, ["comment-1"]);
    await createComment(deps, "sess-a", {
      docPath: "docs/guide.md",
      anchor: anchor(),
      note: "original",
    });

    const handlers = createDocumentCommentsRouteHandlers(deps);
    const res = await handlers.PATCH(
      new Request(
        `http://localhost/api/projects/${PROJECT_NAME}/sessions/sess-a/document-comments/comment-1`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ note: "edited", status: "sent" }),
        },
      ),
      params({ session: "sess-a", id: "comment-1" }),
    );
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.note).toBe("edited");
    expect(updated.status).toBe("sent");
    expect(updated.sentAt).toBe("2026-02-02T00:00:00.000Z");

    const [persisted] = await fx.store.getDocumentComments(
      PROJECT_PATH,
      "sess-a",
      "docs/guide.md",
    );
    expect(persisted?.note).toBe("edited");
    expect(persisted?.status).toBe("sent");
  });

  it("PATCH flipping a sent comment back to pending clears sentAt", async () => {
    const deps = depsFromFixture(fx, ["comment-1"]);
    await createComment(deps, "sess-a", {
      docPath: "docs/guide.md",
      anchor: anchor(),
      note: "original",
    });
    const handlers = createDocumentCommentsRouteHandlers(deps);
    await handlers.PATCH(
      new Request(
        `http://localhost/api/projects/${PROJECT_NAME}/sessions/sess-a/document-comments/comment-1`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "sent" }),
        },
      ),
      params({ session: "sess-a", id: "comment-1" }),
    );
    const res = await handlers.PATCH(
      new Request(
        `http://localhost/api/projects/${PROJECT_NAME}/sessions/sess-a/document-comments/comment-1`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ note: "changed", status: "pending" }),
        },
      ),
      params({ session: "sess-a", id: "comment-1" }),
    );
    const updated = await res.json();
    expect(updated.status).toBe("pending");
    expect(updated.sentAt).toBeNull();
  });

  it("PATCH for an unknown id returns 404", async () => {
    const deps = depsFromFixture(fx, []);
    const handlers = createDocumentCommentsRouteHandlers(deps);
    const res = await handlers.PATCH(
      new Request(
        `http://localhost/api/projects/${PROJECT_NAME}/sessions/sess-a/document-comments/missing`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ note: "x" }),
        },
      ),
      params({ session: "sess-a", id: "missing" }),
    );
    expect(res.status).toBe(404);
  });

  it("PATCH with an id from another session returns 404 and leaves the comment unchanged", async () => {
    const deps = depsFromFixture(fx, ["comment-1"]);
    await createComment(deps, "sess-a", {
      docPath: "docs/guide.md",
      anchor: anchor(),
      note: "original",
    });

    const handlers = createDocumentCommentsRouteHandlers(deps);
    // route addresses sess-b, but the id belongs to sess-a
    const res = await handlers.PATCH(
      new Request(
        `http://localhost/api/projects/${PROJECT_NAME}/sessions/sess-b/document-comments/comment-1`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ note: "hijacked", status: "sent" }),
        },
      ),
      params({ session: "sess-b", id: "comment-1" }),
    );
    expect(res.status).toBe(404);

    const [unchanged] = await fx.store.getDocumentComments(
      PROJECT_PATH,
      "sess-a",
      "docs/guide.md",
    );
    expect(unchanged?.note).toBe("original");
    expect(unchanged?.status).toBe("pending");
  });

  it("DELETE removes a comment in scope", async () => {
    const deps = depsFromFixture(fx, ["comment-1"]);
    await createComment(deps, "sess-a", {
      docPath: "docs/guide.md",
      anchor: anchor(),
      note: "original",
    });
    const handlers = createDocumentCommentsRouteHandlers(deps);
    const res = await handlers.DELETE(
      new Request(
        `http://localhost/api/projects/${PROJECT_NAME}/sessions/sess-a/document-comments/comment-1`,
        { method: "DELETE" },
      ),
      params({ session: "sess-a", id: "comment-1" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const remaining = await fx.store.getDocumentComments(
      PROJECT_PATH,
      "sess-a",
      "docs/guide.md",
    );
    expect(remaining).toHaveLength(0);
  });

  it("DELETE with an id from another session returns 404 and leaves the comment", async () => {
    const deps = depsFromFixture(fx, ["comment-1"]);
    await createComment(deps, "sess-a", {
      docPath: "docs/guide.md",
      anchor: anchor(),
      note: "original",
    });
    const handlers = createDocumentCommentsRouteHandlers(deps);
    const res = await handlers.DELETE(
      new Request(
        `http://localhost/api/projects/${PROJECT_NAME}/sessions/sess-b/document-comments/comment-1`,
        { method: "DELETE" },
      ),
      params({ session: "sess-b", id: "comment-1" }),
    );
    expect(res.status).toBe(404);
    const remaining = await fx.store.getDocumentComments(
      PROJECT_PATH,
      "sess-a",
      "docs/guide.md",
    );
    expect(remaining).toHaveLength(1);
  });
});
