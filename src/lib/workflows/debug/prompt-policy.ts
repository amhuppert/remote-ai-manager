import type {
  DebugModePhase,
  RuntimeDebugModeState,
} from "@/lib/debug-log/schemas";
import {
  debugCleanupResultSchema,
  debugEvidenceAnalysisOutputSchema,
  debugHypothesisOutputSchema,
} from "./schemas";

/**
 * Appended to the system prompt when a conversation is in debug mode.
 * Placeholders are replaced at runtime.
 *
 * NOTE: This prompt instructs the agent to produce two machine-readable
 * artifacts as side effects rather than as the agent's text response:
 *   1. `.debug/<conversationId>/instrumentation.json` — written via the filesystem `Write`
 *      tool. Validated post-write by `debugInstrumentationManifestSchema`
 *      (from `@/lib/debug-log/schemas`) in `src/lib/debug-log/service.ts:readManifest`.
 *   2. Per-probe JSON entries POSTed to `{DEBUG_LOG_URL}` from the
 *      instrumented app at runtime. Validated per-request by
 *      `debugLogEntrySchema.safeParse` in `src/lib/debug-log/ingest-route-handlers.ts`.
 *
 * Neither contract uses the turn's `outputFormat` because neither artifact
 * travels through the agent's text response — the manifest is a file the agent
 * writes during the same turn, and the log entries are HTTP requests the
 * instrumented code makes at user-reproduction time. Structured-output
 * transport cannot constrain side effects of tool calls; instead, both
 * contracts are enforced at consumption via Zod schemas in
 * `@/lib/debug-log/schemas`.
 *
 * The agent's actual *text* response carries the per-phase `outputFormat`
 * derived from `schemas.ts` through the shared backend pipeline (see the
 * conversation lifecycle module).
 */
export const DEBUG_MODE_INSTRUCTIONS = `<debug-mode>
You are in Debug Mode. Debug with runtime evidence, not static guesswork.

## Workflow
1. **Hypothesize + Instrument (same turn)**: Form 3-5 plausible root-cause hypotheses labeled H1, H2, etc., and immediately add the minimum instrumentation needed to test them in the same response. Explain what each hypothesis predicts and where you instrumented. Do not stop after listing hypotheses.
2. **Wait for Reproduction**: Return clear ordered reproduction steps as the \`reproductionSteps\` array in your structured JSON output. The UI renders the steps deterministically from that field. Do not continue until the user says reproduction is complete.
3. **Analyze Evidence (same turn fix or re-instrument)**: Read \`{DEBUG_LOG_FILE_PATH}\` and classify each hypothesis as supported, refuted, or inconclusive. Then choose ONE outcome based on whether the evidence is sufficient to justify a fix:
   - **\`fix_applied\`**: when at least one hypothesis is well-supported and the rest are refuted or inconclusive, implement the minimal fix in this same turn and return verification steps.
   - **\`more_instrumentation\`**: when evidence is inconclusive or insufficient, extend the hypothesis set, add fresh targeted instrumentation in the same turn, and return reproduction steps the user should re-execute.
4. **Verify**: Ask the user to verify the applied fix.
5. **Clean Up**: After the user clicks "Mark Fixed", remove all instrumentation you added.

## Debug Log API
POST logs to: {DEBUG_LOG_URL}

Each log entry must be a JSON object with:
- \`timestamp\`: ISO 8601 string
- \`hypothesisId\`: \`"H1"\`, \`"H2"\`, etc.
- \`location\`: \`"file/path.ts:lineNumber"\`
- \`message\`: human-readable description
- \`data\`: object with the runtime values needed to test the hypothesis

Probes must NOT set the \`X-CC-Debug-Log: 1\` header. The receiver drops every request carrying that header as a self-instrumentation signal, so adding it from a normal probe silently discards every entry. The header is reserved for one narrow case: when the project being debugged is Command Center itself and your probe sits inside CC's own debug-log code path. In that scenario only, set the header (and have any \`fetch\` wrapper skip requests carrying it) so the receiver short-circuits the recursive POST. If you are not debugging CC, omit the header entirely.

Keep logs narrowly targeted to decision points, inputs, outputs, state transitions, and invariants that distinguish between hypotheses. Instrumentation must be fire-and-forget and must never break the app.

## Instrumentation Markers

Every instrumentation block MUST be wrapped with structured comment markers so it can be reliably found and removed during cleanup.

**Multi-line blocks** — use START/END delimiters:
\`\`\`
// @debug-probe:{hypothesisId}:{slug} START
...instrumentation code...
// @debug-probe:{hypothesisId}:{slug} END
\`\`\`

**Single-line additions** (imports, variable declarations needed only for instrumentation):
\`\`\`
import { useRef } from "react"; // @debug-probe:{hypothesisId}:{slug}
\`\`\`

Format: \`@debug-probe:{hypothesisId}:{slug}\` where:
- \`{hypothesisId}\` is the hypothesis being tested (e.g., \`H1\`, \`H2\`)
- \`{slug}\` is a short kebab-case label (e.g., \`pre-dispatch\`, \`token-check\`)

Example instrumentation with markers:
\`\`\`typescript
// @debug-probe:H1:token-validation START
void fetch("{DEBUG_LOG_URL}", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    timestamp: new Date().toISOString(),
    hypothesisId: "H1",
    location: "src/lib/auth.ts:42",
    message: "Token validation result",
    data: { tokenPrefix: token?.slice(0, 8), isValid, userId }
  })
}).catch(() => {});
// @debug-probe:H1:token-validation END
\`\`\`

## Instrumentation Manifest

After adding instrumentation, write a manifest to \`{DEBUG_MANIFEST_PATH}\` that tracks every probe. This manifest is the source of truth for cleanup.

\`\`\`json
{
  "conversationId": "the-conversation-id",
  "createdAt": "ISO 8601 timestamp",
  "probes": [
    {
      "id": "H1:token-validation",
      "file": "src/lib/auth.ts",
      "description": "Logs token validation result to test H1"
    },
    {
      "id": "H2:state-before-dispatch",
      "file": "src/app/api/route.ts",
      "description": "Captures actor state before event dispatch"
    }
  ]
}
\`\`\`

Each probe entry has:
- \`id\`: matches the \`{hypothesisId}:{slug}\` in the comment marker
- \`file\`: relative path to the instrumented file
- \`description\`: what this probe captures

Update the manifest whenever you add or remove probes during additional instrumentation passes.

## Cleanup Verification

During cleanup, after removing all instrumentation:
1. Read \`{DEBUG_MANIFEST_PATH}\` to get the list of probed files
2. Remove all \`@debug-probe\` markers from those files
3. Run \`grep -r "@debug-probe" src/\` to verify zero results — if any remain, remove them
4. Do NOT delete \`{DEBUG_MANIFEST_PATH}\` yourself; Command Center cross-checks your structured report against the manifest and removes the file only after the verification passes. Set \`acknowledgesManifestDeletionContract: true\` in your structured response to confirm you understand CC owns the deletion.
5. Check each modified file for orphaned imports or variables that were only needed by removed probes

## Rules
- Never propose or implement a fix before reviewing runtime evidence from \`{DEBUG_LOG_FILE_PATH}\`.
- Prefer a few high-signal logs over broad tracing.
- If the evidence is incomplete, add another targeted instrumentation pass instead of guessing.
- During the analyze-evidence phase you ARE permitted (and expected, when the runtime evidence is sufficient) to implement the minimal fix in the same turn. Cleanup of debug instrumentation is still deferred until the user clicks "Mark Fixed".
- NEVER remove instrumentation until the user clicks "Mark Fixed". The user controls when cleanup happens, not you.
- ALL instrumentation MUST use \`@debug-probe\` comment markers and be tracked in \`{DEBUG_MANIFEST_PATH}\`.
</debug-mode>`;

/**
 * Phase-specific context snippets prepended to every debug turn after the
 * initial instructions have been delivered. Keeps the agent focused on the
 * current phase without repeating the full workflow.
 */
export const DEBUG_PHASE_CONTEXT: Record<string, string> = {
  hypothesizing:
    '<debug-phase>Phase: HYPOTHESIZING. Form hypotheses, add instrumentation, and provide reproduction steps. Return structured JSON with EVERY one of these fields:\n- `hypotheses` (array, 3\u20135 items): each item has `id` (sequential labels "H1", "H2", \u2026 \u2014 use higher numbers when extending an earlier set), `description` (one sentence), and `instrumentationPlan` (concrete probes you will add).\n- `reproductionSteps` (string[], at least 2): only the user-facing actions to reproduce the bug, written as imperatives ("Click X", "Send a request to Y"). Do NOT include closing remarks directed at yourself or the user (e.g. "tell me when done") \u2014 those belong in the conversational text outside the structured output.</debug-phase>',
  awaiting_reproduction:
    "<debug-phase>Phase: AWAITING REPRODUCTION. The user has not yet confirmed reproduction. Answer follow-up questions but do NOT analyze evidence or propose fixes yet.</debug-phase>",
  analyzing_evidence:
    '<debug-phase>Phase: ANALYZING EVIDENCE. Read the debug log file at {DEBUG_LOG_FILE_PATH} and classify each hypothesis as supported, refuted, or inconclusive based strictly on what the logs show. Then choose ONE of two outcomes based on whether the evidence is sufficient to justify a fix:\n\n(a) FIX_APPLIED \u2014 If at least one hypothesis is well-supported and the rest are refuted or inconclusive AND the evidence is sufficient to commit to a minimal fix, IMPLEMENT THE FIX IN THIS SAME TURN. Return structured JSON with EVERY one of these fields:\n- `outcome`: "fix_applied"\n- `supportedHypotheses` (string[]): hypothesis ids ("H1", "H2", \u2026) the evidence supports.\n- `refutedHypotheses` (string[]): ids the evidence refutes.\n- `inconclusiveHypotheses` (string[]): ids that need more evidence.\n- `evidenceSummary` (string): short prose summary tying log lines to hypotheses.\n- `fixSummary` (string): one or two sentences naming what changed and why.\n- `verificationSteps` (string[], at least 1): the concrete steps the user runs to verify the fix.\nDo NOT remove any instrumentation in this turn \u2014 cleanup only happens when the user clicks "Mark Fixed".\n\n(b) MORE_INSTRUMENTATION \u2014 If the existing evidence is inconclusive or insufficient, EXTEND THE HYPOTHESIS SET and add fresh debug instrumentation in this same turn (using @debug-probe markers and updating {DEBUG_MANIFEST_PATH}). Return structured JSON with EVERY one of these fields:\n- `outcome`: "more_instrumentation"\n- `supportedHypotheses`, `refutedHypotheses`, `inconclusiveHypotheses` (string[]): classification of the existing hypotheses.\n- `evidenceSummary` (string): short prose summary tying log lines to hypotheses.\n- `hypotheses` (array, 1\u20135 items): the extended hypothesis set, each with `id` (sequential labels "H1", "H2", \u2026 \u2014 continue numbering past the prior round; do NOT reuse earlier ids), `description`, and `instrumentationPlan`.\n- `reproductionSteps` (string[], at least 1): imperative steps the user should re-execute so the new probes capture evidence.\n\nThe choice between (a) and (b) depends on whether the existing evidence is sufficient to justify a fix.</debug-phase>',
  awaiting_verification:
    '<debug-phase>Phase: AWAITING VERIFICATION. The user is verifying the fix. Answer questions but do NOT remove instrumentation — cleanup only happens when the user clicks "Mark Fixed".</debug-phase>',
  cleanup_instrumentation:
    '<debug-phase>Phase: CLEANUP. Remove ALL debug instrumentation you added (logging statements, fetch calls to the debug log API, etc.). Follow the cleanup procedure: read {DEBUG_MANIFEST_PATH} for the probe manifest, remove all @debug-probe markers from every file listed there, run `grep -r "@debug-probe" src/` to verify none remain, and check for orphaned imports. Do NOT delete {DEBUG_MANIFEST_PATH} yourself — Command Center cross-checks your structured report against the manifest and removes the manifest after a passing verification.\n\nReturn structured JSON with EVERY one of these fields:\n- `removedInstrumentation` (boolean): true once every @debug-probe marker has been removed.\n- `filesModified` (string[]): every file path listed in the manifest must appear here. Use repository-relative paths.\n- `grepVerificationPassed` (boolean): true when `grep -r "@debug-probe" src/` returned zero results.\n- `acknowledgesManifestDeletionContract` (boolean): set to true to confirm you understand CC (not the agent) deletes the manifest.\n- `notes` (string): brief summary of the cleanup; "" if nothing notable.</debug-phase>',
};

export function buildDebugPromptContext(input: {
  debugMode: RuntimeDebugModeState | null;
  debugLogUrl: string;
  debugManifestPath: string;
}): string | null {
  const { debugMode, debugLogUrl, debugManifestPath } = input;
  if (!debugMode?.active) return null;
  let prefix: string;
  if (!debugMode.instructionsDelivered) {
    prefix = DEBUG_MODE_INSTRUCTIONS.replaceAll("{DEBUG_LOG_URL}", debugLogUrl)
      .replaceAll("{DEBUG_LOG_FILE_PATH}", debugMode.logFilePath)
      .replaceAll("{DEBUG_MANIFEST_PATH}", debugManifestPath);
  } else {
    prefix = (DEBUG_PHASE_CONTEXT[debugMode.phase] ?? "").replaceAll(
      "{DEBUG_MANIFEST_PATH}",
      debugManifestPath,
    );
  }

  if (!debugMode.recording) {
    const pausedNotice =
      "<debug-paused>Recording is paused. New runtime evidence will not be appended to the debug log until recording is re-enabled.</debug-paused>";
    prefix = prefix ? `${pausedNotice}\n\n${prefix}` : pausedNotice;
  }

  return prefix || null;
}

export function resolveDebugOutputSchema(
  phase: DebugModePhase | null | undefined,
): Record<string, unknown> | undefined {
  switch (phase) {
    case "hypothesizing":
      return debugHypothesisOutputSchema;
    case "analyzing_evidence":
      return debugEvidenceAnalysisOutputSchema;
    case "cleanup_instrumentation":
      return debugCleanupResultSchema;
    default:
      return undefined;
  }
}
