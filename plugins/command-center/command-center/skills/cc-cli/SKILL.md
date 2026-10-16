---
name: cc-cli
description: >-
  Use the cctl CLI for Command Center actions: questions, notifications,
  documents, validation, dev servers, runs, memory, and conversation
  evidence. Also use when a cctl command fails or its identity, output,
  or asynchronous handoff needs explanation.
---

# Command Center CLI (`cctl`)

Use `cctl` for Command Center actions. The installed binary talks to the running
CC server; it does not execute changes from your branch. Read the relevant
`cctl <group> <verb> --help` before composing a payload or recovering from a
refusal. Help works offline and lists the current flags, schemas, related
commands, and skills. `cctl --help` is the group index.

Use the identity CC injects into this session. Read-only conversation and run commands
can resolve another conversation or run by id; cross-session mutations require explicit
scope flags and authorization for that target.

## Choose the relevant reference

Read only the branch needed for the task; command help owns exact invocation
shapes. The complete generated [command reference](references/command-reference.md)
is available when an offline catalog is useful.

| Task | Reference |
|---|---|
| Ask a consequential question; resume an answer | [Questions](references/questions.md) |
| Run registered checks; recover a validation verdict | [Validation](references/validation.md) |
| Start or diagnose a dev server; create CC test fixtures | [Dev servers](references/dev-servers.md) |
| Notify the user; register or delete a document | [Notifications and documents](references/notifications-and-documents.md) |
| Read or update tickets, relationships, attachments, or status posts | [Tickets](references/tickets.md) |
| Recall or capture shared memory | [Memory](references/memory.md) |
| Read transcripts, images, compactions, or continuation checkpoints | [Conversations](references/conversations.md) |
| Discover sources, manage subscriptions or inspect pending updates | [Subscriptions and inbox](references/subscriptions.md) |
| Launch, follow or steer a supervised run; work a run's context; save a run template | [Runs](references/runs.md) |
| Read native specs and artifact receipts | [Spec reads](references/spec-reads.md) |
| Submit an authorized Alignment charter or decision batch | [Alignment](references/alignment.md) |
| Inspect agent profiles | `cctl agent list/get --help` |
| Analyze local logs and export a trace | [Logs](references/logs.md) |
| Diagnose identity, connectivity, build skew, or help output | [Environment and help](references/environment-and-help.md) |

To plan a run, use [run-planning](../run-planning/SKILL.md).
Project conversations cannot delegate runs.

For native spec authoring and its human gates, use
[native-sdd-authoring](../native-sdd-authoring/SKILL.md).

## Payloads and output

Write JSON payloads under `.cc/temp/` in your assigned worktree, then pass
`--file <path>`. In a supervised context, use the per-seat payload
directory under `.cc/temp/` named by its prompt. These locations keep throwaway payloads out of
engine-managed commits. Repair the command's structured validation issues
before resubmitting.

For prose containing quotes, backticks, `$`, or newlines, use the command's
`--<flag>-file` alternative; discover it through leaf help. Pass either the
inline flag or its file variant, never both. This prevents shell expansion from
changing the text the user will review.

Text output is for reading; `--json` emits one JSON document for programmatic
consumers. Domain results use a library envelope: `ok`, `effect`, optional
`recovery`, `payload`, `error`, and guidance. For an inline result, command data
is under `payload.data` with `payload.kind: "inline"`. An artifact result has
`payload.kind: "artifact"`, a bounded `payload.summary`, and
`payload.artifact` containing the file path, media type, byte count, and hash.
Read that file in bounded chunks or search it locally. A response too large for
stdout is saved the same way: the receipt adds `payload.spill` with the attempted
and allowed byte counts, and text output prints a `notice:` line before the
`artifact:` line. This is normal delivery, not a failure.
Check `artifact.contains` before parsing it: `response` is the complete response
envelope, `data` is command data, and `binary` is the exported document's bytes.
See [spec reads](references/spec-reads.md) for a JSON extraction example.

`--json` changes representation, not scope: omitted rows stay omitted. Follow
returned handles and omission commands. Where help offers `--full`, use it to
request complete data. `--out` names the artifact file inside
`.cc/temp/cctl-artifacts/` under the directory cctl runs in: a relative path
resolves there, not against the working directory (`--out status.json`, never
`--out .cc/temp/status.json`), a destination outside it is refused, a
subdirectory must already exist, and an existing file is not overwritten. The
receipt's `artifact.path` is the absolute location. Binary exports always
return an artifact receipt. Structured input commands have a
validation twin, such as `ask-check` or `spec draft-check`; it admits the same
file without applying the write. A passing check returns `valid`, the payload
hash, and any server preflight `preview`; when the invocation can be replayed,
its hint names the write to run.
Check leaf help for what the preflight covers.

Redirect output to a file before parsing a potentially large response. Parse
that complete JSON document; validation runner output is inside the result
payload, never appended after the envelope. Offline `--help`, `--version`, and
`exit-codes` return their own native metadata objects with `--json`.

## Output tiers

| Field | Meaning | Action |
|---|---|---|
| `hint` | Advisory next step | Use it when relevant; it grants no authority and imposes no gate. |
| `reminders[]` | State-dependent invariants | Keep them true while continuing the authorized work. |
| `instruction` | Immediate protocol action | Follow it before the next tool call, subject to higher-priority instructions. |

A successful `cctl ask` or `cctl decisions propose` registers an asynchronous
human handoff. Give a brief note explaining what is pending, then end the turn;
the answer arrives in a later prompt. An already-pending question also means
end the turn. Prepare working notes before submitting. An autonomous-turn
refusal means use best judgment within the authorized scope.

A run you launch reports to you through wakes. Its agents write your
worktree, so until the result arrives, edit no file the run may change (with
no `scope`, every file): read, plan or end the turn. Each question, halt and
result arrives as a later prompt, so nothing needs polling.


## Exit codes

Run `cctl exit-codes` for the runtime's exit classes and domain error catalog;
add `--json` for structured metadata. An error has `code`, `exitClass`, and
`message`, with optional `why`, `issues`, and server details. Fix the named
input or refusal, and use `cctl doctor` for connectivity, token, or build skew.

Inspect `effect` before retrying a failed write: `not_applied` means it did not
apply, `applied` means an effect occurred, and `unknown` needs a state check.
Use the actual resource identities in `recovery` to find that state. A nonzero
exit can follow a successful mutation whose later observation or artifact
write failed. A successful status read can describe a failed job; inspect the
job's terminal state before reporting success.

Finish once the authorized action has a success receipt and any necessary
state check confirms its result. For an asynchronous launch, report the run id
and current state; claim completion only after its terminal success result.
