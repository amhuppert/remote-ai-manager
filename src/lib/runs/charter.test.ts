import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createArtifactStore, type ArtifactStore } from "@/lib/artifacts/store";
import {
  charterBundleFor,
  charterFor,
  currentCharter,
  freezeCharter,
  renderCharterDocument,
  reviseCharter,
} from "./charter";
import { runCharterSchema, type RunCharter } from "./schemas";

let root: string;
let store: ArtifactStore;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "cc-charter-store-"));
  store = createArtifactStore({ root });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const charter: RunCharter = {
  mission: "Make the failure notice appear once.",
  nonGoals: ["Networked filesystems"],
  conventions: ["Name events with dots"],
  invariants: [
    { id: "no-mocks", statement: "No vi.mock of internal modules." },
    {
      id: "api-stable",
      statement: "The notice API keeps its shape.",
      appliesTo: ["api"],
    },
  ],
  sourcesOfTruth: [
    {
      rank: 2,
      id: "design",
      label: "Design",
      type: "document",
      locator: "docs/design.md",
      description: "The design",
    },
    {
      rank: 1,
      id: "spec",
      label: "Spec",
      type: "spec",
      locator: "specs/notice.md",
      description: "The spec",
      appliesTo: ["api"],
    },
  ],
};

describe("a run's charter", () => {
  it("refuses a rank or an id used twice, each at its place", () => {
    const parsed = runCharterSchema.safeParse({
      mission: "M",
      invariants: [
        { id: "a", statement: "A" },
        { id: "a", statement: "A again" },
      ],
      sourcesOfTruth: [
        {
          rank: 1,
          id: "x",
          label: "X",
          type: "code",
          locator: "src",
          description: "X",
        },
        {
          rank: 1,
          id: "x",
          label: "Y",
          type: "code",
          locator: "lib",
          description: "Y",
        },
      ],
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((i) => i.path.join("."))).toEqual([
      "sourcesOfTruth.1.rank",
      "sourcesOfTruth.1.id",
      "invariants.1.id",
    ]);
  });

  it("gives each context the invariants and sources meant for it, sources by authority", () => {
    expect(charterBundleFor(charter, "api")).toEqual({
      mission: "Make the failure notice appear once.",
      conventions: ["Name events with dots"],
      nonGoals: ["Networked filesystems"],
      vocabulary: [],
      testStrategy: null,
      knownAmbiguities: [],
      invariants: [
        { id: "no-mocks", statement: "No vi.mock of internal modules." },
        { id: "api-stable", statement: "The notice API keeps its shape." },
      ],
      sourcesOfTruth: [
        {
          rank: 1,
          id: "spec",
          label: "Spec",
          type: "spec",
          locator: "specs/notice.md",
          description: "The spec",
        },
        {
          rank: 2,
          id: "design",
          label: "Design",
          type: "document",
          locator: "docs/design.md",
          description: "The design",
        },
      ],
    });
    expect(
      charterBundleFor(charter, "docs").invariants.map((i) => i.id),
    ).toEqual(["no-mocks"]);
    expect(
      charterBundleFor(charter, "docs").sourcesOfTruth.map((s) => s.id),
    ).toEqual(["design"]);
  });

  it("renders a context's charter in full, nothing meant only for other contexts", () => {
    const docs = renderCharterDocument(charterBundleFor(charter, "docs"));
    expect(docs).toContain("Make the failure notice appear once.");
    expect(docs).toContain("no-mocks");
    expect(docs).toContain("Name events with dots");
    expect(docs).toContain("docs/design.md");
    expect(docs).not.toContain("api-stable");
    expect(docs).not.toContain("specs/notice.md");
  });

  it("freezes one bundle for every context no appliesTo names and one per key one names, from the charter alone", async () => {
    const frozen = await freezeCharter({ charter, store });

    expect(Object.keys(frozen.bundles.byKey)).toEqual(["api"]);
    expect((await store.read(frozen.bundles.default)).toString()).toBe(
      renderCharterDocument(charterBundleFor(charter, "docs")),
    );
    expect((await store.read(frozen.bundles.byKey.api ?? "")).toString()).toBe(
      renderCharterDocument(charterBundleFor(charter, "api")),
    );
  });

  it("records a revision only when the charter changed, with the owner's reason, and gives a context the latest as its charter and a document", async () => {
    const first = await freezeCharter({ charter, store });
    const launched = reviseCharter([], first, {
      source: "launch",
      at: "t1",
      reason: null,
    });
    // The same charter declared again, as when an amendment only adds work, is no new revision.
    expect(
      reviseCharter(launched, await freezeCharter({ charter, store }), {
        source: "amend",
        at: "t2",
        reason: "More work",
      }),
    ).toEqual(launched);

    const amended = reviseCharter(
      launched,
      await freezeCharter({ charter: { ...charter, mission: "M2" }, store }),
      {
        source: "amend",
        at: "t2",
        reason: "The mission narrowed",
      },
    );
    expect(amended.map((r) => [r.revision, r.source, r.reason])).toEqual([
      [1, "launch", null],
      [2, "amend", "The mission narrowed"],
    ]);
    expect(currentCharter(amended)).toEqual({
      revision: 2,
      mission: "M2",
      reason: "The mission narrowed",
    });

    const docs = charterFor({
      revisions: amended,
      key: "docs",
      contextId: "run-1.docs",
    });
    expect(docs?.charter).toMatchObject({
      revision: 2,
      mission: "M2",
      documentPath: ".cc/run-docs/run-1.docs/charter.md",
    });
    expect(docs?.document).toMatchObject({
      artifactId: amended[1]?.bundles?.default,
      path: ".cc/run-docs/run-1.docs/charter.md",
    });
    // A context added later that no appliesTo names reads the same bundle.
    expect(
      charterFor({
        revisions: amended,
        key: "added-later",
        contextId: "run-1.added-later",
      })?.document.artifactId,
    ).toBe(amended[1]?.bundles?.default);
    expect(
      charterFor({ revisions: amended, key: "api", contextId: "run-1.api" })
        ?.document.artifactId,
    ).toBe(amended[1]?.bundles?.byKey.api);
    // A context key that names an object member is still just a key.
    expect(
      charterFor({
        revisions: amended,
        key: "constructor",
        contextId: "run-1.constructor",
      })?.document.artifactId,
    ).toBe(amended[1]?.bundles?.default);
    expect(
      charterFor({
        revisions: reviseCharter(amended, null, {
          source: "amend",
          at: "t3",
          reason: null,
        }),
        key: "docs",
        contextId: "run-1.docs",
      }),
    ).toBeNull();
  });
});
