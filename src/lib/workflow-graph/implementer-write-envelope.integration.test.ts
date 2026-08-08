/**
 * R6.1/R6.2 — the implementer write envelope along the REAL dispatch path.
 *
 * The path an implementer turn actually takes is the CONVERSATION path, not the
 * task path the validator lanes use, so this starts where an implementer turn
 * starts — `implementerRunner.runIteration` — and follows the policy to the two
 * places it has to survive to:
 *
 *  - the NEUTRAL boundary: the `PromptStreamOptions` the runner composes. This
 *    is where a policy's absence would be invisible, because absent means
 *    unrestricted everywhere downstream;
 *  - the PROVIDER boundary: the options the real Claude and Codex conversation
 *    runtimes hand their SDKs. That is where "CC believes it confined the lane"
 *    turns into "the backend was actually asked to".
 *
 * Only the provider SDKs are substituted — no turn needs to reach a model. The
 * composer, the runner, the runtimes, and both translations are production
 * code. What the OPERATING SYSTEM then does about the delivered policy is a
 * different claim, proven against the real installed CLIs in
 * `implementer-write-envelope-enforcement.live.test.ts`.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const claudeQueryMock = vi.hoisted(() => vi.fn());
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: claudeQueryMock }));
vi.mock("@/lib/shared/sdk-env", () => ({}));

/** The `ThreadOptions` and `CodexOptions` the fake Codex SDK was constructed with. */
const codexCapture = vi.hoisted(() => ({
  options: undefined as unknown,
  threadOptions: undefined as unknown,
}));

vi.mock("@openai/codex-sdk", () => ({
  Codex: class {
    constructor(options: unknown) {
      codexCapture.options = options;
    }
    startThread(threadOptions: unknown) {
      codexCapture.threadOptions = threadOptions;
      return {
        id: "thread-1",
        runStreamed: () =>
          Promise.resolve({
            events: (async function* () {
              yield {
                type: "item.completed",
                item: { id: "item-1", type: "agent_message", text: "done" },
              };
              yield {
                type: "turn.completed",
                usage: {
                  input_tokens: 1,
                  cached_input_tokens: 0,
                  output_tokens: 1,
                },
              };
            })(),
          }),
      };
    }
    resumeThread(id: string) {
      return this.startThread({ resumed: id });
    }
  },
}));

import type { FsWritePolicy } from "@/lib/agent-backends/task";
import type { ContextPlacement } from "@/lib/workflow-graph/definition-schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import { getConversationBackendFactory } from "@/lib/agent-backends/registry";
import { sessionConversationTarget } from "@/lib/conversations/conversation-target";
import { createGraphWorkflowImplementerRunner } from "./implementer-runner";
import { composeImplementerLaneWriteEnvelope } from "./implementer-lane-write-envelope";

let fixtureRoot: string;
let worktreePath: string;
let scratchRootDir: string;

const OWNED_PATHS = ["src/lib/workflow-graph", "docs/adr"] as const;

function makeSession(): SessionState {
  return {
    sessionName: "envelope-session",
    worktreePath,
    branchName: "csm/envelope",
    createdAt: new Date(0).toISOString(),
    lastActivityAt: new Date(0).toISOString(),
    archived: false,
    finished: false,
    conversations: [],
  } as unknown as SessionState;
}

/**
 * Drive the real runner and return the options it composed. The prompt-stream
 * seam is the runner's OWN boundary — everything the acceptance criterion is
 * about (composition, ordering, fail-closed) happens before it.
 */
async function runIterationCapturingOptions(
  placement: ContextPlacement,
  backend: AgentBackendId = "claude",
): Promise<{
  fsWritePolicy: FsWritePolicy | undefined;
  prompt: string;
}> {
  let captured: { fsWritePolicy?: FsWritePolicy } | undefined;
  let prompt = "";
  const runner = createGraphWorkflowImplementerRunner({
    executePromptStream: async (
      _projectPath,
      _session,
      promptText,
      _emit,
      conversationId,
      _model,
      _images,
      options,
    ) => {
      captured = options as { fsWritePolicy?: FsWritePolicy };
      prompt = promptText;
      return {
        conversationId: conversationId ?? "conversation-1",
        contextTokens: null,
        contextWindowMax: null,
        compacted: false,
        error: null,
        aborted: false,
      } as never;
    },
    getConversation: (async () => null) as never,
    mintLaneCapability: () => null,
    composeWriteEnvelope: (input) =>
      composeImplementerLaneWriteEnvelope(input, { scratchRootDir }),
  });

  await runner.runIteration({
    projectPath: "/repo",
    session: makeSession(),
    prompt: "Implement the context",
    conversationId: "conversation-1",
    executionId: "execution-1",
    contextId: "context-build",
    backend,
    model: "opus",
    reasoningEffort: "high",
    toolServer: { servers: [] },
    placement,
  });

  return { fsWritePolicy: captured?.fsWritePolicy, prompt };
}

beforeEach(() => {
  claudeQueryMock.mockReset();
  claudeQueryMock.mockImplementation(() => ({
    [Symbol.asyncIterator]: async function* () {},
    interrupt: vi.fn(),
    setPermissionMode: vi.fn(),
    applyFlagSettings: vi.fn(),
    reloadPlugins: vi.fn(),
    mcpServerStatus: vi.fn(),
  }));
  codexCapture.options = undefined;
  codexCapture.threadOptions = undefined;

  fixtureRoot = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "cc-implementer-envelope-int-")),
  );
  worktreePath = path.join(fixtureRoot, "worktree");
  scratchRootDir = path.join(fixtureRoot, "scratch");
  mkdirSync(path.join(worktreePath, "src", "lib", "workflow-graph"), {
    recursive: true,
  });
  mkdirSync(path.join(worktreePath, "docs", "adr"), { recursive: true });
  mkdirSync(path.join(worktreePath, "src", "components"), { recursive: true });
  writeFileSync(path.join(worktreePath, "README.md"), "# fixture\n");
});

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("the implementer dispatch path composes the envelope before dispatching", () => {
  // Per backend, because `backend` is an input to the very call that composes:
  // a composition gated on a backend — or a briefing rendered for one and not
  // the other — would leave the unproven backend dispatching unconfined.
  for (const backend of ["claude", "codex"] as const) {
    it(`carries an owning context's policy onto the turn options (${backend})`, async () => {
      const { fsWritePolicy } = await runIterationCapturingOptions(
        {
          lane: "build",
          mode: "owned",
          ownedPaths: [...OWNED_PATHS],
        },
        backend,
      );

      const canonicalRoot = realpathSync(worktreePath);
      expect(fsWritePolicy?.allowWrite).toContain(
        path.join(canonicalRoot, "src", "lib", "workflow-graph"),
      );
      expect(fsWritePolicy?.allowWrite).toContain(
        path.join(canonicalRoot, "docs", "adr"),
      );
      expect(fsWritePolicy?.allowWrite).not.toContain(canonicalRoot);
      expect(fsWritePolicy?.denyWrite).toEqual([
        path.join(canonicalRoot, ".git"),
      ]);
      // The unowned sibling is the case ownership exists to isolate; it must
      // not be reachable through any allow entry.
      for (const allowed of fsWritePolicy?.allowWrite ?? []) {
        expect(
          path.join(canonicalRoot, "src", "components").startsWith(allowed),
        ).toBe(false);
      }
    });
  }

  it("carries a read-only context's policy, allowing no repository path at all", async () => {
    const { fsWritePolicy } = await runIterationCapturingOptions({
      lane: "session",
      mode: "readOnly",
    });

    const canonicalRoot = realpathSync(worktreePath);
    for (const allowed of fsWritePolicy?.allowWrite ?? []) {
      const insideRepo =
        allowed.startsWith(`${canonicalRoot}${path.sep}`) ||
        allowed === canonicalRoot;
      // The one exception is the injected payload directory, which is inside
      // the repo by construction and git-ignored. Its final segment is the
      // escaped context id, so the check is on its parent namespace.
      expect(insideRepo).toBe(
        path.dirname(allowed) === path.join(canonicalRoot, ".cc", "temp"),
      );
    }
  });

  it("leaves a full-access context unconfined, because it holds its lane alone", async () => {
    const { fsWritePolicy } = await runIterationCapturingOptions({
      lane: "build",
      mode: "full",
    });

    expect(fsWritePolicy).toBeUndefined();
  });

  // Codex runs an enveloped turn with its cwd moved OUT of the worktree (D6),
  // so the absolute repository path in this briefing is the only way it can
  // reach the repository at all.
  for (const backend of ["claude", "codex"] as const) {
    it(`tells the agent where the repository and its payload directory are (${backend})`, async () => {
      const { prompt } = await runIterationCapturingOptions(
        {
          lane: "build",
          mode: "owned",
          ownedPaths: [...OWNED_PATHS],
        },
        backend,
      );

      const canonicalRoot = realpathSync(worktreePath);
      expect(prompt).toContain(canonicalRoot);
      expect(prompt).toContain(
        path.join(canonicalRoot, ".cc", "temp", "context-build"),
      );
      expect(prompt).toContain("Implement the context");
    });
  }

  // The charter requires enforcement to be GATED on the declared capability,
  // not merely attempted: a backend whose adapter cannot natively confine writes
  // must be refused before dispatch rather than discovered afterwards.
  it("refuses an owning turn on a backend that does not declare enforced confinement", async () => {
    let dispatched = false;
    let composed = false;
    const runner = createGraphWorkflowImplementerRunner({
      executePromptStream: (async () => {
        dispatched = true;
        throw new Error("dispatched to a backend that cannot confine writes");
      }) as never,
      getConversation: (async () => null) as never,
      mintLaneCapability: () => null,
      composeWriteEnvelope: (input) => {
        composed = true;
        return composeImplementerLaneWriteEnvelope(input, { scratchRootDir });
      },
      conversationFsWriteRestriction: () => "unsupported",
    });

    await expect(
      runner.runIteration({
        projectPath: "/repo",
        session: makeSession(),
        prompt: "Implement the context",
        conversationId: "conversation-1",
        executionId: "execution-1",
        contextId: "context-build",
        backend: "claude",
        model: "opus",
        reasoningEffort: "high",
        toolServer: { servers: [] },
        placement: {
          lane: "build",
          mode: "owned",
          ownedPaths: [...OWNED_PATHS],
        },
      }),
    ).rejects.toThrow(/cannot mechanically confine|fsWriteRestriction/i);
    expect(dispatched).toBe(false);
    // Refused on the DECLARATION, before any envelope work.
    expect(composed).toBe(false);
  });

  it("dispatches a read-only turn only on a backend that declares enforced confinement", async () => {
    let dispatched = false;
    const runner = createGraphWorkflowImplementerRunner({
      executePromptStream: (async () => {
        dispatched = true;
        throw new Error("dispatched to a backend that cannot confine writes");
      }) as never,
      getConversation: (async () => null) as never,
      mintLaneCapability: () => null,
      composeWriteEnvelope: (input) =>
        composeImplementerLaneWriteEnvelope(input, { scratchRootDir }),
      conversationFsWriteRestriction: () => "unsupported",
    });

    await expect(
      runner.runIteration({
        projectPath: "/repo",
        session: makeSession(),
        prompt: "Implement the context",
        conversationId: "conversation-1",
        executionId: "execution-1",
        contextId: "context-build",
        backend: "codex",
        model: "gpt",
        reasoningEffort: "high",
        toolServer: { servers: [] },
        placement: { lane: "session", mode: "readOnly" },
      }),
    ).rejects.toThrow(/cannot mechanically confine|fsWriteRestriction/i);
    expect(dispatched).toBe(false);
  });

  for (const backend of ["claude", "codex"] as const) {
    it(`fails the turn as an infrastructure outcome when the envelope cannot be composed (${backend})`, async () => {
      let dispatched = false;
      const runner = createGraphWorkflowImplementerRunner({
        executePromptStream: (async () => {
          dispatched = true;
          throw new Error("dispatched despite an unestablishable envelope");
        }) as never,
        getConversation: (async () => null) as never,
        mintLaneCapability: () => null,
        composeWriteEnvelope: () => {
          throw new Error("worktree root is unresolvable");
        },
      });

      await expect(
        runner.runIteration({
          projectPath: "/repo",
          session: makeSession(),
          prompt: "Implement the context",
          conversationId: "conversation-1",
          executionId: "execution-1",
          contextId: "context-build",
          backend,
          model: "opus",
          reasoningEffort: "high",
          toolServer: { servers: [] },
          placement: { lane: "build", mode: "owned", ownedPaths: ["src"] },
        }),
      ).rejects.toThrow(/implementer write envelope/i);
      // Fail-closed means the turn never reached the backend at all — a throw
      // raised AFTER dispatch would already have run the agent unconfined.
      expect(dispatched).toBe(false);
    });
  }
});

/** The registered factory, resolved through the backend seam. */
function conversationFactory(backend: "claude" | "codex") {
  const factory = getConversationBackendFactory(backend);
  if (!factory) throw new Error(`No conversation factory for ${backend}`);
  return factory;
}

describe("both conversation runtimes establish the delivered policy natively", () => {
  function policyFor(): FsWritePolicy {
    return composeImplementerLaneWriteEnvelope(
      {
        executionId: "execution-1",
        contextId: "context-build",
        worktreePath,
        ownedPaths: [...OWNED_PATHS],
      },
      { scratchRootDir },
    ).policy;
  }

  function createInput(fsWritePolicy: FsWritePolicy | undefined) {
    return {
      conversationId: "conversation-1",
      projectPath: "/repo",
      projectName: "repo",
      conversationTarget: sessionConversationTarget(
        "repo",
        "envelope-session",
        "conversation-1",
      ),
      worktreePath,
      persistedRef: null,
      modelId: undefined,
      sessionInstructions: [],
      tooling: { portableMcp: { servers: [] } },
      ...(fsWritePolicy !== undefined ? { fsWritePolicy } : {}),
    } as never;
  }

  it("claude sandboxes exactly the allowlist and denies .git", async () => {
    const policy = policyFor();

    await conversationFactory("claude").createRuntime(createInput(policy));

    const sdkOptions = claudeQueryMock.mock.calls[0]?.[0]?.options;
    expect(sdkOptions.permissionMode).toBe("dontAsk");
    expect(sdkOptions.allowDangerouslySkipPermissions).toBeUndefined();
    expect(sdkOptions.sandbox.enabled).toBe(true);
    expect(sdkOptions.sandbox.failIfUnavailable).toBe(true);
    expect(sdkOptions.sandbox.allowUnsandboxedCommands).toBe(false);
    expect(sdkOptions.sandbox.filesystem.allowWrite).toEqual(policy.allowWrite);
    expect(sdkOptions.sandbox.filesystem.denyWrite).toEqual(policy.denyWrite);
  });

  it("claude path-scopes the file-mutation tools to the owned prefixes and denies them on .git", async () => {
    const policy = policyFor();
    const canonicalRoot = realpathSync(worktreePath);

    await conversationFactory("claude").createRuntime(createInput(policy));

    const permissions =
      claudeQueryMock.mock.calls[0]?.[0]?.options?.settings?.permissions;
    expect(permissions.defaultMode).toBe("dontAsk");
    for (const tool of ["Edit", "Write", "NotebookEdit"]) {
      expect(permissions.allow).toContain(
        `${tool}(//${path.join(canonicalRoot, "src", "lib", "workflow-graph")}/**)`,
      );
      expect(permissions.deny).toContain(
        `${tool}(//${path.join(canonicalRoot, ".git")}/**)`,
      );
      // Nothing pre-approves the tool wholesale; a rule outside the allowlist
      // would make every path-scoped rule above decorative.
      expect(permissions.allow).not.toContain(tool);
    }
    // An unowned sibling directory is not reachable by any allow rule.
    expect(
      permissions.allow.some((rule: string) =>
        rule.includes(path.join(canonicalRoot, "src", "components")),
      ),
    ).toBe(false);
  });

  // The Claude sandbox's DEFAULT writable set is the working directory and its
  // subdirectories, and `allowWrite` only adds paths OUTSIDE it — it is not an
  // exclusive allowlist. A run left in the worktree is therefore writable
  // throughout the worktree no matter what the allowlist says, which would make
  // every owned-prefix rule above decorative. Denying the worktree instead is
  // not available: `checkFsWritePolicy` refuses a policy whose allow entry sits
  // inside a denied path, so the working root has to move, exactly as Codex's
  // `workspace-write` translation already moves it.
  it("claude moves the run out of the worktree, onto the policy's working root", async () => {
    const policy = policyFor();

    await conversationFactory("claude").createRuntime(createInput(policy));

    const sdkOptions = claudeQueryMock.mock.calls[0]?.[0]?.options;
    expect(sdkOptions.cwd).not.toBe(realpathSync(worktreePath));
    expect(sdkOptions.cwd).toBe(policy.allowWrite[0]);
    // Nothing in the worktree may be the working root, or its subdirectories
    // would be writable by default again.
    expect(
      sdkOptions.cwd.startsWith(`${realpathSync(worktreePath)}${path.sep}`),
    ).toBe(false);
  });

  // Claude's sandbox keeps its own SESSION temp directory writable and points
  // sandboxed commands' $TMPDIR at it. Left alone that is a writable path
  // absent from the allowlist, so the envelope binds the session temp to the
  // policy's own tmp entry instead of letting a second one exist.
  it("claude binds its session temp to the policy's tmp directory", async () => {
    const policy = policyFor();
    const policyTmpDir = policy.allowWrite[policy.allowWrite.length - 1];

    await conversationFactory("claude").createRuntime(createInput(policy));

    const env = claudeQueryMock.mock.calls[0]?.[0]?.options?.env;
    expect(env?.CLAUDE_CODE_TMPDIR).toBe(policyTmpDir);
    expect(env?.TMPDIR).toBe(policyTmpDir);
    // The SDK REPLACES the subprocess environment rather than merging it, so
    // the redirect has to extend the session's env contract, not stand in for
    // it: a confined turn that lost PATH would fail for reasons unrelated to
    // confinement.
    expect(env?.PATH).toBeTruthy();
    expect(env?.CLAUDE_CODE_TMPDIR).not.toBe(env?.PATH);
  });

  it("claude leaves the ambient temp alone for an unconfined conversation", async () => {
    await conversationFactory("claude").createRuntime(createInput(undefined));

    const env = claudeQueryMock.mock.calls[0]?.[0]?.options?.env;
    // The redirect is part of the envelope, not a global change of behaviour.
    expect(env?.CLAUDE_CODE_TMPDIR).toBeUndefined();
  });

  it("claude keeps the implementer's toolbox while confining its writes", async () => {
    await conversationFactory("claude").createRuntime(createInput(policyFor()));

    const permissions =
      claudeQueryMock.mock.calls[0]?.[0]?.options?.settings?.permissions;
    for (const tool of ["Bash", "Read", "Task", "Skill"]) {
      expect(permissions.allow).toContain(tool);
    }
  });

  it("claude leaves an unrestricted conversation on the bypass path", async () => {
    await conversationFactory("claude").createRuntime(createInput(undefined));

    const sdkOptions = claudeQueryMock.mock.calls[0]?.[0]?.options;
    expect(sdkOptions.permissionMode).toBe("bypassPermissions");
    expect(sdkOptions.sandbox).toBeUndefined();
  });

  it("codex enumerates the writable roots and moves the run out of the worktree", async () => {
    const policy = policyFor();
    const runtime = await conversationFactory("codex").createRuntime(
      createInput(policy),
    );

    await runtime.sendTurn({
      promptText: "go",
      imageRefs: [],
      sessionInstructions: [],
      autonomous: true,
      signal: new AbortController().signal,
      onEvent: () => {},
    });

    const threadOptions = codexCapture.threadOptions as {
      sandboxMode: string;
      workingDirectory: string;
    };
    const config = (codexCapture.options as { config: Record<string, unknown> })
      .config;
    expect(threadOptions.sandboxMode).toBe("workspace-write");
    // `workspace-write` makes the working directory writable by construction,
    // so a run left in the worktree would be writable throughout it.
    expect(threadOptions.workingDirectory).not.toBe(realpathSync(worktreePath));
    expect(threadOptions.workingDirectory).toBe(policy.allowWrite[0]);
    expect(config["sandbox_workspace_write"]).toEqual({
      writable_roots: policy.allowWrite,
      exclude_tmpdir_env_var: true,
      exclude_slash_tmp: true,
    });
  });

  it("codex leaves an unrestricted conversation on full access in the worktree", async () => {
    const runtime = await conversationFactory("codex").createRuntime(
      createInput(undefined),
    );

    await runtime.sendTurn({
      promptText: "go",
      imageRefs: [],
      sessionInstructions: [],
      autonomous: true,
      signal: new AbortController().signal,
      onEvent: () => {},
    });

    const threadOptions = codexCapture.threadOptions as {
      sandboxMode: string;
      workingDirectory: string;
    };
    expect(threadOptions.sandboxMode).toBe("danger-full-access");
    expect(threadOptions.workingDirectory).toBe(worktreePath);
  });

  it("refuses to create a claude runtime for a policy it cannot establish", async () => {
    // An allow entry inside a denied path is a policy that both permits and
    // forbids one subtree. Establishing it would require guessing which wins.
    await expect(
      conversationFactory("claude").createRuntime(
        createInput({
          mode: "allowlist",
          allowWrite: [path.join(worktreePath, ".git", "hooks")],
          denyWrite: [path.join(worktreePath, ".git")],
        }),
      ),
    ).rejects.toThrow(/write envelope/i);
    expect(claudeQueryMock).not.toHaveBeenCalled();
  });

  it("fails a codex turn for a policy it cannot establish, rather than running it unconfined", async () => {
    const runtime = await conversationFactory("codex").createRuntime(
      createInput({
        mode: "allowlist",
        allowWrite: [],
        denyWrite: [path.join(worktreePath, ".git")],
      }),
    );

    const result = await runtime.sendTurn({
      promptText: "go",
      imageRefs: [],
      sessionInstructions: [],
      autonomous: true,
      signal: new AbortController().signal,
      onEvent: () => {},
    });

    expect(result.failure).not.toBeNull();
    expect(codexCapture.threadOptions).toBeUndefined();
  });
});
