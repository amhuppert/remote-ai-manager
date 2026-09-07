import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { ConversationTarget } from "@/lib/conversations/conversation-target";
import { buildChildEnv } from "@/lib/shared/child-env";
import type { BackendModelSelection } from "../../schemas";
import { CURSOR_DEFAULT_MODEL } from "../model-policy";
import {
  createCursorPackageProbe,
  runCursorStaticPreflight,
} from "../preflight";
import type {
  CursorAttachInput,
  CursorTurnInput,
  CursorWorkerCloseOutcome,
  CursorWorkerExitInfo,
  CursorWorkerSession,
  CursorWorkerStartResult,
  CursorWorkerTransport,
} from "../worker-port";
import type { CursorWorkerFrame } from "../worker/ipc";
import { createCursorProcessHost } from "../worker/process-host";
import {
  createCursorWorkerSupervisor,
  cursorWorkerScriptPath,
  type CursorSupervisorBounds,
} from "../worker/supervisor";

/**
 * The live-worker fixture behind every authenticated acceptance case
 * (spec R14.2, D19).
 *
 * It composes the PRODUCTION supervisor, the production worker bundle and the
 * real `@cursor/sdk` — only the things an acceptance case must vary are
 * injected: the credential (so the preflight taxonomy can supply an absent or
 * invalid one), the teardown bounds (so a cancellation case can measure against
 * a bound rather than wait five minutes), and the workspace root. Anything
 * further from production than that would make the evidence describe the
 * fixture instead of the adapter.
 *
 * Every conversation gets its own git repository as a cwd and its own store,
 * both under the git-ignored evidence root. A real repository is what makes the
 * "Cursor created no nested worktree" claim checkable, and keeping it out of the
 * Command Center worktree is what keeps a live agent from writing into the tree
 * under review.
 */

export interface LiveConversationOptions {
  conversationId?: string;
  sessionName?: string;
  modelSelection: BackendModelSelection;
  /** Reuse an existing workspace — the restart and cross-cwd ref cases need
   *  to control whether a resume sees the same cwd and store. */
  workspace?: LiveWorkspace;
}

export const CURSOR_ACCEPTANCE_MODEL_SELECTION = {
  modelId: CURSOR_DEFAULT_MODEL,
  parameters: { fast: "true" },
} as const satisfies BackendModelSelection;

export interface LiveWorkspace {
  name: string;
  cwd: string;
  storePath: string;
}

export interface LiveConversation {
  readonly conversationId: string;
  /** The Command Center session identity this conversation's worker carries.
   *  Exposed directly because `target` is a scope union and every acceptance
   *  case here is session-scoped. */
  readonly sessionName: string;
  readonly workspace: LiveWorkspace;
  readonly target: ConversationTarget;
  readonly session: CursorWorkerSession;
  readonly frames: readonly CursorWorkerFrame[];
  readonly exits: readonly CursorWorkerExitInfo[];
  attach(input: CursorAttachInput): void;
  startTurn(input: CursorTurnInput): void;
  cancel(runId: string): void;
  close(): Promise<CursorWorkerCloseOutcome>;
}

export interface LiveHarness {
  readonly transport: CursorWorkerTransport;
  readonly root: string;
  createWorkspace(name: string): LiveWorkspace;
  start(options: LiveConversationOptions): Promise<CursorWorkerStartResult>;
  /** Starts and requires `ready`, so a case that is not about start failure
   *  reads as one assertion rather than a result-kind ladder. */
  startReady(options: LiveConversationOptions): Promise<LiveConversation>;
  closeAll(): Promise<void>;
}

export interface LiveHarnessOptions {
  /** Null and "" reach the supervisor exactly as a missing server credential
   *  would; an arbitrary string reaches the SDK as an invalid one. */
  credential: string | null;
  evidenceRoot: string;
  bounds?: Partial<CursorSupervisorBounds>;
  /** Overrides the production bundle path — the only reason is to prove a
   *  spawn failure, never to run a different worker. */
  workerScriptPath?: string;
}

/** Frame types the fixture exposes as awaitable settlement points. */
export type LiveFrameType = CursorWorkerFrame["type"];

export function frameOfType<TType extends LiveFrameType>(
  frames: readonly CursorWorkerFrame[],
  type: TType,
): Extract<CursorWorkerFrame, { type: TType }> | undefined {
  return frames.find(
    (frame): frame is Extract<CursorWorkerFrame, { type: TType }> =>
      frame.type === type,
  );
}

export function framesOfType<TType extends LiveFrameType>(
  frames: readonly CursorWorkerFrame[],
  type: TType,
): readonly Extract<CursorWorkerFrame, { type: TType }>[] {
  return frames.filter(
    (frame): frame is Extract<CursorWorkerFrame, { type: TType }> =>
      frame.type === type,
  );
}

export async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 50,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate();
}

/**
 * A git repository, because the private-state criterion asks whether Cursor
 * created a nested worktree — a question only a real repository can answer.
 */
function initWorkspaceRepository(cwd: string): void {
  execFileSync("git", ["init", "--initial-branch=main", "--quiet"], {
    cwd,
    stdio: "pipe",
  });
  execFileSync("git", ["config", "user.email", "acceptance@example.com"], {
    cwd,
    stdio: "pipe",
  });
  execFileSync("git", ["config", "user.name", "Cursor Acceptance"], {
    cwd,
    stdio: "pipe",
  });
}

export function createLiveHarness(options: LiveHarnessOptions): LiveHarness {
  const root = path.join(options.evidenceRoot, "workspaces");
  mkdirSync(root, { recursive: true, mode: 0o700 });

  const transport: CursorWorkerTransport = createCursorWorkerSupervisor({
    host: createCursorProcessHost(),
    runStaticPreflight: (input) =>
      runCursorStaticPreflight(input, {
        packages: createCursorPackageProbe(
          path.join(process.cwd(), "node_modules"),
        ),
        host: { platform: process.platform, arch: process.arch },
        workerNodeVersion: async () => process.version,
      }),
    readCredential: () => options.credential,
    workerScriptPath: options.workerScriptPath
      ? () => {
          const configured = options.workerScriptPath;
          if (configured === undefined) throw new Error("unreachable");
          return configured;
        }
      : cursorWorkerScriptPath,
    workerExecArgv: () => [],
    buildChildEnv,
    // No server reachable from the suite: the worker's cctl environment is
    // built the same way, it just points at nothing. Nothing in the matrix
    // asks the worker to call back into Command Center.
    getServerUrl: () => null,
    getApiToken: () => null,
    getConfigDir: () => path.join(options.evidenceRoot, "config"),
    newWorkerId: () => randomUUID(),
    ...(options.bounds !== undefined ? { bounds: options.bounds } : {}),
  });

  function createWorkspace(name: string): LiveWorkspace {
    const cwd = path.join(root, name, "workspace");
    const storePath = path.join(root, name, "store");
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    mkdirSync(storePath, { recursive: true, mode: 0o700 });
    initWorkspaceRepository(cwd);
    return { name, cwd, storePath };
  }

  const started: LiveConversation[] = [];

  async function start(
    conversationOptions: LiveConversationOptions,
  ): Promise<CursorWorkerStartResult> {
    const conversationId = conversationOptions.conversationId ?? randomUUID();
    const sessionName =
      conversationOptions.sessionName ?? `acceptance-${conversationId}`;
    const workspace =
      conversationOptions.workspace ?? createWorkspace(sessionName);
    const target: ConversationTarget = {
      scope: "session",
      projectName: "cursor-acceptance",
      sessionName,
      conversationId,
    };

    const frames: CursorWorkerFrame[] = [];
    const exits: CursorWorkerExitInfo[] = [];

    const result = await transport.start({
      conversationId,
      target,
      cwd: workspace.cwd,
      storePath: workspace.storePath,
      modelSelection: conversationOptions.modelSelection,
      ownerToken: {},
      onFrame: (frame) => frames.push(frame),
      onExit: (info) => exits.push(info),
    });

    if (result.kind === "ready" || result.kind === "already_active") {
      const { session } = result;
      started.push({
        conversationId,
        sessionName,
        workspace,
        target,
        session,
        frames,
        exits,
        attach: (input) => session.attach(input),
        startTurn: (input) => session.startTurn(input),
        cancel: (runId) => session.cancel(runId),
        close: () => session.close(),
      });
    }
    return result;
  }

  return {
    transport,
    root,
    createWorkspace,
    start,

    async startReady(conversationOptions) {
      const result = await start(conversationOptions);
      if (result.kind !== "ready") {
        throw new Error(
          `expected a ready Cursor worker, received ${result.kind}${
            "message" in result ? `: ${result.message}` : ""
          }`,
        );
      }
      const live = started.at(-1);
      if (live === undefined)
        throw new Error("unreachable: ready without a record");
      return live;
    },

    async closeAll() {
      await transport.closeAll();
    },
  };
}
