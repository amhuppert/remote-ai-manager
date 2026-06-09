import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  assertRoundTripDurability,
  type RoundTripSpec,
} from "./round-trip-durability";

// A persist/reload pair backed by an in-memory map. The map stores the value
// produced by `produce` (or the fixture itself), and reload returns a clone so
// the harness compares structurally rather than by reference.
function memoryRoundTrip<TSchema extends z.ZodObject<z.ZodRawShape>>(
  produce?: (fixture: z.infer<TSchema>) => z.infer<TSchema>,
): {
  persist: (fixture: z.infer<TSchema>) => z.infer<TSchema>;
  reload: (expected: z.infer<TSchema>) => z.infer<TSchema> | null;
} {
  let stored: z.infer<TSchema> | null = null;
  return {
    persist(fixture) {
      const value = produce ? produce(fixture) : fixture;
      stored = structuredClone(value) as z.infer<TSchema>;
      return value;
    },
    reload() {
      if (stored === null) return null;
      return structuredClone(stored) as z.infer<TSchema>;
    },
  };
}

describe("assertRoundTripDurability — completeness guard", () => {
  it("fails when the maximal fixture omits a top-level schema key", async () => {
    const schema = z.object({
      id: z.string(),
      name: z.string(),
    });
    const rt = memoryRoundTrip<typeof schema>();
    const spec: RoundTripSpec<typeof schema> = {
      label: "missing-top-level",
      schema,
      // `name` deliberately omitted; cast through the schema's input gap.
      buildMaximalFixture: () => ({ id: "a" }) as z.infer<typeof schema>,
      persist: rt.persist,
      reload: rt.reload,
    };

    await expect(assertRoundTripDurability(spec)).rejects.toThrow(/name/);
  });

  it("fails naming a nested key path when an introspectable nested field is omitted", async () => {
    const schema = z.object({
      id: z.string(),
      meta: z.object({
        owner: z.string(),
        label: z.string(),
      }),
    });
    const rt = memoryRoundTrip<typeof schema>();
    const spec: RoundTripSpec<typeof schema> = {
      label: "missing-nested",
      schema,
      buildMaximalFixture: () =>
        ({
          id: "a",
          meta: { owner: "alex" },
        }) as z.infer<typeof schema>,
      persist: rt.persist,
      reload: rt.reload,
    };

    await expect(assertRoundTripDurability(spec)).rejects.toThrow(
      /meta\.label/,
    );
  });

  it("fails naming a deep array element key path when omitted", async () => {
    const schema = z.object({
      questions: z.array(
        z.object({
          options: z.array(
            z.object({
              id: z.string(),
              description: z.string(),
            }),
          ),
        }),
      ),
    });
    const rt = memoryRoundTrip<typeof schema>();
    const spec: RoundTripSpec<typeof schema> = {
      label: "missing-deep-array",
      schema,
      buildMaximalFixture: () =>
        ({
          questions: [{ options: [{ id: "o1" }] }],
        }) as z.infer<typeof schema>,
      persist: rt.persist,
      reload: rt.reload,
    };

    await expect(assertRoundTripDurability(spec)).rejects.toThrow(
      /questions\[0\]\.options\[0\]\.description/,
    );
  });

  it("fails when a persisted key path is left at its schema default", async () => {
    const schema = z.object({
      id: z.string(),
      retries: z.number().default(0),
    });
    const rt = memoryRoundTrip<typeof schema>();
    const spec: RoundTripSpec<typeof schema> = {
      label: "left-at-default",
      schema,
      buildMaximalFixture: () => ({ id: "a", retries: 0 }),
      persist: rt.persist,
      reload: rt.reload,
    };

    await expect(assertRoundTripDurability(spec)).rejects.toThrow(/retries/);
  });

  it("passes when a defaulted key path is populated with a non-default value", async () => {
    const schema = z.object({
      id: z.string(),
      retries: z.number().default(0),
    });
    const rt = memoryRoundTrip<typeof schema>();
    const spec: RoundTripSpec<typeof schema> = {
      label: "non-default-value",
      schema,
      buildMaximalFixture: () => ({ id: "a", retries: 3 }),
      persist: rt.persist,
      reload: rt.reload,
    };

    await expect(assertRoundTripDurability(spec)).resolves.toBeUndefined();
  });

  it("fails naming an empty persisted array whose element schema has fields", async () => {
    const schema = z.object({
      id: z.string(),
      items: z.array(z.object({ value: z.string() })),
    });
    const rt = memoryRoundTrip<typeof schema>();
    const spec: RoundTripSpec<typeof schema> = {
      label: "empty-array",
      schema,
      buildMaximalFixture: () => ({ id: "a", items: [] }),
      persist: rt.persist,
      reload: rt.reload,
    };

    await expect(assertRoundTripDurability(spec)).rejects.toThrow(/items/);
  });

  it("fails naming an empty persisted record whose value schema has fields", async () => {
    const schema = z.object({
      id: z.string(),
      byKey: z.record(z.string(), z.object({ value: z.string() })),
    });
    const rt = memoryRoundTrip<typeof schema>();
    const spec: RoundTripSpec<typeof schema> = {
      label: "empty-record",
      schema,
      buildMaximalFixture: () => ({ id: "a", byKey: {} }),
      persist: rt.persist,
      reload: rt.reload,
    };

    await expect(assertRoundTripDurability(spec)).rejects.toThrow(/byKey/);
  });

  it("requires an opaque leaf to be present (non-null/undefined)", async () => {
    const schema = z.object({
      id: z.string(),
      payload: z.unknown(),
    });
    const rt = memoryRoundTrip<typeof schema>();
    const spec: RoundTripSpec<typeof schema> = {
      label: "opaque-missing",
      schema,
      buildMaximalFixture: () => ({ id: "a" }) as z.infer<typeof schema>,
      persist: rt.persist,
      reload: rt.reload,
    };

    await expect(assertRoundTripDurability(spec)).rejects.toThrow(/payload/);
  });

  it("passes when an opaque leaf carries a non-empty payload that round-trips", async () => {
    const schema = z.object({
      id: z.string(),
      payload: z.unknown(),
    });
    const rt = memoryRoundTrip<typeof schema>();
    const spec: RoundTripSpec<typeof schema> = {
      label: "opaque-present",
      schema,
      buildMaximalFixture: () => ({ id: "a", payload: { nested: 1 } }),
      persist: rt.persist,
      reload: rt.reload,
    };

    await expect(assertRoundTripDurability(spec)).resolves.toBeUndefined();
  });
});

describe("assertRoundTripDurability — round-trip comparison", () => {
  it("passes the happy path for a complete fixture that round-trips deep-equal", async () => {
    const schema = z.object({
      id: z.string(),
      name: z.string(),
      tags: z.array(z.string()),
      nested: z.object({ count: z.number() }),
    });
    const rt = memoryRoundTrip<typeof schema>();
    const spec: RoundTripSpec<typeof schema> = {
      label: "happy",
      schema,
      buildMaximalFixture: () => ({
        id: "a",
        name: "alex",
        tags: ["x", "y"],
        nested: { count: 4 },
      }),
      persist: rt.persist,
      reload: rt.reload,
    };

    await expect(assertRoundTripDurability(spec)).resolves.toBeUndefined();
  });

  it("fails naming the field path when reload drops a persisted value", async () => {
    const schema = z.object({
      id: z.string(),
      queued: z.array(z.string()),
    });
    // Simulate a serialization drop: persist stores the fixture but reload
    // returns a value missing the `queued` array (reset to []).
    const spec: RoundTripSpec<typeof schema> = {
      label: "dropped-on-reload",
      schema,
      buildMaximalFixture: () => ({ id: "a", queued: ["pending"] }),
      persist: (fixture) => fixture,
      reload: (expected) => ({ ...expected, queued: [] }),
    };

    await expect(assertRoundTripDurability(spec)).rejects.toThrow(/queued/);
  });

  it("fails when reload returns null (fixture not persisted)", async () => {
    const schema = z.object({ id: z.string() });
    const spec: RoundTripSpec<typeof schema> = {
      label: "not-persisted",
      schema,
      buildMaximalFixture: () => ({ id: "a" }),
      persist: (fixture) => fixture,
      reload: () => null,
    };

    await expect(assertRoundTripDurability(spec)).rejects.toThrow();
  });

  it("awaits async persist and reload closures", async () => {
    const schema = z.object({ id: z.string(), value: z.string() });
    const store = new Map<string, z.infer<typeof schema>>();
    const spec: RoundTripSpec<typeof schema> = {
      label: "async",
      schema,
      buildMaximalFixture: () => ({ id: "a", value: "v" }),
      persist: async (fixture) => {
        store.set(fixture.id, structuredClone(fixture));
        return fixture;
      },
      reload: async (expected) => store.get(expected.id) ?? null,
    };

    await expect(assertRoundTripDurability(spec)).resolves.toBeUndefined();
  });
});

describe("assertRoundTripDurability — field policies", () => {
  it("passes when a dropped field is declared not-persisted", async () => {
    const schema = z.object({
      id: z.string(),
      ephemeral: z.string(),
    });
    const spec: RoundTripSpec<typeof schema> = {
      label: "declared-not-persisted",
      schema,
      buildMaximalFixture: () => ({ id: "a", ephemeral: "live-only" }),
      persist: (fixture) => fixture,
      // reload drops `ephemeral`, but it is declared not-persisted.
      reload: (expected) => ({ ...expected, ephemeral: "" }),
      fieldPolicies: { ephemeral: "not-persisted" },
    };

    await expect(assertRoundTripDurability(spec)).resolves.toBeUndefined();
  });

  it("excludes a not-persisted key path from the completeness guard", async () => {
    const schema = z.object({
      id: z.string(),
      ephemeral: z.string(),
    });
    const spec: RoundTripSpec<typeof schema> = {
      label: "not-persisted-omitted",
      schema,
      // `ephemeral` omitted from the fixture entirely; declared not-persisted.
      buildMaximalFixture: () => ({ id: "a" }) as z.infer<typeof schema>,
      persist: (fixture) => fixture,
      reload: (expected) => expected,
      fieldPolicies: { ephemeral: "not-persisted" },
    };

    await expect(assertRoundTripDurability(spec)).resolves.toBeUndefined();
  });

  it("fails when a dropped field is NOT declared in fieldPolicies (Req 2.2)", async () => {
    const schema = z.object({
      id: z.string(),
      ephemeral: z.string(),
    });
    const spec: RoundTripSpec<typeof schema> = {
      label: "undeclared-drop",
      schema,
      buildMaximalFixture: () => ({ id: "a", ephemeral: "live-only" }),
      persist: (fixture) => fixture,
      reload: (expected) => ({ ...expected, ephemeral: "" }),
    };

    await expect(assertRoundTripDurability(spec)).rejects.toThrow(/ephemeral/);
  });

  it("compares derived-on-write fields against the expected value returned by persist", async () => {
    const schema = z.object({
      id: z.string(),
      completedAt: z.string(),
    });
    // The fixture provides a placeholder; persist derives the real value; the
    // store keeps that derived value; reload returns it. The harness must
    // compare reload against the persist-returned expected, not the fixture.
    const store = new Map<string, z.infer<typeof schema>>();
    const spec: RoundTripSpec<typeof schema> = {
      label: "derived-survives",
      schema,
      buildMaximalFixture: () => ({ id: "a", completedAt: "placeholder" }),
      persist: (fixture) => {
        const derived = { ...fixture, completedAt: "2026-01-01T00:00:00.000Z" };
        store.set(fixture.id, structuredClone(derived));
        return derived;
      },
      reload: (expected) => store.get(expected.id) ?? null,
      fieldPolicies: { completedAt: "derived-on-write" },
    };

    await expect(assertRoundTripDurability(spec)).resolves.toBeUndefined();
  });

  it("fails when a derived-on-write field is lost between expected and reload", async () => {
    const schema = z.object({
      id: z.string(),
      completedAt: z.string(),
    });
    const spec: RoundTripSpec<typeof schema> = {
      label: "derived-lost",
      schema,
      buildMaximalFixture: () => ({ id: "a", completedAt: "placeholder" }),
      persist: (fixture) => ({
        ...fixture,
        completedAt: "2026-01-01T00:00:00.000Z",
      }),
      // reload drops the derived value.
      reload: (expected) => ({ ...expected, completedAt: "" }),
      fieldPolicies: { completedAt: "derived-on-write" },
    };

    await expect(assertRoundTripDurability(spec)).rejects.toThrow(
      /completedAt/,
    );
  });

  it("fails when a derived-on-write field is absent in the expected value returned by persist", async () => {
    const schema = z.object({
      id: z.string(),
      completedAt: z.string().optional(),
    });
    const spec: RoundTripSpec<typeof schema> = {
      label: "derived-missing-in-expected",
      schema,
      buildMaximalFixture: () => ({ id: "a", completedAt: undefined }),
      // persist FAILS to derive completedAt: it stays absent in expected.
      persist: (fixture) => ({ ...fixture }),
      reload: (expected) => expected,
      fieldPolicies: { completedAt: "derived-on-write" },
    };

    await expect(assertRoundTripDurability(spec)).rejects.toThrow(
      /completedAt/,
    );
  });
});
