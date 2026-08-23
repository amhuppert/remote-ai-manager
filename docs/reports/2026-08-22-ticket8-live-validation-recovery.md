# Ticket 8 live validation-recovery evidence

Date: 2026-08-22 (America/New_York)

## Scope

This live check exercised the validation-round recovery path against the running worktree dev server with real Claude implementer and validator turns. The dev server resolved its durable state to the worktree-local `.config/command-center.db`; no production datastore was used.

Marker: `T8LIVE-9F2C`

Execution: `1f7091a2-56b8-44df-9bfc-ff09de1ef06e`

## Scenario and durable evidence

1. A one-off graph ran one authored context, `certify`, with one task and a required blocking context-validator assignment.
2. While validation round 2 was in `phase: "specialists"` with the specialist `running`, the workflow was paused through the real workflow UI.
3. A SQLite read-back after the pause returned:

   ```json
   {
     "status": "paused",
     "context_status": "ready",
     "completed_tasks": 1,
     "round_seq": 2,
     "round_phase": "concluded",
     "round_outcome": null,
     "specialist_state": "running"
   }
   ```

4. Resuming through the UI scheduled validation-only work. A read-back while it ran returned task count `1`, round sequence `3`, phase `specialists`, and outcome `null`.
5. The next durable boundary was completion. The archived execution row read back as:

   ```json
   {
     "status": "completed",
     "context_status": "completed",
     "completed_tasks": 1,
     "round_seq": 3,
     "round_phase": "concluded",
     "round_outcome": "passed",
     "specialist_state": "verdict_pass"
   }
   ```

6. Reloading the workflow UI showed the same execution in History as `completed`, with the context published to the session and no mutation controls.

The first validator round had already returned a blocking false negative before the initial pause attempt, so the incident-shaped retired round is sequence 2 rather than sequence 1. That earlier verdict did not satisfy certification and did not affect the recovery assertion.

## Result

PASS: pausing an active validation round persisted a concluded-null round without reopening completed task work; resume created a fresh round; the execution completed only after the fresh round passed.

The throwaway fixture session and browser were removed after evidence capture.
