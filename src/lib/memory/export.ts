import { z } from "zod";

import { renderMemoryArtifactHandle } from "./artifact-handles";
import {
  memoryIndexModeSchema,
  memoryKindSchema,
  memoryLifecycleSchema,
  memoryLinkKindSchema,
  memoryScopeSchema,
  memorySessionIncarnationSchema,
  memoryStatusNoteSchema,
  type MemoryLink,
  type MemoryNote,
} from "./schemas";

/**
 * The portable memory archive (spec R14.2): frontmatter-markdown carrying every
 * note's CURRENT state, with revision history deliberately excluded — history is
 * a database concern and an archive that carried it would be a backup rather
 * than the interchange format the spec asks for.
 *
 * Two shapes make the format honest rather than merely plausible:
 *
 * - Values are JSON literals. A hook containing a colon, a body-adjacent quote,
 *   or an alias with a leading `-` are all ordinary content here, so the writer
 *   needs no escaping dialect and the reader needs no YAML.
 * - `bodyLength` states the body's exact character count, so the reader consumes
 *   the body by length instead of scanning for the next `---`. A note ABOUT
 *   frontmatter — the memory library is full of them — otherwise truncates
 *   silently at its own example, which is the one corruption an importer cannot
 *   detect.
 *
 * Identity in the archive is portable: slugs and qualified `scope:slug` handles
 * only. Internal memory ids never appear, so an archive can be re-created into a
 * different Command Center instance without carrying dead references.
 */

const ARCHIVE_MARKER = "command-center-memory";
const ARCHIVE_VERSION = 1;
const DELIMITER = "---";

/** One link as the archive carries it: the artifact in its command-argument handle form. */
export const memoryArchiveLinkSchema = z
  .object({
    kind: memoryLinkKindSchema,
    artifact: z.string().min(1),
  })
  .strict();

/**
 * One note's frontmatter. `body` is not here: it is the markdown that follows
 * the frontmatter, which is what makes the archive readable as documents rather
 * than as a serialized table.
 */
const memoryArchiveFrontmatterSchema = z
  .object({
    slug: z.string().min(1),
    scope: memoryScopeSchema,
    projectPath: z.string().min(1).nullable(),
    session: memorySessionIncarnationSchema.nullable(),
    kind: memoryKindSchema,
    hook: z.string().min(1),
    aliases: z.array(z.string().min(1)),
    statusNote: memoryStatusNoteSchema.nullable(),
    indexMode: memoryIndexModeSchema,
    lifecycle: memoryLifecycleSchema,
    reviewAfter: z.string().min(1).nullable(),
    expiresAt: z.string().min(1).nullable(),
    /** `scope:slug` of the predecessor, or null when it is outside the archive. */
    supersedes: z.string().min(1).nullable(),
    supersededBy: z.string().min(1).nullable(),
    links: z.array(memoryArchiveLinkSchema),
    bodyLength: z.number().int().min(0),
  })
  .strict();

export type MemoryArchiveRecord = Omit<
  z.infer<typeof memoryArchiveFrontmatterSchema>,
  "bodyLength"
> & { readonly body: string };

const archiveHeaderSchema = z
  .object({
    archive: z.literal(ARCHIVE_MARKER),
    version: z.literal(ARCHIVE_VERSION),
    generatedAt: z.string().min(1),
    noteCount: z.number().int().min(0),
  })
  .strict();

export interface MemoryArchive {
  readonly generatedAt: string;
  readonly records: MemoryArchiveRecord[];
}

export interface RenderMemoryArchiveInput {
  readonly generatedAt: string;
  readonly notes: readonly MemoryNote[];
  /** Every note's links, keyed by internal id; a note with none may be absent. */
  readonly linksByMemoryId: ReadonlyMap<string, readonly MemoryLink[]>;
  /**
   * Portable handles for supersession targets that are NOT in `notes`, keyed by
   * internal id. A promoted project note's predecessor is session-scoped, so a
   * project-scoped export holds the successor and not the record it replaced;
   * without this the lineage pointer would silently render as null and the
   * archive would claim the note superseded nothing (R14.2).
   */
  readonly lineageHandlesByMemoryId?: ReadonlyMap<string, string>;
}

/** The portable handle for a note the archive also carries. */
function qualifiedHandle(note: MemoryNote): string {
  return `${note.scope}:${note.slug}`;
}

function renderFrontmatter(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join("\n");
}

export function renderMemoryArchive(input: RenderMemoryArchiveInput): string {
  const handleById = new Map([
    ...(input.lineageHandlesByMemoryId ?? new Map<string, string>()),
    // The exported notes win: a handle derived from the record itself is the
    // authority over one supplied for a record outside the selection.
    ...input.notes.map(
      (note) => [note.id, qualifiedHandle(note)] as [string, string],
    ),
  ]);

  const header = [
    DELIMITER,
    renderFrontmatter({
      archive: ARCHIVE_MARKER,
      version: ARCHIVE_VERSION,
      generatedAt: input.generatedAt,
      noteCount: input.notes.length,
    }),
    DELIMITER,
    "",
  ].join("\n");

  const records = input.notes.map((note) => {
    const links = (input.linksByMemoryId.get(note.id) ?? []).map((row) => ({
      kind: row.kind,
      artifact: renderMemoryArtifactHandle(row.artifact),
    }));
    const frontmatter = renderFrontmatter({
      slug: note.slug,
      scope: note.scope,
      projectPath: note.projectPath,
      session:
        note.sessionName === null || note.sessionCreatedAt === null
          ? null
          : {
              sessionName: note.sessionName,
              sessionCreatedAt: note.sessionCreatedAt,
            },
      kind: note.kind,
      hook: note.hook,
      aliases: note.aliases,
      statusNote: note.statusNote,
      indexMode: note.indexMode,
      lifecycle: note.lifecycle,
      reviewAfter: note.reviewAfter,
      expiresAt: note.expiresAt,
      supersedes:
        note.supersedesId === null
          ? null
          : (handleById.get(note.supersedesId) ?? null),
      supersededBy:
        note.supersededById === null
          ? null
          : (handleById.get(note.supersededById) ?? null),
      links,
      bodyLength: note.body.length,
    });
    return `${DELIMITER}\n${frontmatter}\n${DELIMITER}\n${note.body}\n`;
  });

  return `${header}\n${records.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function fail(reason: string): never {
  throw new Error(`not a Command Center memory archive: ${reason}`);
}

/**
 * A cursor over the archive text. Frontmatter is read line-wise and the body by
 * length, which is the whole reason the two are parsed by different rules.
 */
class ArchiveCursor {
  private offset = 0;

  constructor(private readonly text: string) {}

  atEnd(): boolean {
    return this.text.slice(this.offset).trim() === "";
  }

  /** Consume a `---` fenced frontmatter block and return its parsed JSON fields. */
  readFrontmatter(): Record<string, unknown> {
    this.skipBlankLines();
    if (!this.text.startsWith(`${DELIMITER}\n`, this.offset)) {
      fail("expected a '---' frontmatter delimiter");
    }
    this.offset += DELIMITER.length + 1;

    const close = this.text.indexOf(`\n${DELIMITER}\n`, this.offset - 1);
    if (close === -1) fail("unterminated frontmatter block");
    const block = this.text.slice(this.offset, close + 1);
    this.offset = close + DELIMITER.length + 2;

    const fields: Record<string, unknown> = {};
    for (const line of block.split("\n")) {
      if (line.trim() === "") continue;
      const separator = line.indexOf(": ");
      if (separator === -1) fail(`malformed frontmatter line: ${line}`);
      const key = line.slice(0, separator);
      try {
        fields[key] = JSON.parse(line.slice(separator + 2));
      } catch {
        fail(`frontmatter value for '${key}' is not a JSON literal`);
      }
    }
    return fields;
  }

  /** Take exactly `length` characters of body, then the single newline after it. */
  readBody(length: number): string {
    const body = this.text.slice(this.offset, this.offset + length);
    if (body.length < length)
      fail("body is shorter than its stated bodyLength");
    this.offset += length;
    if (this.text.startsWith("\n", this.offset)) this.offset += 1;
    return body;
  }

  private skipBlankLines(): void {
    while (this.text.startsWith("\n", this.offset)) this.offset += 1;
  }
}

export function parseMemoryArchive(text: string): MemoryArchive {
  const cursor = new ArchiveCursor(text);
  const header = archiveHeaderSchema.safeParse(cursor.readFrontmatter());
  if (!header.success) {
    fail(`its header is not a v${ARCHIVE_VERSION} archive header`);
  }

  const records: MemoryArchiveRecord[] = [];
  while (!cursor.atEnd()) {
    const parsed = memoryArchiveFrontmatterSchema.safeParse(
      cursor.readFrontmatter(),
    );
    if (!parsed.success) {
      fail(
        `record ${records.length + 1} is malformed: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".")} ${issue.message}`)
          .join("; ")}`,
      );
    }
    const { bodyLength, ...fields } = parsed.data;
    records.push({ ...fields, body: cursor.readBody(bodyLength) });
  }

  if (records.length !== header.data.noteCount) {
    fail(
      `header states ${header.data.noteCount} notes but the archive holds ${records.length}`,
    );
  }
  return { generatedAt: header.data.generatedAt, records };
}
