import path from "node:path";
import { createLogger } from "@/lib/logging";
import type { TicketsRepo } from "@/lib/state-store/tickets-repo";
import type { TicketContentStore } from "./content-store";
import type { TicketDetail } from "./schemas";
import type { TicketBundle } from "./bundle";

export interface BundleSession {
  projectPath: string;
  sessionName: string;
  createdAt: string;
  worktreePath: string;
  conversations: { id: string; transcriptPath: string | null }[];
  referenceDocuments: { filePath: string; description: string }[];
}
export interface BundleContext {
  source: string;
  checkoutRoot?: string;
  fileName: string;
  description: string;
  mediaType?: string;
  text?: string;
  filePath?: string;
  missing?: string;
}
export interface BundleCaptureDeps {
  repo: TicketsRepo;
  contentStore: TicketContentStore;
  readFile(filePath: string): Promise<Uint8Array>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<BundleSession | null>;
  getConversation(
    projectPath: string,
    sessionName: string | null,
    id: string,
  ): Promise<{ transcriptPath: string | null } | null>;
  getContext(
    ticket: TicketDetail,
    sessions: BundleSession[],
    conversationIds: string[],
  ): Promise<BundleContext[]>;
}
const logger = createLogger("tickets.bundle-capture");

/** Capture only explicit context edges; prose remains uninterpreted historical content. */
export async function captureTicketBundle(
  deps: BundleCaptureDeps,
  projectPath: string,
  number: number,
): Promise<TicketBundle> {
  const ticket = await deps.repo.find(projectPath, number);
  if (!ticket) throw new Error("Ticket not found");
  const bundle: TicketBundle = {
    format: "cc-ticket-bundle",
    version: 1,
    capturedAt: new Date().toISOString(),
    ticket,
    attachments: ticket.attachments,
    relationships: ticket.relationships,
    sessions: ticket.sessions,
    statusUpdates: [],
    roots: [projectPath],
    omissions: [],
    documents: [],
  };
  const seen = new Set<string>();
  const sessions = new Map<string, BundleSession>();
  const conversations = new Map<
    string,
    {
      projectPath: string;
      sessionName: string | null;
      transcriptPath?: string | null;
    }
  >();
  const missing = (source: string, reason: string) => {
    bundle.omissions.push({ source, reason });
  };
  async function document(
    source: string,
    fileName: string,
    description: string,
    read: () => Promise<Uint8Array>,
    mediaType: string | null = null,
  ) {
    if (seen.has(source)) return;
    seen.add(source);
    try {
      const bytes = await read();
      bundle.documents.push({
        source,
        fileName,
        description,
        mediaType,
        content: Buffer.from(bytes).toString("base64"),
        sha256: "",
      });
    } catch {
      missing(source, "Source content is unavailable or unreadable");
    }
  }
  async function session(
    project: string,
    name: string,
    incarnation?: string | null,
  ) {
    const key = JSON.stringify([project, name]);
    const value = await deps.getSession(project, name);
    if (!value || (incarnation && value.createdAt !== incarnation)) {
      missing(
        `session:${project}/${name}`,
        "The linked session no longer exists (or its name belongs to a different session)",
      );
      return;
    }
    if (sessions.has(key)) return;
    sessions.set(key, value);
    if (project === projectPath) bundle.roots.push(value.worktreePath);
    for (const conversation of value.conversations)
      conversations.set(conversation.id, {
        projectPath: project,
        sessionName: name,
        transcriptPath: conversation.transcriptPath,
      });
    for (const ref of value.referenceDocuments) {
      const filePath = path.resolve(value.worktreePath, ref.filePath);
      await document(filePath, path.basename(filePath), ref.description, () =>
        deps.readFile(filePath),
      );
    }
  }
  for (const link of ticket.sessions)
    await session(link.projectPath, link.sessionName, link.sessionCreatedAt);
  for (const attachment of ticket.attachments) {
    const payload = attachment.payload;
    if (payload.kind === "file") {
      await document(
        `attachment:${attachment.id}`,
        payload.fileName,
        attachment.description,
        () => deps.contentStore.read(payload.snapshotKey),
        payload.mediaType,
      );
    }
    if (payload.kind === "conversation") {
      conversations.set(payload.conversationId, {
        projectPath: payload.projectPath,
        sessionName: payload.sessionName,
      });
      if (payload.snapshotKey)
        await document(
          `attachment:${attachment.id}`,
          `${payload.conversationId}-summary.md`,
          attachment.description,
          () => deps.contentStore.read(payload.snapshotKey!),
          "text/markdown",
        );
      else
        missing(
          `attachment:${attachment.id}`,
          `Retained conversation summary is ${payload.snapshotStatus ?? "unavailable"}; any available transcript is captured separately`,
        );
    }
    if (payload.kind === "session")
      await session(payload.projectPath, payload.sessionName);
  }
  let cursor: string | undefined;
  do {
    const page = await deps.repo.listStatusUpdates({
      ticketId: ticket.id,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    bundle.statusUpdates.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  for (const [id, ref] of conversations) {
    const conversation =
      ref.transcriptPath !== undefined
        ? ref
        : await deps.getConversation(ref.projectPath, ref.sessionName, id);
    if (!conversation?.transcriptPath) {
      missing(
        `conversation:${id}`,
        "Conversation transcript is unavailable; retained summaries, if any, are included separately",
      );
      continue;
    }
    const transcriptPath = conversation.transcriptPath;
    await document(
      `conversation:${id}`,
      `${id}.jsonl`,
      `Full conversation history: ${id} (original transcript ${transcriptPath})`,
      async () => {
        const bytes = await deps.readFile(transcriptPath);
        const images = new Set<string>();
        function collectImages(value: unknown): void {
          if (!value || typeof value !== "object") return;
          if (Array.isArray(value)) {
            value.forEach(collectImages);
            return;
          }
          const record = Object.fromEntries(Object.entries(value));
          if (
            (record["type"] === "image_ref" ||
              record["type"] === "image_marker") &&
            typeof record["imagePath"] === "string"
          )
            images.add(record["imagePath"]);
          Object.values(record).forEach(collectImages);
        }
        for (const line of Buffer.from(bytes).toString("utf8").split("\n")) {
          if (!line.trim()) continue;
          try {
            collectImages(JSON.parse(line));
          } catch {
            missing(
              `conversation:${id}`,
              "Transcript contains an incomplete or invalid record; original bytes are retained",
            );
          }
        }
        for (const imagePath of images)
          await document(
            imagePath,
            path.basename(imagePath),
            `Conversation image: ${id}`,
            () => deps.readFile(imagePath),
          );
        return bytes;
      },
      "application/x-ndjson",
    );
  }
  for (const context of await deps.getContext(
    ticket,
    [...sessions.values()],
    [...conversations.keys()],
  )) {
    if (context.checkoutRoot) bundle.roots.push(context.checkoutRoot);
    if (context.missing) {
      missing(context.source, context.missing);
      continue;
    }
    await document(
      context.source,
      context.fileName,
      context.description,
      async () => {
        if (context.text !== undefined) return Buffer.from(context.text);
        if (context.filePath) return deps.readFile(context.filePath);
        throw new Error("Context has no content");
      },
      context.mediaType ?? null,
    );
  }
  const current = await deps.repo.find(projectPath, number);
  if (!current || current.updatedAt !== ticket.updatedAt)
    throw new Error(
      "Ticket changed during capture. Export again to capture its current content.",
    );
  bundle.roots = [...new Set(bundle.roots)];
  logger.info("bundle.captured", {
    ticketId: ticket.id,
    documents: bundle.documents.length,
    conversations: conversations.size,
    omissions: bundle.omissions.length,
  });
  return bundle;
}
