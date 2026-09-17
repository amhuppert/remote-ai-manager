import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentAuth } from "@/lib/agent-gateway/token";
import type { PublishFn } from "@/lib/events/publication";
import {
  createNotepadContentStore,
  type NotepadContentStore,
} from "@/lib/notepads/content-store";
import {
  createNotepadsRouteHandlers,
  type NotepadsRouteHandlers,
} from "@/lib/notepads/route-handlers";
import {
  createNotepadService,
  type NotepadService,
} from "@/lib/notepads/service";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { shellWords } from "@/lib/shared/testing/shell-words";
import {
  createNotepadCommentsRepo,
  type NotepadCommentsRepo,
} from "@/lib/state-store/notepad-comments-repo";
import {
  createNotepadsRepo,
  type NotepadsRepo,
} from "@/lib/state-store/notepads-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import { ccRequestFailure } from "../framework/request";
import {
  runCcWithHost,
  inlineDataOf as dataOf,
} from "../testing/domain-runtime";
import { cliRequest, type CliEnv, type CliHost } from "../transport";

/**
 * Contract layer per doc 01 §8: the real CLI core driving the real notepad route
 * handlers in-process, over a real SQLite store and the real token gate. The
 * four-operation round-trip, the compare-and-swap contract, write-mode
 * enforcement, and the not-found refusal are therefore proven against the
 * production service that owns those decisions — a CLI test with a fake host can
 * only prove which request the command would have sent.
 *
 * Durability claims read back through the REPOSITORY rather than trusting the
 * response body: a service that answered correctly while persisting nothing
 * would satisfy every stdout assertion.
 */

const TOKEN = "notepad-contract-token";
const PROJECT_NAME = "cc";
const PROJECT_PATH = "/repos/cc";
const CONVERSATION_ID = "conv-agent-1";

/** Canonical notepad content: Markdown carrying a reference in its XML form. */
const REFERENCE_XML =
  '<spec-ref spec-slug="notepad" name="Notepad" read-command="cctl spec show notepad" />';
const SEED_CONTENT = `# Migration notes\n\nSee ${REFERENCE_XML} before starting.`;

let dir: string;
let contentBase: string;
let fixture: PersistenceFixture;
let repo: NotepadsRepo;
let commentsRepo: NotepadCommentsRepo;
let contentStore: NotepadContentStore;
let handlers: NotepadsRouteHandlers;
let service: NotepadService;

const publish: PublishFn = () => ({ delivered: true });

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "cctl-notepad-"));
  contentBase = await mkdtemp(path.join(os.tmpdir(), "cc-notepad-content-"));
  await writeFile(path.join(dir, "api-token"), `${TOKEN}\n`, { mode: 0o600 });

  fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT_PATH);
  const writeQueue = createWriteQueue();
  repo = createNotepadsRepo(fixture.db, writeQueue);
  contentStore = createNotepadContentStore({
    contentRoot: path.join(contentBase, "notepad-content"),
    listNotepadIdsForProject: (projectPath) => repo.listNotepadIds(projectPath),
  });

  let clock = 0;
  let idSeq = 0;
  commentsRepo = createNotepadCommentsRepo(fixture.db, writeQueue);
  service = createNotepadService({
    repo,
    comments: commentsRepo,
    publish,
    deleteNotepadContent: (notepadId) => contentStore.deleteNotepad(notepadId),
    now: () => {
      clock += 1000;
      return new Date(Date.UTC(2026, 7, 27, 9, 0, 0) + clock).toISOString();
    },
    generateId: () => {
      idSeq += 1;
      return `notepad-${idSeq}`;
    },
  });

  handlers = createNotepadsRouteHandlers({
    getService: () => service,
    resolveProjectPath: async (projectName) => {
      if (projectName === PROJECT_NAME) return PROJECT_PATH;
      return null;
    },
    auth: createAgentAuth({ configDir: dir }),
  });
});

afterEach(async () => {
  fixture.close();
  await rm(dir, { recursive: true, force: true });
  await rm(contentBase, { recursive: true, force: true });
});

/**
 * Routes a request the CLI built to the handler Next.js would have run. The
 * dynamic `[notepadId]` segment is decoded exactly as the app router decodes it,
 * so an id that needs escaping is proven to survive the round-trip.
 */
function makeHost(): CliHost & {
  requests: string[];
} {
  const requests: string[] = [];
  return {
    requests,
    async fetch(url, init) {
      requests.push(`${init.method ?? "GET"} ${new URL(url).pathname}`);
      const segments = new URL(url).pathname.split("/").filter(Boolean);
      const request = new Request(url, {
        method: init.method,
        headers: init.headers,
        ...(init.body === undefined ? {} : { body: init.body }),
      });

      // /api/notepads
      const notepadId = segments[2];
      if (notepadId === undefined) {
        return init.method === "POST"
          ? handlers.createPOST(request)
          : handlers.listGET(request);
      }

      // /api/notepads/<notepadId>[/content]
      const context = {
        params: Promise.resolve({ notepadId: decodeURIComponent(notepadId) }),
      };
      if (segments[3] === "content") {
        return handlers.contentPOST(request, context);
      }

      // /api/notepads/<notepadId>/comments[/<commentId>[/replies]]
      if (segments[3] === "comments") {
        const commentId = segments[4];
        if (commentId === undefined) {
          return init.method === "POST"
            ? handlers.commentsPOST(request, context)
            : handlers.commentsGET(request, context);
        }
        const commentContext = {
          params: Promise.resolve({
            notepadId: decodeURIComponent(notepadId),
            commentId: decodeURIComponent(commentId),
          }),
        };
        if (segments[5] === "replies") {
          return handlers.commentRepliesPOST(request, commentContext);
        }
        return init.method === "DELETE"
          ? handlers.commentDELETE(request, commentContext)
          : handlers.commentPATCH(request, commentContext);
      }

      if (init.method === "PATCH")
        return handlers.detailPATCH(request, context);
      if (init.method === "DELETE") {
        return handlers.detailDELETE(request, context);
      }
      return handlers.detailGET(request, context);
    },
    async readTextFile(filePath) {
      try {
        return await readFile(filePath, "utf-8");
      } catch {
        return null;
      }
    },
    async readFileBytes() {
      return null;
    },
    async sleep() {},
    platform: os.platform(),
    homedir: os.homedir(),
  };
}

function makeEnv(overrides: CliEnv = {}): CliEnv {
  return {
    CC_SERVER_URL: "http://127.0.0.1:4998",
    CC_API_TOKEN: TOKEN,
    CC_PROJECT: PROJECT_NAME,
    CC_CONVERSATION_ID: CONVERSATION_ID,
    ...overrides,
  };
}

function envelopeOf(result: Awaited<ReturnType<typeof runCcWithHost>>) {
  if (result.format !== "json") throw new Error("Expected a JSON run");
  return result.envelope;
}

/** The user's own act, made where the panel makes it — not through the CLI. */
async function userPatch(
  notepadId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return handlers.detailPATCH(
    new Request(`http://127.0.0.1:4998/api/notepads/${notepadId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ notepadId }) },
  );
}

/** Create a notepad through the CLI and return its id and head revision. */
async function createNotepad(
  host: CliHost,
  name: string,
  content = SEED_CONTENT,
): Promise<{ id: string; revision: number }> {
  const created = await runCcWithHost(
    ["notepad", "create", "--name", name, "--content", content, "--json"],
    makeEnv(),
    host,
  );
  expect(created.exitCode, created.stderr).toBe(0);
  const notepad = dataOf(created).notepad as {
    id: string;
    revision: number;
  };
  return { id: notepad.id, revision: notepad.revision };
}

/**
 * The user's review act, made where the panel makes it: a comment anchored to a
 * passage of the canonical text, quoted at the offsets that text actually holds.
 * The agent surface only ever READS these, so seeding through the service is the
 * fixture, not the behaviour under test.
 */
async function seedComment(
  notepadId: string,
  quote: string,
  body: string,
  line = 3,
): Promise<string> {
  const blockText = SEED_CONTENT.split("\n")[line - 1] ?? "";
  const charStart = blockText.indexOf(quote);
  if (charStart < 0) {
    throw new Error(
      `seedComment: ${JSON.stringify(quote)} is not on line ${line}`,
    );
  }
  const result = await service.createComment(notepadId, {
    anchor: {
      sectionId: "migration-notes",
      headingLabel: "Migration notes",
      line,
      charStart,
      charEnd: charStart + quote.length,
      quote,
      prefix: blockText.slice(0, charStart),
      suffix: blockText.slice(charStart + quote.length),
      notepadRevision: 1,
    },
    body,
    author: { kind: "user" },
  });
  if (!result.ok) throw new Error(`seedComment failed: ${result.error.code}`);
  return result.value.id;
}

describe("cctl notepad against the real notepad routes", () => {
  it("create → get → update → append round-trips and every result is durable", async () => {
    const host = makeHost();

    const created = await createNotepad(host, "Migration notes");
    expect(created.revision).toBe(1);
    const stored = await repo.find(created.id);
    expect(stored?.content).toBe(SEED_CONTENT);
    expect(stored?.projectPath).toBe(PROJECT_PATH);

    // The read hands back the canonical text verbatim — the embedded reference
    // arrives as XML carrying its own retrieval command, not as resolved prose.
    const read = await runCcWithHost(
      ["notepad", "get", created.id],
      makeEnv(),
      host,
    );
    expect(read.exitCode, read.stderr).toBe(0);
    expect(read.stdout).toContain(REFERENCE_XML);
    expect(read.stdout).toContain("revision: 1");

    const updated = await runCcWithHost(
      [
        "notepad",
        "update",
        created.id,
        "--if-revision",
        "1",
        "--content",
        `# Migration notes\n\nReplaced, still citing ${REFERENCE_XML}.`,
        "--json",
      ],
      makeEnv(),
      host,
    );
    expect(updated.exitCode, updated.stderr).toBe(0);
    expect((dataOf(updated).notepad as { revision: number }).revision).toBe(2);

    const appended = await runCcWithHost(
      [
        "notepad",
        "append",
        created.id,
        "--if-revision",
        "2",
        "--content",
        "## Findings",
        "--json",
      ],
      makeEnv(),
      host,
    );
    expect(appended.exitCode, appended.stderr).toBe(0);

    // Read back through the repository: the response body could be right while
    // nothing was persisted.
    const reloaded = await repo.find(created.id);
    expect(reloaded?.revision).toBe(3);
    expect(reloaded?.content).toContain("Replaced, still citing");
    expect(reloaded?.content).toContain(REFERENCE_XML);
    expect(reloaded?.content.endsWith("## Findings")).toBe(true);

    // And every write left an attributed revision behind.
    const revisions = await repo.listRevisions(created.id);
    expect(revisions.map((entry) => entry.origin)).toEqual([
      "create",
      "edit",
      "append",
    ]);
    for (const revision of revisions) {
      expect(revision.authorKind).toBe("agent");
      expect(revision.authorConversationId).toBe(CONVERSATION_ID);
    }

    const finalRead = await runCcWithHost(
      ["notepad", "get", created.id, "--json"],
      makeEnv(),
      host,
    );
    expect((dataOf(finalRead).notepad as { content: string }).content).toBe(
      reloaded?.content,
    );
  });

  it("refuses a write with no --if-revision at exit 2 without touching the notepad", async () => {
    const host = makeHost();
    const created = await createNotepad(host, "Guarded");

    for (const operation of ["update", "append"] as const) {
      const result = await runCcWithHost(
        ["notepad", operation, created.id, "--content", "sneaky"],
        makeEnv(),
        host,
      );
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("--if-revision");
    }

    const stored = await repo.find(created.id);
    expect(stored?.revision).toBe(1);
    expect(stored?.content).toBe(SEED_CONTENT);
  });

  it("refuses a stale write reporting the current revision, and the retry after a fresh read succeeds", async () => {
    const host = makeHost();
    const created = await createNotepad(host, "Contested");

    // Another writer moves the notepad on while this agent still holds rev 1.
    const byOther = await runCcWithHost(
      [
        "notepad",
        "append",
        created.id,
        "--if-revision",
        "1",
        "--content",
        "written by the other agent",
      ],
      makeEnv({ CC_CONVERSATION_ID: "conv-agent-2" }),
      host,
    );
    expect(byOther.exitCode, byOther.stderr).toBe(0);

    const stale = await runCcWithHost(
      [
        "notepad",
        "append",
        created.id,
        "--if-revision",
        "1",
        "--content",
        "based on a revision that has moved",
      ],
      makeEnv(),
      host,
    );
    expect(stale.exitCode).toBe(1);
    expect(stale.stderr).toContain("revision 2");
    expect(stale.stderr).toContain("why:");
    expect(stale.stderr).toContain("instruction:");

    const staleJson = await runCcWithHost(
      [
        "notepad",
        "append",
        created.id,
        "--if-revision",
        "1",
        "--content",
        "based on a revision that has moved",
        "--json",
      ],
      makeEnv(),
      host,
    );
    const envelope = envelopeOf(staleJson);
    expect(envelope.error?.details).toHaveProperty(
      "serverCode",
      "stale_revision",
    );
    expect(envelope.error?.details).toHaveProperty(
      "serverDetails",
      expect.objectContaining({ currentRevision: 2 }),
    );

    // Re-read, then retry against what the read reported.
    const reread = await runCcWithHost(
      ["notepad", "get", created.id, "--json"],
      makeEnv(),
      host,
    );
    const current = (dataOf(reread).notepad as { revision: number }).revision;
    const retried = await runCcWithHost(
      [
        "notepad",
        "append",
        created.id,
        "--if-revision",
        String(current),
        "--content",
        "based on a revision that has moved",
      ],
      makeEnv(),
      host,
    );
    expect(retried.exitCode, retried.stderr).toBe(0);

    // The refused write discarded nothing: both writers' content is present.
    const reloaded = await repo.find(created.id);
    expect(reloaded?.revision).toBe(3);
    expect(reloaded?.content).toContain("written by the other agent");
    expect(reloaded?.content).toContain("based on a revision that has moved");
  });

  it("names the requested id when a notepad was deleted or never existed", async () => {
    const host = makeHost();
    const created = await createNotepad(host, "Doomed");

    const deleted = await handlers.detailDELETE(
      new Request(`http://127.0.0.1:4998/api/notepads/${created.id}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ notepadId: created.id }) },
    );
    expect(deleted.status).toBe(200);

    const afterDelete = await runCcWithHost(
      ["notepad", "get", created.id],
      makeEnv(),
      host,
    );
    expect(afterDelete.exitCode).toBe(1);
    expect(afterDelete.stderr).toContain(created.id);

    const unknown = await runCcWithHost(
      ["notepad", "get", "never-existed", "--json"],
      makeEnv(),
      host,
    );
    expect(unknown.exitCode).toBe(1);
    const envelope = envelopeOf(unknown);
    expect(envelope.error?.details).toHaveProperty("serverCode", "not_found");
    expect(String(envelope.error?.message)).toContain("never-existed");
  });

  it("reads through a reference captured before a rename", async () => {
    const host = makeHost();
    const created = await createNotepad(host, "Original name");

    const renamed = await userPatch(created.id, { name: "Renamed" });
    expect(renamed.status).toBe(200);

    // The id an agent captured before the rename is unchanged and still resolves.
    const read = await runCcWithHost(
      ["notepad", "get", created.id, "--json"],
      makeEnv(),
      host,
    );
    expect(read.exitCode, read.stderr).toBe(0);
    const notepad = dataOf(read).notepad as { id: string; name: string };
    expect(notepad.id).toBe(created.id);
    expect(notepad.name).toBe("Renamed");

    // And the write path resolves by the same id, under the new name.
    const appended = await runCcWithHost(
      [
        "notepad",
        "append",
        created.id,
        "--if-revision",
        "1",
        "--content",
        "still reachable",
        "--json",
      ],
      makeEnv(),
      host,
    );
    expect(appended.exitCode, appended.stderr).toBe(0);
    expect((await repo.find(created.id))?.name).toBe("Renamed");
  });

  it("renders the server's write-mode refusal, naming the mode and its reason", async () => {
    const host = makeHost();
    const readOnly = await createNotepad(host, "Read only");
    const appendOnly = await createNotepad(host, "Append only");
    expect(
      (await userPatch(readOnly.id, { writeMode: "read-only" })).status,
    ).toBe(200);
    expect(
      (await userPatch(appendOnly.id, { writeMode: "append-only" })).status,
    ).toBe(200);

    for (const operation of ["update", "append"] as const) {
      const refused = await runCcWithHost(
        [
          "notepad",
          operation,
          readOnly.id,
          "--if-revision",
          "1",
          "--content",
          "not allowed",
        ],
        makeEnv(),
        host,
      );
      expect(refused.exitCode, `read-only ${operation}`).toBe(1);
      expect(refused.stderr).toContain("read-only");
      expect(refused.stderr).toContain("why:");
      expect(refused.stderr).toContain("instruction:");
    }

    const refusedUpdate = await runCcWithHost(
      [
        "notepad",
        "update",
        appendOnly.id,
        "--if-revision",
        "1",
        "--content",
        "not allowed",
        "--json",
      ],
      makeEnv(),
      host,
    );
    expect(refusedUpdate.exitCode).toBe(1);
    const envelope = envelopeOf(refusedUpdate);
    expect(envelope.error?.details).toHaveProperty(
      "serverCode",
      "write_mode_refused",
    );
    expect(String(envelope.error?.message)).toContain("append-only");

    const acceptedAppend = await runCcWithHost(
      [
        "notepad",
        "append",
        appendOnly.id,
        "--if-revision",
        "1",
        "--content",
        "allowed",
      ],
      makeEnv(),
      host,
    );
    expect(acceptedAppend.exitCode, acceptedAppend.stderr).toBe(0);

    // Neither refusal wrote anything; the accepted append did.
    expect((await repo.find(readOnly.id))?.revision).toBe(1);
    expect((await repo.find(appendOnly.id))?.revision).toBe(2);
  });

  it("lists scopes with bounded rows and a reveal command that returns the rest", async () => {
    const host = makeHost();
    for (const name of ["First", "Second", "Third"]) {
      await createNotepad(host, name, `# ${name}`);
    }
    const globalCreate = await runCcWithHost(
      ["notepad", "create", "--name", "Standing", "--global", "--json"],
      makeEnv(),
      host,
    );
    expect(globalCreate.exitCode, globalCreate.stderr).toBe(0);

    const bounded = await runCcWithHost(
      ["notepad", "list", "--limit", "2", "--json"],
      makeEnv(),
      host,
    );
    const data = dataOf(bounded);
    expect(data.omission).toMatchObject({
      total: { kind: "known", count: 4 },
      returned: 2,
      truncated: true,
    });
    expect(data.revealCommand).toBe("cctl notepad list --project=cc --limit=4");

    // The reveal command is a real invocation that returns everything omitted —
    // run here from a DIFFERENT ambient project, because a reveal that only
    // worked where it was printed would disclose another scope's notepads to any
    // agent that carried it elsewhere.
    const revealed = await runCcWithHost(
      [...String(data.revealCommand).split(" ").slice(1), "--json"],
      makeEnv({ CC_PROJECT: "some-other-project" }),
      host,
    );
    const all = dataOf(revealed).notepads as { name: string }[];
    expect(all).toHaveLength(4);
    expect(all.map((item) => item.name).sort()).toEqual([
      "First",
      "Second",
      "Standing",
      "Third",
    ]);

    // --global narrows to the scope reachable from every conversation.
    const globalOnly = await runCcWithHost(
      ["notepad", "list", "--global", "--json"],
      makeEnv(),
      host,
    );
    const globals = dataOf(globalOnly).notepads as { name: string }[];
    expect(globals.map((item) => item.name)).toEqual(["Standing"]);

    // The text rows carry the id an agent addresses the notepad by.
    const text = await runCcWithHost(["notepad", "list"], makeEnv(), host);
    expect(text.stdout).toContain("4 total, 4 shown");
    expect(text.stdout).toContain("global");
    expect(text.stdout).toContain(`project(${PROJECT_NAME})`);
  });

  it("refuses a duplicate name in the same scope and allows it in the other", async () => {
    const host = makeHost();
    await createNotepad(host, "Shared name");

    const duplicate = await runCcWithHost(
      ["notepad", "create", "--name", "Shared name", "--json"],
      makeEnv(),
      host,
    );
    expect(duplicate.exitCode).toBe(1);
    expect(envelopeOf(duplicate).error?.details).toHaveProperty(
      "serverCode",
      "name_taken",
    );

    const otherScope = await runCcWithHost(
      ["notepad", "create", "--name", "Shared name", "--global"],
      makeEnv(),
      host,
    );
    expect(otherScope.exitCode, otherScope.stderr).toBe(0);
  });

  it("lists a notepad's comments and persists a reply attributed to the caller", async () => {
    const host = makeHost();
    const created = await createNotepad(host, "Reviewed");
    const commentId = await seedComment(
      created.id,
      "before starting",
      "Is this reference still the right one?",
    );

    const listed = await runCcWithHost(
      ["notepad", "comment", "list", created.id, "--json"],
      makeEnv(),
      host,
    );
    expect(listed.exitCode, listed.stderr).toBe(0);
    const threads = dataOf(listed).comments as {
      comment: { id: string; body: string; status: string };
      passage: { quote: string; location: string; state: string };
      replies: unknown[];
    }[];
    expect(threads).toHaveLength(1);
    expect(threads[0]?.comment).toMatchObject({
      id: commentId,
      body: "Is this reference still the right one?",
      status: "open",
    });
    // The passage is stated over the canonical text a `notepad get` returns, so
    // the agent can find it in what it reads.
    expect(threads[0]?.passage).toEqual({
      quote: "before starting",
      location: "Migration notes, line 3",
      state: "anchored",
    });

    const text = await runCcWithHost(
      ["notepad", "comment", "list", created.id],
      makeEnv(),
      host,
    );
    expect(text.exitCode, text.stderr).toBe(0);
    for (const fact of [
      commentId,
      "open",
      "Migration notes, line 3",
      "before starting",
      "Is this reference still the right one?",
    ]) {
      expect(text.stdout).toContain(fact);
    }

    const replied = await runCcWithHost(
      [
        "notepad",
        "comment",
        "reply",
        created.id,
        commentId,
        "--body",
        "Refreshed the reference in revision 2.",
        "--json",
      ],
      makeEnv(),
      host,
    );
    expect(replied.exitCode, replied.stderr).toBe(0);

    // Read back through the repository: a service that answered correctly while
    // persisting nothing would satisfy the response assertions above.
    const stored = await commentsRepo.list({ notepadId: created.id });
    expect(stored[0]?.replies).toHaveLength(1);
    expect(stored[0]?.replies[0]).toMatchObject({
      body: "Refreshed the reference in revision 2.",
      authorKind: "agent",
      authorConversationId: CONVERSATION_ID,
    });

    // And the listing shows the reply to the next reader.
    const relisted = await runCcWithHost(
      ["notepad", "comment", "list", created.id, "--json"],
      makeEnv(),
      host,
    );
    const withReply = dataOf(relisted).comments as {
      replies: { body: string }[];
    }[];
    expect(withReply[0]?.replies.map((reply) => reply.body)).toEqual([
      "Refreshed the reference in revision 2.",
    ]);
  });

  it("bounds the comment listing and reveals the remainder with the command it printed", async () => {
    const host = makeHost();
    const created = await createNotepad(host, "Heavily reviewed");
    for (const nth of [1, 2, 3]) {
      await seedComment(created.id, "before starting", `Comment ${nth}.`);
    }
    // A resolved one, so the reveal has a filter it must carry back.
    const resolvedId = await seedComment(
      created.id,
      "before starting",
      "Already handled.",
    );
    const settled = await handlers.commentPATCH(
      new Request(
        `http://127.0.0.1:4998/api/notepads/${created.id}/comments/${resolvedId}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "resolved" }),
        },
      ),
      {
        params: Promise.resolve({
          notepadId: created.id,
          commentId: resolvedId,
        }),
      },
    );
    expect(settled.status).toBe(200);

    const bounded = await runCcWithHost(
      [
        "notepad",
        "comment",
        "list",
        created.id,
        "--status",
        "open",
        "--limit",
        "2",
        "--json",
      ],
      makeEnv(),
      host,
    );
    const data = dataOf(bounded);
    expect(data.omission).toMatchObject({
      total: { kind: "known", count: 3 },
      returned: 2,
      truncated: true,
    });

    // The reveal is a real invocation that returns everything the cap dropped —
    // and keeps the status filter, or it would disclose a different set than the
    // one it omitted.
    const words = shellWords(String(data.revealCommand));
    expect(words[0]).toBe("cctl");
    const revealed = await runCcWithHost(
      ["--json", ...words.slice(1)],
      makeEnv(),
      host,
    );
    expect(revealed.exitCode, revealed.stdout + revealed.stderr).toBe(0);
    const all = dataOf(revealed).comments as {
      comment: { body: string };
    }[];
    expect(all.map((thread) => thread.comment.body).sort()).toEqual([
      "Comment 1.",
      "Comment 2.",
      "Comment 3.",
    ]);
  });

  it("accepts a reply on a read-only notepad, where every content write is refused", async () => {
    const host = makeHost();
    const created = await createNotepad(host, "Frozen");
    const commentId = await seedComment(
      created.id,
      "Migration notes",
      "This heading is wrong.",
      1,
    );
    expect(
      (await userPatch(created.id, { writeMode: "read-only" })).status,
    ).toBe(200);

    // The same notepad, the same agent: the content write is refused…
    const refused = await runCcWithHost(
      [
        "notepad",
        "update",
        created.id,
        "--if-revision",
        "1",
        "--content",
        "rewritten",
      ],
      makeEnv(),
      host,
    );
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("read-only");

    // …and the reply is not, because a reply is review discussion rather than a
    // change to the content the write mode governs.
    const replied = await runCcWithHost(
      [
        "notepad",
        "comment",
        "reply",
        created.id,
        commentId,
        "--body",
        "Agreed — I cannot change it while the notepad is read-only.",
      ],
      makeEnv(),
      host,
    );
    expect(replied.exitCode, replied.stderr).toBe(0);

    const stored = await commentsRepo.list({ notepadId: created.id });
    expect(stored[0]?.replies.map((reply) => reply.authorKind)).toEqual([
      "agent",
    ]);
    // The refused update left the content where it was.
    expect((await repo.find(created.id))?.revision).toBe(1);
  });

  it("has no verb for resolving, reopening, or deleting a comment", async () => {
    const host = makeHost();

    for (const verb of ["resolve", "reopen", "delete"]) {
      const attempted = await runCcWithHost(
        ["notepad", "comment", verb, "notepad-1", "comment-1"],
        makeEnv(),
        host,
      );
      expect(attempted.exitCode, `notepad comment ${verb}`).toBe(2);
      // The refusal names the whole surface, so the absence is legible rather
      // than looking like a typo in a verb that exists.
      expect(attempted.stderr).toContain("notepad comment reply");
      // Nothing was sent: the boundary holds before any request.
      expect(host.requests).toEqual([]);
    }
  });

  it("renders the server's refusal when an agent-attributed caller tries to resolve a comment", async () => {
    const host = makeHost();
    const created = await createNotepad(host, "Judged");
    const commentId = await seedComment(
      created.id,
      "before starting",
      "Please rewrite this sentence.",
    );

    // No CLI verb builds this request — that IS the primary guard — so the
    // refusal is proven at the boundary an agent could still reach directly,
    // carrying the same claimed attribution `cctl notepad update` sends.
    for (const attempt of [
      { method: "PATCH", body: { status: "resolved" }, act: "resolve" },
      { method: "PATCH", body: { status: "open" }, act: "reopen" },
      { method: "DELETE", body: undefined, act: "delete" },
    ]) {
      const result = await cliRequest(host, {
        server: "http://127.0.0.1:4998",
        token: TOKEN,
        tokenSource: "env",
        method: attempt.method,
        path: `/api/notepads/${created.id}/comments/${commentId}`,
        headers: { "x-cc-conversation-id": CONVERSATION_ID },
        ...(attempt.body === undefined ? {} : { body: attempt.body }),
      });
      if (result.kind === "ok") {
        throw new Error(`${attempt.act} was accepted from an agent caller`);
      }

      const failure = ccRequestFailure(result);
      expect(failure.error.message).toContain(
        `Only the user can ${attempt.act}`,
      );
      expect(failure.error.why).toBeTruthy();
      expect(failure.instruction).toBeDefined();
      expect(failure.error.details).toMatchObject({
        serverCode: "comment_user_act_refused",
        serverDetails: { act: attempt.act },
      });
    }

    // The comment survived all three attempts, open and undeleted.
    const stored = await commentsRepo.list({ notepadId: created.id });
    expect(stored.map((thread) => thread.comment.status)).toEqual(["open"]);
  });

  it("rejects a bad token at exit 3 before the request can change anything", async () => {
    const host = makeHost();
    const created = await createNotepad(host, "Protected");

    const result = await runCcWithHost(
      [
        "notepad",
        "append",
        created.id,
        "--if-revision",
        "1",
        "--content",
        "not allowed",
      ],
      makeEnv({ CC_API_TOKEN: "wrong-token" }),
      host,
    );
    expect(result.exitCode).toBe(3);
    expect((await repo.find(created.id))?.revision).toBe(1);
  });
});
