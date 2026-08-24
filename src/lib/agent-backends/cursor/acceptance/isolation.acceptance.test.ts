import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CURSOR_DEFAULT_MODEL } from "../model-policy";
import { ambientCredentialKeys } from "../worker/credential-env";
import type { CredentialSecret } from "./credential-scan";
import {
  readFileTreeSources,
  readProcessEnvironSource,
  scanForCredentials,
} from "./credential-scan";
import { readProcessCwd } from "./process-scan";
import {
  resolveAcceptanceEvidenceRoot,
  type AcceptanceEvidenceStore,
} from "./evidence";
import { captureProcessBoundaries } from "./harness";
import { openAcceptanceEvidence } from "./harness";
import {
  createLiveHarness,
  frameOfType,
  waitUntil,
  type LiveConversation,
  type LiveHarness,
} from "./live-worker";

/**
 * Two authenticated conversations at once (spec R4.1, R4.3, R14.2).
 *
 * Command Center runs conversations side by side, so the isolation claim is
 * not "a worker is a separate process" but "two live workers share nothing
 * that could leak one conversation into the other" — process, process group,
 * workspace, store, continuation ref, and the Command Center session identity
 * its environment carries. The parent's own environment is compared before and
 * after, because a supervisor that mutated it to pass something down would
 * make every later conversation on that server observe it.
 */

/** Keys the fixture asserts the supervisor never mutates on the parent. */
const CONTROLLED_PARENT_KEYS = [
  "CURSOR_API_KEY",
  "CC_SESSION",
  "CC_PROJECT",
  "CC_CONVERSATION_ID",
  "CC_SERVER_URL",
  "CC_API_TOKEN",
  "PATH",
  "HOME",
  "PWD",
] as const;

function snapshotParentEnv(): string {
  return JSON.stringify(
    CONTROLLED_PARENT_KEYS.map((key) => [key, process.env[key] ?? null]),
  );
}

async function readWorkerEnv(pid: number): Promise<Map<string, string>> {
  const { records } = await readProcessEnvironSource(pid);
  const entries = new Map<string, string>();
  for (const record of records) {
    const separator = record.indexOf("=");
    if (separator <= 0) continue;
    entries.set(record.slice(0, separator), record.slice(separator + 1));
  }
  return entries;
}

/** The CC identity keys a worker's environment carries for its conversation. */
function ccIdentity(env: Map<string, string>): Record<string, string> {
  const identity: Record<string, string> = {};
  for (const [key, value] of env) {
    if (key.startsWith("CC_")) identity[key] = value;
  }
  return identity;
}

let store: AcceptanceEvidenceStore;
let secret: CredentialSecret;
let harness: LiveHarness;
let first: LiveConversation;
let second: LiveConversation;
let firstEnv: Map<string, string>;
let secondEnv: Map<string, string>;
let firstCwd: string | null;
let secondCwd: string | null;
let parentEnvBefore: string;
let parentEnvAfter: string;

beforeAll(async () => {
  ({ store, secret } = await openAcceptanceEvidence(process.env));
  parentEnvBefore = snapshotParentEnv();

  harness = createLiveHarness({
    credential: secret.value,
    evidenceRoot: resolveAcceptanceEvidenceRoot(process.env),
  });

  // Started together, not one after the other: the claim is about two workers
  // that are alive at the same moment.
  [first, second] = await Promise.all([
    harness.startReady({
      sessionName: "isolation-a",
      model: CURSOR_DEFAULT_MODEL,
    }),
    harness.startReady({
      sessionName: "isolation-b",
      model: CURSOR_DEFAULT_MODEL,
    }),
  ]);

  for (const live of [first, second]) {
    live.attach({
      mode: "create",
      ref: null,
      model: CURSOR_DEFAULT_MODEL,
      mcpServers: {},
    });
  }
  expect(
    await waitUntil(
      () =>
        frameOfType(first.frames, "refIssued") !== undefined &&
        frameOfType(second.frames, "refIssued") !== undefined,
      90_000,
    ),
    "both conversations did not attach",
  ).toBe(true);

  [firstEnv, secondEnv] = await Promise.all([
    readWorkerEnv(first.session.pid),
    readWorkerEnv(second.session.pid),
  ]);
  firstCwd = readProcessCwd(first.session.pid);
  secondCwd = readProcessCwd(second.session.pid);
  parentEnvAfter = snapshotParentEnv();
});

afterAll(async () => {
  await harness?.closeAll();
});

describe("two simultaneous authenticated Cursor conversations", () => {
  it("runs in distinct processes and distinct process groups", () => {
    expect(first.session.pid).not.toBe(second.session.pid);
    const firstReady = frameOfType(first.frames, "ready");
    const secondReady = frameOfType(second.frames, "ready");
    expect(firstReady?.pgid).toBeDefined();
    expect(firstReady?.pgid).not.toBe(secondReady?.pgid);
    // Each worker leads its own group, which is what makes group-scoped
    // teardown able to take one conversation's tools without touching another's.
    expect(firstReady?.pgid).toBe(first.session.pid);
    expect(secondReady?.pgid).toBe(second.session.pid);
  });

  it("runs in distinct workspaces and distinct stores", () => {
    expect(first.workspace.storePath).not.toBe(second.workspace.storePath);
    // The OS's view of each worker's working directory, not the configured
    // value: `PWD` is inherited from the parent and says nothing about where a
    // process actually is, which is what a tool call would resolve against.
    expect(firstCwd).toBe(first.workspace.cwd);
    expect(secondCwd).toBe(second.workspace.cwd);
    expect(firstCwd).not.toBe(secondCwd);
  });

  it("holds distinct continuation refs", () => {
    const firstRef = frameOfType(first.frames, "refIssued")?.ref;
    const secondRef = frameOfType(second.frames, "refIssued")?.ref;
    expect(firstRef).toBeTruthy();
    expect(secondRef).toBeTruthy();
    expect(firstRef).not.toBe(secondRef);
  });

  it("carries distinct Command Center session identities", () => {
    const firstIdentity = ccIdentity(firstEnv);
    const secondIdentity = ccIdentity(secondEnv);
    expect(Object.keys(firstIdentity).length).toBeGreaterThan(0);
    expect(firstIdentity).not.toEqual(secondIdentity);
    expect(firstIdentity["CC_SESSION"]).not.toBe(secondIdentity["CC_SESSION"]);
  });

  it("lets neither worker observe the other's workspace, store, or identity", () => {
    const firstText = [...firstEnv].map(([k, v]) => `${k}=${v}`).join("\n");
    const secondText = [...secondEnv].map(([k, v]) => `${k}=${v}`).join("\n");

    expect(firstText).not.toContain(second.workspace.cwd);
    expect(firstText).not.toContain(second.workspace.storePath);
    expect(firstText).not.toContain(second.sessionName);
    expect(secondText).not.toContain(first.workspace.cwd);
    expect(secondText).not.toContain(first.workspace.storePath);
    expect(secondText).not.toContain(first.sessionName);
  });

  it("keeps the credential out of every worker environment", () => {
    for (const env of [firstEnv, secondEnv]) {
      expect(env.has("CURSOR_API_KEY")).toBe(false);
    }
    expect(
      scanForCredentials(
        [secret],
        [
          { label: "worker-a/environ", text: [...firstEnv].join("\n") },
          { label: "worker-b/environ", text: [...secondEnv].join("\n") },
        ],
      ),
    ).toEqual([]);
  });

  it("inherits no credential-shaped variable into a worker environment", () => {
    // Stated over the KEY SET rather than by scanning for values: this is the
    // supervisor's own rule read back off a live worker, so a variable that
    // arrived empty — telling the model the name is live — fails here too.
    //
    // CC_API_TOKEN is the one permitted name. It is credential-shaped and it is
    // deliberately PLACED by the session contract rather than inherited, which
    // is what keeps cctl working inside a Cursor session; this suite runs with
    // no server, so it is absent here and the set is empty in practice.
    for (const [label, env] of [
      ["worker-a", firstEnv],
      ["worker-b", secondEnv],
    ] as const) {
      expect(
        ambientCredentialKeys(Object.fromEntries(env)).filter(
          (key) => key !== "CC_API_TOKEN",
        ),
        `${label} inherited a credential-shaped variable from the server`,
      ).toEqual([]);
    }
  });

  it("keeps the credential out of the argv and environment of every process in both worker groups", async () => {
    const firstPgid =
      frameOfType(first.frames, "ready")?.pgid ?? first.session.pid;
    const secondPgid =
      frameOfType(second.frames, "ready")?.pgid ?? second.session.pid;

    const captured = await captureProcessBoundaries({
      store,
      secret,
      label: "isolation-worker-groups",
      pgids: [firstPgid, secondPgid],
    });

    expect(
      captured.pids.length,
      "no live process was read, so this proves nothing",
    ).toBeGreaterThanOrEqual(2);
    expect(
      captured.findings.map((finding) => finding.sourceLabel),
      "the credential reached a worker-group process boundary",
    ).toEqual([]);
    // Scanned on the live bytes for every OTHER credential-shaped variable the
    // server carries too: a worker copies the server environment, so a Cursor
    // conversation must not become the way an unrelated key reaches the model.
    expect(
      captured.ambientFindings.map(
        (finding) => `${finding.sourceLabel} (${finding.secretLabel})`,
      ),
      "a third-party credential reached a worker-group process boundary",
    ).toEqual([]);

    await store.publish({
      caseId: "worker-group-argv-env-scan",
      outcome: "pass",
      metrics: {
        processesScanned: captured.pids.length,
        boundariesScanned: captured.sources.length,
        findings: 0,
        ambientCredentialFindings: 0,
      },
      artifacts: [captured.artifact],
    });
  });

  it("leaves the parent environment byte-for-byte unchanged on controlled keys", () => {
    expect(parentEnvAfter).toBe(parentEnvBefore);
  });

  it("writes transcript-bearing state only where Command Center owns it, owner-only", async () => {
    const stateFiles = await readFileTreeSources(first.workspace.storePath);
    expect(
      stateFiles.length,
      "the conversation wrote no caller-owned state at all",
    ).toBeGreaterThan(0);

    for (const file of stateFiles) {
      const target = path.join(first.workspace.storePath, file.label);
      const mode = statSync(target).mode & 0o777;
      expect(
        mode & 0o077,
        `${file.label} is readable or writable outside its owner (mode ${mode.toString(8)})`,
      ).toBe(0);
    }
  });

  it("creates no nested git worktree in the conversation's repository", () => {
    for (const live of [first, second]) {
      const worktrees = execFileSync(
        "git",
        ["worktree", "list", "--porcelain"],
        {
          cwd: live.workspace.cwd,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const roots = worktrees
        .split("\n")
        .filter((line) => line.startsWith("worktree "));
      expect(roots).toHaveLength(1);
    }
  });

  it("publishes the isolation evidence", async () => {
    const firstReady = frameOfType(first.frames, "ready");
    const secondReady = frameOfType(second.frames, "ready");

    const firstOutcome = await first.close();
    const secondOutcome = await second.close();
    expect(firstOutcome.kind).toBe("verified");
    expect(secondOutcome.kind).toBe("verified");

    await store.publish({
      caseId: "worker-concurrency-isolation",
      outcome: "pass",
      metrics: {
        distinctPids: first.session.pid !== second.session.pid,
        distinctPgids: firstReady?.pgid !== secondReady?.pgid,
        distinctWorkspaces: true,
        distinctStores: true,
        distinctRefs: true,
        distinctCcIdentity: true,
        credentialInWorkerEnv: false,
        parentEnvUnchanged: parentEnvAfter === parentEnvBefore,
        nestedWorktrees: 0,
      },
      artifacts: [],
    });
  });
});
