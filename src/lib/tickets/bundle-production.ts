import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  getConversationById,
  getProjectConversation,
  getSession,
  getStateDb,
} from "@/lib/state-store";
import { getSharedWriteQueue } from "@/lib/state-store/write-queue";
import { createContextArtifactsRepo } from "@/lib/context-artifacts/repo";
import { compactionEnvelopeToMarkdown } from "@/lib/context-artifacts/render-markdown";
import { createSessionAlignmentRepo } from "@/lib/session-alignment/repo";
import { createMemoryRepo } from "@/lib/state-store/memory-repo";
import { createSpecLinksRepo } from "@/lib/state-store/spec-links-repo";
import { createSpecsRepo } from "@/lib/state-store/specs-repo";
import { createSpecReviewRepo } from "@/lib/state-store/spec-review-repo";
import { createSpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import { createSpecEventsRepo } from "@/lib/state-store/spec-events-repo";
import { stableStringify } from "@/lib/state-store/serialization";
import {
  loadSpecExportState,
  renderVerifiedCanonicalBundle,
} from "@/lib/specs/export";
import { createProductionSpecWorkflowCleanupPort } from "@/lib/specs/workflow-cleanup-port";
import { getTicketContentStore, getTicketsRepo } from "./service-factory";
import type { BundleCaptureDeps, BundleContext } from "./bundle-capture";

/** Registry adapters enumerate explicit context; archive capture never needs to know each domain's storage layout. */
export function createBundleCaptureDeps(): BundleCaptureDeps {
  return {
    repo: getTicketsRepo(),
    contentStore: getTicketContentStore(),
    readFile,
    async getSession(projectPath, sessionName) {
      const session = await getSession(projectPath, sessionName);
      return session ? { ...session, projectPath } : null;
    },
    async getConversation(projectPath, sessionName, id) {
      if (sessionName === null) return getProjectConversation(projectPath, id);
      const session = await getSession(projectPath, sessionName);
      return (
        session?.conversations.find((conversation) => conversation.id === id) ??
        null
      );
    },
    async getContext(ticket, capturedSessions, conversationIds) {
      const db = getStateDb();
      const queue = getSharedWriteQueue();
      const contexts: BundleContext[] = [];
      const sessions = new Map(
        capturedSessions.map((session) => [
          JSON.stringify([session.projectPath, session.sessionName]),
          session,
        ]),
      );
      for (const id of conversationIds) {
        const owner = await getConversationById(id);
        if (owner) {
          const session = await getSession(
            owner.projectPath,
            owner.sessionName,
          );
          if (session)
            sessions.set(
              JSON.stringify([owner.projectPath, owner.sessionName]),
              { ...session, projectPath: owner.projectPath },
            );
        }
      }
      const text = (
        source: string,
        fileName: string,
        description: string,
        content: string,
      ) =>
        contexts.push({
          source,
          fileName,
          description,
          text: content,
          mediaType: "text/markdown",
        });
      const json = (
        source: string,
        fileName: string,
        description: string,
        value: unknown,
      ) =>
        contexts.push({
          source,
          fileName,
          description,
          text: JSON.stringify(value, null, 2),
          mediaType: "application/json",
        });
      const specLinks = createSpecLinksRepo(db);
      const conversationSpecIds = new Set<string>();
      const alignment = createSessionAlignmentRepo(db);
      for (const session of sessions.values()) {
        contexts.push({
          source: `session-context:${session.projectPath}/${session.sessionName}`,
          fileName: "session-context.json",
          description: `Source session context: ${session.sessionName}`,
          text: JSON.stringify(
            {
              projectPath: session.projectPath,
              sessionName: session.sessionName,
              createdAt: session.createdAt,
              worktreePath: session.worktreePath,
              referenceDocuments: session.referenceDocuments,
            },
            null,
            2,
          ),
          mediaType: "application/json",
          ...(session.projectPath === ticket.projectPath
            ? { checkoutRoot: session.worktreePath }
            : {}),
        });
        for (const conversation of session.conversations) {
          if (!conversationIds.includes(conversation.id)) continue;
          for (const link of specLinks.findByLinkedObject(
            "conversation",
            stableStringify({
              projectName: path.basename(session.projectPath),
              sessionName: session.sessionName,
              conversationId: conversation.id,
            }),
          ))
            conversationSpecIds.add(link.spec_id);
        }

        for (const ref of session.referenceDocuments) {
          const filePath = path.resolve(session.worktreePath, ref.filePath);
          contexts.push({
            source: filePath,
            fileName: path.basename(filePath),
            description: ref.description,
            filePath,
          });
        }
        for (const charter of alignment.findVersionHistory(
          session.projectPath,
          session.sessionName,
        )) {
          text(
            `charter:${charter.id}`,
            `charter-${charter.id}.md`,
            `Alignment charter: ${session.sessionName}, version ${charter.version}`,
            charter.content,
          );
        }
        const draft = alignment.findDraftVersion(
          session.projectPath,
          session.sessionName,
        );
        if (draft)
          text(
            `charter:${draft.id}`,
            `charter-${draft.id}.md`,
            `Unapproved Alignment draft: ${session.sessionName}`,
            draft.content,
          );
        const decisions = alignment.findDecisionsReverseChron(
          session.projectPath,
          session.sessionName,
        );
        if (decisions.length)
          json(
            `decisions:${session.projectPath}/${session.sessionName}`,
            "alignment-decisions.json",
            `Alignment decisions: ${session.sessionName}`,
            decisions,
          );
      }
      for (const artifact of createContextArtifactsRepo(
        db,
      ).findByConversationIds(conversationIds)) {
        if (!artifact.payload || artifact.status !== "complete") {
          contexts.push({
            source: `compaction:${artifact.id}`,
            fileName: "compaction.md",
            description: "Conversation compaction",
            missing: `Compaction is ${artifact.status}`,
          });
          continue;
        }
        json(
          `compaction-record:${artifact.id}`,
          `${artifact.id}.json`,
          `Compaction record: ${artifact.conversationId}`,
          artifact,
        );
        text(
          `compaction:${artifact.id}`,
          `${artifact.id}.md`,
          `Compaction summary: ${artifact.conversationId}`,
          compactionEnvelopeToMarkdown(artifact.payload, {
            stale: false,
            staleBehindMessages: 0,
            outdated: false,
            updatedAt: artifact.updatedAt,
          }),
        );
      }
      const memory = createMemoryRepo(db, queue);
      for (const link of await memory.listLinksForArtifact({
        kind: "ticket",
        ticketId: ticket.id,
      })) {
        const note = await memory.find(link.memoryId);
        if (note) {
          text(
            `memory:${note.id}`,
            `${note.slug}.md`,
            note.hook,
            `# ${note.hook}\n\n${note.body}`,
          );
          json(
            `memory-record:${note.id}`,
            `${note.slug}.json`,
            `Memory provenance: ${note.slug}`,
            { note, links: await memory.listLinks(note.id) },
          );
        } else
          contexts.push({
            source: `memory:${link.memoryId}`,
            fileName: "memory.md",
            description: "Ticket-linked memory",
            missing: "Linked memory note is unavailable",
          });
      }
      const links = createSpecLinksRepo(db).findByLinkedObject(
        "ticket",
        stableStringify({
          ticketId: ticket.id,
          projectName: ticket.projectName,
          number: ticket.number,
        }),
      );
      for (const id of new Set([
        ...links.map((link) => link.spec_id),
        ...conversationSpecIds,
      ])) {
        try {
          const state = await loadSpecExportState(
            {
              specs: createSpecsRepo(db, queue),
              review: createSpecReviewRepo(db),
              delivery: createSpecDeliveryRepo(db),
              events: createSpecEventsRepo(db),
              observeLinkedWorkflow:
                createProductionSpecWorkflowCleanupPort().observe,
            },
            id,
          );
          const exported = renderVerifiedCanonicalBundle(state);
          json(
            `spec:${id}`,
            `spec-${id}.json`,
            `Linked specification ${state.spec.name}`,
            {
              manifest: JSON.parse(exported.manifest),
              links: createSpecLinksRepo(db).findBySpecId(id),
            },
          );
          for (const file of exported.markdownFiles)
            text(
              `spec:${id}/${file.path}`,
              path.basename(file.path),
              `Specification: ${file.path}`,
              file.content,
            );
        } catch {
          contexts.push({
            source: `spec:${id}`,
            fileName: "spec.json",
            description: "Linked specification",
            missing:
              "Linked specification could not be exported with verified integrity",
          });
        }
      }
      return contexts;
    },
  };
}
