## cctl run, cctl run template, cctl context

The mechanics of supervised runs: payload files, receipts, wakes and refusals.
How to plan a run, write its briefs and steer it lives in the
[run-planning](../../run-planning/SKILL.md) skill. Each verb's `--help` owns its
exact fields.

```
cctl run launch-check --file .cc/temp/run.json
cctl run launch --file .cc/temp/run.json
cctl run workflow-check --file .cc/temp/workflow.json
cctl run workflow --file .cc/temp/workflow.json
cctl run show <run-id>
cctl run audit <run-id>
cctl run audit <run-id> --context <context-id>
cctl run audit <run-id> --full --out run-audit.json
cctl run answer <run-id> --question <question-id> --text "<answer>"
cctl run resume <run-id> --context <context-id> --occurrence <occurrence> --disposition <kind>
cctl run retry <run-id> --lane <key>
cctl run definition <run-id>
cctl run amend-check <run-id> --file .cc/temp/workflow.json --based-on <revision>
cctl run amend <run-id> --file .cc/temp/workflow.json --based-on <revision> --reason "<why>"
cctl run pause <run-id>
cctl run resume <run-id>
cctl run cancel <run-id>
```

The conversation that launches a run owns it. Only the owner answers its
questions and amends it; the owner and the user in Command Center pause,
resume, cancel and retry it; only the user decides an approval. Any
authenticated conversation can read it with `run show`, `run definition` or
`run audit`, including from another project or session. Bare run ids resolve
their target; explicit project/session flags constrain reads to that target.

### Payload files and check verbs

`run launch`, `run workflow`, `run amend`, `run template save` and
`run template launch` read a JSON file (`--file`), and each has a `-check` twin
that validates the same file without applying anything. A passing check prints
`valid` and the payload hash. A failing one exits `2` with one
`issue:` line per problem, ending in its JSON path:

```
issue: schema: "a" (writes the whole workspace) and "b" (writes the whole workspace) can run at the same time and would change the same files. Give them disjoint owned scopes, or order them with dependsOn. (["contexts",1,"scope"])
```

The checks run locally. `launch-check` checks the file's shape;
`workflow-check` and `amend-check` add every topology rule; `template save-check`
checks the template's shape, parameter tokens and workflow, but not its
profiles; `template launch-check` checks only the inputs file. What needs the
server is checked by the write itself: check names against the project's
registered validation commands, profiles, backends and models, document files,
the session's state, the run's history for an amendment, and the template's
current revision. A launch file is at most 256 KB; a workflow or
amendment file, 1 MB.

### Receipts and ids

A launch prints `Run <run-id> launched (<progress>)` and hints `run show`. With
`--json`, `payload.data` holds `runId`, `contextIds` and `progress`; a template
launch adds `ownerConversationId`. Keep the run id: every other verb takes it.

- **Context ids** are `<run-id>.<key>`; an agent run's one context has the key
  `agent`, and a later loop pass is `<run-id>.<key>.pass<N>`. `run resume
  --context` takes the id `run show` prints in brackets.
- **Question ids** come from the wake and from `run show`.
- **Halt occurrences** come from the wake and from `run show`. An occurrence
  changes whenever the context moves on, and a stale one is refused.
- **Definition revisions** appear on the first line of `run show`; `--based-on`
  takes the one you read.
- **Template revisions** appear in `run template list` and `run template show`.

`run show` prints the run's progress, then each context as
`- <key> [<context-id>]: <state>` with its tasks, open questions, halt and
occurrence, last summary, result and the document revisions it froze, then
lanes (a publishing lane names what it waits for), loops, the charter,
documents, run-level halts and the last five boundaries. `run definition`
writes the workflow definition as written to a JSON file under
`.cc/temp/cctl-artifacts/`; the reply names its revision, and
its `artifact:` line names the file. Copy it, edit the copy and amend with
that: the written file is never overwritten, so an edited one would block
reading the same revision again. An agent run has none.

### Audit evidence

Start with `run audit <run-id>`. Its bounded overview counts all invocations,
historical agent conversations, candidate versions, reviews, workspace
operations and wake deliveries. Every context row gives an exact detail
command; pagination reports the total and next command. A past loop pass has
its own context id, and replaced agents remain in its history.

`--context <context-id>` reads that context's work report, candidate and review
history, advice dispositions, acceptance and agent seats. The output links to
each agent's transcript. Use `conversation read <id> --outline`, then the
returned message or seq window with `--include-tools full`; `conversation entry
get` exports an entry without excerpts. `--full` includes every context and the
durable boundary, workspace and wake evidence. Large output becomes an artifact;
read it from the path in the receipt.

Conversation coverage includes every recorded context seat, including replaced
agents. Lane conflict-resolution and validation-fix tasks have no conversation
transcript; use their workspace outcomes and server logs. The audit states this
coverage limit in both text and JSON.

Prompt dispatch evidence records the exact work, formatting and repair input
CC sent to its backend adapter. It does not reconstruct provider wire requests
or provider-injected instructions. Older transcripts may lack these records;
the audit distinguishes absent records from unavailable transcripts. Neither
condition proves that no formatting or repair turn happened.

The audit's timestamps, project/session and conversation ids also identify the
scope for `cctl logs report --help`. Use logs to investigate runtime failures
beyond the durable evidence; audit output is not a bundle of every server log.

When a context halts with `output_invalid`, inspect its work report before
choosing a remedy. `retry_capture` only formats its existing result again;
`continue` resumes work, then captures and reviews a new result.

### Wakes

The owner follows its run from launch: the run is a `run` subscription source
with wake. Each boundary wakes the owner with a turn whose prompt holds a
notice:

```
<run-boundary run="<run-id>" kind="question" boundary="3">
<summary>
Question: <the seat's question>
Answer: cctl run answer <run-id> --question <question-id> --text "<answer>"
</run-boundary>
```

Boundaries are `question`, `approval`, `halted` (a context's halt, a route,
loop or lane that cannot proceed, or a fault), `succeeded` (with every result
that ran), `cancelled` and `restored_paused` (the server restarted). Each
notice ends with the command that answers it. A question already closed, and
an approval or context halt the context has moved past, are withdrawn before
delivery. Run-level halt, fault and restored-pause notices are delivered even
when someone has already acted on them, so they may describe earlier state:
read `run show` before acting on one. Until the result arrives, edit no file
the run may change (with no `scope`, every file in its worktree); read, plan or
end your turn. Nothing needs polling. `cctl inbox list --all` keeps delivered
notices.

### Refusals to expect

Read the error message: it names the cause, and usually the remedy.

| Refusal | Cause |
|---|---|
| `conversation_identity_required` | not run from an agent conversation of this session; project conversations cannot launch runs |
| `seat_cannot_launch` | a seat conversation tried to launch; ask your owner with `cctl ask` |
| `owner_not_wakeable` | this conversation cannot be woken: archived, owned by another execution, or not an ordinary conversation |
| `session_finished`, `session_finalizing`, `session_deleted` | the session takes no new run |
| a profile, backend or model message naming a context | a seat cannot be resolved; read `cctl agent list` |
| `Invalid documents` | a document's path, `from` file or size; one issue per document |
| `checks_not_registered` | a check names no validation command registered for this project (`cctl validate list`); one issue per check |
| `not_run_owner` | only the conversation that launched the run answers, amends or steers it |
| `question_closed` | the question was already answered or withdrawn |
| `run_control_refused` | the run finished, the disposition does not clear that halt, the occurrence is stale, the lane has nothing to retry, or the definition revision moved |
| `amendment_refused` | the amendment changes work that already happened; one issue per change |
| `human_decision_required` | only the user decides an approval |
| `run_template_changed`, `run_template_revision_conflict` | the template changed since the revision you named (launch or replace); read it again |
| `run_template_exists` | a create named an id the library already uses; replace it with `--based-on`, or choose another id |
| `run_template_invalid`, `run_template_launch_invalid` | the template, or what a launch's values make of it, has problems; one issue each |
| `RUN_CURRENT` | a current run blocks merging or deleting its session; let it finish or cancel it |

### Commands for seats

A conversation working a supervised context uses `cctl context`; its first
order lists the commands it may use. Any other conversation is refused.

```
cctl context task complete <task-id>
cctl context task reopen <task-id>
cctl context task add <task-id> --title "<title>"
cctl context doc publish <file> --description "<what it holds>"
```

`context doc publish` (implementers only) freezes a file from the seat's working
directory as the next revision of a run document, for work that starts later. To revise a
document read under `.cc/run-docs/`, copy it, edit the copy and publish that
with `--as <document path>`. A revision is refused when another context or an
amendment changed the document since the seat's context started.

### Templates

```
cctl run template list
cctl run template show <id>
cctl run template save-check <id> --file .cc/temp/template.json
cctl run template save <id> --file .cc/temp/template.json --based-on <revision>
cctl run template delete <id> --based-on <revision>
cctl run template launch-check <id> --file .cc/temp/inputs.json
cctl run template launch <id> --file .cc/temp/inputs.json
```

`show` writes the template file `save` takes; edit a copy, as for
`run definition`.
`save` creates a template without `--based-on` and replaces one with it.
`--tier project|global` picks the library. Without it, a replacement, `show`,
`delete` and `launch` find the template by id and refuse an id both tiers use,
and a create goes to this project, refused when the global library already uses
the id. A template file is at most 1 MB and a launch's inputs file 256 KB.
`launch` takes `{parameters, revision}` and launches as `run workflow` would;
you own the run.
