import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logger = vi.hoisted(() => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/logging", () => ({
  createLogger: () => logger,
}));

import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createTicketContentStore,
  sanitizeSnapshotBasename,
  TicketContentError,
  type TicketContentStore,
} from "./content-store";

const TICKET_ID = "11111111-1111-4111-8111-111111111111";
const ATTACHMENT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_TICKET_ID = "33333333-3333-4333-8333-333333333333";

let base: string;
let contentRoot: string;
let workDir: string;

beforeEach(async () => {
  vi.clearAllMocks();
  base = await mkdtemp(path.join(tmpdir(), "cc-ticket-content-"));
  contentRoot = path.join(base, "ticket-content");
  workDir = path.join(base, "work");
  await mkdir(workDir, { recursive: true });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function makeStore(
  listTicketIdsForProject: (projectPath: string) => Promise<string[]> = () =>
    Promise.resolve([]),
): TicketContentStore {
  return createTicketContentStore({ contentRoot, listTicketIdsForProject });
}

async function expectContentError(
  promise: Promise<unknown>,
  code: "unsafe_key" | "snapshot_not_found",
): Promise<void> {
  const error = await promise.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(TicketContentError);
  expect((error as TicketContentError).code).toBe(code);
}

describe("sanitizeSnapshotBasename", () => {
  it("keeps ordinary file names", () => {
    expect(sanitizeSnapshotBasename("report v2.pdf")).toBe("report v2.pdf");
  });

  it("reduces paths to their basename", () => {
    expect(sanitizeSnapshotBasename("../../nested/evil.txt")).toBe("evil.txt");
    expect(sanitizeSnapshotBasename("/etc/passwd")).toBe("passwd");
  });

  it("replaces unsafe characters and strips leading dots", () => {
    expect(sanitizeSnapshotBasename("a\\b\0c.txt")).toBe("a_b_c.txt");
    expect(sanitizeSnapshotBasename(".env")).toBe("env");
  });

  it("falls back for names that sanitize to nothing", () => {
    expect(sanitizeSnapshotBasename("..")).toBe("attachment");
    expect(sanitizeSnapshotBasename("...")).toBe("attachment");
    expect(sanitizeSnapshotBasename("")).toBe("attachment");
  });

  it("truncates very long names", () => {
    const name = `${"x".repeat(400)}.txt`;
    expect(sanitizeSnapshotBasename(name).length).toBeLessThanOrEqual(120);
  });

  it("stays idempotent when truncation would split a surrogate pair", () => {
    const name = `x${"𠀀".repeat(80)}`;
    const once = sanitizeSnapshotBasename(name);
    expect(sanitizeSnapshotBasename(once)).toBe(once);
  });
});

describe("capture", () => {
  it("keeps a captured file readable after its source is deleted", async () => {
    const store = makeStore();
    const sourcePath = path.join(workDir, "notes.md");
    const bytes = Buffer.from("# Notes\n\nsome context", "utf8");
    await writeFile(sourcePath, bytes);

    const snapshot = await store.capture({
      ticketId: TICKET_ID,
      attachmentId: ATTACHMENT_ID,
      fileName: "notes.md",
      bytes: await readFile(sourcePath),
    });
    await rm(sourcePath);

    const roundTripped = await store.read(snapshot.snapshotKey);
    expect(Buffer.from(roundTripped).equals(bytes)).toBe(true);
  });

  it("returns the snapshot key, sanitized name, size, and sha256", async () => {
    const store = makeStore();
    const bytes = Buffer.from("payload", "utf8");

    const snapshot = await store.capture({
      ticketId: TICKET_ID,
      attachmentId: ATTACHMENT_ID,
      fileName: "../escape attempt/payload.bin",
      bytes,
    });

    expect(snapshot.snapshotKey).toBe(
      `${TICKET_ID}/${ATTACHMENT_ID}/payload.bin`,
    );
    expect(snapshot.fileName).toBe("payload.bin");
    expect(snapshot.sizeBytes).toBe(bytes.byteLength);
    expect(snapshot.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stores the snapshot inside the content root and leaves no temp files", async () => {
    const store = makeStore();
    const snapshot = await store.capture({
      ticketId: TICKET_ID,
      attachmentId: ATTACHMENT_ID,
      fileName: "file.txt",
      bytes: Buffer.from("x"),
    });

    const attachmentDir = path.join(contentRoot, TICKET_ID, ATTACHMENT_ID);
    const entries = await readdir(attachmentDir);
    expect(entries).toEqual(["file.txt"]);
    expect(snapshot.snapshotKey).toBe(`${TICKET_ID}/${ATTACHMENT_ID}/file.txt`);
    await expect(
      stat(path.join(attachmentDir, "file.txt")),
    ).resolves.toBeTruthy();
  });

  it("rejects unsafe id segments", async () => {
    const store = makeStore();
    await expectContentError(
      store.capture({
        ticketId: "../escape",
        attachmentId: ATTACHMENT_ID,
        fileName: "file.txt",
        bytes: Buffer.from("x"),
      }),
      "unsafe_key",
    );
    await expectContentError(
      store.capture({
        ticketId: TICKET_ID,
        attachmentId: "..",
        fileName: "file.txt",
        bytes: Buffer.from("x"),
      }),
      "unsafe_key",
    );
  });
});

describe("captureText", () => {
  it("round-trips compaction markdown as utf8", async () => {
    const store = makeStore();
    const markdown = "## Compaction\n\n- point one\n- ünïcode ✓";

    const snapshot = await store.captureText({
      ticketId: TICKET_ID,
      attachmentId: ATTACHMENT_ID,
      fileName: "compaction.md",
      text: markdown,
    });

    const bytes = await store.read(snapshot.snapshotKey);
    expect(Buffer.from(bytes).toString("utf8")).toBe(markdown);
    expect(snapshot.snapshotKey).toBe(
      `${TICKET_ID}/${ATTACHMENT_ID}/compaction.md`,
    );
  });
});

describe("read", () => {
  it("throws snapshot_not_found for a missing snapshot", async () => {
    const store = makeStore();
    await expectContentError(
      store.read(`${TICKET_ID}/${ATTACHMENT_ID}/missing.txt`),
      "snapshot_not_found",
    );
  });

  it.each([
    ["../../outside.txt", "traversal segments"],
    [`${TICKET_ID}/${ATTACHMENT_ID}/../escape.txt`, "dot-dot name"],
    [`${TICKET_ID}/${ATTACHMENT_ID}`, "too few segments"],
    [`${TICKET_ID}/${ATTACHMENT_ID}/a/b.txt`, "too many segments"],
    [`${TICKET_ID}/${ATTACHMENT_ID}/.hidden`, "unsanitized name"],
    [`/etc/${ATTACHMENT_ID}/passwd`, "absolute-ish segment"],
  ])("rejects unsafe key %s (%s)", async (key) => {
    const store = makeStore();
    await expectContentError(store.read(key), "unsafe_key");
  });

  it("cannot read files outside the content root", async () => {
    const secretPath = path.join(base, "secret.txt");
    await writeFile(secretPath, "secret");
    const store = makeStore();

    await expectContentError(store.read("../secret.txt"), "unsafe_key");
    await expectContentError(
      store.read(`${TICKET_ID}/../../secret.txt`),
      "unsafe_key",
    );
  });
});

describe("materialize", () => {
  it("copies a snapshot to a destination, creating parent directories", async () => {
    const store = makeStore();
    const bytes = Buffer.from("materialize me", "utf8");
    const snapshot = await store.capture({
      ticketId: TICKET_ID,
      attachmentId: ATTACHMENT_ID,
      fileName: "doc.md",
      bytes,
    });

    const destination = path.join(workDir, "nested", "deeper", "doc.md");
    await store.materialize(snapshot.snapshotKey, destination);

    expect(Buffer.from(await readFile(destination)).equals(bytes)).toBe(true);
  });

  it("throws snapshot_not_found for a missing snapshot", async () => {
    const store = makeStore();
    await expectContentError(
      store.materialize(
        `${TICKET_ID}/${ATTACHMENT_ID}/missing.txt`,
        path.join(workDir, "out.txt"),
      ),
      "snapshot_not_found",
    );
  });

  it("rejects unsafe keys before touching the destination", async () => {
    const store = makeStore();
    const destination = path.join(workDir, "never-created.txt");
    await expectContentError(
      store.materialize("../../escape.txt", destination),
      "unsafe_key",
    );
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("delete", () => {
  it("removes the snapshot and prunes empty ticket directories", async () => {
    const store = makeStore();
    const snapshot = await store.capture({
      ticketId: TICKET_ID,
      attachmentId: ATTACHMENT_ID,
      fileName: "gone.txt",
      bytes: Buffer.from("x"),
    });

    await store.delete(snapshot.snapshotKey);

    await expectContentError(
      store.read(snapshot.snapshotKey),
      "snapshot_not_found",
    );
    await expect(stat(path.join(contentRoot, TICKET_ID))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });

  it("keeps sibling attachments of the same ticket", async () => {
    const store = makeStore();
    const first = await store.capture({
      ticketId: TICKET_ID,
      attachmentId: ATTACHMENT_ID,
      fileName: "first.txt",
      bytes: Buffer.from("first"),
    });
    const second = await store.capture({
      ticketId: TICKET_ID,
      attachmentId: "44444444-4444-4444-8444-444444444444",
      fileName: "second.txt",
      bytes: Buffer.from("second"),
    });

    await store.delete(first.snapshotKey);

    const bytes = await store.read(second.snapshotKey);
    expect(Buffer.from(bytes).toString("utf8")).toBe("second");
  });

  it("removes only the selected snapshot when one attachment has multiple versions", async () => {
    const store = makeStore();
    const first = await store.capture({
      ticketId: TICKET_ID,
      attachmentId: ATTACHMENT_ID,
      fileName: "first.txt",
      bytes: Buffer.from("first"),
    });
    const second = await store.capture({
      ticketId: TICKET_ID,
      attachmentId: ATTACHMENT_ID,
      fileName: "second.txt",
      bytes: Buffer.from("second"),
    });

    await store.delete(first.snapshotKey);

    await expectContentError(
      store.read(first.snapshotKey),
      "snapshot_not_found",
    );
    const bytes = await store.read(second.snapshotKey);
    expect(Buffer.from(bytes).toString("utf8")).toBe("second");
  });

  it("is idempotent", async () => {
    const store = makeStore();
    const key = `${TICKET_ID}/${ATTACHMENT_ID}/never-existed.txt`;
    await expect(store.delete(key)).resolves.toBeUndefined();
    await expect(store.delete(key)).resolves.toBeUndefined();
  });

  it("rejects unsafe keys", async () => {
    const store = makeStore();
    await expectContentError(store.delete("../../work"), "unsafe_key");
  });
});

describe("deleteTicket", () => {
  it("removes every snapshot for the ticket and keeps other tickets", async () => {
    const store = makeStore();
    const mine = await store.capture({
      ticketId: TICKET_ID,
      attachmentId: ATTACHMENT_ID,
      fileName: "mine.txt",
      bytes: Buffer.from("mine"),
    });
    const other = await store.capture({
      ticketId: OTHER_TICKET_ID,
      attachmentId: ATTACHMENT_ID,
      fileName: "other.txt",
      bytes: Buffer.from("other"),
    });

    await store.deleteTicket(TICKET_ID);

    await expectContentError(
      store.read(mine.snapshotKey),
      "snapshot_not_found",
    );
    await expect(store.read(other.snapshotKey)).resolves.toBeTruthy();
  });

  it("is a no-op for tickets with no snapshots", async () => {
    const store = makeStore();
    await expect(store.deleteTicket(TICKET_ID)).resolves.toBeUndefined();
  });

  it("rejects unsafe ticket ids", async () => {
    const store = makeStore();
    await expectContentError(store.deleteTicket(".."), "unsafe_key");
    await expectContentError(store.deleteTicket("a/b"), "unsafe_key");
  });
});

describe("deleteProject", () => {
  it("removes the content of every ticket the lookup reports", async () => {
    const store = makeStore(() =>
      Promise.resolve([TICKET_ID, OTHER_TICKET_ID]),
    );
    const first = await store.capture({
      ticketId: TICKET_ID,
      attachmentId: ATTACHMENT_ID,
      fileName: "a.txt",
      bytes: Buffer.from("a"),
    });
    const second = await store.capture({
      ticketId: OTHER_TICKET_ID,
      attachmentId: ATTACHMENT_ID,
      fileName: "b.txt",
      bytes: Buffer.from("b"),
    });

    await store.deleteProject("/projects/demo");

    await expectContentError(
      store.read(first.snapshotKey),
      "snapshot_not_found",
    );
    await expectContentError(
      store.read(second.snapshotKey),
      "snapshot_not_found",
    );
  });

  it("uses ids captured before a project cascade without querying deleted rows", async () => {
    const lookup = vi.fn(() => Promise.reject(new Error("rows deleted")));
    const store = makeStore(lookup);
    const snapshot = await store.capture({
      ticketId: TICKET_ID,
      attachmentId: ATTACHMENT_ID,
      fileName: "captured.txt",
      bytes: Buffer.from("captured"),
    });

    await store.deleteProject("/projects/demo", [TICKET_ID]);

    expect(lookup).not.toHaveBeenCalled();
    await expectContentError(
      store.read(snapshot.snapshotKey),
      "snapshot_not_found",
    );
  });

  it("is best-effort: unsafe ids and missing directories never throw", async () => {
    const store = makeStore(() =>
      Promise.resolve(["../escape", "never-captured-ticket"]),
    );
    await expect(
      store.deleteProject("/projects/demo"),
    ).resolves.toBeUndefined();
  });

  it("is best-effort: a failing lookup never throws", async () => {
    const store = makeStore(() => Promise.reject(new Error("db closed")));
    await expect(
      store.deleteProject("/projects/demo"),
    ).resolves.toBeUndefined();
  });

  it("logs a stable orphan path key when the lookup fails", async () => {
    const store = makeStore(() => Promise.reject(new Error("db closed")));
    await store.deleteProject("/projects/demo");
    expect(logger.warn).toHaveBeenCalledWith(
      "content.project_cleanup_lookup_failed",
      expect.objectContaining({
        projectPath: "/projects/demo",
        orphanPathKey: "ticket-content",
        error: "db closed",
      }),
    );
  });
});
