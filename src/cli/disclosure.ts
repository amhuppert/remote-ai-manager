import { createHash } from "node:crypto";

import { z } from "zod";

import {
  EXIT_OK,
  EXIT_OPERATION_FAILED,
  failure,
  render,
  type CliHost,
  type CliResult,
  type FailureInput,
  type JsonEnvelope,
} from "./shared";

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

const MEDIA_TYPE_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/svg+xml": "svg",
};

/**
 * A media type without its parameters. `image/png; charset=binary` and
 * `image/png` name the same bytes, and the manifest reports one of them.
 */
function mediaTypeEssence(mediaType: string): string {
  return (mediaType.split(";")[0] ?? "").trim().toLowerCase();
}

/**
 * The extension a materialized binary gets. Viewers dispatch on the extension,
 * so `image/png` must land as `.png`; sanitizing the whole media type would
 * produce `.image-png`, which nothing opens.
 */
function binaryExtensionFor(essence: string): string {
  const mapped = MEDIA_TYPE_EXTENSIONS[essence];
  if (mapped !== undefined) return mapped;
  const subtype = (essence.split("/")[1] ?? "").replace(/[^a-z0-9]+/gu, "-");
  return subtype === "" ? "bin" : subtype;
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

/**
 * The receipt that stands in for content stdout does not carry. Rendered here
 * rather than per command so every spill announces the same four facts, and a
 * reader can prove the file it opens is the one announced.
 */
export function artifactReceiptLines(
  command: string,
  manifest: ArtifactManifest,
): string[] {
  return [
    `${command}\tstdout budget exceeded`,
    `artifact: ${manifest.path}`,
    `format: ${manifest.format}`,
    `bytes: ${manifest.bytes}`,
    `sha256: ${manifest.sha256}`,
  ];
}

/**
 * A spill the caller's own filesystem refused. Exit 1 rather than 2: the read
 * itself succeeded and the server is not at fault, so the recovery is local.
 * Typed and bounded — never a fallback that dumps the content stdout could not
 * hold, and never a silent truncation.
 */
export function artifactWriteFailure(
  command: string,
  outcome: { reason: "host_cannot_write" | "write_failed"; path: string },
  json: boolean,
  /**
   * The exit class to keep. A spill that fails while reporting an existing
   * failure must not relabel it: the caller's usage mistake or the server's
   * refusal is still what happened, and only the rendering went wrong.
   */
  exitCode = EXIT_OPERATION_FAILED,
  /**
   * The recovery projection of the failure being reported, when this spill was
   * reporting one. A filesystem that refused the write is the worst moment to
   * also forget which operation was refused and why.
   */
  retain?: RecoveryFacts,
): CliResult {
  const facts = retain ?? {};
  const carried =
    Object.keys(facts).length === 0
      ? {}
      : { detail: recoveryLines(facts).join("\n"), details: { ...facts } };
  return outcome.reason === "host_cannot_write"
    ? failure({
        exitCode,
        message: `${command}: this CLI host cannot write artifact files`,
        code: "write_unavailable",
        ...carried,
        json,
      })
    : failure({
        exitCode,
        message: `${command}: could not write ${JSON.stringify(outcome.path)}`,
        code: "write_failed",
        ...carried,
        json,
      });
}

/**
 * The facts a caller still acts on once a failure's body has moved to a file:
 * identity, phase, refusal code, delivery correlations, the scoped remedy.
 *
 * Flat scalars on purpose. One value produces both the text lines and the JSON
 * `details`, which is what stops the two formats from disclosing different
 * things — the failure mode this projection exists to close.
 */
export type RecoveryFacts = Readonly<Record<string, string | number | boolean>>;

/** The text rendering of a {@link RecoveryFacts} projection. */
export function recoveryLines(facts: RecoveryFacts): string[] {
  return Object.entries(facts).map(([label, value]) => `${label}: ${value}`);
}

/**
 * A page the SERVER bounded, accounted for in the same shape a local cap uses.
 *
 * `boundedItems` caps an in-memory set; a cursor-paginated read has already
 * been capped upstream, and the facts it must still state — how many rows the
 * window holds, how many came back, and the exact cursor command for the rest —
 * are the same three. Going through `Omission` is what keeps its text and JSON
 * renderings from drifting apart, and keeps `reveal` mandatory on the truncated
 * arm.
 */
export function pagedOmission(input: {
  total: number;
  returned: number;
  /** The next-page command, or null when this page is the last. */
  reveal: string | null;
}): Omission {
  return omissionSchema.parse(
    input.reveal === null
      ? { total: input.total, returned: input.returned, truncated: false }
      : {
          total: input.total,
          returned: input.returned,
          truncated: true,
          reveal: input.reveal,
        },
  );
}

/**
 * Write binary bytes the caller asked for to a file and describe them.
 *
 * Binary never goes to stdout: base64 in a terminal is unreadable to a human
 * and unusable to an agent's image viewer, and the byte-exactness an archive
 * export promises survives only as a file plus its digest.
 */
export async function emitBinary(
  host: CliHost,
  bytes: Uint8Array,
  options: { format: string; namePrefix: string; dir?: string },
): Promise<ArtifactOutcome> {
  const digest = createHash("sha256").update(bytes).digest("hex");
  const essence = mediaTypeEssence(options.format);
  const path = `${options.dir ?? ARTIFACT_DIR}/${options.namePrefix}-${digest.slice(0, 12)}.${binaryExtensionFor(essence)}`;
  const write = host.writeFileBytes;
  if (write === undefined) {
    return { kind: "unwritable", reason: "host_cannot_write", path };
  }
  try {
    await write(path, bytes);
  } catch {
    return { kind: "unwritable", reason: "write_failed", path };
  }
  return {
    kind: "artifact",
    manifest: artifactManifestSchema.parse({
      path,
      format: essence,
      bytes: bytes.byteLength,
      sha256: `sha256:${digest}`,
      reason: "requested",
    }),
  };
}

/** Bytes one suggested chunk of a spilled artifact carries. */
const ARTIFACT_CHUNK_BYTES = 4_000;

/**
 * How a caller reads a spilled artifact without re-flooding its context.
 *
 * The chunk is measured in BYTES, not lines. A JSON envelope is serialized onto
 * one line and a single tool result can be one line too, so a line-ranged read
 * such as `sed -n '1,200p'` prints the entire artifact — the exact flood the
 * spill existed to prevent. Byte ranges bound every artifact this CLI writes,
 * whatever its internal line structure.
 */
export function artifactReadInstruction(manifest: ArtifactManifest): string {
  const next = ARTIFACT_CHUNK_BYTES + 1;
  return (
    `read it in bounded byte ranges (it may be one long line): ` +
    `head -c ${ARTIFACT_CHUNK_BYTES} ${manifest.path}` +
    `, then continue with tail -c +${next} ${manifest.path} | head -c ${ARTIFACT_CHUNK_BYTES}` +
    ` — ${manifest.bytes} bytes total`
  );
}

/** Bytes of the original message a spilled failure still states inline. */
const SPILLED_MESSAGE_BYTES = 2_000;

/**
 * Truncate on a code-point boundary so a multibyte character is never cut in
 * half. Reported in bytes because that is the budget being enforced.
 */
function clampToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let kept = "";
  let bytes = 0;
  for (const codePoint of text) {
    const size = Buffer.byteLength(codePoint, "utf8");
    if (bytes + size > maxBytes) break;
    kept += codePoint;
    bytes += size;
  }
  return `${kept}…`;
}

/**
 * Emit one command's FINAL FAILURE under the shared stdout budget.
 *
 * The sibling of {@link renderBounded} for the paths that exit non-zero. A
 * refusal is not automatically small: a server error string, a findings array
 * and a receipt's omission list are all caller-supplied text, and dumping them
 * unbounded would make a failure the one output that ignores the budget every
 * successful read obeys. The exit class and the primary facts survive the
 * spill; the full rendering moves to the file.
 */
export async function boundedFailure(
  host: CliHost,
  input: {
    command: string;
    namePrefix: string;
    failure: FailureInput;
    /**
     * The recovery projection this failure keeps whatever happens to its body.
     * It reaches the JSON `details` on every path and the text detail on every
     * path that drops the body, so neither format is the only one that knows
     * which operation was refused.
     */
    retain?: RecoveryFacts;
    budgetBytes?: number;
  },
): Promise<CliResult> {
  const facts = input.retain ?? {};
  const hasFacts = Object.keys(facts).length > 0;
  // The projection is authoritative over any same-named server detail: it is
  // the value this command promised to keep.
  const spec: FailureInput = hasFacts
    ? {
        ...input.failure,
        details: { ...(input.failure.details ?? {}), ...facts },
      }
    : input.failure;
  const full = failure(spec);

  // The budget covers everything that reaches the caller: a JSON failure
  // prints its envelope on stdout AND its message on stderr, a text failure
  // prints only stderr.
  const budgetBytes = input.budgetBytes ?? STDOUT_BUDGET_BYTES;
  const reaching = Buffer.byteLength(`${full.stdout}${full.stderr}`, "utf8");
  if (reaching < budgetBytes) return full;

  // The artifact holds the document its manifest labels. Appending the stderr
  // rendering to the JSON envelope would produce a `.json` file that does not
  // parse — the corruption the spill exists to prevent, moved into the file.
  const outcome = await emitLarge(
    host,
    input.failure.json ? full.stdout : full.stderr,
    {
      format: input.failure.json ? "json" : "text",
      namePrefix: input.namePrefix,
      force: "stdout_budget_exceeded",
    },
  );
  if (outcome.kind === "unwritable") {
    return artifactWriteFailure(
      input.command,
      outcome,
      input.failure.json,
      input.failure.exitCode,
      facts,
    );
  }
  return failure({
    exitCode: input.failure.exitCode,
    message: clampToBytes(input.failure.message, SPILLED_MESSAGE_BYTES),
    detail: [
      ...recoveryLines(facts),
      ...artifactReceiptLines(input.command, outcome.manifest),
    ].join("\n"),
    ...(input.failure.code === undefined ? {} : { code: input.failure.code }),
    // The rationale explains the refused constraint, not the rendering. A text
    // caller left with a remedy and no reason for it cannot judge whether to
    // follow it.
    ...(input.failure.rationale === undefined
      ? {}
      : { rationale: input.failure.rationale }),
    details: { ...facts, artifact: outcome.manifest },
    hint: artifactReadInstruction(outcome.manifest),
    json: input.failure.json,
  });
}

/**
 * Emit one command's FINAL output under the shared stdout budget.
 *
 * The budget is measured after serialization — escaping, metadata and all —
 * because that is what actually reaches the pipe: a JSON envelope whose
 * escaping doubles a payload's size overflows a budget its raw content fit.
 * Both serializations are built from the same values and only one is measured,
 * so text and JSON always disclose the same thing and only differ in shape.
 */
export async function renderBounded(
  host: CliHost,
  input: {
    command: string;
    json: boolean;
    humanBody: string;
    envelope: JsonEnvelope;
    namePrefix: string;
    budgetBytes?: number;
  },
): Promise<CliResult> {
  const serialized = render(input.json, input.humanBody, input.envelope);
  const outcome = await emitLarge(host, serialized, {
    format: input.json ? "json" : "text",
    namePrefix: input.namePrefix,
    ...(input.budgetBytes === undefined
      ? {}
      : { budgetBytes: input.budgetBytes }),
  });
  if (outcome.kind === "inline") {
    return { exitCode: EXIT_OK, stdout: outcome.text, stderr: "" };
  }
  if (outcome.kind === "unwritable") {
    return artifactWriteFailure(input.command, outcome, input.json);
  }
  return {
    exitCode: EXIT_OK,
    stdout: render(
      input.json,
      `${artifactReceiptLines(input.command, outcome.manifest).join("\n")}\n`,
      {
        ok: true,
        storage: "artifact",
        artifact: outcome.manifest,
        hint: artifactReadInstruction(outcome.manifest),
      },
    ),
    stderr: "",
  };
}
