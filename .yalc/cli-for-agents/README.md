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

Use Node 20+, npm and the lockfile. TypeScript 5.9.3, esbuild 0.25.12 and
`@types/node` are **development-only** dependencies.

```sh
bash scripts/worktree-init.sh
cctl validate run typecheck --scope full --queue-if-busy
cctl validate run build --scope full --queue-if-busy
cctl validate run test --scope full --queue-if-busy
```

Build emits `dist`. Typecheck runs six isolated positive compiler programs before
negative misuse fixtures. Test compiles first and runs all 17 test files with one
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
resolved from application state and must already exist.

The package remains private and unpublished. Consumer migration/wire cutover,
Commander replacement, plugin synchronization, optional HTTP/job/gate/identity/
digest kits, live progress, streaming exports, interactive/ANSI/TTY behavior and
raw stdout escape hatches are excluded. The pilots make no kb/cctl migration,
SQLite, production deployment or crash-recovery claim.
