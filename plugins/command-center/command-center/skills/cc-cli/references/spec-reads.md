## Native SDD read disclosure

Read a spec through a pull-based ladder rather than fetching its complete view
up front:

1. `cctl spec show <slug> --summary` returns counts plus zero-returned/truncation
   disclosure and the exact default-outline next command.
2. `cctl spec show <slug>` returns a bounded nested outline with stable handles,
   per-element state, and explicit omission metadata.
3. `cctl spec get <slug>/<handle>` returns one element in full as line-oriented
   text by default or the named `element` envelope with `--json`.
4. `cctl spec section get <slug> --id <element-id>` returns one section under
   its own named `section` payload. Sections are the only content with no
   handle, so the outline lists them by element id and nothing addresses them
   as `<slug>/<handle>`; an `--id` that resolves to a handled element is
   refused and names that element's kind and handle.
5. `cctl spec show <slug> --rendered` writes the canonical current revision as
   Markdown, while `--full` writes the complete JSON view. Both return a small,
   file-backed artifact manifest instead of embedding the document on stdout.

Both element reads answer from the current revision and never fall back to an
older one. A handle or section id the current revision no longer carries is
refused with `historical_only`, whose details name the last revision that held
it and whose instruction is the exact read to run. `--revision` is the explicit
selector on either read and takes a revision number or a revision id — the
value's own shape decides which, so a caller holding either one passes it
unchanged.

`--json` preserves whichever level was selected. For an artifact read it
serializes the manifest; it does not put the rendered or full body back into
the envelope. Read the returned path in **byte** ranges (`head -c N <path>`,
then `tail -c +N <path> | head -c N`) or search it locally — the receipt's hint
spells the exact commands out. Do not reach for a line-ranged read: a spilled
JSON envelope is one very long line, and a single huge tool result can be too,
so `sed -n '1,200p'` prints the whole file you just avoided printing. If even a
bounded summary or outline would exceed the stdout budget, the CLI writes that
exact inline envelope to JSON and returns a `storage: "artifact"` receipt with
`reason: "stdout_budget_exceeded"`.

Inline summary and outline show envelopes are flattened: `spec` is the spec
identity, while view data such as `counts`, `requirements`, and `tasks` are
sibling fields. Artifact show receipts instead carry `storage: "artifact"` and
`artifact: {path, format, bytes, sha256}`; rendered/full receipts also carry a
bounded `revision`. Status, lint, get, and section get keep their named payloads
under `status`, `lint`, `element`, and `section`. The get receipt also hoists
`elementId`/`kind`/`elementVersion`; use those identity fields instead of
traversing the durable snapshot row's nested `element` objects.

Revision fields answer different questions. `baseRevision` is the immediate
parent named by the current revision's `basedOnRevisionId`. `currentRevision`
is the spec's latest revision, whether draft, proposed, or approved.
`currentApprovedRevision` is the latest revision whose state is approved and
may therefore differ from both. Inspect
the machine-readable envelope map and these semantics offline with
`cctl spec schema read-envelopes`.
