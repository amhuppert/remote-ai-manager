/**
 * The credential gate on the authenticated Cursor acceptance suite (spec R14.2,
 * D19).
 *
 * A green acceptance run is supposed to mean one thing: authenticated Cursor
 * turns actually ran on the pinned baseline. An environment without
 * `CURSOR_API_KEY` cannot produce that, so the suite refuses rather than
 * skipping quietly — a vacuous pass here would be indistinguishable from real
 * live evidence in every place the result is later cited.
 *
 * Plain ESM because the launcher runs under bare `node` with no TypeScript
 * loader, following `worker-budget.mjs`. Types live in the sibling `.d.mts`.
 */

/**
 * `EX_CONFIG` from sysexits(3). Deliberately neither 0 (which reads as a pass)
 * nor 1 (which reads as ordinary test failures), so the outcome is legible as
 * its own third state in a shell, in CI, and in `cctl validate` output.
 */
export const CURSOR_ACCEPTANCE_BLOCKED_EXIT_CODE = 78;

/**
 * @param {{ CURSOR_API_KEY?: string | undefined }} env
 * @returns {import("./cursor-acceptance-gate.d.mts").CursorAcceptanceGate}
 */
export function resolveCursorAcceptanceGate(env) {
  const credential = env.CURSOR_API_KEY;
  // Whitespace counts as absent: an operator who exported an empty value has
  // no more credential than one who exported nothing, and the SDK would reject
  // it well after a worker and its state directory already existed.
  if (typeof credential !== "string" || credential.trim().length === 0) {
    return {
      state: "blocked",
      reason: "credential_absent",
      message:
        "CURSOR_API_KEY is not set in this environment, so no authenticated Cursor turn can run.",
    };
  }
  return { state: "ready" };
}

/**
 * The one owner of the verdict text. It names the state first so a reader —
 * or a grep — reaches the outcome before the prose, and it never interpolates
 * the credential.
 *
 * @param {import("./cursor-acceptance-gate.d.mts").CursorAcceptanceGate} gate
 * @returns {string}
 */
export function formatCursorAcceptanceVerdict(gate) {
  if (gate.state === "ready") {
    return "cursor-acceptance: verdict=ready — running the authenticated live matrix on the pinned baseline.";
  }
  return [
    `cursor-acceptance: verdict=blocked reason=${gate.reason}`,
    `cursor-acceptance: ${gate.message}`,
    "cursor-acceptance: no live evidence was produced — this is NOT a pass. Provision the credential in the Command Center server environment and re-run.",
  ].join("\n");
}
