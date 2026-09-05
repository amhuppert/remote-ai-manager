# Ticket #109 verification

Date: 2026-09-05. Scope: steps 4–6 of [the decided design](../designs/ticket80-native-sdd-planning-simplification.md), following [the approved pre-implementation review](../designs/ticket109-planning-simplification-review.md).

## Implemented contracts

- Criterion records preserve optional `covers`. Proposal derives the selected covered union for each stable authored context and freezes it in the v4 candidate manifest. The authored binding contains dispositions only. Every unlaunched v3 state requires reopening into v4 and fresh sign-off; historical candidate bytes remain readable and unchanged.
- All five `coverage/*` findings identify the blocked proposal transition and its remedy. Tests apply each remedy through workflow replacement and verify parity between preflight, status, and proposal.
- Definitions accept generic seeded documents with UTF-8 limits of 262,144 bytes per document and 1,048,576 bytes per plan. Local CLI and server boundaries validate the contract; execution reservation and materialization preserve the documents.
- Spec delivery supplies one excerpt per authored context with scoped source entries, the full pinned spec, and one immutable claims document with an index and context sections. Generated sources omit `accessPolicy`; seeded document locators do not produce committed-tree warnings.
- Advisory review identity covers authored content, including authored documents, while excluding managed augmentation. Exact candidate and sign-off hashes still bind the complete frozen definition. Proposal, sign-off receipts, and Spec Studio expose review status. The CLI plan-edit command, help entry, schema document, and skill reference are removed.

## Automated evidence

Behavior changes were developed with failing focused tests followed by passing registered runs. Schema/storage round trips cover `covers`, seeded documents, and v4 manifests. Coverage-remedy tests use the real accountability analysis. Delivery tests prove that a failed context earns no partial credit and that working-definition edits cannot change frozen attribution.

All 32 initially changed test files passed in four explicit eight-file batches:

- `vrun-d0b14c7e-81f1-4fb3-ba4f-b3233acb2558`
- `vrun-5accae47-e1f9-49dc-843f-5c4c114ddc3f`
- `vrun-96de717b-3685-480a-89f0-57bfd39e78d5`
- `vrun-6567d740-15b3-4c73-8668-7a25f559d196`

Twelve additional related files cover managed definition policy/service, migration 0039, execution attachment/binding, delivery gating, archived execution persistence, prompt composition, and seeded-document lifecycle. Eleven passed unchanged. The ownership-prompt integration fixture was updated to supply the same context identity as the production implementer and to compare the shared map separately from the reader's section pointer; it passed as `vrun-730c0423-1cd9-4a45-a9e3-69554297b46d`.

The remaining stale spec-help assertions were updated for workflow replacement and passed as `vrun-80ff8665-3672-4a8a-bf0f-c07bd8b98e1a`. CLI write tests passed again as `vrun-2205f0a0-ce88-40b2-b673-7f69c461c022`. These checks cover 45 distinct test files.

Registered checks passed:

- TypeScript: `vrun-d623cdca-7fa9-49e9-ac4d-30d9e111c400`
- Architecture seams: `vrun-3900d474-eadc-47b7-8cd0-b014f0e96bb6`
- Formatting: `vrun-cd5ec779-630d-43e6-bcea-c7b73dd79bee`
- Lint: `vrun-235da9cd-bade-4846-ad1e-84b4240c644e`

The broad changed-scope selection discovered 822 files and stopped on two 60-second timeouts in unchanged migration 0030 tests. That entire migration file passed in isolation as `vrun-fde35564-e516-4f33-9cb2-e762004b0391`, bringing the verified set to 46 distinct files. A concurrent TypeScript run also reached its timeout; the subsequent run above passed. The full 822-file selection is not claimed green.

## Live S4 and S5

The session's `cctl dev ensure nextjs` supplied `http://localhost:3002`. Its database and configuration were verified under this worktree's `.config`. The scratch repository was `.cc/p/lab`, with no remote. No production datastore or main worktree was modified, and no merge was invoked.

Identifiers:

- Spec: `lab/ticket109-coverage`
- Candidate: `0d2b9a9e-2401-4ddc-b300-1b3d90141f75`
- Candidate hash: `sha256:72d9fe4260c277b4f692a25d391dfe63f1961d152f50c4c982d5a6b1e1b0f4f0`
- Graph execution: `7a62b888-1d3e-440c-913e-cae866e922ce`
- Authored review hash: `sha256:341f326a34c7dbfb3e3e2e0b930ceb0fa214141bc64bc2008b7682d38ba2b1aa`

**Proposal and review:** the plain authored file was reviewed before replacement. Replacement cleared all four initial proposal findings and retained the approved review. Proposal printed that same review. Playwright verified the advisory in Spec Studio, performed the actual human plan-sign-off control, and confirmed the exact candidate hash and `approvedBy.kind: human` in the persisted response. The advisory remained visible after sign-off.

**S4:** the `probe` context had two records with disjoint coverage. Its first task deliberately wrote a wrong beta marker to exercise failure recovery. A real Claude validator failed `beta-output`, explicitly recognized alpha as correct, and cited no alpha issue. The runtime snapshot was captured before replacement by the second round. The implementer corrected beta, and the real validator passed the whole context on round two. The downstream audit context also passed, and the workflow completed and archived its integrated result.

There is no public delivery-gate preflight endpoint. The production composition's `deliveryGate.evaluate` was invoked directly against the scratch datastore without dispatching a merge. After human delivery approval, it passed and persisted exactly two `spec_delivery_verdicts`, both attributed to `probe` and the frozen candidate/hash. To inspect failure attribution after the automatic retry had advanced, the captured real failed runtime was replayed through the same production evaluator in a separate copied scratch database. The beta issue appeared only on R1.2; both criteria remained failed, integration remained unsettled, and that replay database contained zero delivery verdicts. The running instance was never rewound.

**S5:** all five seeded documents in the integrated session tree exactly matched `launchDocument.definition.seededDocuments`. The real lane agents read their materialized excerpts and shared documents. The audit agent read its own empty excerpt and its section in the single claims document, then wrote `document-audit.md` quoting both. The frozen charter had separate `appliesTo.contextIds` entries for `probe` and `audit`, ranked before the full spec and claims map. No injected source carried `accessPolicy`; preflight returned no findings. The generic shared-document inventory remains global; the charter's excerpt source entries are scoped.

Raw local evidence is preserved under `.cc/temp/`: `ticket109-live-summary.json`, `ticket109-browser-evidence.md`, proposal/review/sign-off receipts, `ticket109-failed-probe-runtime.json`, `ticket109-completed-execution.json`, and `ticket109-gate-{completed,failed-replay}.json`.

## Environment findings and cleanup

The initial longer scratch project path exceeded the existing workflow-storage directory-name limit after base64 encoding; the shorter path above resolved it. A Turbopack internal panic interrupted the first launch request before an execution existed; `cctl dev ensure` restarted it and the retry completed. Development build-stamp drift was handled with the worktree's source CLI against the same scratch server.

The separate delivery-policy approval has no current Spec Studio button: the attention link returns to the Delivery view. For this isolated fixture, Playwright invoked the existing human `grant-gate-approval` HTTP action and verified its durable human approval. This is recorded as an API check, not a successful UI control check.

The browser was closed. Scratch-session teardown and restoration of the original dev configuration are completed before handoff. Evidence files are retained for review.
