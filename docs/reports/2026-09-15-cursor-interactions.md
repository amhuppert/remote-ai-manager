# Cursor in-turn interactions — ticket #123

## Delivered behavior

Cursor SDK 1.0.31 supports native text steering through `Run.steer`. CC now exposes in-turn delivery, correlates acknowledgements with the requesting run, and records accepted messages through the durable queue. Attachments, unavailable runtimes, and explicit provider refusals use the next turn. Lost acknowledgements, transport failures after dispatch, and the 30-second acknowledgement bound leave delivery uncertain for user review; they do not automatically resend the message.

Cursor can ask questions during a turn through CC's `cc_question` custom tool. It uses the existing question panel and the SDK's supported `local.customTools` callback. Answers are persisted once before releasing the callback. The question ID, conversation scope, and run-bound callback keep replies out of unrelated runs. A five-minute limit, cancellation, duplicate-reply rejection, and restart recovery settle requests. Questions from nested agents share the conversation's single pending batch; overlapping requests return unavailable. The SDK supplies no child-agent identity, so CC does not claim to identify which child asked.

Ordinary and managed conversation replies use this same callback route before any workflow-specific next-turn handling. Question availability follows the turn's question permission. Asynchronous `cctl ask` retains its end-turn and next-user-message contract.

Cursor's informational execution warning explains text-only steering, next-turn fallback, uncertain delivery, and CC-owned questions. Built-in Cursor `askQuestion` and `await` remain denied.

## Provider evidence and limits

The installed baseline was 1.0.28. The implementation pins the SDK and supported platform packages to 1.0.31 and refreshes the generated model catalog through its existing generator.

- [Official steering documentation](https://cursor.com/docs/api/sdk/typescript#steering-a-run-in-flight): `complete_delivered` confirms delivery in the running turn; `revert_to_followup` leaves delivery to the host. `steer` is optional and is not part of the `supports()` vocabulary.
- Installed `run.d.ts` exposes that method. `options.d.ts` exposes asynchronous custom-tool callbacks with an optional tool call ID. The SDK documents propagation of custom tools to nested agents.
- The local SDK implementation explicitly rejects native questions in both main and subagent execution. Its `type: request` stream message is correlation metadata emitted when a run starts, not an actionable question.
- The SDK has no host-supplied steering idempotency key or acknowledgement recovery query. Exactly-once provider delivery across process death remains unproven and cannot be promised. CC preserves ambiguity rather than replaying automatically.
- The question implementation is a CC-owned tool over a supported callback. It does not implement the unavailable native question/reply API. A restarted process cannot reconnect an outstanding callback, so its durable question marker is retired and stale replies are refused.

These provider gaps remain improvement opportunities under the governing migration policy; usable steering and the disclosed question fallback are delivered.

## Validation

[Sanitized durable evidence and validation run IDs](2026-09-15-cursor-interactions-evidence.json).

The authenticated app checks used this worktree's isolated dev database, a scratch Git project, SDK/platform packages 1.0.31, and Composer 2.5. No backend fallback was used.

| Check | Result |
| --- | --- |
| Native steer while a custom question waits | Both HTTP requests succeeded. SDK acknowledged `complete_delivered`. One finished run returned Blue and the unique `CC_LIVE_123_S4_NOVEL7` marker. |
| Durable delivery | Exactly one visible user transcript entry for the steer, one answer transcript entry, and one occurrence of the marker in the run's answer. The SDK's separate raw echo remains diagnostic metadata. |
| Question UI | Selected and submitted answers in the real conversation panel. Inspected the panel and the Cursor warning in Storybook screenshots. |
| Cancellation | Abort returned 200, cleared the pending question, and a stale reply returned 410. No answer was queued. |
| Server restart | Restarted while a question was pending. Its marker was cleared, stale reply returned 410, and a subsequent prompt resumed the same Cursor agent successfully. |
| Asynchronous `cctl ask` | Real shell invocation registered a `q_` batch and ended its run. Selecting Orange in the UI produced `CC_ASYNC_123:Orange` in a distinct finished run. |
| Final durable state | Conversation awaiting, Cursor backend preserved, no pending question or queued message. |
| Next.js diagnostics | No configuration or browser session errors. |

Registered checks passed: 26 focused test files across three regression runs, full type checking, lint, seam validation, and formatting. Tests cover acknowledgement correlation and ambiguity, worker request deduplication and settlement, answer persistence failures, overlapping questions, cancellation/expiry, stale replies, both storage scopes on restart, and durable queue recovery. The timer and overlap cases use injected seams; they are not evidence of a provider guarantee. Live nested-agent attribution and a forced loss of a provider acknowledgement were not claimed as verified.

Live testing found and fixed an admission bug: a running Cursor turn with an open question was rejected because its conversation status was `waiting_for_input`. The queue route now admits that run's in-turn question state while retaining the asynchronous-question boundary. Confirmed fallback responses also report `next_turn` accurately.

The scratch session was removed and the dev configuration restored after verification. Changes are uncommitted.
