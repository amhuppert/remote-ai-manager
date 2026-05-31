# Live Verification — Smart Merge (2026-05-31)

Live end-to-end verification of the new `prepareSquashMerge` / `publishPreparedMerge` pipeline and the actor-level `ready-to-land` gate. The driver is `scripts/smart-merge-live-verify.ts`, which builds a fresh git repository per scenario in a `mktemp` directory, invokes the production `src/lib/git/worktree.ts` exports directly, and asserts the observable end state.

- Driver: `scripts/smart-merge-live-verify.ts` (self-contained; re-runnable)
- CC worktree: `/Users/alex/github/command-center/.worktrees/smart-merge-strategy-cf2445.revise-requirements`
- git version: 2.39.5 (Apple Git-154) → auto-detect selects the `plumbing` path
- Production code exercised: `prepareSquashMerge`, `publishPreparedMerge`, `discoverTargetCheckout` from `src/lib/git/worktree.ts`

---

## Scenario 1 — Happy path (clean main → publish)

### Setup
- Fresh repo `/var/folders/.../cc-sm-happy-vUqnSd` (mktemp).
- Baseline commit on `main` (`a9d5af67…`) with `README.md`, `src/a.ts`, `src/b.ts`.
- Feature branch `csm/verify-feature` with one divergent commit modifying `src/b.ts` (`b34774e3…`).
- `main` checked out, status clean.

### Commands invoked
```ts
discoverTargetCheckout(projectPath, "main")
prepareSquashMerge({ projectPath, featureBranch: "csm/verify-feature", featureSha, targetBranch: "main", targetSha: mainBaseSha, message, jobId })
publishPreparedMerge({ projectPath, targetBranch: "main", preparedSha, expectedTargetSha, parkedRef, cleanTargetWorktreePath })
```

### Observed
```
discoverTargetCheckout → kind=clean
prepareSquashMerge → kind=prepared
  preparedSha=7621e6176c2a5a475bc1a02fc3eb5b8fba207cc5
  parkedRef=refs/cc-merges/job-happy-1780222095035
publishPreparedMerge → kind=published
  mergeHash=7621e6176c2a5a475bc1a02fc3eb5b8fba207cc5
git rev-parse refs/heads/main → 7621e6176c2a5a475bc1a02fc3eb5b8fba207cc5  (advanced)
git status --porcelain → (empty, clean)
cat src/b.ts → contains feature content ("c = 3")
git rev-parse refs/cc-merges/job-happy-… → (missing — deleted)
```

### Result
**PASS** — outcome `published`, `refs/heads/main` advanced to the prepared SHA, the target worktree is clean and reflects the feature commit, the parking ref was deleted, no `MergePreconditionFailed` thrown.

---

## Scenario 2 — Dirty main → `ready-to-land` → Land

### Setup
- Fresh repo `/var/folders/.../cc-sm-dirty-cjFFmc`.
- Baseline `main` (`3ae952e3…`) + feature `csm/verify-feature` (`c7c984d5…`) modifying `src/b.ts`.
- Tracked dirty change introduced on `main`: `echo "extra dirty line" >> README.md` (un-staged tracked modification).
- `git status --porcelain` → ` M README.md` before prepare.

### Commands invoked
```ts
// Prepare phase
prepareSquashMerge({ … })                         // expected: kind="prepared", no throw

// Actor's gate (simulated): discoverTargetCheckout decides "ready-to-land"
discoverTargetCheckout(projectPath, "main")       // expected: kind="dirty"

// User cleans main
git checkout -- README.md

// Land action (publishPreparedMerge re-invoked with the original parked sha)
discoverTargetCheckout(projectPath, "main")       // now clean
publishPreparedMerge({ … same prepared/expected/parked … })
```

### Observed
```
dirty status pre-prepare: M README.md
prepareSquashMerge → kind=prepared  parkedRef=refs/cc-merges/job-dirty-1780222111220
discoverTargetCheckout → kind=dirty  trackedDirtyPaths=["README.md"]
(actor would surface status="ready-to-land")
git rev-parse refs/heads/main → 3ae952e3…  (unchanged — main NOT advanced)
git rev-parse refs/cc-merges/job-dirty-… → preparedSha  (parked ref retained)

# After git checkout -- README.md
discoverTargetCheckout → kind=clean
publishPreparedMerge (Land) → kind=published
  mergeHash=71aa50aca9fcd073ba0085eddbaa8a1baa3c3f5d
git rev-parse refs/heads/main → 71aa50aca9…   (advanced after Land)
git rev-parse refs/cc-merges/job-dirty-… → (missing — deleted)
```

### Result
**PASS** — prepare succeeded with no precondition error and produced a parked commit; the actor-level gate (`discoverTargetCheckout`) identified the dirty target and would emit `status: "ready-to-land"` (the same terminal output the job/SSE channel surfaces from `runPublish`); `refs/heads/main` did not advance; after cleaning, the Land action (a re-invocation of `publishPreparedMerge` with the same parked SHA / expected SHA) advanced main and deleted the parked ref.

Note on the job/SSE channel: the driver verifies the same logic path that the production actor returns (`runPublish` → `discoverTargetCheckout` → early `ready-to-land`). The job/SSE machinery (`publishActor` → state-store → SSE broadcast) wraps that output unchanged; this scenario validates the producing end of the channel without booting the full SSE stack.

---

## Scenario 3 — Concurrent publish → CAS retry

### Setup
- Fresh repo `/var/folders/.../cc-sm-conc-I1VaTJ`.
- Baseline `main` (`30b569a1…`).
- Two feature branches off the same baseline:
  - `csm/feature-a` (`f81a783d…`) modifying `src/a.ts`.
  - `csm/feature-b` (`13eb7f62…`) modifying `src/b.ts`.

### Commands invoked
```ts
// Prepare both against the SAME expectedTargetSha (the baseline)
prepA = prepareSquashMerge({ …feature-a, targetSha: mainBaseSha })
prepB = prepareSquashMerge({ …feature-b, targetSha: mainBaseSha })

// Publish both in parallel
Promise.all([ publishPreparedMerge(prepA …), publishPreparedMerge(prepB …) ])

// Re-prepare the loser against the new tip, re-publish
prepRetry = prepareSquashMerge({ …loser, targetSha: newMainTip })
publishPreparedMerge(prepRetry …)
```

### Observed
```
both prepares produced parked refs against expectedTargetSha=30b569a1…
  preparedShaA=b9e33cce21764511abfeb395ab5fc10323f5e1f2
  preparedShaB=f1d1601b945bf211d70e0ae74013032c192424fa

parallel publishPreparedMerge results:
  pubA.kind = cas-lost
  pubB.kind = published    ← winner

cas-lost.actualTargetSha = f1d1601b…  == winner preparedShaB ✓
(internal: `git update-ref refs/heads/main b9e33cce… 30b569a1…` failed with
 "cannot lock ref 'refs/heads/main': is at f1d1601b… but expected 30b569a1…"
 — captured and returned as { kind: "cas-lost", actualTargetSha } without
 propagating an exception)

retry path:
  new main tip = f1d1601b…
  prepareSquashMerge (loser against new tip) → kind=prepared
    preparedSha=ecdabf497d98628e9a31cd1310fd0b0fb0f96ca6
  publishPreparedMerge (retry) → kind=published, mergeHash=ecdabf497d…
```

### Result
**PASS** — first publish succeeded via CAS, second detected the stale `expected-old` and returned a structured `cas-lost` result (no exception escaped); re-preparing the loser against the new tip and republishing succeeded — exactly the design-stated recovery path. The loser's original `parkedRef` is intentionally retained on `cas-lost` per the design (caller decides whether to retry, discard, or surface).

---

## Scenario 4 — Prepare-phase independence from dirty main

A static + dynamic confirmation that `MergePreconditionFailed` is no longer thrown during prepare/validation, regardless of target worktree state.

### Static check
```
src/lib/git/worktree.ts            → 0 references to MergePreconditionFailed
src/lib/workflow-graph/errors.ts   → 0 references
src/lib/**/*.ts (all production)   → 0 references
src/components/workflow-graph/ContextHaltCard.stories.tsx:108 → 1 reference (Storybook story name only — cosmetic, not in any runtime code path)
```

### Dynamic check
```
grep -i "MergePreconditionFailed" /tmp/{happy,dirty,conc}.log → no matches
```

In particular, the dirty-main scenario (Scenario 2) exercised the exact pre-revision throw site and now flows through cleanly: `prepareSquashMerge` returned `kind: "prepared"` despite ` M README.md` on the target worktree.

### Result
**PASS** — no `MergePreconditionFailed` can be thrown during prepare or validation. The symbol is removed from production code; the only surviving occurrence is a Storybook story name for the legacy "halt" UI, which is not on the prepare path.

---

# Summary

| Scenario | Result |
| --- | --- |
| 1. Happy path (clean main → publish) | **PASS** |
| 2. Dirty main → ready-to-land → Land | **PASS** |
| 3. Concurrent publish → CAS retry | **PASS** |
| 4. Prepare-phase dirty independence (no MergePreconditionFailed) | **PASS** |

### Anomalies / observations
- The cas-lost branch (Scenario 3) emits a warn-level `git.error` log from `exec` when `update-ref` fails. That is expected — the log is emitted by the generic git wrapper before `publishPreparedMerge`'s catch block translates the failure into a structured `cas-lost` result. No exception escapes.
- The loser's original parked ref (Scenario 3) is intentionally retained on `cas-lost` per the design contract; cleanup is the caller's responsibility (in production, the actor decides whether to re-prepare or surface).

No production-code remediation required.
