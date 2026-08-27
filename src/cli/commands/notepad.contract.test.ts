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
import { createNotepadService } from "@/lib/notepads/service";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { shellWords } from "@/lib/shared/testing/shell-words";
import {
  createNotepadsRepo,
  type NotepadsRepo,
} from "@/lib/state-store/notepads-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import { runCli } from "../core";
import type { CliEnv, CliHost, CliResult } from "../shared";

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

/**
 * A legal project directory basename that a shell acts on. The project resolver
 * restricts no character, so this is an ordinary project — and a reveal command
 * naming it is the case where bad quoting silently lists a DIFFERENT project
 * instead of failing.
 */
const HOSTILE_PROJECT_NAME = "team$prod dir";
const HOSTILE_PROJECT_PATH = "/repos/team$prod dir";

/**
 * A legal basename the CLI itself would read as a flag. `mkdir -- --team`
 * makes one, and it lists fine through `CC_PROJECT` — so a reveal that cannot
 * name it back is a reveal that discloses nothing.
 */
const FLAG_SHAPED_PROJECT_NAME = "--team";
const FLAG_SHAPED_PROJECT_PATH = "/repos/--team";

/** Canonical notepad content: Markdown carrying a reference in its XML form. */
const REFERENCE_XML =
  '<spec-ref spec-slug="notepad" name="Notepad" read-command="cctl spec show notepad" />';
const SEED_CONTENT = `# Migration notes\n\nSee ${REFERENCE_XML} before starting.`;

let dir: string;
let contentBase: string;
let fixture: PersistenceFixture;
let repo: NotepadsRepo;
let contentStore: NotepadContentStore;
let handlers: NotepadsRouteHandlers;

const publish: PublishFn = () => ({ delivered: true });

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "cctl-notepad-"));
  contentBase = await mkdtemp(path.join(os.tmpdir(), "cc-notepad-content-"));
  await writeFile(path.join(dir, "api-token"), `${TOKEN}\n`, { mode: 0o600 });

  fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT_PATH);
  fixture.seedProject(HOSTILE_PROJECT_PATH);
  fixture.seedProject(FLAG_SHAPED_PROJECT_PATH);
  repo = createNotepadsRepo(fixture.db, createWriteQueue());
  contentStore = createNotepadContentStore({
    contentRoot: path.join(contentBase, "notepad-content"),
    listNotepadIdsForProject: (projectPath) => repo.listNotepadIds(projectPath),
  });

  let clock = 0;
  let idSeq = 0;
  const service = createNotepadService({
    repo,
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
      if (projectName === HOSTILE_PROJECT_NAME) return HOSTILE_PROJECT_PATH;
      if (projectName === FLAG_SHAPED_PROJECT_NAME) {
        return FLAG_SHAPED_PROJECT_PATH;
      }
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
function makeHost(): CliHost & { written: Record<string, string> } {
  const written: Record<string, string> = {};
  return {
    written,
    async fetch(url, init) {
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
    async writeTextFile(filePath, contents) {
      written[filePath] = contents;
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

function envelopeOf(result: CliResult): Record<string, unknown> {
  return JSON.parse(result.stdout) as Record<string, unknown>;
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
  const created = await runCli(
    ["notepad", "create", "--name", name, "--content", content, "--json"],
    makeEnv(),
    host,
  );
  expect(created.exitCode, created.stderr).toBe(0);
  const notepad = envelopeOf(created).notepad as {
    id: string;
    revision: number;
  };
  return { id: notepad.id, revision: notepad.revision };
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
    const read = await runCli(["notepad", "get", created.id], makeEnv(), host);
    expect(read.exitCode, read.stderr).toBe(0);
    expect(read.stdout).toContain(REFERENCE_XML);
    expect(read.stdout).toContain("revision: 1");

    const updated = await runCli(
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
    expect((envelopeOf(updated).notepad as { revision: number }).revision).toBe(
      2,
    );

    const appended = await runCli(
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

    const finalRead = await runCli(
      ["notepad", "get", created.id, "--json"],
      makeEnv(),
      host,
    );
    expect((envelopeOf(finalRead).notepad as { content: string }).content).toBe(
      reloaded?.content,
    );
  });

  it("refuses a write with no --if-revision at exit 2 without touching the notepad", async () => {
    const host = makeHost();
    const created = await createNotepad(host, "Guarded");

    for (const operation of ["update", "append"] as const) {
      const result = await runCli(
        ["notepad", operation, created.id, "--content", "sneaky"],
        makeEnv(),
        host,
      );
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("--if-revision");
    }
    for (const raw of ["0", "-3", "2.5", "latest"]) {
      const result = await runCli(
        [
          "notepad",
          "update",
          created.id,
          "--if-revision",
          raw,
          "--content",
          "sneaky",
        ],
        makeEnv(),
        host,
      );
      expect(result.exitCode, `--if-revision ${raw}`).toBe(2);
      expect(result.stderr).toContain("positive integer");
    }

    const stored = await repo.find(created.id);
    expect(stored?.revision).toBe(1);
    expect(stored?.content).toBe(SEED_CONTENT);
  });

  it("refuses a stale write reporting the current revision, and the retry after a fresh read succeeds", async () => {
    const host = makeHost();
    const created = await createNotepad(host, "Contested");

    // Another writer moves the notepad on while this agent still holds rev 1.
    const byOther = await runCli(
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

    const stale = await runCli(
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

    const staleJson = await runCli(
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
    expect(envelope.code).toBe("stale_revision");
    expect(envelope.details).toMatchObject({ currentRevision: 2 });

    // Re-read, then retry against what the read reported.
    const reread = await runCli(
      ["notepad", "get", created.id, "--json"],
      makeEnv(),
      host,
    );
    const current = (envelopeOf(reread).notepad as { revision: number })
      .revision;
    const retried = await runCli(
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

    const afterDelete = await runCli(
      ["notepad", "get", created.id],
      makeEnv(),
      host,
    );
    expect(afterDelete.exitCode).toBe(1);
    expect(afterDelete.stderr).toContain(created.id);

    const unknown = await runCli(
      ["notepad", "get", "never-existed", "--json"],
      makeEnv(),
      host,
    );
    expect(unknown.exitCode).toBe(1);
    const envelope = envelopeOf(unknown);
    expect(envelope.code).toBe("not_found");
    expect(String(envelope.error)).toContain("never-existed");
  });

  it("reads through a reference captured before a rename", async () => {
    const host = makeHost();
    const created = await createNotepad(host, "Original name");

    const renamed = await userPatch(created.id, { name: "Renamed" });
    expect(renamed.status).toBe(200);

    // The id an agent captured before the rename is unchanged and still resolves.
    const read = await runCli(
      ["notepad", "get", created.id, "--json"],
      makeEnv(),
      host,
    );
    expect(read.exitCode, read.stderr).toBe(0);
    const notepad = envelopeOf(read).notepad as { id: string; name: string };
    expect(notepad.id).toBe(created.id);
    expect(notepad.name).toBe("Renamed");

    // And the write path resolves by the same id, under the new name.
    const appended = await runCli(
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
      const refused = await runCli(
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

    const refusedUpdate = await runCli(
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
    expect(envelope.code).toBe("write_mode_refused");
    expect(String(envelope.error)).toContain("append-only");

    const acceptedAppend = await runCli(
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
    const globalCreate = await runCli(
      ["notepad", "create", "--name", "Standing", "--global", "--json"],
      makeEnv(),
      host,
    );
    expect(globalCreate.exitCode, globalCreate.stderr).toBe(0);

    const bounded = await runCli(
      ["notepad", "list", "--limit", "2", "--json"],
      makeEnv(),
      host,
    );
    const envelope = envelopeOf(bounded);
    expect(envelope.total).toBe(4);
    expect(envelope.returned).toBe(2);
    expect(envelope.truncated).toBe(true);
    expect(envelope.reveal).toBe("cctl notepad list --project cc --limit 4");

    // The reveal command is a real invocation that returns everything omitted —
    // run here from a DIFFERENT ambient project, because a reveal that only
    // worked where it was printed would disclose another scope's notepads to any
    // agent that carried it elsewhere.
    const revealed = await runCli(
      [...String(envelope.reveal).split(" ").slice(1), "--json"],
      makeEnv({ CC_PROJECT: "some-other-project" }),
      host,
    );
    const all = envelopeOf(revealed).notepads as { name: string }[];
    expect(all).toHaveLength(4);
    expect(all.map((item) => item.name).sort()).toEqual([
      "First",
      "Second",
      "Standing",
      "Third",
    ]);

    // --global narrows to the scope reachable from every conversation.
    const globalOnly = await runCli(
      ["notepad", "list", "--global", "--json"],
      makeEnv(),
      host,
    );
    const globals = envelopeOf(globalOnly).notepads as { name: string }[];
    expect(globals.map((item) => item.name)).toEqual(["Standing"]);

    // The text rows carry the id an agent addresses the notepad by.
    const text = await runCli(["notepad", "list"], makeEnv(), host);
    expect(text.stdout).toContain("4 total, 4 shown");
    expect(text.stdout).toContain("global");
    expect(text.stdout).toContain(`project(${PROJECT_NAME})`);
  });

  /**
   * The whole disclosure chain against real persistence, for the two project
   * basenames that break a naive reveal: one the SHELL rewrites, one the CLI
   * reads as a flag. Both list fine through `CC_PROJECT`, so a reveal that
   * cannot name them back is the difference between disclosing the remainder and
   * disclosing nothing.
   */
  it.each([
    [HOSTILE_PROJECT_NAME, "the shell would rewrite"],
    [FLAG_SHAPED_PROJECT_NAME, "the CLI would read as a flag"],
  ])("reveals the remainder for a project name %j %s", async (project) => {
    const host = makeHost();
    const inThatProject = makeEnv({ CC_PROJECT: project });
    for (const name of ["First", "Second", "Third"]) {
      const created = await runCli(
        ["notepad", "create", "--name", name, "--content", `# ${name}`],
        inThatProject,
        host,
      );
      expect(created.exitCode, created.stderr).toBe(0);
    }

    const bounded = await runCli(
      ["notepad", "list", "--limit", "2", "--json"],
      inThatProject,
      host,
    );
    const envelope = envelopeOf(bounded);
    expect(envelope.total).toBe(3);
    expect(envelope.truncated).toBe(true);

    // End to end: the reveal string goes through a REAL shell, and the argv that
    // survives runs against the real routes from a DIFFERENT ambient project. An
    // expansion that leaked, or a name the parser refused, lands somewhere other
    // than the three rows this bounded away.
    const words = shellWords(String(envelope.reveal));
    expect(words[0]).toBe("cctl");

    const revealed = await runCli(
      [...words.slice(1), "--json"],
      makeEnv({ CC_PROJECT: PROJECT_NAME }),
      host,
    );
    expect(revealed.exitCode, revealed.stderr).toBe(0);
    const all = envelopeOf(revealed).notepads as { name: string }[];
    expect(all.map((item) => item.name).sort()).toEqual([
      "First",
      "Second",
      "Third",
    ]);
  });

  it("delivers oversized content as an artifact receipt instead of truncating it", async () => {
    const host = makeHost();
    const big = `${SEED_CONTENT}\n\n${"filler line\n".repeat(6_000)}`;
    const created = await createNotepad(host, "Large", big);

    const read = await runCli(["notepad", "get", created.id], makeEnv(), host);
    expect(read.exitCode, read.stderr).toBe(0);
    expect(read.stdout).not.toContain("filler line");
    expect(read.stdout).toContain("artifact: .cc/temp/notepad-");
    expect(read.stdout).toContain("format: markdown");
    expect(read.stdout).toMatch(/sha256: sha256:[a-f0-9]{64}/);

    // The artifact holds the canonical text, reference XML included.
    const [artifactPath, artifactBody] = Object.entries(host.written)[0] ?? [];
    expect(read.stdout).toContain(`artifact: ${artifactPath}`);
    expect(artifactBody).toBe(big);
    expect(artifactBody).toContain(REFERENCE_XML);

    // --json spills the same way: it changes serialization, never volume.
    const asJson = await runCli(
      ["notepad", "get", created.id, "--json"],
      makeEnv(),
      host,
    );
    const envelope = envelopeOf(asJson);
    expect(envelope.storage).toBe("artifact");
    expect(envelope.artifact).toMatchObject({ format: "markdown" });
    expect(envelope.notepad).not.toHaveProperty("content");
  });

  it("refuses a duplicate name in the same scope and allows it in the other", async () => {
    const host = makeHost();
    await createNotepad(host, "Shared name");

    const duplicate = await runCli(
      ["notepad", "create", "--name", "Shared name", "--json"],
      makeEnv(),
      host,
    );
    expect(duplicate.exitCode).toBe(1);
    expect(envelopeOf(duplicate).code).toBe("name_taken");

    const otherScope = await runCli(
      ["notepad", "create", "--name", "Shared name", "--global"],
      makeEnv(),
      host,
    );
    expect(otherScope.exitCode, otherScope.stderr).toBe(0);
  });

  it("rejects a bad token at exit 3 before the request can change anything", async () => {
    const host = makeHost();
    const created = await createNotepad(host, "Protected");

    const result = await runCli(
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
