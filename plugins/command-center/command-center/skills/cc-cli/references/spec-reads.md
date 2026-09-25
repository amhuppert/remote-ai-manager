## Native SDD read disclosure

Read a spec through a pull-based ladder rather than fetching its complete view
up front:

1. `cctl spec show <slug> --summary` returns counts plus zero-returned/truncation
   disclosure and the exact default-outline next command.
2. `cctl spec show <slug>` returns a bounded nested outline with stable handles,
   per-element state, and explicit omission metadata.
3. `cctl spec get <slug>/<handle>` returns one element in full as line-oriented
   text by default or `payload.data.element` with `--json`.
4. `cctl spec section get <slug> --id <element-id>` returns one section under
   `payload.data.section`. Sections are the only content with no
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

`--json` preserves the selected disclosure level. Inline data is under
`payload.data`; artifacts use `payload.kind: "artifact"`, with bounded
`payload.summary` and `payload.artifact` metadata. Rendered/full show reads
always return artifacts. Use `--out <path>` to choose their destination.
Read the file in byte ranges or search it locally. A JSON artifact can contain
one long line, so a line-ranged read may still flood context.

Use the manifest's `contains` field to interpret the file. Automatic JSON spill
contains a `response` envelope. `--json --out` exports `data` when the original
payload was inline. A `binary` artifact contains the exported document, such as
the JSON view from `spec show --full`, without a response wrapper.

Within inline show data, `spec` is the identity and `counts` or
`requirements` are sibling view fields. Status, lint, get, and section get keep
`status`, `lint`, `element`, and `section` inside `payload.data`. Get also
provides `elementId`, `kind`, and `elementVersion` there. Use those identities
rather than traversing the durable snapshot row.

Plan reads and open/propose/reopen receipts keep the plan at
`payload.data.plan`. Abandon returns only the retired attempt's ID.
For example, this extracts selected plan fields from a successful read while
handling inline output, automatic spill, and explicit JSON `--out`:

```sh
cctl spec plan status my-spec --json > .cc/temp/plan-receipt.json
python3 - <<'PY'
import json
from pathlib import Path

receipt = json.loads(Path('.cc/temp/plan-receipt.json').read_text())
if not receipt['ok']:
    raise SystemExit(receipt['error']['message'])
payload = receipt['payload']
if payload['kind'] == 'inline':
    data = payload['data']
else:
    artifact = payload['artifact']
    if artifact['contains'] == 'binary':
        raise SystemExit('Read the exported document at ' + artifact['path'])
    exported = json.loads(Path(artifact['path']).read_text())
    data = exported['payload']['data'] if artifact['contains'] == 'response' else exported
plan = data['plan']
print(json.dumps({'attempt': plan['attempt'], 'nextAct': plan['nextAct']}, indent=2))
PY
```

`spec status`, `spec diff`, `spec delta`, `spec plan get`, and `spec plan status`
return bounded collections by default. Follow omission commands or choose
`--full` for complete data and optional `--out` artifact delivery.

Revision fields answer different questions. `baseRevision` is the immediate
parent named by the current revision's `basedOnRevisionId`. `currentRevision`
is the spec's latest revision, whether draft, approved, or withdrawn.
`currentApprovedRevision` is the latest revision whose state is approved and
may therefore differ from both. Inspect
the machine-readable envelope map and these semantics offline with
`cctl spec schema read-envelopes`.
