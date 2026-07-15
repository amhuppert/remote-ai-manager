import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import {
  ARTIFACT_KIND_PATH_RULES,
  artifactKindSchema,
  artifactRecordSchema,
  artifactRequiredFailureName,
  createArtifactRegistry,
  type ArtifactKind,
  type ArtifactRecord,
  type ArtifactRegistryDeps,
} from "./artifact-registry";

const FIXED_NOW = "2026-04-28T12:00:00.000Z";
const SESSION_WORKTREE = "/tmp/cc-session-worktree";

interface RecordedReferenceRegistration {
  worktreePath: string;
  relativePath: string;
  description: string;
  source: { workflowId?: string; laneId?: string; round?: number };
}

interface RecordedSharedDocRegistration {
  worktreePath: string;
  relativePath: string;
  description: string;
  readWhen: string;
}

interface FakeFs {
  written: Array<{ absolutePath: string; contents: string | Uint8Array }>;
  ensured: string[];
  failOnce?: string;
}

function makeFakeFs(): FakeFs {
  return { written: [], ensured: [] };
}

function makeDeps(
  fs: FakeFs,
  overrides: Partial<ArtifactRegistryDeps> = {},
): ArtifactRegistryDeps {
  let idSeq = 0;
  return {
    writeFile: async (absolutePath, contents) => {
      if (fs.failOnce && absolutePath === fs.failOnce) {
        fs.failOnce = undefined;
        throw new Error("disk full");
      }
      fs.written.push({ absolutePath, contents });
    },
    ensureDir: async (absolutePath) => {
      fs.ensured.push(absolutePath);
    },
    now: () => FIXED_NOW,
    newId: () => `art-${++idSeq}`,
    ...overrides,
  };
}

describe("artifactKindSchema", () => {
  it("supports the established artifact kinds", () => {
    const kinds: ArtifactKind[] = [
      "reference_document",
      "focus_memory",
      "codex_output",
      "graph_shared_document",
      "validation_log",
      "workflow_report",
    ];
    for (const k of kinds) {
      expect(artifactKindSchema.safeParse(k).success).toBe(true);
    }
    expect(artifactKindSchema.safeParse("not_a_kind").success).toBe(false);
  });
});

describe("ARTIFACT_KIND_PATH_RULES", () => {
  it("preserves the established canonical locations", () => {
    expect(ARTIFACT_KIND_PATH_RULES.focus_memory.canonicalPath).toBe(
      "memory-bank/focus.md",
    );
    expect(ARTIFACT_KIND_PATH_RULES.codex_output.requiredBaseDir).toBe(
      "memory-bank/codex",
    );
    expect(ARTIFACT_KIND_PATH_RULES.graph_shared_document.requiredBaseDir).toBe(
      ".cc/graph-workflow-docs",
    );
    expect(ARTIFACT_KIND_PATH_RULES.validation_log.requiredBaseDir).toBe(
      ".cc/workflow",
    );
    expect(
      ARTIFACT_KIND_PATH_RULES.reference_document.requiredBaseDir,
    ).toBeUndefined();
    expect(
      ARTIFACT_KIND_PATH_RULES.workflow_report.requiredBaseDir,
    ).toBeUndefined();
  });
});

describe("createArtifactRegistry write — path resolution and traversal rejection", () => {
  let fs: FakeFs;
  beforeEach(() => {
    fs = makeFakeFs();
  });

  it("writes to the canonical focus.md path even if caller passes nothing", async () => {
    const registry = createArtifactRegistry(makeDeps(fs));
    const record = await registry.write({
      kind: "focus_memory",
      worktreePath: SESSION_WORKTREE,
      relativePath: "memory-bank/focus.md",
      contents: "# Focus",
      audience: "user_facing",
      source: { workflowId: "wf-1" },
    });

    expect(record.relativePath).toBe("memory-bank/focus.md");
    expect(fs.written[0]?.absolutePath).toBe(
      path.join(SESSION_WORKTREE, "memory-bank/focus.md"),
    );
  });

  it("rejects focus_memory with a non-canonical relative path", async () => {
    const registry = createArtifactRegistry(makeDeps(fs));
    await expect(
      registry.write({
        kind: "focus_memory",
        worktreePath: SESSION_WORKTREE,
        relativePath: "memory-bank/something-else.md",
        contents: "x",
        audience: "user_facing",
        source: { workflowId: "wf-1" },
      }),
    ).rejects.toThrow(/canonical path/i);
  });

  it("requires codex_output paths under memory-bank/codex", async () => {
    const registry = createArtifactRegistry(makeDeps(fs));
    await expect(
      registry.write({
        kind: "codex_output",
        worktreePath: SESSION_WORKTREE,
        relativePath: "elsewhere/note.md",
        contents: "x",
        audience: "internal_log",
        source: { workflowId: "wf-1" },
      }),
    ).rejects.toThrow(/memory-bank\/codex/);

    const ok = await registry.write({
      kind: "codex_output",
      worktreePath: SESSION_WORKTREE,
      relativePath: "memory-bank/codex/note.md",
      contents: "x",
      audience: "internal_log",
      source: { workflowId: "wf-1" },
    });
    expect(ok.relativePath).toBe("memory-bank/codex/note.md");
  });

  it("requires graph_shared_document paths under .cc/graph-workflow-docs", async () => {
    const registry = createArtifactRegistry(makeDeps(fs));
    await expect(
      registry.write({
        kind: "graph_shared_document",
        worktreePath: SESSION_WORKTREE,
        relativePath: "elsewhere/x.md",
        contents: "x",
        audience: "user_facing",
        source: { workflowId: "wf-1" },
      }),
    ).rejects.toThrow(/\.cc\/graph-workflow-docs/);
  });

  it("rejects absolute paths", async () => {
    const registry = createArtifactRegistry(makeDeps(fs));
    await expect(
      registry.write({
        kind: "reference_document",
        worktreePath: SESSION_WORKTREE,
        relativePath: "/etc/passwd",
        contents: "x",
        audience: "internal_log",
        source: { workflowId: "wf-1" },
      }),
    ).rejects.toThrow(/absolute/i);
  });

  it("rejects relative paths that traverse outside the session worktree", async () => {
    const registry = createArtifactRegistry(makeDeps(fs));
    await expect(
      registry.write({
        kind: "reference_document",
        worktreePath: SESSION_WORKTREE,
        relativePath: "../../../../etc/passwd",
        contents: "x",
        audience: "internal_log",
        source: { workflowId: "wf-1" },
      }),
    ).rejects.toThrow(/outside.*worktree/i);
  });

  it("rejects empty relative paths", async () => {
    const registry = createArtifactRegistry(makeDeps(fs));
    await expect(
      registry.write({
        kind: "reference_document",
        worktreePath: SESSION_WORKTREE,
        relativePath: "",
        contents: "x",
        audience: "internal_log",
        source: { workflowId: "wf-1" },
      }),
    ).rejects.toThrow();
  });
});

describe("createArtifactRegistry write — record metadata", () => {
  it("returns a parsed ArtifactRecord with shallow source metadata", async () => {
    const fs = makeFakeFs();
    const registry = createArtifactRegistry(makeDeps(fs));

    const record = await registry.write({
      kind: "validation_log",
      worktreePath: SESSION_WORKTREE,
      relativePath: ".cc/workflow/exec-1/pre-merge-2026.log",
      contents: "log body",
      audience: "internal_log",
      source: { workflowId: "wf-1", laneId: "implementer", round: 2 },
    });

    expect(artifactRecordSchema.safeParse(record).success).toBe(true);
    const parsed: ArtifactRecord = artifactRecordSchema.parse(record);
    expect(parsed.kind).toBe("validation_log");
    expect(parsed.audience).toBe("internal_log");
    expect(parsed.relativePath).toBe(".cc/workflow/exec-1/pre-merge-2026.log");
    expect(parsed.source.workflowId).toBe("wf-1");
    expect(parsed.source.laneId).toBe("implementer");
    expect(parsed.source.round).toBe(2);
    expect(parsed.source.createdAt).toBe(FIXED_NOW);
    expect(parsed.artifactId).toMatch(/^art-/);
  });

  it("ensures the parent directory exists before writing", async () => {
    const fs = makeFakeFs();
    const registry = createArtifactRegistry(makeDeps(fs));

    await registry.write({
      kind: "codex_output",
      worktreePath: SESSION_WORKTREE,
      relativePath: "memory-bank/codex/sub/file.md",
      contents: "x",
      audience: "internal_log",
      source: { workflowId: "wf-1" },
    });

    expect(fs.ensured[0]).toBe(
      path.join(SESSION_WORKTREE, "memory-bank/codex/sub"),
    );
    expect(fs.written[0]?.absolutePath).toBe(
      path.join(SESSION_WORKTREE, "memory-bank/codex/sub/file.md"),
    );
  });
});

describe("createArtifactRegistry write — discoverability registration", () => {
  it("registers a focus_memory artifact as a reference document", async () => {
    const fs = makeFakeFs();
    const registrations: RecordedReferenceRegistration[] = [];
    const registry = createArtifactRegistry(
      makeDeps(fs, {
        registration: {
          registerReferenceDocument: async (input) => {
            registrations.push(input);
          },
        },
      }),
    );

    await registry.write({
      kind: "focus_memory",
      worktreePath: SESSION_WORKTREE,
      relativePath: "memory-bank/focus.md",
      contents: "# focus",
      audience: "user_facing",
      source: { workflowId: "wf-1" },
      description: "Current focus",
    });

    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.relativePath).toBe("memory-bank/focus.md");
    expect(registrations[0]?.description).toBe("Current focus");
  });

  it("registers reference_document artifacts via reference document registration", async () => {
    const fs = makeFakeFs();
    const registrations: RecordedReferenceRegistration[] = [];
    const registry = createArtifactRegistry(
      makeDeps(fs, {
        registration: {
          registerReferenceDocument: async (input) => {
            registrations.push(input);
          },
        },
      }),
    );

    await registry.write({
      kind: "reference_document",
      worktreePath: SESSION_WORKTREE,
      relativePath: "memory-bank/notes/topic.md",
      contents: "x",
      audience: "user_facing",
      description: "Notes on topic",
      source: { workflowId: "wf-1" },
    });

    expect(registrations).toHaveLength(1);
    expect(registrations[0]?.description).toBe("Notes on topic");
  });

  it("registers graph_shared_document artifacts via shared document registration", async () => {
    const fs = makeFakeFs();
    const sharedRegs: RecordedSharedDocRegistration[] = [];
    const registry = createArtifactRegistry(
      makeDeps(fs, {
        registration: {
          registerSharedDocument: async (input) => {
            sharedRegs.push(input);
          },
        },
      }),
    );

    await registry.write({
      kind: "graph_shared_document",
      worktreePath: SESSION_WORKTREE,
      relativePath: ".cc/graph-workflow-docs/notes.md",
      contents: "x",
      audience: "user_facing",
      description: "Shared notes",
      readWhen: "Before iteration",
      source: { workflowId: "wf-1" },
    });

    expect(sharedRegs).toHaveLength(1);
    expect(sharedRegs[0]?.relativePath).toBe(
      ".cc/graph-workflow-docs/notes.md",
    );
    expect(sharedRegs[0]?.description).toBe("Shared notes");
    expect(sharedRegs[0]?.readWhen).toBe("Before iteration");
  });

  it("does not call any registration hook for kinds that have no metadata system", async () => {
    const fs = makeFakeFs();
    const referenceRegs: RecordedReferenceRegistration[] = [];
    const sharedRegs: RecordedSharedDocRegistration[] = [];
    const registry = createArtifactRegistry(
      makeDeps(fs, {
        registration: {
          registerReferenceDocument: async (input) => {
            referenceRegs.push(input);
          },
          registerSharedDocument: async (input) => {
            sharedRegs.push(input);
          },
        },
      }),
    );

    await registry.write({
      kind: "validation_log",
      worktreePath: SESSION_WORKTREE,
      relativePath: ".cc/workflow/exec-1/pre-merge.log",
      contents: "x",
      audience: "internal_log",
      source: { workflowId: "wf-1" },
    });
    await registry.write({
      kind: "codex_output",
      worktreePath: SESSION_WORKTREE,
      relativePath: "memory-bank/codex/note.md",
      contents: "x",
      audience: "internal_log",
      source: { workflowId: "wf-1" },
    });

    expect(referenceRegs).toHaveLength(0);
    expect(sharedRegs).toHaveLength(0);
  });

  it("writes the file before registering (registration only fires after a successful write)", async () => {
    const fs = makeFakeFs();
    fs.failOnce = path.join(SESSION_WORKTREE, "memory-bank/focus.md");
    const referenceRegs: RecordedReferenceRegistration[] = [];
    const registry = createArtifactRegistry(
      makeDeps(fs, {
        registration: {
          registerReferenceDocument: async (input) => {
            referenceRegs.push(input);
          },
        },
      }),
    );

    await expect(
      registry.write({
        kind: "focus_memory",
        worktreePath: SESSION_WORKTREE,
        relativePath: "memory-bank/focus.md",
        contents: "x",
        audience: "user_facing",
        description: "focus",
        source: { workflowId: "wf-1" },
      }),
    ).rejects.toThrow();

    expect(referenceRegs).toHaveLength(0);
  });

  it("requires description when the kind needs reference document registration", async () => {
    const fs = makeFakeFs();
    const referenceRegs: RecordedReferenceRegistration[] = [];
    const registry = createArtifactRegistry(
      makeDeps(fs, {
        registration: {
          registerReferenceDocument: async (input) => {
            referenceRegs.push(input);
          },
        },
      }),
    );

    await expect(
      registry.write({
        kind: "reference_document",
        worktreePath: SESSION_WORKTREE,
        relativePath: "memory-bank/notes/x.md",
        contents: "x",
        audience: "user_facing",
        source: { workflowId: "wf-1" },
      }),
    ).rejects.toThrow(/description/i);
  });
});

describe("createArtifactRegistry write — write vs writeOptional failure handling", () => {
  it("write() throws ArtifactRequiredFailure when the write fails", async () => {
    const fs = makeFakeFs();
    fs.failOnce = path.join(SESSION_WORKTREE, ".cc/workflow/exec-1/x.log");
    const registry = createArtifactRegistry(makeDeps(fs));

    let caught: Error | null = null;
    try {
      await registry.write({
        kind: "validation_log",
        worktreePath: SESSION_WORKTREE,
        relativePath: ".cc/workflow/exec-1/x.log",
        contents: "x",
        audience: "internal_log",
        source: { workflowId: "wf-1" },
      });
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).not.toBeNull();
    expect(caught?.name).toBe(artifactRequiredFailureName);
  });

  it("writeOptional() returns a warning outcome and does not throw when the write fails", async () => {
    const fs = makeFakeFs();
    fs.failOnce = path.join(SESSION_WORKTREE, ".cc/workflow/exec-1/x.log");
    const warnings: Array<{ event: string; fields: Record<string, unknown> }> =
      [];
    const registry = createArtifactRegistry(
      makeDeps(fs, {
        logger: {
          warn: (event, fields) => warnings.push({ event, fields }),
          info: () => {},
          error: () => {},
        },
      }),
    );

    const outcome = await registry.writeOptional({
      kind: "validation_log",
      worktreePath: SESSION_WORKTREE,
      relativePath: ".cc/workflow/exec-1/x.log",
      contents: "x",
      audience: "internal_log",
      source: { workflowId: "wf-1" },
    });

    expect(outcome.status).toBe("skipped_warning");
    if (outcome.status === "skipped_warning") {
      expect(outcome.warning).toMatch(/disk full|write/i);
    }
    expect(
      warnings.some((w) => w.event === "artifact-registry.optional_skipped"),
    ).toBe(true);
  });

  it("write() propagates registration failures as required failures", async () => {
    const fs = makeFakeFs();
    const registry = createArtifactRegistry(
      makeDeps(fs, {
        registration: {
          registerReferenceDocument: async () => {
            throw new Error("state lock contention");
          },
        },
      }),
    );

    let caught: Error | null = null;
    try {
      await registry.write({
        kind: "focus_memory",
        worktreePath: SESSION_WORKTREE,
        relativePath: "memory-bank/focus.md",
        contents: "x",
        audience: "user_facing",
        description: "focus",
        source: { workflowId: "wf-1" },
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.name).toBe(artifactRequiredFailureName);
  });

  describe("register", () => {
    it("registers an existing on-disk artifact via the reference-document hook without writing or creating directories", async () => {
      const fs = makeFakeFs();
      const calls: RecordedReferenceRegistration[] = [];
      const registry = createArtifactRegistry({
        ...makeDeps(fs),
        registration: {
          registerReferenceDocument: async (input) => {
            calls.push({
              worktreePath: input.worktreePath,
              relativePath: input.relativePath,
              description: input.description,
              source: {
                ...(input.source.workflowId !== undefined
                  ? { workflowId: input.source.workflowId }
                  : {}),
                ...(input.source.laneId !== undefined
                  ? { laneId: input.source.laneId }
                  : {}),
                ...(input.source.round !== undefined
                  ? { round: input.source.round }
                  : {}),
              },
            });
          },
        },
      });

      const record = await registry.register({
        kind: "focus_memory",
        worktreePath: SESSION_WORKTREE,
        relativePath: "memory-bank/focus.md",
        description: "Current focus",
        source: { workflowId: "wf-1" },
      });

      expect(record.kind).toBe("focus_memory");
      expect(record.relativePath).toBe("memory-bank/focus.md");
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({
        worktreePath: SESSION_WORKTREE,
        relativePath: "memory-bank/focus.md",
        description: "Current focus",
        source: { workflowId: "wf-1" },
      });
      expect(fs.written).toHaveLength(0);
      expect(fs.ensured).toHaveLength(0);
    });

    it("rejects registration for kinds that are filesystem-only (no registration target)", async () => {
      const fs = makeFakeFs();
      const registry = createArtifactRegistry({ ...makeDeps(fs) });
      let caught: Error | undefined;
      try {
        await registry.register({
          kind: "codex_output",
          worktreePath: SESSION_WORKTREE,
          relativePath: "memory-bank/codex/run-1/notes.md",
          description: "n/a",
          source: {},
        });
      } catch (err) {
        caught = err as Error;
      }
      expect(caught?.name).toBe(artifactRequiredFailureName);
    });

    it("rejects path traversal at registration", async () => {
      const fs = makeFakeFs();
      const registry = createArtifactRegistry({
        ...makeDeps(fs),
        registration: {
          registerReferenceDocument: async () => {},
        },
      });
      let caught: Error | undefined;
      try {
        await registry.register({
          kind: "focus_memory",
          worktreePath: SESSION_WORKTREE,
          relativePath: "../escape.md",
          description: "x",
          source: {},
        });
      } catch (err) {
        caught = err as Error;
      }
      expect(caught?.name).toBe(artifactRequiredFailureName);
    });

    it("propagates registration failures as ArtifactRequiredFailure with stage=registration", async () => {
      const fs = makeFakeFs();
      const registry = createArtifactRegistry({
        ...makeDeps(fs),
        registration: {
          registerReferenceDocument: async () => {
            throw new Error("state contention");
          },
        },
      });
      let caught: Error | undefined;
      try {
        await registry.register({
          kind: "focus_memory",
          worktreePath: SESSION_WORKTREE,
          relativePath: "memory-bank/focus.md",
          description: "x",
          source: {},
        });
      } catch (err) {
        caught = err as Error;
      }
      expect(caught?.name).toBe(artifactRequiredFailureName);
      expect((caught as { stage?: string }).stage).toBe("registration");
    });
  });
});
