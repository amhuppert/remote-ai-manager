import { describe, expect, it } from "vitest";
import { getStaticBackendModelCatalog } from "@/lib/agent-backends/catalog";
import { validateModelSelection } from "@/lib/agent-backends/model-selection";
import { modelOptions } from "./template-fixtures";
import {
  catalogFor,
  effortParameterOf,
  profileKey,
  profileRefOf,
  seatOf,
  withBackend,
  withEffort,
  withModel,
} from "./seat-model";

const claude = getStaticBackendModelCatalog("claude");
const codex = getStaticBackendModelCatalog("codex");
const opusHigh = {
  backend: "claude" as const,
  modelSelection: { modelId: "opus", parameters: { effort: "high" } },
};

describe("a seat's backend", () => {
  it("is the Command Center default when unset, which leaves the model to it too", () => {
    expect(withBackend(opusHigh, null)).toEqual({});
  });

  it("starts at its own default model when chosen", () => {
    expect(withBackend(opusHigh, "codex")).toEqual({ backend: "codex" });
  });

  it("finds its catalog among the project's model options", () => {
    expect(catalogFor(modelOptions, "codex")?.backend).toBe("codex");
    expect(catalogFor(modelOptions, undefined)).toBeNull();
  });
});

describe("a seat's model and effort", () => {
  it("maps a chosen model to a complete selection, keeping the effort it supports", () => {
    const seat = withModel(opusHigh, claude, "sonnet");
    expect(seat).toEqual({
      backend: "claude",
      modelSelection: { modelId: "sonnet", parameters: { effort: "high" } },
    });
    if (seat.modelSelection === undefined) throw new Error("no selection");
    expect(validateModelSelection(claude, seat.modelSelection).valid).toBe(
      true,
    );
  });

  it("takes the model's default selection when it has no effort to keep", () => {
    expect(withModel(opusHigh, claude, "haiku").modelSelection).toEqual({
      modelId: "haiku",
      parameters: {},
    });
  });

  it("leaves the model to the backend's default when none is chosen", () => {
    expect(withModel(opusHigh, claude, null)).toEqual({ backend: "claude" });
  });

  it("sets the effort on the selection, keeping the model's other parameters", () => {
    expect(withEffort(opusHigh, claude, "max").modelSelection).toEqual({
      modelId: "opus",
      parameters: { effort: "max" },
    });
    const codexSeat = withModel({ backend: "codex" }, codex, "gpt-6-sol");
    const fast = {
      backend: "codex" as const,
      modelSelection: {
        modelId: "gpt-6-sol",
        parameters: {
          ...codexSeat.modelSelection?.parameters,
          fast: "true",
        },
      },
    };
    expect(withEffort(fast, codex, "low").modelSelection?.parameters).toEqual({
      fast: "true",
      reasoning: "low",
    });
  });

  it("names the parameter the effort control sets, if the model has one", () => {
    expect(effortParameterOf(claude, "opus")?.label).toBe("Effort");
    expect(effortParameterOf(codex, "gpt-6-sol")?.label).toBe("Reasoning");
    expect(effortParameterOf(claude, "haiku")).toBeNull();
  });
});

describe("a seat's fields", () => {
  it("are only its backend and model", () => {
    expect(
      seatOf({
        profile: { tier: "builtin", id: "standard-agent" },
        ...opusHigh,
      }),
    ).toEqual(opusHigh);
    expect(
      seatOf({ profile: { tier: "builtin", id: "standard-agent" } }),
    ).toEqual({});
  });
});

describe("a profile choice", () => {
  it("round-trips a qualified reference through its key", () => {
    const ref = { tier: "project", id: "careful-implementer" } as const;
    expect(profileKey(ref)).toBe("project:careful-implementer");
    expect(profileRefOf(profileKey(ref))).toEqual(ref);
    expect(profileRefOf("nowhere:x")).toBeNull();
  });
});
