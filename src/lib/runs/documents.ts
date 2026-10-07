import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { ArtifactStore } from "@/lib/artifacts/store";
import { getErrorMessage } from "@/lib/shared/errors";
import type { ContractDocument } from "@/lib/execution-context/schemas";
import type { RunDocument, RunDocumentRevision } from "./schemas";

/**
 * A run's documents: declared at launch (or amendment), frozen as artifact
 * snapshots before anything is recorded, kept as revisions per path, and
 * bound to each context when it starts. A seat reads its context's documents
 * as read-only copies under this directory of its working directory, in the
 * context's own subdirectory.
 */
export const RUN_DOCUMENTS_DIR = ".cc/run-docs";
export const MAX_DOCUMENT_BYTES = 262_144;
export const MAX_RUN_DOCUMENTS_BYTES = 1_048_576;

export const runDocumentRequestSchema = z
  .object({
    /** Where the document appears under the run's documents directory. */
    path: z.string(),
    /** A file in the session worktree, read when the run launches or is amended. */
    from: z.string().min(1).optional(),
    contents: z.string().optional(),
    description: z.string().trim().min(1),
    readWhen: z.string().trim().min(1).optional(),
    /** The context keys it is for; every context when absent. */
    appliesTo: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();
export type RunDocumentRequest = z.infer<typeof runDocumentRequestSchema>;

export interface DocumentIssue {
  path: Array<string | number>;
  message: string;
}

const MAX_NAME_BYTES = 200;

function pathProblem(documentPath: string): string | null {
  const parts = documentPath.split("/");
  if (
    documentPath.length === 0 ||
    documentPath.length > 240 ||
    documentPath.startsWith("/") ||
    documentPath.includes("\\") ||
    parts.some((part) => part === "" || part === "." || part === "..")
  )
    return `Document path "${documentPath}" must be a relative path with no empty, "." or ".." parts`;
  if ([...documentPath].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f))
    return `Document path "${documentPath}" contains a control character`;
  if (parts.some((part) => Buffer.byteLength(part) > MAX_NAME_BYTES))
    return `Document path "${documentPath}" has a name longer than ${MAX_NAME_BYTES} bytes`;
  return null;
}

/**
 * Where a path would collide with one declared before it: the same path, the
 * same path in another case (one file on a case-insensitive disk), or a
 * directory of it, or inside it.
 */
function collision(documentPath: string, earlier: readonly string[]): string | null {
  const folded = documentPath.toLowerCase();
  for (const other of earlier) {
    const otherFolded = other.toLowerCase();
    if (other === documentPath) return `"${documentPath}" is already another document's path`;
    if (otherFolded === folded)
      return `"${documentPath}" differs from "${other}" only by case, and on a case-insensitive disk they are one file`;
    if (otherFolded.startsWith(`${folded}/`) || folded.startsWith(`${otherFolded}/`))
      return `"${documentPath}" and "${other}" cannot both be documents: one would be a directory of the other`;
  }
  return null;
}

function issuesOf(request: RunDocumentRequest, index: number, earlier: string[]): DocumentIssue[] {
  const issues: DocumentIssue[] = [];
  const problem = pathProblem(request.path) ?? collision(request.path, earlier);
  if (problem !== null) issues.push({ path: ["documents", index, "path"], message: problem });
  else earlier.push(request.path);
  if ((request.from === undefined) === (request.contents === undefined))
    issues.push({
      path: ["documents", index],
      message: "A document needs exactly one of from (a file in the session worktree) or contents",
    });
  else if (request.contents !== undefined && Buffer.byteLength(request.contents) > MAX_DOCUMENT_BYTES)
    issues.push({ path: ["documents", index], message: `A document can hold at most ${MAX_DOCUMENT_BYTES} bytes` });
  return issues;
}

/** A file's bytes, read only from inside the session worktree (links included). */
async function readFromWorktree(
  worktreePath: string,
  from: string,
  index: number,
): Promise<{ ok: true; bytes: Buffer } | { ok: false; issue: DocumentIssue }> {
  const located = (message: string) => ({ ok: false as const, issue: { path: ["documents", index, "from"], message } });
  const base = await realpath(worktreePath);
  const outsideOf = (target: string) => {
    const relative = path.relative(base, target);
    return relative.startsWith("..") || path.isAbsolute(relative);
  };
  const candidate = path.resolve(base, from);
  if (path.isAbsolute(from) || outsideOf(candidate))
    return located(`"${from}" must be a file inside the session worktree`);
  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    return located(`No file at "${from}" in the session worktree`);
  }
  if (outsideOf(real)) return located(`"${from}" must be a file inside the session worktree; it links outside it`);
  try {
    const found = await stat(real);
    if (!found.isFile()) return located(`"${from}" is not a file`);
    // Checked before reading, so a mistaken huge file is refused without loading it.
    if (found.size > MAX_DOCUMENT_BYTES)
      return {
        ok: false,
        issue: { path: ["documents", index], message: `A document can hold at most ${MAX_DOCUMENT_BYTES} bytes` },
      };
    return { ok: true, bytes: await readFile(real) };
  } catch (error) {
    return located(`"${from}" could not be read: ${getErrorMessage(error)}`);
  }
}

/**
 * Freezes declared documents: reads each one's bytes, checks them, and only
 * when every document is sound stores them as artifacts. Every problem is
 * reported, each at the declaration it concerns.
 */
export async function snapshotRunDocuments(input: {
  requests: readonly RunDocumentRequest[];
  worktreePath: string;
  store: Pick<ArtifactStore, "snapshot">;
}): Promise<{ ok: true; documents: RunDocument[] } | { ok: false; issues: DocumentIssue[] }> {
  const issues: DocumentIssue[] = [];
  const earlier: string[] = [];
  const read: Array<{ request: RunDocumentRequest; bytes: Buffer }> = [];
  for (const [index, request] of input.requests.entries()) {
    const found = issuesOf(request, index, earlier);
    if (found.length > 0) {
      issues.push(...found);
      continue;
    }
    let bytes: Buffer;
    if (request.from !== undefined) {
      const file = await readFromWorktree(input.worktreePath, request.from, index);
      if (!file.ok) {
        issues.push(file.issue);
        continue;
      }
      bytes = file.bytes;
    } else {
      bytes = Buffer.from(request.contents ?? "");
    }
    if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
      issues.push({ path: ["documents", index], message: `A document can hold at most ${MAX_DOCUMENT_BYTES} bytes` });
      continue;
    }
    read.push({ request, bytes });
  }
  const total = read.reduce((sum, entry) => sum + entry.bytes.byteLength, 0);
  if (total > MAX_RUN_DOCUMENTS_BYTES)
    issues.push({ path: ["documents"], message: `A run's documents can hold at most ${MAX_RUN_DOCUMENTS_BYTES} bytes together` });
  if (issues.length > 0) return { ok: false, issues };
  const documents: RunDocument[] = [];
  for (const { request, bytes } of read) {
    const ref = await input.store.snapshot(bytes);
    documents.push({
      path: request.path,
      artifactId: ref.artifactId,
      bytes: ref.bytes,
      description: request.description,
      ...(request.readWhen !== undefined ? { readWhen: request.readWhen } : {}),
      ...(request.appliesTo !== undefined ? { appliesTo: request.appliesTo } : {}),
    });
  }
  return { ok: true, documents };
}

/** The latest revision of each document path, in the order the paths first appeared. */
function latestByPath(revisions: readonly RunDocumentRevision[]): Map<string, RunDocumentRevision> {
  const latest = new Map<string, RunDocumentRevision>();
  for (const revision of revisions) latest.set(revision.path, revision);
  return latest;
}

/**
 * The revisions after a launch or amendment declared `next`: one for each
 * document that is new or changed, and one for each document `next` leaves
 * out, which removes it. An unchanged document gets no revision.
 */
export function reviseDocuments(
  revisions: readonly RunDocumentRevision[],
  next: readonly RunDocument[],
  source: RunDocumentRevision["source"],
  at: string,
): RunDocumentRevision[] {
  const latest = latestByPath(revisions);
  const revised = [...revisions];
  const declared = new Set<string>();
  for (const { path: documentPath, ...document } of next) {
    declared.add(documentPath);
    const previous = latest.get(documentPath);
    if (previous?.document != null && isDeepStrictEqual(previous.document, document)) continue;
    revised.push({ path: documentPath, revision: (previous?.revision ?? 0) + 1, source, at, document });
  }
  for (const [documentPath, previous] of latest) {
    if (previous.document === null || declared.has(documentPath)) continue;
    revised.push({ path: documentPath, revision: previous.revision + 1, source, at, document: null });
  }
  return revised;
}

/** The latest revision of each document the run still has, in the order the paths first appeared. */
export function currentDocuments(
  revisions: readonly RunDocumentRevision[],
): Array<RunDocumentRevision & { document: NonNullable<RunDocumentRevision["document"]> }> {
  return [...latestByPath(revisions).values()].flatMap((revision) =>
    revision.document === null ? [] : [{ ...revision, document: revision.document }],
  );
}

/**
 * What a context freezes when it starts: the latest revision of every
 * document meant for its key, in a directory of its own, so contexts sharing
 * a worktree never overwrite each other's frozen copies.
 */
export function documentsFor(input: {
  revisions: readonly RunDocumentRevision[];
  contextId: string;
  key: string;
}): ContractDocument[] {
  return currentDocuments(input.revisions).flatMap(({ path: documentPath, document }) =>
    document.appliesTo !== undefined && !document.appliesTo.includes(input.key)
      ? []
      : [
          {
            artifactId: document.artifactId,
            path: `${RUN_DOCUMENTS_DIR}/${input.contextId}/${documentPath}`,
            description: document.description,
            ...(document.readWhen !== undefined ? { readWhen: document.readWhen } : {}),
          },
        ],
  );
}
