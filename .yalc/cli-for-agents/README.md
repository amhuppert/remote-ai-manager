# cli-for-agents

A working, private TypeScript library for command-line tools that AI agents call.
One command declaration supplies typed inputs, parsing, help and invocation
references. The runtime owns lazy execution, guidance arbitration, bounded output,
artifacts and process draining. The kernel has **no runtime package dependencies**.

Start with [adding a command](docs/implementation/add-a-command.md). Read the
[public contract](docs/design/public-contract.md) for API guarantees and
[ENVELOPE](ENVELOPE.md) for the conditions this code is built for — and the ones it
will never meet. [HANDOFF](HANDOFF.md) orients the next implementer.

## Package surfaces

| Import | Purpose |
| --- | --- |
| `cli-for-agents` | `commandsFor`, command/group/flow declarations, inputs/results, pages, finite binary requests and checked values |
| `cli-for-agents/runtime` | `createCli`, `runCli`, `main`, Node host, help, reference generation/checking and envelope decoding |
| `cli-for-agents/guidance` | Hints/instructions, rule definitions and candidate evaluation |
| `cli-for-agents/testing` | Injectable test host, production-runtime observations and seven inherited contract cases |

The [complete inventory](docs/implementation/api-inventory.md) maps all 39
functions and two constants to owners. Internal paths are private. The package
emits ESM and declarations; consumer applications can bundle into one executable.

## Develop and verify

Use Node 20+, npm and the lockfile. TypeScript 5.9.3, esbuild 0.25.12,
`@types/node`, Zod 4.6.5 and `@standard-schema/spec` 1.0.0 (schema compatibility
fixtures) and yalc 1.0.0-pre.53 (local-publication tests) are **development-only**
dependencies; the emitted package imports none of them.

```sh
bash scripts/worktree-init.sh
cctl validate run typecheck --scope full --queue-if-busy
cctl validate run build --scope full --queue-if-busy
cctl validate run test --scope full --queue-if-busy
```

Build emits `dist`. Typecheck runs ten isolated positive compiler programs before
negative misuse fixtures. Test compiles first and runs all 23 test files with one
worker. In a behavior change's red/green loop, select one exact file:

```sh
cctl validate run test --queue-if-busy -- tests/execution.test.mjs
```

`CommandCenter.json` registers these commands; `cctl validate list` shows the live
registry. Full distribution tests require the Node 20, Node 24 and Bun 1 executables
pinned in [runtimes.json](scripts/distribution/runtimes.json); only the major version
must match. Missing runtimes fail. The [distribution guide](docs/implementation/distribution-guards.md)
describes CI provisioning, executable bundling and the bundle-size/import
guards. CC manages git lifecycle actions.

## Use it from another local project

The package is private and unpublished; consume a fresh local snapshot with
[yalc](https://github.com/wclr/yalc) (tested with 1.0.0-pre.53). Packing runs the
`prepack` hook, which deletes `dist` and rebuilds it from source; a failed build
fails the pack, so a stale or partial `dist` never ships. yalc runs that hook only
when scripts are enabled, so publish with `--scripts` and do not use bare
`yalc push`, which defaults to scripts off.

```sh
# In this repository, after installing development dependencies:
npm ci
npm exec -- yalc publish --private --scripts

# In the consumer (yalc on PATH, or npx yalc@1.0.0-pre.53), the first time:
yalc add cli-for-agents && npm install
# After each later publication:
yalc update cli-for-agents && npm install
```

Consumers compile against the shipped declarations only; with
`exactOptionalPropertyTypes`, Zod and other Standard Schema v1 libraries assign to
`StandardSchema` directly, without an adapter. Owner-controlled consumers migrate
across breaking changes in their own rollouts; see the
[consumer migration guide](docs/implementation/consumer-migration.md).

## Run the pilots

The local pilot uses a real finite JSON workspace. Its test builds the executable:

```sh
cctl validate run test --queue-if-busy -- tests/pilots/local.test.mjs
node .cc/temp/local-pilot/bundle/workspace.mjs init --json
```

Set `WORKSPACE_HOME` to the returned root, then run:

```sh
node .cc/temp/local-pilot/bundle/workspace.mjs query --json
node .cc/temp/local-pilot/bundle/workspace.mjs show n1 --context --full
```

See [local instructions](examples/local-workspace/README.md) for structured
read/validate/apply, scalar updates, raw file/stdin ingestion and binary exports.
The [remote pilot](examples/remote-service/README.md) is a thin client with lazy
application-owned HTTP transport:

```sh
node examples/remote-service/cli.mjs doctor --json
cctl validate run test --queue-if-busy -- tests/pilots/remote.test.mjs
```

The remote test bundles the actual CLI and runs it against an ephemeral loopback
service, including disconnect, cancellation, rule guidance and recovery.
`examples/notebook` remains a compile-only type fixture with deliberate stubs.

## Delivered scope

Plain and structured reads, scalar and prepared payload writes, typed contexts,
strict generated inputs, progressive help, bounded guidance, atomic artifacts,
finite binary output and real Node process delivery are implemented. Default
output is 32,768 serialized UTF-8 bytes across both streams; configured budgets
must be at least 8,192 bytes. Artifact directories are explicitly configured or
resolved from application state; the kernel creates a missing directory only when a
response actually needs an artifact.

The package remains private and unpublished; owner-controlled projects consume
local snapshots. Consumer migration/wire cutover,
Commander replacement, plugin synchronization, optional HTTP/job/gate/identity/
digest kits, live progress, streaming exports, interactive/ANSI/TTY behavior and
raw stdout escape hatches are excluded. The pilots make no kb/cctl migration,
SQLite, production deployment or crash-recovery claim.
