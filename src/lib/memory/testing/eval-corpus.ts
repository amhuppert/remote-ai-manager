import { z } from "zod";

import {
  memoryArtifactKindSchema,
  memoryKindSchema,
  memoryLinkKindSchema,
  memoryScopeSchema,
  memorySlugSchema,
  type MemoryActor,
  type MemoryArtifactRef,
  type MemoryNote,
} from "../schemas";
import type { MemoryService } from "../service";
import corpusJson from "./memory-eval-corpus.json";

/**
 * The committed evaluation corpus (`memory-eval-corpus.json` beside this file):
 * fifteen representative notes drawn from the operator's real memory library,
 * the ten named recall queries that are R7.1's acceptance targets, and the
 * stale-status specimen R2.1 withholds.
 *
 * The fixture is READ, never written, and it is seeded through the ordinary
 * service verbs — an evaluation that bypassed `create` and `link` would prove
 * the ranking over rows no capture path can actually produce. Nothing here
 * touches the operator's home directory; the JSON in the repository is the
 * whole corpus.
 */
const memoryEvalCorpusNoteSchema = z
  .object({
    slug: memorySlugSchema,
    kind: memoryKindSchema,
    scope: memoryScopeSchema,
    aliases: z.array(z.string().min(1)),
    hook: z.string().min(1),
    body: z.string().min(1),
    statusNote: z.string().min(1).optional(),
    /**
     * A typed link the corpus declares (about or source, spec R8). The artifact
     * it binds to is supplied at seed time, because artifact identities belong
     * to the seeding suite rather than to the committed fixture.
     */
    link: z
      .object({
        kind: memoryLinkKindSchema,
        artifactKind: memoryArtifactKindSchema,
        note: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

const memoryEvalCorpusQuerySchema = z
  .object({
    query: z.string().min(1),
    expectSlug: memorySlugSchema,
    /** Why this query is in the set — the retrieval path it exercises. */
    via: z.string().min(1),
    /**
     * The spec's body-only symptom case: no term of the query may occur in the
     * expected record's slug, hook, or aliases, so the query can only be
     * answered by the indexed body. Declared here rather than inferred from
     * prose so the evaluation asserts it and a fixture edit that quietly moves
     * a term into the hook fails instead of passing vacuously.
     */
    requireBodyOnly: z.boolean().default(false),
  })
  .strict();

/**
 * The terms a body-only assertion compares, normalized the way the index
 * normalizes them: case-folded and stripped of the punctuation that FTS5's
 * tokenizer drops, so `vm.swapusage` in a query is compared as `vm` and
 * `swapusage` rather than as one opaque string.
 */
export function memoryEvalQueryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term !== "");
}

export const memoryEvalCorpusSchema = z
  .object({
    description: z.string().min(1),
    notes: z.array(memoryEvalCorpusNoteSchema).min(1),
    queries: z.array(memoryEvalCorpusQuerySchema).min(1),
  })
  .strict();

export type MemoryEvalCorpus = z.infer<typeof memoryEvalCorpusSchema>;

/**
 * Parse the committed corpus. Validation is the point: a fixture edit that
 * drops a slug or renames a field fails here rather than silently shrinking
 * the evaluation.
 */
export function loadMemoryEvalCorpus(): MemoryEvalCorpus {
  return memoryEvalCorpusSchema.parse(corpusJson);
}

export interface SeedMemoryEvalCorpusOptions {
  readonly service: MemoryService;
  /** Writes land in this actor's scope, so the corpus is seeded where it is read. */
  readonly actor: MemoryActor;
  readonly corpus?: MemoryEvalCorpus;
  /**
   * The artifact a corpus note's declared link binds to, by artifact kind.
   * A kind the caller does not supply leaves that note unlinked, so a suite
   * that does not model tickets still seeds the rest of the corpus.
   */
  readonly linkArtifacts?: Partial<
    Record<MemoryArtifactRef["kind"], MemoryArtifactRef>
  >;
}

/**
 * Seed the corpus through `create` (and `link` for a note that declares one),
 * returning each note by its corpus slug. The service assigns identity,
 * lifecycle, and leases exactly as it would for a live capture.
 */
export async function seedMemoryEvalCorpus(
  options: SeedMemoryEvalCorpusOptions,
): Promise<Map<string, MemoryNote>> {
  const corpus = options.corpus ?? loadMemoryEvalCorpus();
  const seeded = new Map<string, MemoryNote>();
  for (const entry of corpus.notes) {
    const created = await options.service.create(
      {
        scope: entry.scope,
        kind: entry.kind,
        slug: entry.slug,
        hook: entry.hook,
        body: entry.body,
        aliases: entry.aliases,
        ...(entry.statusNote === undefined
          ? {}
          : { statusNote: entry.statusNote }),
      },
      options.actor,
    );
    if (!created.ok) {
      throw new Error(
        `corpus seed failed for ${entry.slug}: ${created.error.code} ${created.error.message}`,
      );
    }
    const note = created.value.note;
    seeded.set(entry.slug, note);

    const declared = entry.link;
    const artifact =
      declared === undefined
        ? undefined
        : options.linkArtifacts?.[declared.artifactKind];
    if (declared === undefined || artifact === undefined) continue;
    const linked = await options.service.link(
      note.slug,
      { kind: declared.kind, artifact },
      options.actor,
    );
    if (!linked.ok) {
      throw new Error(
        `corpus link failed for ${entry.slug}: ${linked.error.code} ${linked.error.message}`,
      );
    }
  }
  return seeded;
}
