#!/usr/bin/env bun
/**
 * Live end-to-end verification of the prepare/publish smart-merge pipeline.
 *
 * Drives `prepareSquashMerge`, `publishPreparedMerge`, and `discoverTargetCheckout`
 * (the actor's "ready-to-land" gate) against a fresh, self-contained git repository
 * created in a temporary directory. Each scenario builds its own repo so the script
 * is fully reproducible.
 *
 * Usage:
 *   bun scripts/smart-merge-live-verify.ts happy-path
 *   bun scripts/smart-merge-live-verify.ts dirty-main
 *   bun scripts/smart-merge-live-verify.ts concurrent
 *   bun scripts/smart-merge-live-verify.ts all
 */

import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  prepareSquashMerge,
  publishPreparedMerge,
  discoverTargetCheckout,
} from "../src/lib/git/worktree";

const exec = promisify(execFile);

async function git(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await exec("git", args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout, stderr };
}

async function makeRepo(label: string): Promise<{
  projectPath: string;
  mainBaseSha: string;
}> {
  const projectPath = await mkdtemp(join(tmpdir(), `cc-sm-${label}-`));
  await git(projectPath, ["init", "-q", "-b", "main"]);
  await git(projectPath, ["config", "user.email", "verify@local"]);
  await git(projectPath, ["config", "user.name", "verify"]);
  await git(projectPath, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(projectPath, "README.md"), "# Verify\n");
  await mkdir(join(projectPath, "src"), { recursive: true });
  await writeFile(join(projectPath, "src/a.ts"), "export const a = 1;\n");
  await writeFile(join(projectPath, "src/b.ts"), "export const b = 2;\n");
  await git(projectPath, ["add", "-A"]);
  await git(projectPath, ["commit", "-q", "-m", "baseline"]);
  const { stdout: head } = await git(projectPath, ["rev-parse", "HEAD"]);
  return { projectPath, mainBaseSha: head.trim() };
}

async function makeFeatureBranch(
  projectPath: string,
  branchName: string,
  file: string,
  content: string,
  message: string,
): Promise<string> {
  await git(projectPath, ["checkout", "-q", "-b", branchName]);
  await writeFile(join(projectPath, file), content);
  await git(projectPath, ["add", file]);
  await git(projectPath, ["commit", "-q", "-m", message]);
  const { stdout } = await git(projectPath, ["rev-parse", "HEAD"]);
  await git(projectPath, ["checkout", "-q", "main"]);
  return stdout.trim();
}

function ok(line: string): void {
  console.log(`  ✓ ${line}`);
}
function info(line: string): void {
  console.log(`  · ${line}`);
}

async function refExists(projectPath: string, ref: string): Promise<boolean> {
  try {
    await git(projectPath, ["rev-parse", "--verify", ref]);
    return true;
  } catch {
    return false;
  }
}

async function scenarioHappyPath(): Promise<{
  pass: boolean;
  notes: string[];
}> {
  console.log("\n=== Scenario 1: Happy Path (clean main → publish) ===");
  const notes: string[] = [];
  const { projectPath, mainBaseSha } = await makeRepo("happy");
  notes.push(`projectPath=${projectPath}`);
  notes.push(`mainBaseSha=${mainBaseSha}`);

  const featureSha = await makeFeatureBranch(
    projectPath,
    "csm/verify-feature",
    "src/b.ts",
    "export const b = 22;\nexport const c = 3;\n",
    "feature: update b",
  );
  notes.push(`featureSha=${featureSha}`);

  const checkout = await discoverTargetCheckout(projectPath, "main");
  info(`discoverTargetCheckout → kind=${checkout.kind}`);
  if (checkout.kind !== "clean") {
    return { pass: false, notes: [...notes, "main should be clean"] };
  }

  const jobId = `job-happy-${Date.now()}`;
  const prep = await prepareSquashMerge({
    projectPath,
    featureBranch: "csm/verify-feature",
    featureSha,
    targetBranch: "main",
    targetSha: mainBaseSha,
    message: "squash: feature into main",
    jobId,
  });
  info(`prepareSquashMerge → kind=${prep.kind}`);
  if (prep.kind !== "prepared") {
    return {
      pass: false,
      notes: [...notes, `prepare unexpected: ${prep.kind}`],
    };
  }
  ok(`prepared parkedRef=${prep.parkedRef} preparedSha=${prep.preparedSha}`);
  notes.push(`preparedSha=${prep.preparedSha}`);
  notes.push(`parkedRef=${prep.parkedRef}`);

  const pub = await publishPreparedMerge({
    projectPath,
    targetBranch: "main",
    preparedSha: prep.preparedSha,
    expectedTargetSha: prep.expectedTargetSha,
    parkedRef: prep.parkedRef,
    cleanTargetWorktreePath: checkout.worktreePath,
  });
  info(`publishPreparedMerge → kind=${pub.kind}`);
  if (pub.kind !== "published") {
    return {
      pass: false,
      notes: [...notes, `publish unexpected: ${pub.kind}`],
    };
  }
  ok(`published mergeHash=${pub.mergeHash}`);

  const { stdout: mainTip } = await git(projectPath, [
    "rev-parse",
    "refs/heads/main",
  ]);
  notes.push(`postMainSha=${mainTip.trim()}`);
  if (mainTip.trim() !== prep.preparedSha) {
    return {
      pass: false,
      notes: [...notes, "main did not advance to preparedSha"],
    };
  }
  ok(`refs/heads/main advanced to preparedSha`);

  const { stdout: status } = await git(projectPath, ["status", "--porcelain"]);
  if (status.trim().length !== 0) {
    return { pass: false, notes: [...notes, `main worktree dirty: ${status}`] };
  }
  ok("main worktree is clean after refresh");

  const { stdout: bContent } = await exec("cat", [
    join(projectPath, "src/b.ts"),
  ]);
  if (!bContent.includes("c = 3")) {
    return {
      pass: false,
      notes: [...notes, "main worktree missing feature content"],
    };
  }
  ok("main worktree reflects feature content");

  if (await refExists(projectPath, prep.parkedRef)) {
    return { pass: false, notes: [...notes, "parkedRef still exists"] };
  }
  ok(`parkedRef ${prep.parkedRef} was deleted`);

  await rm(projectPath, { recursive: true, force: true });
  return { pass: true, notes };
}

async function scenarioDirtyMain(): Promise<{
  pass: boolean;
  notes: string[];
}> {
  console.log("\n=== Scenario 2: Dirty Main → ready-to-land → Land ===");
  const notes: string[] = [];
  const { projectPath, mainBaseSha } = await makeRepo("dirty");
  notes.push(`projectPath=${projectPath}`);
  notes.push(`mainBaseSha=${mainBaseSha}`);

  const featureSha = await makeFeatureBranch(
    projectPath,
    "csm/verify-feature",
    "src/b.ts",
    "export const b = 22;\nexport const c = 3;\n",
    "feature: update b",
  );
  notes.push(`featureSha=${featureSha}`);

  // Make main dirty (tracked change).
  await writeFile(
    join(projectPath, "README.md"),
    "# Verify\nextra dirty line\n",
  );
  const { stdout: dirtyStatus } = await git(projectPath, [
    "status",
    "--porcelain",
  ]);
  info(`dirty status pre-prepare: ${dirtyStatus.trim().replace(/\n/g, " | ")}`);

  const jobId = `job-dirty-${Date.now()}`;
  let prepError: unknown = null;
  let prep: Awaited<ReturnType<typeof prepareSquashMerge>> | null = null;
  try {
    prep = await prepareSquashMerge({
      projectPath,
      featureBranch: "csm/verify-feature",
      featureSha,
      targetBranch: "main",
      targetSha: mainBaseSha,
      message: "squash: feature into dirty main",
      jobId,
    });
  } catch (err) {
    prepError = err;
  }
  if (prepError !== null) {
    return {
      pass: false,
      notes: [...notes, `prepareSquashMerge threw: ${String(prepError)}`],
    };
  }
  if (prep === null || prep.kind !== "prepared") {
    return {
      pass: false,
      notes: [...notes, `prepare unexpected: ${prep?.kind}`],
    };
  }
  ok(`prepare succeeded despite dirty main: parkedRef=${prep.parkedRef}`);

  // Simulate the actor's gate: discoverTargetCheckout sees "dirty" → ready-to-land.
  const checkout = await discoverTargetCheckout(projectPath, "main");
  info(`discoverTargetCheckout → kind=${checkout.kind}`);
  if (checkout.kind !== "dirty") {
    return {
      pass: false,
      notes: [...notes, `expected dirty checkout, got ${checkout.kind}`],
    };
  }
  ok(
    `actor would surface status="ready-to-land" (parkedRef=${prep.parkedRef})`,
  );
  info(
    `trackedDirtyPaths=${JSON.stringify(checkout.trackedDirtyPaths.map((p) => p.path))}`,
  );

  // main must not have advanced.
  const { stdout: mainTipPre } = await git(projectPath, [
    "rev-parse",
    "refs/heads/main",
  ]);
  if (mainTipPre.trim() !== mainBaseSha) {
    return {
      pass: false,
      notes: [...notes, "main advanced before Land — should not have"],
    };
  }
  ok("refs/heads/main unchanged");

  // parkedRef should still exist (the prepared commit is parked, waiting).
  if (!(await refExists(projectPath, prep.parkedRef))) {
    return {
      pass: false,
      notes: [...notes, "parkedRef missing — should be retained"],
    };
  }
  ok("parkedRef retained while awaiting Land");

  // Now clean main and invoke the Land action (= publishPreparedMerge again).
  await git(projectPath, ["checkout", "--", "README.md"]);
  const checkout2 = await discoverTargetCheckout(projectPath, "main");
  if (checkout2.kind !== "clean") {
    return {
      pass: false,
      notes: [...notes, `after cleanup, checkout kind=${checkout2.kind}`],
    };
  }
  ok("main cleaned");

  const land = await publishPreparedMerge({
    projectPath,
    targetBranch: "main",
    preparedSha: prep.preparedSha,
    expectedTargetSha: prep.expectedTargetSha,
    parkedRef: prep.parkedRef,
    cleanTargetWorktreePath: checkout2.worktreePath,
  });
  info(`Land (publishPreparedMerge) → kind=${land.kind}`);
  if (land.kind !== "published") {
    return { pass: false, notes: [...notes, `land unexpected: ${land.kind}`] };
  }
  ok(`Land published mergeHash=${land.mergeHash}`);

  const { stdout: mainTipPost } = await git(projectPath, [
    "rev-parse",
    "refs/heads/main",
  ]);
  if (mainTipPost.trim() !== prep.preparedSha) {
    return {
      pass: false,
      notes: [...notes, "main did not advance after Land"],
    };
  }
  ok("main advanced to preparedSha after Land");

  if (await refExists(projectPath, prep.parkedRef)) {
    return {
      pass: false,
      notes: [...notes, "parkedRef should be deleted after Land"],
    };
  }
  ok("parkedRef deleted after Land");

  await rm(projectPath, { recursive: true, force: true });
  return { pass: true, notes };
}

async function scenarioConcurrent(): Promise<{
  pass: boolean;
  notes: string[];
}> {
  console.log("\n=== Scenario 3: Concurrent publish → CAS retry ===");
  const notes: string[] = [];
  const { projectPath, mainBaseSha } = await makeRepo("conc");
  notes.push(`projectPath=${projectPath}`);
  notes.push(`mainBaseSha=${mainBaseSha}`);

  // Two divergent feature branches off the same baseline.
  const featureASha = await makeFeatureBranch(
    projectPath,
    "csm/feature-a",
    "src/a.ts",
    "export const a = 11;\nexport const ax = 100;\n",
    "feature A: a.ts",
  );
  const featureBSha = await makeFeatureBranch(
    projectPath,
    "csm/feature-b",
    "src/b.ts",
    "export const b = 22;\nexport const bx = 200;\n",
    "feature B: b.ts",
  );
  notes.push(`featureASha=${featureASha}`);
  notes.push(`featureBSha=${featureBSha}`);

  const jobIdA = `job-concA-${Date.now()}`;
  const jobIdB = `job-concB-${Date.now()}`;

  // Prepare both against the SAME expected target SHA (the original baseline).
  const prepA = await prepareSquashMerge({
    projectPath,
    featureBranch: "csm/feature-a",
    featureSha: featureASha,
    targetBranch: "main",
    targetSha: mainBaseSha,
    message: "squash: A",
    jobId: jobIdA,
  });
  const prepB = await prepareSquashMerge({
    projectPath,
    featureBranch: "csm/feature-b",
    featureSha: featureBSha,
    targetBranch: "main",
    targetSha: mainBaseSha,
    message: "squash: B",
    jobId: jobIdB,
  });
  if (prepA.kind !== "prepared" || prepB.kind !== "prepared") {
    return {
      pass: false,
      notes: [...notes, `prep failed: A=${prepA.kind} B=${prepB.kind}`],
    };
  }
  ok(`both prepares against expectedTargetSha=${mainBaseSha}`);
  notes.push(`preparedShaA=${prepA.preparedSha}`);
  notes.push(`preparedShaB=${prepB.preparedSha}`);

  const checkout = await discoverTargetCheckout(projectPath, "main");
  if (checkout.kind !== "clean") {
    return {
      pass: false,
      notes: [...notes, `expected clean main, got ${checkout.kind}`],
    };
  }

  // Publish A and B in quick succession.
  const [pubA, pubB] = await Promise.all([
    publishPreparedMerge({
      projectPath,
      targetBranch: "main",
      preparedSha: prepA.preparedSha,
      expectedTargetSha: prepA.expectedTargetSha,
      parkedRef: prepA.parkedRef,
      cleanTargetWorktreePath:
        checkout.kind === "clean" ? checkout.worktreePath : null,
    }),
    publishPreparedMerge({
      projectPath,
      targetBranch: "main",
      preparedSha: prepB.preparedSha,
      expectedTargetSha: prepB.expectedTargetSha,
      parkedRef: prepB.parkedRef,
      cleanTargetWorktreePath:
        checkout.kind === "clean" ? checkout.worktreePath : null,
    }),
  ]);
  info(`pubA.kind=${pubA.kind}`);
  info(`pubB.kind=${pubB.kind}`);

  // One succeeded; one lost CAS.
  const outcomes = [pubA.kind, pubB.kind].sort().join("|");
  if (outcomes !== "cas-lost|published") {
    return {
      pass: false,
      notes: [
        ...notes,
        `expected one published + one cas-lost, got ${outcomes}`,
      ],
    };
  }
  ok("one publish succeeded, one returned cas-lost (no exception thrown)");

  const losing = pubA.kind === "cas-lost" ? prepA : prepB;
  const winning = pubA.kind === "published" ? prepA : prepB;
  const loserInput =
    pubA.kind === "cas-lost"
      ? {
          prep: prepA,
          jobId: jobIdA,
          branch: "csm/feature-a",
          featureSha: featureASha,
          prepResult: pubA,
        }
      : {
          prep: prepB,
          jobId: jobIdB,
          branch: "csm/feature-b",
          featureSha: featureBSha,
          prepResult: pubB,
        };
  notes.push(`winnerPreparedSha=${winning.preparedSha}`);
  notes.push(`loserPreparedSha=${losing.preparedSha}`);

  // Confirm the cas-lost result included the new actual target SHA.
  const casLost =
    pubA.kind === "cas-lost" ? pubA : pubB.kind === "cas-lost" ? pubB : null;
  if (!casLost || casLost.kind !== "cas-lost") {
    return { pass: false, notes: [...notes, "cas-lost result not captured"] };
  }
  info(`casLost.actualTargetSha=${casLost.actualTargetSha}`);
  if (casLost.actualTargetSha !== winning.preparedSha) {
    return {
      pass: false,
      notes: [
        ...notes,
        `actualTargetSha mismatch: ${casLost.actualTargetSha} vs ${winning.preparedSha}`,
      ],
    };
  }
  ok("cas-lost.actualTargetSha matches the winning prepared SHA");

  // Re-prepare the loser against the new tip and retry — the design's
  // expected recovery path. Refresh main worktree first since the winner
  // advanced it via the cleanTargetWorktreePath refresh.
  const { stdout: newMain } = await git(projectPath, [
    "rev-parse",
    "refs/heads/main",
  ]);
  const newMainSha = newMain.trim();
  info(`new main tip = ${newMainSha}`);

  const prepRetryJobId = `${loserInput.jobId}-retry`;
  const prepRetry = await prepareSquashMerge({
    projectPath,
    featureBranch: loserInput.branch,
    featureSha: loserInput.featureSha,
    targetBranch: "main",
    targetSha: newMainSha,
    message: `squash: ${loserInput.branch} (retry)`,
    jobId: prepRetryJobId,
  });
  if (prepRetry.kind !== "prepared") {
    return {
      pass: false,
      notes: [...notes, `retry prepare unexpected: ${prepRetry.kind}`],
    };
  }
  ok(`retry prepare ok preparedSha=${prepRetry.preparedSha}`);

  const checkoutAfter = await discoverTargetCheckout(projectPath, "main");
  const pubRetry = await publishPreparedMerge({
    projectPath,
    targetBranch: "main",
    preparedSha: prepRetry.preparedSha,
    expectedTargetSha: prepRetry.expectedTargetSha,
    parkedRef: prepRetry.parkedRef,
    cleanTargetWorktreePath:
      checkoutAfter.kind === "clean" ? checkoutAfter.worktreePath : null,
  });
  info(`retry publish → ${pubRetry.kind}`);
  if (pubRetry.kind !== "published") {
    return {
      pass: false,
      notes: [...notes, `retry publish unexpected: ${pubRetry.kind}`],
    };
  }
  ok(`retry published mergeHash=${pubRetry.mergeHash}`);

  // Clean up the stale parked ref left from the original losing publish.
  if (await refExists(projectPath, losing.parkedRef)) {
    info(
      `(stale parkedRef ${losing.parkedRef} retained from cas-lost — design states it is intentionally retained for caller to decide)`,
    );
  }

  await rm(projectPath, { recursive: true, force: true });
  return { pass: true, notes };
}

async function main(): Promise<void> {
  const scenario = process.argv[2] ?? "all";
  const results: Record<string, { pass: boolean; notes: string[] }> = {};

  if (scenario === "happy-path" || scenario === "all") {
    results["happy-path"] = await scenarioHappyPath();
  }
  if (scenario === "dirty-main" || scenario === "all") {
    results["dirty-main"] = await scenarioDirtyMain();
  }
  if (scenario === "concurrent" || scenario === "all") {
    results["concurrent"] = await scenarioConcurrent();
  }

  console.log("\n=== SUMMARY ===");
  for (const [name, result] of Object.entries(results)) {
    console.log(`${result.pass ? "PASS" : "FAIL"}  ${name}`);
    for (const note of result.notes) console.log(`  ${note}`);
  }

  const allPass = Object.values(results).every((r) => r.pass);
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error("FATAL", err);
  process.exit(2);
});
