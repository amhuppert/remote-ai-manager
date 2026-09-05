import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createTicketsRepo } from "@/lib/state-store/tickets-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import { createTicketContentStore } from "./content-store";
import { importTicketBundle } from "./bundle-import";
import { bundleFixture } from "./bundle.fixtures";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
});

describe("ticket bundle import", () => {
  it("creates a usable independent ticket with local documents and requires consent for another copy", async () => {
    const db = _createTestDb({ inMemory: true });
    const root = await mkdtemp(path.resolve(".cc/temp/bundle-test-"));
    cleanup.push(async () => {
      db.close();
      await rm(root, { recursive: true, force: true });
    });
    const repo = createTicketsRepo(db, createWriteQueue());
    const contentStore = createTicketContentStore({
      contentRoot: root,
      listTicketIdsForProject: repo.listTicketIds,
    });
    const source = bundleFixture();
    const result = await importTicketBundle(
      { repo, contentStore },
      source,
      "/destination/repo",
      false,
    );
    expect(result).toMatchObject({
      title: source.ticket.title,
      status: "in_progress",
      projectPath: "/destination/repo",
      sessions: [],
    });
    expect(result.id).not.toBe(source.ticket.id);
    expect(result.attachments.length).toBeGreaterThan(1);
    const design = result.attachments.find(
      (a) => a.payload.kind === "file" && a.payload.fileName === "design.md",
    );
    expect(design?.payload.kind).toBe("file");
    if (design?.payload.kind !== "file")
      throw new Error("Expected imported file");
    expect(
      Buffer.from(
        await contentStore.read(design.payload.snapshotKey),
      ).toString(),
    ).toBe("Decision\n");
    await expect(
      importTicketBundle(
        { repo, contentStore },
        source,
        "/destination/repo",
        false,
      ),
    ).rejects.toThrow(/already imported/i);
    const copy = await importTicketBundle(
      { repo, contentStore },
      source,
      "/destination/repo",
      true,
    );
    expect(copy.number).not.toBe(result.number);
    expect(await repo.listTicketIds("/destination/repo")).toHaveLength(2);
  });
});

it("keeps imported files usable after source loss and materializes a navigable index", async () => {
  const { createTicketMaterializer } = await import("./materializer");
  const { readFile } = await import("node:fs/promises");
  const db = _createTestDb({ inMemory: true });
  const root = await mkdtemp(path.resolve(".cc/temp/bundle-materialize-test-"));
  cleanup.push(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  const repo = createTicketsRepo(db, createWriteQueue());
  const contentStore = createTicketContentStore({
    contentRoot: path.join(root, "content"),
    listTicketIdsForProject: repo.listTicketIds,
  });
  const imported = await importTicketBundle(
    { repo, contentStore },
    bundleFixture(),
    "/destination/repo",
    false,
  );
  const registered: string[] = [];
  await createTicketMaterializer({
    contentStore,
    async registerReferenceDocument(_project, _session, file) {
      registered.push(file);
    },
  }).materialize({
    projectPath: "/destination/repo",
    sessionName: "work",
    worktreePath: root,
    ticketNumber: imported.number,
    attachments: imported.attachments,
  });
  const indexPath = registered.find((file) => file.endsWith("bundle-index.md"));
  expect(indexPath).toBeDefined();
  const index = await readFile(path.join(root, indexPath!), "utf8");
  expect(index).toContain('"/old/repo" → "/destination/repo"');
  for (const match of index.matchAll(/\]\(\.\/([^)]*)\)/g)) {
    expect(
      await readFile(
        path.join(
          root,
          path.dirname(indexPath!),
          decodeURIComponent(match[1]!),
        ),
      ),
    ).toBeDefined();
  }
});
