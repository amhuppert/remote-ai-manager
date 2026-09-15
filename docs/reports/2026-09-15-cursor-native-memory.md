# Cursor native memory — ticket #124

## Result

CC delivers an instruction-only shared-memory policy on every Cursor worker
send, including conversations, tasks, create, resume, and follow-up turns.
Cursor remains available for governed execution. Its descriptor still declares
`nativeMemory.mechanism: "none"`. **Native memory neutralization and full memory
parity are not established.**

The policy asks the agent to use CC memory, avoid reading or writing Cursor
memories, apply the policy to delegated work, and preserve conversation history
for continuity. It does not pretend to switch off the provider's memory.
The worker logs `cursor-worker.native_memory_policy` with the run ID,
`mechanism: none`, user-message delivery, and unknown effective state, without
logging prompt contents.

The descriptor's reason supplies the existing execution warning and the Memory
Library explanation. The Memory Library and CLI now say native memory is **not
disabled**, rather than claiming it is active. There is no acknowledgement or
admission gate. CC memory index bytes and CLI retrieval remain available.

## Provider investigation

Inspected the actual installed package and the published package on 2026-09-15;
no provider mocks were used to establish these API findings.

| Surface | Finding |
| --- | --- |
| Installed `@cursor/sdk` 1.0.28 | CC remains pinned to this version. `AgentOptions`, `LocalAgentOptions`, `LocalSendOptions`, and public agent operations expose no native-memory disable or effective-state API. |
| Published `@cursor/sdk` 1.0.31 | Downloaded and inspected without changing dependencies. The same memory controls are absent. |
| Generated transport in both versions | `aiserver.v1.ChatConfig` contains boolean field 9, `memory_default_enabled` (`memoryDefaultEnabled`). This is server configuration, not a writable public agent option. Its generated constructor default `false` is not an effective-state receipt. |
| Other generated memory messages | `PotentiallyGenerateMemoryRequest` / `Response` describe generation traffic; their presence is not a supported disable API or proof that memory is used by a particular SDK run. |
| `local.settingSources: []` | Selects ambient settings sources. It is not evidence of disabling memory, excluding server memory, or overriding all policy layers. |
| Public SDK documentation | Describes local stores, options, create/resume, and MCP configuration; no supported native-memory disable/readback contract was found. |

Sources:

- [SDK documentation](https://cursor.com/docs/api/sdk/typescript)
- [Published npm metadata](https://registry.npmjs.org/@cursor%2fsdk/latest)
- [Versioned 1.0.31 package](https://registry.npmjs.org/@cursor/sdk/-/sdk-1.0.31.tgz)
- Installed `node_modules/@cursor/sdk/dist/esm/{options.d.ts,agent.d.ts,index.js}`
- Downloaded package and documentation snapshots: `.cc/temp/cursor-sdk-1.0.31/`,
  `.cc/temp/cursor-sdk-docs.html`, `.cc/temp/cursor-sdk-latest.json`

SHA-256 of `dist/esm/options.d.ts`:

- 1.0.28: `7b3cb70b33fd10d377761dcb168ecef9ecbd26e8d6184bc654557eb441e3befe`
- 1.0.31: `a0846936190c1e2bb2c3f45d047fae8ca0643bd075eb4bfcbe0c9d38dfce2817`

Additional package-file hashes are in `.cc/temp/124-sdk-hashes.json`.
These findings bound the examined SDK surface; they do not prove the absence
of every possible private provider mechanism.

## Provider request and unblock evidence

**Prepared request; not submitted to Cursor. No provider acknowledgement or
commitment has been obtained.**

Please provide a supported, per-agent/per-run native-memory policy that:

1. Disables both retrieval/injection and generation/storage of provider-native
   memories without disabling conversation continuity or CC-supplied context.
2. Applies on create and resume, including existing stored agents, follow-up
   sends, and native subagents; documents which options must be reapplied.
3. Defines precedence against user, project, team, MDM, remote policy, and
   server feature configuration. An overriding policy must be observable.
4. Returns the effective disposition and provenance before any model work,
   including an explicit unsupported/unknown result when it cannot verify it.
5. Provides an authenticated fixture or supported memory-management API for
   seeding a known native memory, proving it is absent during disabled runs,
   and proving those runs generate no native memories.

Unblock full neutralization only after applying that control in the shared
create/resume boundary and verifying effective state. Tests must then cover
policy overrides, unreadable state, restart/resume, and effective behavior.
Refuse a launch that claims neutralization but cannot establish it. Until such
a control exists, the governing migration policy permits the disclosed `none`
fallback; the provider gap does not block Cursor feature admission.

## Validation

Red-green reproductions:

- Missing memory instructions on create/resume: failed at the expected prompt
  assertion (`vrun-f5479be6-6c76-46f3-afbb-075250087b0b`), then passed.
- Missing descriptor-derived execution disclosure:
  `vrun-c82581fd-f53e-4758-bc88-7a3dbf3a344a`, then passed.
- CLI wording overstated effective state:
  `vrun-32c3eef8-c07a-4a7b-b006-10684539ca44`, then passed.
- Memory Library wording overstated effective state:
  `vrun-d79f719a-bba4-4cbd-ae96-568678b7bee6`, then passed.

Registered passing checks:

- Seven explicitly matched regression files:
  `vrun-ababcdfe-e15f-4c09-a9ed-3e3f978f1f20`. Covers worker create/resume and
  repeated sends, descriptor/catalog agreement, CLI memory index/retrieval,
  Memory Library disclosure, task behavior, and Claude's existing effective
  policy refusal tests. These tests prove CC behavior, not provider guarantees.
- Typecheck: `vrun-8b0fc57a-ceb4-4d0b-a022-46ff3f6dbeca`.
- Lint: `vrun-b5c308c8-fef4-478e-aa5f-36896df686f2`.
- Architecture seams: `vrun-b0d02ec9-deee-49c6-9b48-5d0564765bb6`.
- Format: `vrun-3812d3e8-fba5-4fc8-925f-d48db2fa2f82`.

Storybook was started through this session's `cctl dev ensure storybook`.
Visual inspection covered the workflow assignment warning and the expanded
Memory Library disclosure at 390 pixels, plus the Library at 900 pixels.
Keyboard Enter toggles the Library disclosure. Text wraps without clipping, and the
warning does not prevent Cursor selection. Switching to Claude hides the
warning; keyboard selection of Cursor restores it. Screenshots were opened
inline in the conversation. The browser tool refused saving into this
worktree because its configured filesystem roots differ; no screenshot file
is claimed as an artifact.

## Authenticated matrix — passed

`src/lib/agent-backends/cursor/acceptance/native-memory.acceptance.test.ts`
passed both cases on 2026-09-15 with SDK 1.0.28 and Composer 2.5:
four authenticated turns, 33.99 seconds total (32.71 seconds in tests).

- Conversation create, close worker, reload the saved reference, resume.
- Task create, reload its saved reference, resume in another worker.

Each turn receives a unique token in a supplied CC memory index and must write
that token to a file. The test reads back the real file, checks the resumed
reference, and records credential-screened evidence. A fresh token on resume
checks consumption of current CC context. This proves supplied-memory
consumption and continuity only; it does not prove native memory is disabled,
nor exercise live `cctl memory` retrieval from an application server.

The managing server has no registered authenticated Cursor validator. After
Alex approved the four-turn test and SDK auxiliary home-directory access, the
following scoped diagnostic completed successfully:

```sh
TMPDIR="$PWD/.cc/temp" scripts/validate/cursor-acceptance.sh \
  src/lib/agent-backends/cursor/acceptance/native-memory.acceptance.test.ts
```

The wrapper built this branch's production worker and placed CC state, local
stores, workspaces, and evidence under `.cc/temp/cursor-acceptance/`. The harness
closed all four workers. Scratch evidence is retained for review.

Independent readback after the test confirmed:

- All four real token files match their supplied CC memory index values.
- Both saved continuation references match the references recorded on create
  and resume. The SDK stores contain 43 conversation event rows and 41 task
  event rows.
- Both provider transcript files contain two user rows carrying the CC memory
  policy, covering create and resume for each facet.
- The per-worker logs contain four `cursor-worker.native_memory_policy` events;
  each reports `mechanism: none`, user-message delivery, and unknown effective
  state. These records live under `config/logs/cursor-workers/`, separate from
  the harness's `logs/acceptance.log`.

Evidence:

- Runner verdict: `.cc/temp/124-live-output.log` (one file, two tests passed).
- Published receipts: `.cc/temp/cursor-acceptance/published.jsonl`.
- Independent file hashes, reference checks, policy logs, and transcript counts:
  `.cc/temp/124-live-readback.json`.
- Conversation raw receipt SHA-256:
  `f66bc03a1825654d8a5f251198c5fbbd3980495d65b47e875d648c75e918c5b9`.
- Task raw receipt SHA-256:
  `4ca570f62f9bea60776cd92dc4f72f48ac4ab4a0b4fd005c6ffba2f640a203c5`.

The live pass establishes delivered policy, current CC context consumption, and
create/resume continuity for this account and model. It does not establish
provider-native memory exclusion or prevent an agent from ignoring the
instruction-only policy. Full neutralization remains dependent on the provider
control and effective-state evidence requested above.
