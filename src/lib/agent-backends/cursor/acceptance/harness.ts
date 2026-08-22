import { ambientCredentialKeys } from "../worker/credential-env";
import {
  maskSecrets,
  MIN_SCANNABLE_SECRET_LENGTH,
  readProcessArgvSource,
  readProcessEnvironSource,
  redactBoundaryRecord,
  scanForCredentials,
  type CredentialFinding,
  type CredentialSecret,
  type ProcessBoundarySource,
} from "./credential-scan";
import {
  createAcceptanceEvidenceStore,
  resolveAcceptanceEvidenceRoot,
  type AcceptanceEnv,
  type AcceptanceEvidenceStore,
  type RawArtifact,
} from "./evidence";
import { findGroupPids } from "./process-scan";

/**
 * Shared entry points for every authenticated acceptance file (spec R14.2,
 * D19).
 *
 * Two invariants live here rather than in each case: an acceptance file
 * without a credential fails instead of passing vacuously, and every evidence
 * store knows the credential it must never publish.
 */

export const CURSOR_ACCEPTANCE_SECRET_LABEL = "cursor-api-key";

export function requireAcceptanceCredential(
  env: AcceptanceEnv,
): CredentialSecret {
  const value = env["CURSOR_API_KEY"];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      "CURSOR_API_KEY is not set: the Cursor acceptance suite produces live evidence or fails. " +
        "Run it through `cctl validate run cursor-acceptance`, which reports this as a blocked verdict.",
    );
  }
  return { label: CURSOR_ACCEPTANCE_SECRET_LABEL, value };
}

/**
 * The evidence store for one acceptance file, with the live credential already
 * registered — so a case that tries to publish it is refused at the boundary
 * rather than caught later by a scan over an artifact that already exists.
 */
export async function openAcceptanceEvidence(
  env: AcceptanceEnv,
): Promise<{ store: AcceptanceEvidenceStore; secret: CredentialSecret }> {
  const secret = requireAcceptanceCredential(env);
  const store = await createAcceptanceEvidenceStore(
    resolveAcceptanceEvidenceRoot(env),
  );
  store.registerSecret(secret);
  return { store, secret };
}

/** The `/argv` and `/environ` marker every captured snapshot is labelled by. */
export const ACCEPTANCE_BOUNDARY_ARTIFACT_PREFIX = "boundaries-";

export interface CapturedProcessBoundaries {
  /** Pids actually read — zero means the capture proved nothing. */
  pids: readonly number[];
  sources: readonly ProcessBoundarySource[];
  findings: readonly CredentialFinding[];
  /**
   * Hits for credential-shaped variables OTHER than the Cursor key, scanned on
   * the live `/proc` bytes. The persisted snapshot is redacted, so this is the
   * only point at which a third-party credential in a worker or tool child can
   * be observed at all.
   */
  ambientFindings: readonly CredentialFinding[];
  artifact: RawArtifact;
}

/**
 * The credential-shaped variables the environment carries, as scannable
 * secrets labelled by variable name.
 *
 * The names come from the same rule the supervisor strips by, so the suite
 * checks for exactly what production claims to withhold. Values shorter than
 * the scan's floor are skipped: a two-character "secret" would match
 * everywhere and make every boundary look dirty.
 */
function ambientSecrets(
  env: Readonly<Record<string, string | undefined>>,
): readonly CredentialSecret[] {
  return ambientCredentialKeys(env).flatMap((key) => {
    const value = env[key];
    return value !== undefined && value.length >= MIN_SCANNABLE_SECRET_LENGTH
      ? [{ label: `env:${key}`, value }]
      : [];
  });
}

/**
 * What gets written to disk for a set of captured boundaries.
 *
 * The scan runs over the LIVE text — anything less would weaken the check the
 * capture exists to perform — but only this rendering is persisted: every
 * environment value redacted to its size and digest, and any registered secret
 * that did survive masked to its label. Each block carries the verdict for its
 * own boundary, so the closing sweep can still confirm from the artifact alone
 * that every captured boundary was scanned and came back clean.
 */
function renderBoundarySnapshot(
  secrets: readonly CredentialSecret[],
  sources: readonly ProcessBoundarySource[],
): string {
  return sources
    .map((source) => {
      const findings = scanForCredentials(secrets, [source]);
      const body = source.records.map(redactBoundaryRecord).join("\n");
      return (
        `### ${source.label} records=${source.records.length} credentialFindings=${findings.length}\n` +
        `${maskSecrets(body, secrets)}\n`
      );
    })
    .join("");
}

/**
 * Reads argv and the environment of every process in `pgids`' groups while they
 * are still alive, scans them for credential material, and persists the
 * snapshot as a private raw fixture (spec R6.2).
 *
 * The whole GROUP is read, not just the worker: the criterion covers every
 * environment the worker passes to its children, and a shell tool or an inline
 * MCP server is exactly such a child. `/proc` entries vanish when a process is
 * reaped, so this has to happen mid-turn rather than during the closing sweep.
 *
 * The snapshot is persisted REDACTED (see `renderBoundarySnapshot`). A worker
 * inherits the Command Center server's environment, which on a real host
 * carries third-party credentials that have nothing to do with Cursor; writing
 * those environments out whole would put credential material into the evidence
 * tree in the name of proving credential material stays out of it.
 */
export async function captureProcessBoundaries(input: {
  store: AcceptanceEvidenceStore;
  secret: CredentialSecret;
  label: string;
  pgids: readonly number[];
  /** Extra pids outside those groups — a tool process reparented away, say. */
  extraPids?: readonly number[];
  /** The environment whose credential-shaped variables must NOT be found in
   *  any captured boundary. Defaults to the server environment this run
   *  inherited, which is the one a worker would have copied. */
  ambientEnv?: Readonly<Record<string, string | undefined>>;
}): Promise<CapturedProcessBoundaries> {
  const pids = [
    ...new Set([
      ...input.pgids.flatMap((pgid) => [pgid, ...findGroupPids(pgid)]),
      ...(input.extraPids ?? []),
    ]),
  ];

  const sources: ProcessBoundarySource[] = [];
  for (const pid of pids) {
    sources.push(await readProcessArgvSource(pid));
    sources.push(await readProcessEnvironSource(pid));
  }

  const findings = scanForCredentials([input.secret], sources);
  // Scanned here, on the live bytes, and NOT later over the artifact: the
  // artifact is redacted, so a third-party credential in a worker or tool
  // environment would be invisible to any check that ran after this point.
  const ambientFindings = scanForCredentials(
    ambientSecrets(input.ambientEnv ?? process.env).filter(
      (candidate) => candidate.value !== input.secret.value,
    ),
    sources,
  );

  // Both secret sets are masked out of what is written, so an ambient
  // credential cannot reach the evidence tree by way of the snapshot that
  // detected it.
  const artifact = await input.store.writeRaw(
    `${ACCEPTANCE_BOUNDARY_ARTIFACT_PREFIX}${input.label}.txt`,
    renderBoundarySnapshot(
      [input.secret, ...ambientSecrets(input.ambientEnv ?? process.env)],
      sources,
    ),
  );

  return { pids, sources, findings, ambientFindings, artifact };
}
