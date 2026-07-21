import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createStateStore } from "./store";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";

/**
 * Durability contract for the focused project-override store mutations that
 * replace the whole-state `mutateState` path (Design 2.2, task 3). Each case
 * writes through the real store over a real SQLite DB, then reloads through a
 * FRESH store over the same connection so the assertion proves the value
 * reached disk — not an in-memory cache. Reads never happen under the write
 * lock and no aggregate is touched.
 */

let fixture: PersistenceFixture;

beforeEach(() => {
  fixture = createPersistenceFixture();
});

afterEach(() => {
  fixture.close();
});

describe("mutateProjectMcpOverrides durability", () => {
  it("persists the written overrides and clears them via the write:false branch", async () => {
    fixture.seedProject("/proj");

    await fixture.store.mutateProjectMcpOverrides<void>(
      "/proj",
      "test.write",
      (current) => {
        expect(current).toBeUndefined();
        return {
          write: true,
          overrides: { servers: { kagi: { enabled: false } } },
          result: undefined,
        };
      },
    );

    const reloaded = createStateStore({ db: fixture.db });
    expect(await reloaded.getProjectMcpOverrides("/proj")).toEqual({
      servers: { kagi: { enabled: false } },
    });

    // write:false leaves the persisted column exactly as it was.
    const skipped = await fixture.store.mutateProjectMcpOverrides<string>(
      "/proj",
      "test.skip",
      (current) => {
        expect(current).toEqual({ servers: { kagi: { enabled: false } } });
        return { write: false, result: "skipped" };
      },
    );
    expect(skipped).toBe("skipped");
    expect(
      await createStateStore({ db: fixture.db }).getProjectMcpOverrides(
        "/proj",
      ),
    ).toEqual({ servers: { kagi: { enabled: false } } });
  });

  it("throws when the project row is missing", async () => {
    await expect(
      fixture.store.mutateProjectMcpOverrides("/missing", "test.write", () => ({
        write: true,
        overrides: { servers: {} },
        result: undefined,
      })),
    ).rejects.toThrow(/not found/i);
  });
});

describe("mutateProjectAgentCapabilityOverrides durability", () => {
  it("persists the written overrides through a real reload", async () => {
    fixture.seedProject("/proj");

    await fixture.store.mutateProjectAgentCapabilityOverrides<void>(
      "/proj",
      "test.write",
      () => ({
        write: true,
        overrides: {
          cascades: {
            "claude-skills": { items: { "skill:a": { enabled: false } } },
          },
        },
        result: undefined,
      }),
    );

    const reloaded = createStateStore({ db: fixture.db });
    expect(await reloaded.getProjectAgentCapabilityOverrides("/proj")).toEqual({
      cascades: {
        "claude-skills": { items: { "skill:a": { enabled: false } } },
      },
    });
  });

  it("hands the mutator the fresh persisted overrides so concurrent merges do not lose updates", async () => {
    fixture.seedProject("/proj");

    // Three concurrent merges into distinct cascades: each mutator must see the
    // committed result of the ones the queue ran before it.
    await Promise.all([
      fixture.store.mutateProjectAgentCapabilityOverrides<void>(
        "/proj",
        "test.merge",
        (current) => ({
          write: true,
          overrides: {
            cascades: {
              ...(current?.cascades ?? {}),
              "claude-skills": { items: { a: { enabled: true } } },
            },
          },
          result: undefined,
        }),
      ),
      fixture.store.mutateProjectAgentCapabilityOverrides<void>(
        "/proj",
        "test.merge",
        (current) => ({
          write: true,
          overrides: {
            cascades: {
              ...(current?.cascades ?? {}),
              "codex-skills": { items: { b: { enabled: false } } },
            },
          },
          result: undefined,
        }),
      ),
    ]);

    const reloaded = createStateStore({ db: fixture.db });
    const overrides =
      await reloaded.getProjectAgentCapabilityOverrides("/proj");
    expect(overrides?.cascades["claude-skills"]?.items["a"]?.enabled).toBe(
      true,
    );
    expect(overrides?.cascades["codex-skills"]?.items["b"]?.enabled).toBe(
      false,
    );
  });
});
