/**
 * The declared exceptions to the `--json` volume rule (`.kiro/steering/cli.md`):
 * `--json` preserves the disclosure level a command already selected and
 * changes only serialization. Every command whose envelope carries more than
 * its text prints is enumerated here.
 *
 * It stays as data rather than as prose so a NEW exception is a reviewed edit
 * to this list — with its deletion condition written down before it ships —
 * instead of a paragraph nobody reads. The contract test refuses an entry whose
 * command no longer exists, so the list cannot outlive the debt.
 */

export interface JsonVolumeException {
  /** Registry path key of the command, e.g. `workflow status`. */
  readonly command: string;
  /** What `--json` returns in full where the text output is bounded. */
  readonly payload: string;
  /** The exact change that makes this entry deletable. */
  readonly deletionCondition: string;
}

export const JSON_VOLUME_EXCEPTIONS: readonly JsonVolumeException[] = [
  {
    command: "validate run",
    payload:
      "on a pass, the envelope carries the run's captured output in full while text relays a 20-line tail behind the verdict line",
    deletionCondition:
      "the pass envelope bounds `output` to the same tail the text prints (or drops it), leaving `validate status <run-id>` as the only full-output read",
  },
  {
    command: "validate status",
    payload:
      "for a terminal run, the envelope carries the whole `result` — including the run's full captured output — while text prints a one-line run status",
    deletionCondition:
      "the full result/output moves behind an explicit detail selector on `validate status` so the default text and JSON disclose the same one-line status",
  },
];
