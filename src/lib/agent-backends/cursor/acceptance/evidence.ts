import { createHash } from "node:crypto";
import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { scanForCredentials, type CredentialSecret } from "./credential-scan";

/**
 * Evidence hygiene for the authenticated Cursor acceptance suite (spec R14.2,
 * D19).
 *
 * A live run produces two very different things. The RAW fixtures — native SDK
 * envelopes, transcripts, worker logs, captured process tables — are the
 * complete record, and are also the only artifact that could carry a
 * credential, a prompt, or image bytes. They stay owner-only under the
 * git-ignored `.cc/` tree. What gets PUBLISHED next to them is bounded
 * metadata and sha256 digests, and this module is the boundary that enforces
 * the difference: a caller cannot publish an unbounded value or one carrying
 * registered credential material, because `publish` refuses rather than
 * trusting every case to remember.
 */

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

const RAW_DIRECTORY = "raw";
const PUBLISHED_FILE = "published.jsonl";

/** Long enough for a latency, a pid, or a terminal-outcome name; far too short
 *  for assistant text, a prompt, a transcript line, or a base64 image. */
const MAX_METRIC_TEXT_LENGTH = 200;

const rawArtifactSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

const publishedRecordSchema = z
  .object({
    caseId: z.string().trim().min(1).max(80),
    outcome: z.enum(["pass", "fail", "blocked"]),
    metrics: z.record(
      z.string().min(1).max(60),
      z.union([
        z.string().max(MAX_METRIC_TEXT_LENGTH),
        z.number(),
        z.boolean(),
        z.null(),
      ]),
    ),
    artifacts: z.array(rawArtifactSchema).max(64),
  })
  .strict();

export type RawArtifact = z.infer<typeof rawArtifactSchema>;
export type PublishedRecord = z.infer<typeof publishedRecordSchema>;

/**
 * Environment read by the harness. A plain record rather than
 * `NodeJS.ProcessEnv`: the Next.js augmentation makes that type readonly-typed
 * on `NODE_ENV`, and the harness only ever reads two of its own keys.
 */
export type AcceptanceEnv = Readonly<Record<string, string | undefined>>;

export interface AcceptanceEvidenceStore {
  readonly rawDir: string;
  readonly publishedPath: string;
  /**
   * Values the published boundary must never contain. Registered rather than
   * read from the environment, so the same guard covers a test-only sentinel
   * as well as the real key.
   */
  registerSecret(secret: CredentialSecret): void;
  writeRaw(name: string, content: string): Promise<RawArtifact>;
  publish(record: PublishedRecord): Promise<void>;
  readPublished(): Promise<readonly PublishedRecord[]>;
}

/**
 * The registered `cursor-acceptance` command creates and exports this root. The
 * fallback keeps a direct Vitest invocation writing to the same git-ignored
 * place rather than somewhere a raw fixture could be committed from.
 */
export function resolveAcceptanceEvidenceRoot(env: AcceptanceEnv): string {
  const configured = env["CC_CURSOR_ACCEPTANCE_ROOT"];
  if (typeof configured === "string" && configured.trim().length > 0) {
    return configured;
  }
  return path.join(process.cwd(), ".cc", "temp", "cursor-acceptance");
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export async function createAcceptanceEvidenceStore(
  root: string,
): Promise<AcceptanceEvidenceStore> {
  const rawDir = path.join(root, RAW_DIRECTORY);
  const publishedPath = path.join(root, PUBLISHED_FILE);

  await mkdir(rawDir, { recursive: true, mode: DIRECTORY_MODE });
  // Explicit chmod as well as the creation mode: `mkdir` applies the process
  // umask to it, and a directory that already existed keeps its old mode.
  await chmod(root, DIRECTORY_MODE);
  await chmod(rawDir, DIRECTORY_MODE);

  const secrets: CredentialSecret[] = [];

  async function ensurePublishedFile(): Promise<void> {
    await writeFile(publishedPath, "", { flag: "a", mode: FILE_MODE });
    await chmod(publishedPath, FILE_MODE);
  }
  await ensurePublishedFile();

  return {
    rawDir,
    publishedPath,

    registerSecret(secret) {
      secrets.push(secret);
    },

    async writeRaw(name, content) {
      const target = path.join(rawDir, name);
      if (path.dirname(target) !== rawDir) {
        throw new Error(
          `raw fixture name must be a plain file name, received "${name}"`,
        );
      }
      await writeFile(target, content, { mode: FILE_MODE });
      await chmod(target, FILE_MODE);
      return {
        name,
        bytes: Buffer.byteLength(content, "utf8"),
        sha256: sha256(content),
      };
    },

    async publish(record) {
      const parsed = publishedRecordSchema.safeParse(record);
      if (!parsed.success) {
        throw new Error(
          `published evidence for "${record.caseId}" is not bounded metadata: ${parsed.error.issues
            .map((issue) => `${issue.path.join(".")} ${issue.message}`)
            .join("; ")}`,
        );
      }
      const line = JSON.stringify(parsed.data);
      const findings = scanForCredentials(secrets, [
        { label: `published:${parsed.data.caseId}`, text: line },
      ]);
      if (findings.length > 0) {
        throw new Error(
          `published evidence for "${parsed.data.caseId}" carries credential material (${findings
            .map((finding) => `${finding.secretLabel}/${finding.variant}`)
            .join(", ")})`,
        );
      }
      await appendFile(publishedPath, `${line}\n`, { mode: FILE_MODE });
    },

    async readPublished() {
      const contents = await readFile(publishedPath, "utf8");
      return contents
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line): PublishedRecord => {
          const parsed = publishedRecordSchema.safeParse(JSON.parse(line));
          if (!parsed.success) {
            throw new Error(
              `published evidence at ${publishedPath} is unreadable: ${parsed.error.message}`,
            );
          }
          return parsed.data;
        });
    },
  };
}
