import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  readdir,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { createLogger, runAsTrace } from "@/lib/logging";
import { TicketAlreadyImportedError } from "@/lib/state-store/tickets-repo";
import {
  bundleDigest,
  decodeTicketBundle,
  encodeTicketBundle,
  type TicketBundle,
} from "./bundle";
import {
  bundleTransferSchema,
  type BundleTransfer,
} from "./bundle-transfer-schemas";

const logger = createLogger("tickets.bundle-transfer");
const RETENTION_MS = 24 * 60 * 60 * 1000;
const storedTransferSchema = z.object({
  projectPath: z.string(),
  createdAt: z.number(),
  ownerPid: z.number(),
  transfer: bundleTransferSchema,
});
export interface BundleTransferDeps {
  root: string;
  capture(projectPath: string, number: number): Promise<TicketBundle>;
  importBundle(
    bundle: TicketBundle,
    projectPath: string,
    allowDuplicate: boolean,
  ): Promise<number>;
  publish(projectPath: string, transfer: BundleTransfer): void;
}

/** Prepared archives are immutable for 24 hours: review, acknowledgment and download all name the same bytes. */
export function createBundleTransfers(deps: BundleTransferDeps) {
  function directory(id: string) {
    if (!z.uuid().safeParse(id).success) throw new Error("Transfer not found");
    return path.join(deps.root, id);
  }
  async function save(
    projectPath: string,
    transfer: BundleTransfer,
    createdAt: number,
  ) {
    const target = path.join(directory(transfer.id), "status.json");
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(
      temporary,
      JSON.stringify({
        projectPath,
        createdAt,
        ownerPid: process.pid,
        transfer,
      }),
      { mode: 0o600 },
    );
    await rename(temporary, target);
    deps.publish(projectPath, transfer);
  }
  async function load(projectPath: string, id: string) {
    const input: unknown = JSON.parse(
      await readFile(path.join(directory(id), "status.json"), "utf8"),
    );
    const parsed = storedTransferSchema.safeParse(input);
    if (!parsed.success || parsed.data.projectPath !== projectPath)
      throw new Error("Transfer not found");
    if (Date.now() - parsed.data.createdAt > RETENTION_MS)
      throw new Error("Prepared bundle expired; prepare it again");
    if (["preparing", "importing"].includes(parsed.data.transfer.status)) {
      try {
        process.kill(parsed.data.ownerPid, 0);
      } catch {
        throw new Error(
          "Bundle preparation was interrupted by a server restart; prepare it again",
        );
      }
    }
    return parsed.data;
  }
  async function archive(projectPath: string, id: string) {
    const state = await load(projectPath, id);
    const bytes = await readFile(
      path.join(directory(id), "archive.cc-ticket.gz"),
    );
    if (bundleDigest(bytes) !== state.transfer.digest)
      throw new Error(
        "Prepared bundle integrity check failed; prepare it again",
      );
    return { state, bytes };
  }
  async function cleanExpired() {
    await mkdir(deps.root, { recursive: true, mode: 0o700 });
    for (const name of await readdir(deps.root)) {
      if (!z.uuid().safeParse(name).success) continue;
      const dir = directory(name);
      if (Date.now() - (await stat(dir)).mtimeMs > RETENTION_MS)
        await rm(dir, { recursive: true, force: true });
    }
  }
  function launch(
    projectPath: string,
    transfer: BundleTransfer,
    createdAt: number,
    work: () => Promise<void>,
  ) {
    void runAsTrace("ticket-bundle", work)
      .catch(async (error: unknown) => {
        transfer.status =
          error instanceof TicketAlreadyImportedError ? "duplicate" : "failed";
        transfer.error =
          error instanceof Error ? error.message : "Bundle operation failed";
        logger.warn("bundle.operation_failed", {
          id: transfer.id,
          status: transfer.status,
          error: transfer.error,
        });
        await save(projectPath, transfer, createdAt);
      })
      .catch((error) =>
        logger.error("bundle.status_write_failed", {
          id: transfer.id,
          error: String(error),
        }),
      );
  }
  return {
    async prepare(
      projectPath: string,
      input: { number: number } | { bytes: Uint8Array },
    ): Promise<BundleTransfer> {
      await cleanExpired();
      const id = randomUUID();
      const createdAt = Date.now();
      const transfer: BundleTransfer = {
        id,
        mode: "number" in input ? "export" : "import",
        status: "preparing",
        title: "",
        documentCount: 0,
        omissions: [],
        digest: null,
        error: null,
        ticketNumber: null,
      };
      await mkdir(directory(id), { mode: 0o700 });
      if ("bytes" in input)
        await writeFile(
          path.join(directory(id), "archive.cc-ticket.gz"),
          input.bytes,
          { mode: 0o600 },
        );
      await save(projectPath, transfer, createdAt);
      launch(projectPath, transfer, createdAt, async () => {
        const bundle =
          "number" in input
            ? await deps.capture(projectPath, input.number)
            : await decodeTicketBundle(input.bytes);
        const bytes =
          "number" in input ? await encodeTicketBundle(bundle) : input.bytes;
        if ("number" in input)
          await writeFile(
            path.join(directory(id), "archive.cc-ticket.gz"),
            bytes,
            { mode: 0o600 },
          );
        Object.assign(transfer, {
          status: "ready",
          title: bundle.ticket.title,
          documentCount: bundle.documents.length,
          omissions: bundle.omissions,
          digest: bundleDigest(bytes),
        });
        await save(projectPath, transfer, createdAt);
        logger.info("bundle.prepared", {
          id,
          mode: transfer.mode,
          documents: transfer.documentCount,
        });
      });
      return { ...transfer, status: "preparing" };
    },
    async get(projectPath: string, id: string): Promise<BundleTransfer> {
      return (await load(projectPath, id)).transfer;
    },
    async download(
      projectPath: string,
      id: string,
      acknowledgedDigest?: string,
    ): Promise<Uint8Array> {
      const { state, bytes } = await archive(projectPath, id);
      if (state.transfer.mode !== "export" || state.transfer.status !== "ready")
        throw new Error("Bundle is not ready to download");
      if (
        state.transfer.omissions.length &&
        acknowledgedDigest !== state.transfer.digest
      )
        throw new Error(
          "Acknowledge the listed omissions for this prepared bundle before downloading",
        );
      return bytes;
    },
    async commit(
      projectPath: string,
      id: string,
      digest: string,
      allowDuplicate: boolean,
    ): Promise<BundleTransfer> {
      const { state, bytes } = await archive(projectPath, id);
      const transfer = state.transfer;
      if (transfer.status === "imported" || transfer.status === "importing")
        return transfer;
      if (
        transfer.mode !== "import" ||
        !["ready", "duplicate"].includes(transfer.status) ||
        digest !== transfer.digest
      )
        throw new Error("Review this prepared bundle before importing");
      const claim = path.join(directory(id), "import-claim");
      await writeFile(claim, "", { flag: "wx", mode: 0o600 });
      transfer.status = "importing";
      transfer.error = null;
      await save(projectPath, transfer, state.createdAt);
      launch(projectPath, transfer, state.createdAt, async () => {
        try {
          transfer.ticketNumber = await deps.importBundle(
            await decodeTicketBundle(bytes),
            projectPath,
            allowDuplicate,
          );
          transfer.status = "imported";
          await save(projectPath, transfer, state.createdAt);
        } finally {
          await rm(claim, { force: true });
        }
      });
      return { ...transfer };
    },
  };
}
