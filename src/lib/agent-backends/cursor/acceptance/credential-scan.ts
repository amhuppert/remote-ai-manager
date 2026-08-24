import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/**
 * The credential-sentinel scan behind the authenticated acceptance suite
 * (spec R6.2, R14.2).
 *
 * The suite's central negative claim is that `CURSOR_API_KEY` never reaches
 * argv, a worker or tool environment, a log, a transcript, an error, caller-
 * owned SDK state, or a published evidence artifact. That claim is only worth
 * as much as the scan behind it, so this module reads each boundary directly
 * and reports hits by LABEL: a finding that quoted the secret would leak it
 * into the very test output the scan exists to keep clean.
 */

export interface CredentialSecret {
  /** Identifies the secret in findings. The value is never reported. */
  label: string;
  value: string;
}

export interface ScanSource {
  label: string;
  text: string;
}

export type CredentialFindingVariant = "literal" | "base64";

export interface CredentialFinding {
  sourceLabel: string;
  secretLabel: string;
  variant: CredentialFindingVariant;
  occurrences: number;
}

/**
 * Below this a "secret" is common enough to match by coincidence, which would
 * make a clean scan meaningless and a dirty one uninvestigable. Real Cursor
 * keys are far longer; a short value here means the harness was misconfigured.
 */
export const MIN_SCANNABLE_SECRET_LENGTH = 8;

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

export function scanForCredentials(
  secrets: readonly CredentialSecret[],
  sources: readonly ScanSource[],
): readonly CredentialFinding[] {
  const needles = secrets.map((secret) => {
    if (secret.value.length < MIN_SCANNABLE_SECRET_LENGTH) {
      throw new Error(
        `secret "${secret.label}" is too short to scan for: ${MIN_SCANNABLE_SECRET_LENGTH} characters are required`,
      );
    }
    return {
      label: secret.label,
      // Base64 as well as the literal value: a caller-owned JSONL store or an
      // environment dump can hold the key in encoded form, and a scan that
      // only knew the literal spelling would report that boundary clean.
      variants: [
        { variant: "literal" as const, text: secret.value },
        {
          variant: "base64" as const,
          text: Buffer.from(secret.value, "utf8").toString("base64"),
        },
      ],
    };
  });

  const findings: CredentialFinding[] = [];
  for (const source of sources) {
    for (const needle of needles) {
      for (const { variant, text } of needle.variants) {
        const occurrences = countOccurrences(source.text, text);
        if (occurrences > 0) {
          findings.push({
            sourceLabel: source.label,
            secretLabel: needle.label,
            variant,
            occurrences,
          });
        }
      }
    }
  }
  return findings;
}

/**
 * Replaces registered secret material with its label.
 *
 * A leak has to stay VISIBLE as a leak in whatever the harness persists —
 * silently dropping it would hide the one thing the artifact exists to expose —
 * while the value itself never reaches disk.
 */
export function maskSecrets(
  text: string,
  secrets: readonly CredentialSecret[],
): string {
  let masked = text;
  for (const secret of secrets) {
    for (const { variant, needle } of [
      { variant: "literal" as const, needle: secret.value },
      {
        variant: "base64" as const,
        needle: Buffer.from(secret.value, "utf8").toString("base64"),
      },
    ]) {
      masked = masked
        .split(needle)
        .join(`<redacted-secret:${secret.label}/${variant}>`);
    }
  }
  return masked;
}

/** A `/proc` environment key: what stays, once the value has gone. */
const ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function describeRedactedValue(value: string): string {
  return `<redacted bytes=${Buffer.byteLength(value, "utf8")} sha256=${createHash(
    "sha256",
  )
    .update(value, "utf8")
    .digest("hex")
    .slice(0, 16)}>`;
}

/**
 * The persistable form of one `/proc` record.
 *
 * Every `KEY=VALUE` assignment loses its value — not merely the ones whose key
 * looks credential-shaped. A server environment carries third-party API keys,
 * connection strings, and socket paths under names no allow-list can enumerate,
 * so a snapshot that kept "the values that look safe" would be a leak waiting
 * on the next variable someone exports. What an environment capture has to
 * prove is which KEYS crossed the boundary (`CURSOR_API_KEY` absent,
 * `CC_SESSION` present), and that is entirely preserved here. The digest keeps
 * it auditable without exposure: a reviewer holding a suspected value can hash
 * it and compare.
 *
 * A record that is not an assignment — an argv token — is kept verbatim,
 * because the captured command line is itself evidence: the cancellation cases
 * identify their descendant by the marker inside it.
 */
export function redactBoundaryRecord(record: string): string {
  const separator = record.indexOf("=");
  if (separator <= 0) return record;
  const key = record.slice(0, separator);
  if (!ENVIRONMENT_KEY_PATTERN.test(key)) return record;
  return `${key}=${describeRedactedValue(record.slice(separator + 1))}`;
}

/**
 * A process boundary, carrying the NUL-delimited records `/proc` actually
 * stored as well as the flat text the scan reads.
 *
 * The records survive the read because redaction has to be exact: environment
 * values contain spaces and `=`, so a snapshot already flattened into one
 * string cannot be split back into assignments without guessing.
 */
export interface ProcessBoundarySource extends ScanSource {
  records: readonly string[];
}

/**
 * The records of one darwin `KERN_PROCARGS2` dump, split at the argv/environ
 * boundary the buffer's own argc declares.
 */
export interface DarwinProcargs2 {
  argv: readonly string[];
  environ: readonly string[];
}

/**
 * Parses the raw `KERN_PROCARGS2` sysctl buffer: an int32 argc, the exec path,
 * NUL padding, argc NUL-terminated argv records, then the environ records.
 * This is darwin's only exact source for another process's argv and environment
 * — `ps -E` flattens the records into one space-joined string, which cannot be
 * split back into assignments without guessing.
 *
 * Null for a buffer that does not carry the declared shape: a truncated dump
 * must surface as unreadable rather than as a half-parsed environment.
 */
export function parseDarwinProcargs2(buffer: Buffer): DarwinProcargs2 | null {
  if (buffer.length < 4) return null;
  const argc = buffer.readInt32LE(0);
  if (argc < 0) return null;
  let offset = 4;

  const readRecord = (): string | null => {
    if (offset >= buffer.length) return null;
    const end = buffer.indexOf(0, offset);
    if (end === -1) return null;
    const record = buffer.toString("utf8", offset, end);
    offset = end + 1;
    return record;
  };

  // The exec path comes first; the kernel pads with NULs before argv begins.
  if (readRecord() === null) return null;
  while (offset < buffer.length && buffer[offset] === 0) offset += 1;

  const argv: string[] = [];
  for (let index = 0; index < argc; index += 1) {
    const token = readRecord();
    if (token === null) return null;
    argv.push(token);
  }

  const environ: string[] = [];
  let record = readRecord();
  while (record !== null) {
    // Trailing padding NULs read as empty records; an environment assignment
    // is never empty.
    if (record.length > 0) environ.push(record);
    record = readRecord();
  }
  return { argv, environ };
}

/**
 * `/proc` entries vanish the instant a process is reaped, and the acceptance
 * suite reads them precisely around teardown. An unreadable process is an empty
 * source rather than an error: a race with an exiting worker must not be
 * reported as a scan failure.
 */
async function readProcRecords(
  pid: number,
  name: string,
): Promise<readonly string[]> {
  try {
    const raw = await readFile(`/proc/${pid}/${name}`);
    // Both files are NUL-delimited records, not text. The trailing NUL yields a
    // final empty record, which is an artifact of the format rather than a
    // value.
    return raw
      .toString("utf8")
      .split("\0")
      .filter((record) => record.length > 0);
  } catch {
    return [];
  }
}

const execFileAsync = promisify(execFile);

/**
 * The bun-executed sysctl helper next to this module. Executed rather than
 * imported: `bun:ffi` does not exist in the Node runtime the suite runs under.
 */
const DARWIN_PROCARGS_HELPER = fileURLToPath(
  new URL("./darwin-procargs.mjs", import.meta.url),
);

/** Unreadable-process semantics match the linux reader: null, not an error. */
async function readDarwinProcargs(
  pid: number,
): Promise<DarwinProcargs2 | null> {
  try {
    const { stdout } = await execFileAsync(
      "bun",
      [DARWIN_PROCARGS_HELPER, String(pid)],
      { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 },
    );
    return parseDarwinProcargs2(stdout);
  } catch {
    return null;
  }
}

function boundarySource(
  pid: number,
  label: string,
  records: readonly string[],
): ProcessBoundarySource {
  return { label: `pid:${pid}/${label}`, text: records.join("\n"), records };
}

export async function readProcessArgvSource(
  pid: number,
): Promise<ProcessBoundarySource> {
  if (process.platform === "darwin") {
    const parsed = await readDarwinProcargs(pid);
    return boundarySource(pid, "argv", parsed?.argv ?? []);
  }
  return boundarySource(pid, "argv", await readProcRecords(pid, "cmdline"));
}

export async function readProcessEnvironSource(
  pid: number,
): Promise<ProcessBoundarySource> {
  if (process.platform === "darwin") {
    const parsed = await readDarwinProcargs(pid);
    return boundarySource(pid, "environ", parsed?.environ ?? []);
  }
  return boundarySource(pid, "environ", await readProcRecords(pid, "environ"));
}

/**
 * Every regular file under `root`, labelled by its path relative to it.
 *
 * Read whole rather than sampled: a partial read would let a leak past the one
 * check that is supposed to catch it. Callers point this at trees the harness
 * itself created — a store, a log directory, an evidence root — so the size is
 * bounded by the fixture, not by the filesystem.
 */
export async function readFileTreeSources(
  root: string,
): Promise<readonly ScanSource[]> {
  const sources: ScanSource[] = [];

  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        sources.push({
          label: path.relative(root, absolute),
          text: await readFile(absolute, "utf8"),
        });
      } catch {
        // Unreadable file: recorded as present but empty would be a lie, and
        // skipping silently would be worse. Surface it as its own label so a
        // reviewer sees the gap in coverage.
        sources.push({
          label: `${path.relative(root, absolute)} (unreadable)`,
          text: "",
        });
      }
    }
  }

  await walk(root);
  return sources;
}
