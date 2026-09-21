import { runtimeConfigurationFixture } from "../testing/runtime-configuration-fixture";
import { describe, expect, it } from "vitest";
import { shouldRecreateRuntime } from "./runtime-recreate";

describe("shouldRecreateRuntime", () => {
  const lowA = { modelId: "a", parameters: { effort: "low" } };
  const highA = { modelId: "a", parameters: { effort: "high" } };
  const lowB = { modelId: "b", parameters: { effort: "low" } };

  it("returns false when session is undefined", () => {
    expect(
      shouldRecreateRuntime({
        current: undefined,
        desired: runtimeConfigurationFixture({
          modelSelection: lowA,
          alignmentVersion: null,
          fsWritePolicy: undefined,
        }),
      }),
    ).toBe(false);
  });

  it("returns false when session is dead", () => {
    expect(
      shouldRecreateRuntime({
        current: {
          ...runtimeConfigurationFixture(),
          ...{ status: "dead", modelSelection: lowA },
        },
        desired: runtimeConfigurationFixture({
          modelSelection: highA,
          alignmentVersion: null,
          fsWritePolicy: undefined,
        }),
      }),
    ).toBe(false);
  });

  it("returns false when the complete selection is unchanged", () => {
    expect(
      shouldRecreateRuntime({
        current: {
          ...runtimeConfigurationFixture(),
          ...{ status: "alive", modelSelection: lowA },
        },
        desired: runtimeConfigurationFixture({
          modelSelection: lowA,
          alignmentVersion: null,
          fsWritePolicy: undefined,
        }),
      }),
    ).toBe(false);
  });

  it("returns true when model changed", () => {
    expect(
      shouldRecreateRuntime({
        current: {
          ...runtimeConfigurationFixture(),
          ...{ status: "alive", modelSelection: lowA },
        },
        desired: runtimeConfigurationFixture({
          modelSelection: lowB,
          alignmentVersion: null,
          fsWritePolicy: undefined,
        }),
      }),
    ).toBe(true);
  });

  it("returns true when a model parameter changed", () => {
    expect(
      shouldRecreateRuntime({
        current: {
          ...runtimeConfigurationFixture(),
          ...{ status: "alive", modelSelection: lowA },
        },
        desired: runtimeConfigurationFixture({
          modelSelection: highA,
          alignmentVersion: null,
          fsWritePolicy: undefined,
        }),
      }),
    ).toBe(true);
  });

  it("returns true when an existing parameter is removed", () => {
    expect(
      shouldRecreateRuntime({
        current: {
          ...runtimeConfigurationFixture(),
          ...{ status: "alive", modelSelection: lowA },
        },
        desired: runtimeConfigurationFixture({
          modelSelection: { modelId: "a", parameters: {} },
          alignmentVersion: null,
          fsWritePolicy: undefined,
        }),
      }),
    ).toBe(true);
  });

  it("returns false when both parameter maps are empty", () => {
    expect(
      shouldRecreateRuntime({
        current: {
          ...runtimeConfigurationFixture(),
          ...{
            status: "alive",
            modelSelection: { modelId: "a", parameters: {} },
          },
        },
        desired: runtimeConfigurationFixture({
          modelSelection: { modelId: "a", parameters: {} },
          alignmentVersion: null,
          fsWritePolicy: undefined,
        }),
      }),
    ).toBe(false);
  });

  it("returns true when the alignment version advanced (3 -> 4)", () => {
    expect(
      shouldRecreateRuntime({
        current: {
          ...runtimeConfigurationFixture(),
          ...{
            status: "alive",
            modelSelection: lowA,
            alignmentVersion: 3,
          },
        },
        desired: runtimeConfigurationFixture({
          modelSelection: lowA,
          alignmentVersion: 4,
          fsWritePolicy: undefined,
        }),
      }),
    ).toBe(true);
  });

  it("returns false when the alignment version is unchanged (3 === 3)", () => {
    expect(
      shouldRecreateRuntime({
        current: {
          ...runtimeConfigurationFixture(),
          ...{
            status: "alive",
            modelSelection: lowA,
            alignmentVersion: 3,
          },
        },
        desired: runtimeConfigurationFixture({
          modelSelection: lowA,
          alignmentVersion: 3,
          fsWritePolicy: undefined,
        }),
      }),
    ).toBe(false);
  });

  it("returns false when both alignment versions are null", () => {
    expect(
      shouldRecreateRuntime({
        current: {
          ...runtimeConfigurationFixture(),
          ...{
            status: "alive",
            modelSelection: lowA,
            alignmentVersion: null,
          },
        },
        desired: runtimeConfigurationFixture({
          modelSelection: lowA,
          alignmentVersion: null,
          fsWritePolicy: undefined,
        }),
      }),
    ).toBe(false);
  });

  it("returns true when the charter was deactivated (3 -> null)", () => {
    expect(
      shouldRecreateRuntime({
        current: {
          ...runtimeConfigurationFixture(),
          ...{
            status: "alive",
            modelSelection: lowA,
            alignmentVersion: 3,
          },
        },
        desired: runtimeConfigurationFixture({
          modelSelection: lowA,
          alignmentVersion: null,
          fsWritePolicy: undefined,
        }),
      }),
    ).toBe(true);
  });

  it("returns true when a charter became active (null -> 3)", () => {
    expect(
      shouldRecreateRuntime({
        current: {
          ...runtimeConfigurationFixture(),
          ...{
            status: "alive",
            modelSelection: lowA,
            alignmentVersion: null,
          },
        },
        desired: runtimeConfigurationFixture({
          modelSelection: lowA,
          alignmentVersion: 3,
          fsWritePolicy: undefined,
        }),
      }),
    ).toBe(true);
  });

  it("treats a missing runtime alignmentVersion as null (no recreate when desired is null)", () => {
    expect(
      shouldRecreateRuntime({
        current: {
          ...runtimeConfigurationFixture(),
          ...{ status: "alive", modelSelection: lowA },
        },
        desired: runtimeConfigurationFixture({
          modelSelection: lowA,
          alignmentVersion: null,
          fsWritePolicy: undefined,
        }),
      }),
    ).toBe(false);
  });
});

describe("creation requirements", () => {
  it.each([
    { name: "backend", change: { backend: "codex" as const } },
    {
      name: "instruction content",
      change: { repeatableInstructions: ["changed"] },
    },
    {
      name: "instruction order",
      change: {
        repeatableInstructions: [
          ...runtimeConfigurationFixture().repeatableInstructions,
        ].reverse(),
      },
    },
    {
      name: "write envelope",
      change: {
        fsWritePolicy: {
          mode: "allowlist" as const,
          allowWrite: ["src"],
          denyWrite: [],
        },
      },
    },
  ])("recreates for changed $name", ({ change }) => {
    const current = { ...runtimeConfigurationFixture(), status: "alive" };
    expect(
      shouldRecreateRuntime({ current, desired: { ...current, ...change } }),
    ).toBe(true);
  });
  it("compares write policy keys semantically while retaining meaningful path order", () => {
    const current = {
      ...runtimeConfigurationFixture(),
      status: "alive",
      fsWritePolicy: {
        mode: "allowlist" as const,
        allowWrite: ["src", "tests"],
        denyWrite: [],
      },
    };
    expect(
      shouldRecreateRuntime({
        current,
        desired: {
          ...current,
          fsWritePolicy: {
            denyWrite: [],
            allowWrite: ["src", "tests"],
            mode: "allowlist",
          },
        },
      }),
    ).toBe(false);
    expect(
      shouldRecreateRuntime({
        current,
        desired: {
          ...current,
          fsWritePolicy: {
            ...current.fsWritePolicy,
            allowWrite: ["tests", "src"],
          },
        },
      }),
    ).toBe(true);
  });
});
