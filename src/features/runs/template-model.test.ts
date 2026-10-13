import { describe, expect, it } from "vitest";
import { validateRunTemplate } from "@/lib/run-templates/document";
import { RUN_SETTING_DEFAULTS } from "@/lib/runs/settings";
import { checkoutTemplate } from "./template-fixtures";
import {
  TEMPLATE_PART,
  changeCounts,
  contentOf,
  contextSettings,
  draftProblems,
  editContext,
  minutesOf,
  resetContextSetting,
  resetDefault,
  setContextSetting,
  setDefault,
  setLaneChecks,
  templateSettings,
  timeoutMsOf,
} from "./template-model";

const globals = RUN_SETTING_DEFAULTS;
const saved = contentOf(checkoutTemplate);

function contextOf(
  draft: ReturnType<typeof contentOf>,
  key: string,
): (typeof draft.workflow.contexts)[number] {
  const context = draft.workflow.contexts.find((each) => each.key === key);
  if (context === undefined) throw new Error(`No context ${key}`);
  return context;
}

describe("the template fixture", () => {
  it("is a template the server would save", () => {
    expect(validateRunTemplate(saved)).toEqual({ ok: true, content: saved });
  });
});

describe("settings as the editor shows them", () => {
  it("takes every value from the cascade, with the tier it comes from", () => {
    expect(templateSettings(globals, saved).checks).toEqual({
      value: ["typecheck", "lint"],
      from: "template",
    });
    expect(templateSettings(globals, saved).humanApproval).toEqual({
      value: false,
      from: "global",
    });
    expect(contextSettings(globals, saved, "api").checks).toEqual({
      value: ["typecheck", "test"],
      from: "context",
    });
    expect(contextSettings(globals, saved, "plan").implementer).toEqual({
      value: saved.defaults.implementer,
      from: "template",
    });
  });
});

describe("editing settings", () => {
  it("writes a changed default only to the template's patch, so inheriting contexts gain no override", () => {
    const draft = setDefault(saved, "humanApproval", true);
    expect(draft.defaults.humanApproval).toBe(true);
    expect(draft.workflow.contexts.map((context) => context.settings)).toEqual(
      saved.workflow.contexts.map((context) => context.settings),
    );
    expect(contextSettings(globals, draft, "plan").humanApproval).toEqual({
      value: true,
      from: "template",
    });
    expect(contextSettings(globals, draft, "ui").humanApproval).toEqual({
      value: true,
      from: "context",
    });
  });

  it("resets a context override by deleting its key, falling back to the template's value", () => {
    const draft = resetContextSetting(saved, "migrate", "implementer");
    expect(contextOf(draft, "migrate").settings).not.toHaveProperty(
      "implementer",
    );
    expect(contextOf(draft, "migrate").settings?.checks).toEqual([
      "typecheck",
      "test",
    ]);
    expect(contextSettings(globals, draft, "migrate").implementer).toEqual({
      value: saved.defaults.implementer,
      from: "template",
    });
  });

  it("drops a context's settings once its last override is reset", () => {
    const draft = resetContextSetting(saved, "docs", "reviewers");
    expect(contextOf(draft, "docs")).not.toHaveProperty("settings");
  });

  it("resets a default by deleting its key, falling back to the Command Center defaults", () => {
    const draft = resetDefault(saved, "checks");
    expect(draft.defaults).not.toHaveProperty("checks");
    expect(contextSettings(globals, draft, "plan").checks).toEqual({
      value: [],
      from: "global",
    });
  });

  it("sets a context override in that context's patch only", () => {
    const draft = setContextSetting(saved, "plan", "timeoutMs", 600_000);
    expect(contextOf(draft, "plan").settings?.timeoutMs).toBe(600_000);
    expect(draft.defaults).toEqual(saved.defaults);
    expect(contextOf(draft, "api").settings).toEqual(
      contextOf(saved, "api").settings,
    );
  });
});

describe("unsaved changes", () => {
  it("compare authored patches, so setting and resetting a value leaves none", () => {
    const draft = resetContextSetting(
      setContextSetting(saved, "plan", "humanApproval", true),
      "plan",
      "humanApproval",
    );
    expect([...changeCounts(saved, draft)]).toEqual([]);
  });

  it("count a reset override against its context and a changed default against the template", () => {
    const draft = setDefault(
      resetContextSetting(saved, "migrate", "implementer"),
      "checks",
      ["lint"],
    );
    const counts = changeCounts(saved, draft);
    expect(counts.get("migrate")).toBe(1);
    expect(counts.get(TEMPLATE_PART)).toBe(1);
    expect(counts.get("plan")).toBeUndefined();
  });

  it("ignore key order within an equal value", () => {
    const implementer = contextOf(saved, "migrate").settings?.implementer;
    if (implementer === undefined) throw new Error("fixture changed");
    const reordered = {
      modelSelection: implementer.modelSelection,
      backend: implementer.backend,
      profile: implementer.profile,
    };
    const draft = setContextSetting(saved, "migrate", "implementer", reordered);
    expect([...changeCounts(saved, draft)]).toEqual([]);
  });

  it("count content and lane check edits", () => {
    const draft = setLaneChecks(
      editContext(saved, "api", { brief: "Add the endpoints." }),
      "ui",
      ["lint"],
    );
    const counts = changeCounts(saved, draft);
    expect(counts.get("api")).toBe(1);
    expect(counts.get(TEMPLATE_PART)).toBe(1);
  });
});

describe("editing a context's content", () => {
  it("leaves out optional text and lists it empties", () => {
    const draft = editContext(saved, "plan", {
      title: "",
      tasks: [
        { title: "Read the spec", instructions: "" },
        { title: "Return the plan", instructions: "Include all of it." },
      ],
      acceptanceCriteria: [],
      outputSchema: null,
    });
    const plan = contextOf(draft, "plan");
    expect(plan).not.toHaveProperty("title");
    expect(plan).not.toHaveProperty("acceptanceCriteria");
    expect(plan).not.toHaveProperty("outputSchema");
    expect(plan.tasks).toEqual([
      { title: "Read the spec" },
      { title: "Return the plan", instructions: "Include all of it." },
    ]);
    expect(
      contextOf(editContext(saved, "api", { outputSchema: null }), "api"),
    ).not.toHaveProperty("outputSchema");
  });

  it("drops a lane's checks once none are left", () => {
    const draft = setLaneChecks(saved, "api", []);
    expect(draft.workflow.lanes?.find((lane) => lane.key === "api")).toEqual({
      key: "api",
    });
  });
});

describe("problems that block a save", () => {
  it("are none for a valid template", () => {
    expect(draftProblems(saved)).toEqual([]);
  });

  it("locate the server's token lint at the context that holds the token", () => {
    const draft = editContext(
      editContext(saved, "api", { brief: "Fix {{inputs.ticket}} now." }),
      "ui",
      { brief: "Ship {{flag}}." },
    );
    const problems = draftProblems(draft);
    expect(problems.map(({ part, location }) => [part, location])).toEqual([
      ["api", "api · brief"],
      ["ui", "ui · brief"],
    ]);
    expect(problems[0]?.message).toContain('parameter "ticket"');
    expect(problems[1]?.message).toContain("is not a parameter token");
  });

  it("locate a template-wide problem at the template", () => {
    const problems = draftProblems({ ...saved, name: "" });
    expect(problems.map(({ part, location }) => [part, location])).toEqual([
      [TEMPLATE_PART, "name"],
    ]);
  });
});

describe("the turn time limit", () => {
  it("is edited in minutes and stored in milliseconds, empty meaning none", () => {
    expect(timeoutMsOf(12)).toBe(720_000);
    expect(timeoutMsOf(null)).toBeNull();
    expect(minutesOf(720_000)).toBe(12);
    expect(minutesOf(90_000)).toBe(1.5);
    expect(minutesOf(null)).toBeNull();
  });
});
