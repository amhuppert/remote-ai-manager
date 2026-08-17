/**
 * Where a lane's temp directory lives, and why it is short.
 *
 * The backend adapters bind a confined run's `$TMPDIR` to the policy's temp
 * entry (the allowlist's last entry), and the Claude sandbox on Linux creates
 * its socat network-bridge sockets inside that `$TMPDIR` as
 * `claude-http-<16 hex>.sock` / `claude-socks-<16 hex>.sock`. AF_UNIX socket
 * paths are capped at 108 bytes on Linux, so the temp entry carries a hard
 * byte budget: a longer path does not degrade — it makes the sandbox
 * unestablishable, and with `failIfUnavailable` every shell command in the
 * lane fails closed (ticket remote-ai-manager#5, where a UUID execution id
 * alone pushed a scratch-nested temp past the cap for every implementer).
 *
 * Two consequences shape the composition:
 *  - the temp CANNOT be nested under the lane's scratch directory, whose depth
 *    grows with authored ids; it lives at a fixed-width digest name directly
 *    under one short root, so its length is independent of every id;
 *  - the root is literally `/tmp`, not `os.tmpdir()`. The per-user macOS
 *    temp root (`/var/folders/...`) and an administrator's `$TMPDIR` redirect
 *    are exactly the long-path hazard this module exists to remove, and both
 *    feed `os.tmpdir()`. `/tmp` resolves to `/private/tmp` on macOS — still
 *    well inside the budget.
 *
 * The digest name trades the composers' reversible-segment discipline for the
 * byte budget, which no injective encoding of unbounded ids can meet. What
 * per-lane isolation needs from the name is that two DIFFERENT lanes never
 * share it, and the preimage — the kind discriminator joined with the ids'
 * injective segment encodings, `/`-separated (a code point no segment can
 * contain) — reduces that to SHA-256 collision resistance over distinct
 * inputs. The hex image is also caseless, so case-insensitive volumes cannot
 * fold two names together.
 */

import { createHash } from "node:crypto";
import { toLanePathSegment } from "./lane-path-segments";

/** Root for every lane temp directory CC creates. */
export const DEFAULT_LANE_TMP_ROOT_DIR = "/tmp/cc-lane-tmp";

/**
 * The byte budget a lane's canonical temp directory must fit inside:
 * 108 (Linux AF_UNIX `sun_path`) minus the 35 bytes the longer bridge socket
 * name appends (`/claude-socks-` + 16 hex + `.sock`).
 */
export const MAX_LANE_TMP_DIR_BYTES = 73;

/** 128 digest bits: a collision needs ~2^64 work, far beyond authored plans. */
const DIGEST_HEX_CHARS = 32;

/**
 * The fixed-width directory name for one lane's temp, stable across turns so
 * a continuation finds the same directory its earlier turns used.
 */
export function laneTmpDirName(
  kind: "implementer" | "validator",
  ids: readonly string[],
): string {
  const preimage = [kind, ...ids.map(toLanePathSegment)].join("/");
  return createHash("sha256")
    .update(preimage, "utf8")
    .digest("hex")
    .slice(0, DIGEST_HEX_CHARS);
}

/**
 * Why a canonical temp directory cannot be handed to a backend, or null when
 * it fits. Checked against the CANONICAL path — symlink resolution is what
 * lands in `$TMPDIR`, and on macOS it is longer than the composed form.
 */
export function laneTmpDirBudgetViolation(
  canonicalTmpDir: string,
): string | null {
  const bytes = Buffer.byteLength(canonicalTmpDir);
  if (bytes <= MAX_LANE_TMP_DIR_BYTES) return null;
  return (
    `temp directory "${canonicalTmpDir}" is ${bytes} bytes, over the ` +
    `${MAX_LANE_TMP_DIR_BYTES}-byte AF_UNIX budget the sandbox's bridge ` +
    `sockets need`
  );
}
