import { createHash } from "node:crypto";

import { z } from "zod";

import type { CliHost } from "./shared";

/**
 * What a bounded query left out. `reveal` is carried only by the truncated
 * arm, so a cap without the exact command that discloses the rest cannot be
 * constructed — the steering rule "a cap without disclosure is a defect" is a
 * type error rather than a review item.
 */
export const omissionSchema = z.discriminatedUnion("truncated", [
  z
    .object({
      total: z.number().int().nonnegative(),
      returned: z.number().int().nonnegative(),
      truncated: z.literal(false),
    })
    .strict(),
  z
    .object({
      total: z.number().int().nonnegative(),
      returned: z.number().int().nonnegative(),
      truncated: z.literal(true),
      reveal: z.string().min(1),
    })
    .strict(),
]);

export type Omission = z.infer<typeof omissionSchema>;

/**
 * The one rendering of an omission. Text lines and the JSON fragment are built
 * from the same value, so the two serializations cannot report different
 * counts or point at different follow-up commands.
 */
export function omissionSummary(omission: Omission): string {
  const counts = `${omission.total} total, ${omission.returned} shown`;
  return omission.truncated ? `${counts} — rest: ${omission.reveal}` : counts;
}

/**
 * Cap any item set and account for what the cap dropped. Structured payloads
 * and their rendered rows come through here alike, so one call can bound both
 * serializations of the same section rather than each counting for itself.
 */
export function boundedItems<T>(
  items: readonly T[],
  cap: number,
  reveal: string,
): { items: T[]; omission: Omission } {
  if (!Number.isInteger(cap) || cap < 1) {
    throw new Error(
      `boundedItems: cap must be a positive integer, received ${cap}`,
    );
  }
  if (reveal.trim() === "") {
    throw new Error(
      "boundedItems: reveal must name the command that discloses the omitted rows",
    );
  }
  const shown = items.slice(0, cap);
  const omission: Omission =
    shown.length < items.length
      ? {
          total: items.length,
          returned: shown.length,
          truncated: true,
          reveal,
        }
      : { total: items.length, returned: shown.length, truncated: false };
  return { items: shown, omission };
}

/**
 * Cap a rendered row set and account for what the cap dropped. A row may be a
 * multi-line block: the cap counts rows, never the lines inside them.
 *
 * `rows` are the capped rows alone (for callers that place the summary in a
 * section header); `lines` closes them with the summary.
 */
export function boundedRows(
  rows: readonly string[],
  cap: number,
  reveal: string,
): { rows: string[]; lines: string[]; omission: Omission } {
  const bounded = boundedItems(rows, cap, reveal);
  return {
    rows: bounded.items,
    lines: [...bounded.items, omissionSummary(bounded.omission)],
    omission: bounded.omission,
  };
}

/** Hard stdout budget for one command's output before it spills to a file. */
export const STDOUT_BUDGET_BYTES = 60_000;
/** Default artifact location: inside `.cc/`, which lane commits sweep. */
export const ARTIFACT_DIR = ".cc/temp";

export const artifactManifestSchema = z
  .object({
    path: z.string().min(1),
    format: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    reason: z.enum(["stdout_budget_exceeded", "requested"]),
  })
  .strict();

export type ArtifactManifest = z.infer<typeof artifactManifestSchema>;

export interface EmitLargeOptions {
  /** Artifact format; also selects the generated file extension. */
  readonly format: string;
  /** Inline ceiling in UTF-8 bytes; content at or above it spills. */
  readonly budgetBytes?: number;
  readonly dir?: string;
  /** Stem of a generated `<prefix>-<digest>.<ext>` file name. */
  readonly namePrefix?: string;
  /** Exact destination, e.g. a caller's `--out`; wins over dir/namePrefix. */
  readonly path?: string;
  /**
   * Write an artifact whatever the budget says, recording this reason —
   * `requested` for a caller-asked file, `stdout_budget_exceeded` when the
   * caller measured a serialization this content is not identical to.
   */
  readonly force?: ArtifactManifest["reason"];
}

export type ArtifactOutcome =
  | { kind: "artifact"; manifest: ArtifactManifest }
  | {
      kind: "unwritable";
      reason: "host_cannot_write" | "write_failed";
      path: string;
    };

export type EmitLargeOutcome =
  | { kind: "inline"; text: string }
  | ArtifactOutcome;

const FORMAT_EXTENSIONS: Readonly<Record<string, string>> = {
  markdown: "md",
  json: "json",
  text: "txt",
};

function extensionFor(format: string): string {
  return FORMAT_EXTENSIONS[format] ?? format.replace(/[^a-z0-9]+/giu, "-");
}

/**
 * Emit content that may not fit stdout. Past the budget the bytes move to a
 * file and stdout carries the manifest instead — the alternative is a pipe
 * that truncates mid-envelope, which corrupts output exactly when it feeds
 * code. The digest lets a reader prove the file it opens is the one announced.
 */
export async function emitLarge(
  host: CliHost,
  content: string,
  options: EmitLargeOptions & { readonly force: ArtifactManifest["reason"] },
): Promise<ArtifactOutcome>;
export async function emitLarge(
  host: CliHost,
  content: string,
  options: EmitLargeOptions,
): Promise<EmitLargeOutcome>;
export async function emitLarge(
  host: CliHost,
  content: string,
  options: EmitLargeOptions,
): Promise<EmitLargeOutcome> {
  const bytes = Buffer.byteLength(content, "utf8");
  const budgetBytes = options.budgetBytes ?? STDOUT_BUDGET_BYTES;
  if (options.force === undefined && bytes < budgetBytes) {
    return { kind: "inline", text: content };
  }
  const digest = createHash("sha256").update(content, "utf8").digest("hex");
  const path =
    options.path ??
    `${options.dir ?? ARTIFACT_DIR}/${options.namePrefix ?? "cctl"}-${digest.slice(0, 12)}.${extensionFor(options.format)}`;
  const write = host.writeTextFile;
  if (write === undefined) {
    return { kind: "unwritable", reason: "host_cannot_write", path };
  }
  try {
    await write(path, content);
  } catch {
    return { kind: "unwritable", reason: "write_failed", path };
  }
  return {
    kind: "artifact",
    manifest: artifactManifestSchema.parse({
      path,
      format: options.format,
      bytes,
      sha256: `sha256:${digest}`,
      reason: options.force ?? "stdout_budget_exceeded",
    }),
  };
}
