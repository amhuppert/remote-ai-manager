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
/** Where a context's charter is copied, beside its documents; no declared document may take it. */
export const RESERVED_CHARTER_DOCUMENT = "charter.md";

export const runDocumentRequestSchema = z
  .object({
    /** Where the document appears under the run's documents directory. */
    path: z.string(),
    /** A file in the session worktree, read when the run launches or is amended. */
    from: z.string().min(1).optional(),
    contents: z.string().optional(),
    /**
     * The run's current revision of this path the declaration was written
     * against (an amendment, from `run definition`): alone, it keeps that
     * revision as it is; with from or contents, it replaces it.
     */
    revision: z.number().int().min(1).optional(),
    description: z.string().trim().min(1),
    readWhen: z.string().trim().min(1).optional(),
    /** The context keys it is for; every context when absent. */
    appliesTo: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();
export type RunDocumentRequest = z.infer<typeof runDocumentRequestSchema>;

/**
 * A declared document as frozen, and the revision of its path it was written
 * against, which must still be the latest when the amendment is recorded.
 */
export type ProposedDocument = RunDocument & { seen?: number };

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
  const folded = documentPath.toLowerCase();
  if (folded === RESERVED_CHARTER_DOCUMENT || folded.startsWith(`${RESERVED_CHARTER_DOCUMENT}/`))
    return `Document path "${documentPath}" is reserved for the run's charter`;
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
  const sources = [request.from, request.contents].filter((source) => source !== undefined).length;
  if (sources > 1 || (sources === 0 && request.revision === undefined))
    issues.push({
      path: ["documents", index],
      message:
        "A document needs exactly one of from (a file in the session worktree) or contents, or revision alone to keep the run's current one",
    });
  else if (request.contents !== undefined && Buffer.byteLength(request.contents) > MAX_DOCUMENT_BYTES)
    issues.push({ path: ["documents", index], message: `A document can hold at most ${MAX_DOCUMENT_BYTES} bytes` });
  return issues;
}

/**
 * A file's bytes, read only from inside a worktree (links included). `place`
 * names the worktree to whoever wrote the path.
 */
export async function readDocumentFile(
  worktreePath: string,
  file: string,
  place: string,
): Promise<{ ok: true; bytes: Buffer; relative: string } | { ok: false; message: string; tooLarge: boolean }> {
  const refused = (message: string, tooLarge = false) => ({ ok: false as const, message, tooLarge });
  const base = await realpath(worktreePath);
  const outsideOf = (target: string) => {
    const relative = path.relative(base, target);
    return relative.startsWith("..") || path.isAbsolute(relative);
  };
  // An absolute path is judged once links are resolved: the worktree itself may be reached through one.
  const candidate = path.resolve(base, file);
  if (!path.isAbsolute(file) && outsideOf(candidate)) return refused(`"${file}" must be a file inside ${place}`);
  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    return refused(`No file at "${file}" in ${place}`);
  }
  if (outsideOf(real))
    return refused(`"${file}" must be a file inside ${place}${path.isAbsolute(file) ? "" : "; it links outside it"}`);
  const relative = path.isAbsolute(file)
    ? path.relative(base, path.join(await realpath(path.dirname(file)), path.basename(file)))
    : path.normalize(file);
  try {
    const found = await stat(real);
    if (!found.isFile()) return refused(`"${file}" is not a file`);
    const tooLarge = refused(`A document can hold at most ${MAX_DOCUMENT_BYTES} bytes`, true);
    // Checked before reading, so a mistaken huge file is refused without loading it, and after, in case it grew.
    if (found.size > MAX_DOCUMENT_BYTES) return tooLarge;
    const bytes = await readFile(real);
    return bytes.byteLength > MAX_DOCUMENT_BYTES ? tooLarge : { ok: true, bytes, relative };
  } catch (error) {
    return refused(`"${file}" could not be read: ${getErrorMessage(error)}`);
  }
}

/**
 * Freezes a file a seat publishes, read from inside its working directory,
 * with its path relative to that directory. A frozen copy is refused: the
 * seat edits a copy of it elsewhere and publishes that.
 */
export async function snapshotDocumentFile(input: {
  worktreePath: string;
  file: string;
  store: Pick<ArtifactStore, "snapshot">;
}): Promise<{ ok: true; path: string; artifactId: string; bytes: number } | { ok: false; message: string }> {
  const read = await readDocumentFile(input.worktreePath, input.file, "your working directory");
  if (!read.ok) return { ok: false, message: read.message };
  if (read.relative.startsWith(`${RUN_DOCUMENTS_DIR}/`))
    return {
      ok: false,
      message: `"${input.file}" is a frozen copy: copy it elsewhere, edit it there and publish that file with --as <document path>`,
    };
  const { artifactId, bytes } = await input.store.snapshot(read.bytes);
  return { ok: true, path: read.relative, artifactId, bytes };
}

/**
 * Freezes declared documents: reads each one's bytes, checks them, and only
 * when every document is sound stores them as artifacts. A declaration that
 * keeps a revision takes the bytes `current` already holds. Every problem is
 * reported, each at the declaration it concerns.
 */
export async function snapshotRunDocuments(input: {
  requests: readonly RunDocumentRequest[];
  /** The run's revisions, for an amendment; none at launch. */
  current?: readonly RunDocumentRevision[];
  worktreePath: string;
  store: Pick<ArtifactStore, "snapshot">;
}): Promise<{ ok: true; documents: ProposedDocument[] } | { ok: false; issues: DocumentIssue[] }> {
  const issues: DocumentIssue[] = [];
  const earlier: string[] = [];
  const latest = new Map(currentDocuments(input.current ?? []).map((revision) => [revision.path, revision]));
  const read: Array<{
    request: RunDocumentRequest;
    source: { bytes: Buffer } | { kept: number; artifactId: string; bytes: number };
  }> = [];
  for (const [index, request] of input.requests.entries()) {
    const found = issuesOf(request, index, earlier);
    if (found.length > 0) {
      issues.push(...found);
      continue;
    }
    const replaces = request.from !== undefined || request.contents !== undefined;
    const current = latest.get(request.path);
    const atRevision = (message: string) => issues.push({ path: ["documents", index, "revision"], message });
    if (request.revision !== undefined && current === undefined) {
      atRevision(`The run has no document "${request.path}" to ${replaces ? "replace" : "keep"}`);
      continue;
    }
    if (request.revision !== undefined && current !== undefined && current.revision !== request.revision) {
      atRevision(
        `"${request.path}" was read at revision ${request.revision}, but its latest is revision ${current.revision}; read run definition again`,
      );
      continue;
    }
    // Replacing what a seat published without having read it would silently undo the publication.
    if (request.revision === undefined && current?.source === "publish") {
      atRevision(
        `"${request.path}" revision ${current.revision} was published by ${current.by ?? "a context"}; to replace it, name it ("revision": ${current.revision}), or keep it`,
      );
      continue;
    }
    if (!replaces && current !== undefined) {
      read.push({
        request,
        source: { kept: current.revision, artifactId: current.document.artifactId, bytes: current.document.bytes },
      });
      continue;
    }
    let bytes: Buffer;
    if (request.from !== undefined) {
      const file = await readDocumentFile(input.worktreePath, request.from, "the session worktree");
      if (!file.ok) {
        issues.push({ path: file.tooLarge ? ["documents", index] : ["documents", index, "from"], message: file.message });
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
    read.push({ request, source: { bytes } });
  }
  const total = read.reduce(
    (sum, { source }) => sum + ("kept" in source ? source.bytes : source.bytes.byteLength),
    0,
  );
  if (total > MAX_RUN_DOCUMENTS_BYTES)
    issues.push({ path: ["documents"], message: `A run's documents can hold at most ${MAX_RUN_DOCUMENTS_BYTES} bytes together` });
  if (issues.length > 0) return { ok: false, issues };
  const documents: ProposedDocument[] = [];
  for (const { request, source } of read) {
    const ref = "kept" in source ? source : await input.store.snapshot(source.bytes);
    documents.push({
      path: request.path,
      artifactId: ref.artifactId,
      bytes: ref.bytes,
      description: request.description,
      ...(request.readWhen !== undefined ? { readWhen: request.readWhen } : {}),
      ...(request.appliesTo !== undefined ? { appliesTo: request.appliesTo } : {}),
      ...(request.revision !== undefined ? { seen: request.revision } : {}),
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
  /** Why the owner amended the run, recorded with each revision it makes. */
  reason?: string,
): RunDocumentRevision[] {
  const latest = latestByPath(revisions);
  const revised = [...revisions];
  const declared = new Set<string>();
  const why = reason !== undefined ? { reason } : {};
  for (const { path: documentPath, ...document } of next) {
    declared.add(documentPath);
    const previous = latest.get(documentPath);
    if (previous?.document != null && isDeepStrictEqual(previous.document, document)) continue;
    revised.push({ path: documentPath, revision: (previous?.revision ?? 0) + 1, source, at, ...why, document });
  }
  for (const [documentPath, previous] of latest) {
    if (previous.document === null || declared.has(documentPath)) continue;
    revised.push({ path: documentPath, revision: previous.revision + 1, source, at, ...why, document: null });
  }
  return revised;
}

/** What a seat publishes: the bytes it froze, and what it says about them when it says anything. */
export interface DocumentPublication {
  path: string;
  artifactId: string;
  bytes: number;
  description?: string;
  readWhen?: string;
  /** The context whose seat published it. */
  by: string;
  /**
   * The revision of this path the publishing context froze when it started:
   * null when it froze none, absent when its start did not record it.
   */
  base?: number | null;
}

/**
 * The revisions after a seat published one document: a new revision of that
 * path only, checked as a declaration would be against the run's other
 * current documents. A revision keeps the description, read-when text and
 * applicability its document had unless the seat gives new ones.
 */
export function publishDocument(
  revisions: readonly RunDocumentRevision[],
  published: DocumentPublication,
  at: string,
):
  | { ok: true; revisions: RunDocumentRevision[]; revision: number; unchanged: boolean }
  | { ok: false; reason: string } {
  const current = currentDocuments(revisions);
  const others = current.filter((revision) => revision.path !== published.path);
  const problem = pathProblem(published.path) ?? collision(published.path, others.map((revision) => revision.path));
  if (problem !== null) return { ok: false, reason: problem };
  const previous = latestByPath(revisions).get(published.path);
  // Publishing over a revision the publisher never read would silently replace it.
  if (
    published.base !== undefined &&
    previous !== undefined &&
    previous.revision !== published.base &&
    previous.by !== published.by
  )
    return {
      ok: false,
      reason: `${published.path} is at revision ${previous.revision}, ${previous.source === "publish" ? `published by ${previous.by ?? "another context"}` : "made by an amendment"} after you started${published.base === null ? "" : ` from revision ${published.base}`}: publish under another path, or say so in the message that ends your turn`,
    };
  const kept = previous?.document ?? null;
  const description = published.description ?? kept?.description;
  if (description === undefined)
    return { ok: false, reason: `"${published.path}" is a new document, so it needs a description` };
  const total = others.reduce((sum, revision) => sum + revision.document.bytes, published.bytes);
  if (total > MAX_RUN_DOCUMENTS_BYTES)
    return { ok: false, reason: `A run's documents can hold at most ${MAX_RUN_DOCUMENTS_BYTES} bytes together` };
  const readWhen = published.readWhen ?? kept?.readWhen;
  const document = {
    artifactId: published.artifactId,
    bytes: published.bytes,
    description,
    ...(readWhen !== undefined ? { readWhen } : {}),
    ...(kept?.appliesTo !== undefined ? { appliesTo: kept.appliesTo } : {}),
  };
  if (previous !== undefined && kept !== null && isDeepStrictEqual(kept, document))
    return { ok: true, revisions: [...revisions], revision: previous.revision, unchanged: true };
  const revision = (previous?.revision ?? 0) + 1;
  return {
    ok: true,
    revisions: [...revisions, { path: published.path, revision, source: "publish", at, by: published.by, document }],
    revision,
    unchanged: false,
  };
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
  return meantFor(input.revisions, input.key).map(({ path: documentPath, document }) => ({
    artifactId: document.artifactId,
    path: `${RUN_DOCUMENTS_DIR}/${input.contextId}/${documentPath}`,
    description: document.description,
    ...(document.readWhen !== undefined ? { readWhen: document.readWhen } : {}),
  }));
}

/**
 * A workflow as written with the run's current documents in it, each a
 * reference to its latest revision, which an amendment keeps by naming it.
 */
export function withCurrentDocuments(
  authored: Record<string, unknown>,
  revisions: readonly RunDocumentRevision[],
): Record<string, unknown> {
  const { documents: _written, ...rest } = authored;
  const documents = currentDocuments(revisions).map(({ path: documentPath, revision, document }) => ({
    path: documentPath,
    revision,
    description: document.description,
    ...(document.readWhen !== undefined ? { readWhen: document.readWhen } : {}),
    ...(document.appliesTo !== undefined ? { appliesTo: document.appliesTo } : {}),
  }));
  return documents.length === 0 ? rest : { ...rest, documents };
}

/** Which revision of each document a context starting now for `key` freezes. */
export function documentRevisionsFor(
  revisions: readonly RunDocumentRevision[],
  key: string,
): Array<{ path: string; revision: number }> {
  return meantFor(revisions, key).map(({ path: documentPath, revision }) => ({ path: documentPath, revision }));
}

function meantFor(revisions: readonly RunDocumentRevision[], key: string) {
  return currentDocuments(revisions).filter(
    ({ document }) => document.appliesTo === undefined || document.appliesTo.includes(key),
  );
}
