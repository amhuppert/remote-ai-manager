// @vitest-environment jsdom
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiCallError } from "@/lib/api/errors";
import { runKeys } from "@/lib/runs/query-keys";
import { RUN_SETTING_DEFAULTS } from "@/lib/runs/settings";
import { installFetchFixture, type FetchFixture } from "@/test/fetch-fixture";
import type { RunTemplateContent, RunTemplateRecord } from "./document";
import {
  launchRefusalOf,
  useLaunchRunTemplateMutation,
  useSaveRunTemplateMutation,
} from "./mutations";
import { runTemplateKeys } from "./query-keys";

const content: RunTemplateContent = {
  name: "Review",
  description: "",
  parameters: [{ name: "ticket", description: "Ticket", required: true }],
  defaults: { humanApproval: true },
  workflow: {
    contexts: [{ key: "review", brief: "Review {{inputs.ticket}}." }],
  },
};
const stored: RunTemplateRecord = {
  ...content,
  format: 1,
  id: "review",
  revision: 5,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-13T00:00:00.000Z",
};
const templateUrl = "/api/projects/alpha/run-templates/project/review";

let api: FetchFixture;
beforeEach(() => {
  api = installFetchFixture();
});
afterEach(() => api.restore());

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const detail = runTemplateKeys.detail("alpha", "project", "review");
  const list = runTemplateKeys.list("alpha");
  client.setQueryData(detail, {
    template: { ...stored, revision: 4 },
    globals: RUN_SETTING_DEFAULTS,
  });
  client.setQueryData(list, { items: [], diagnostics: [] });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
  return { client, wrapper, detail, list };
}

const save = {
  tier: "project",
  id: "review",
  expectedRevision: 4,
  template: content,
} as const;

describe("saving a run template", () => {
  it("puts the content at its base revision, then caches the stored record and refreshes the list", async () => {
    api.json("PUT", templateUrl, { template: stored });
    const { client, wrapper, detail, list } = setup();
    const { result } = renderHook(() => useSaveRunTemplateMutation("alpha"), {
      wrapper,
    });

    await expect(result.current.mutateAsync(save)).resolves.toEqual({
      kind: "saved",
      template: stored,
    });

    expect(api.requestsTo("PUT", templateUrl)[0]?.jsonBody).toEqual({
      expectedRevision: 4,
      template: content,
    });
    expect(client.getQueryData(detail)).toEqual({
      template: stored,
      globals: RUN_SETTING_DEFAULTS,
    });
    await waitFor(() =>
      expect(client.getQueryState(list)?.isInvalidated).toBe(true),
    );
  });

  it("keeps a newer revision another writer's event already cached", async () => {
    api.json("PUT", templateUrl, { template: stored });
    const { client, wrapper, detail } = setup();
    const newer = {
      template: { ...stored, revision: 6, name: "Saved after mine" },
      globals: RUN_SETTING_DEFAULTS,
    };
    client.setQueryData(detail, newer);
    const { result } = renderHook(() => useSaveRunTemplateMutation("alpha"), {
      wrapper,
    });

    await expect(result.current.mutateAsync(save)).resolves.toEqual({
      kind: "saved",
      template: stored,
    });
    expect(client.getQueryData(detail)).toEqual(newer);
  });

  it("answers a revision conflict as a conflict, leaving the cached template alone", async () => {
    api.reply("PUT", templateUrl, {
      status: 409,
      json: {
        error: "Run template project:review is at revision 5, not 4",
        code: "run_template_revision_conflict",
        details: { currentRevision: 5 },
      },
    });
    const { client, wrapper, detail } = setup();
    const { result } = renderHook(() => useSaveRunTemplateMutation("alpha"), {
      wrapper,
    });

    await expect(result.current.mutateAsync(save)).resolves.toEqual({
      kind: "conflict",
      currentRevision: 5,
    });
    expect(client.getQueryData(detail)).toEqual({
      template: { ...stored, revision: 4 },
      globals: RUN_SETTING_DEFAULTS,
    });
  });

  it("refuses an invalid template with each located issue", async () => {
    api.reply("PUT", templateUrl, {
      status: 400,
      json: {
        error: "Run template project:review is invalid",
        code: "run_template_invalid",
        issues: [
          {
            path: "defaults.implementer.profile",
            message: "Profile project:gone does not exist",
          },
        ],
      },
    });
    const { wrapper } = setup();
    const { result } = renderHook(() => useSaveRunTemplateMutation("alpha"), {
      wrapper,
    });

    await expect(result.current.mutateAsync(save)).rejects.toThrow(
      "Run template project:review is invalid\ndefaults.implementer.profile: Profile project:gone does not exist",
    );
  });
});

describe("launching a run template", () => {
  const launchUrl = "/api/projects/alpha/sessions/fix/runs/template";
  const request = {
    template: { tier: "project", id: "review", revision: 5 },
    owner: { kind: "new", title: "Review owner" },
    parameters: { ticket: "CC-12" },
  } as const;

  it("posts the request and refreshes the session's runs", async () => {
    const receipt = {
      runId: "run-1",
      contextIds: ["run-1.review"],
      progress: { kind: "running" },
      ownerConversationId: "c-1",
    };
    api.reply("POST", launchUrl, { status: 202, json: receipt });
    const { client, wrapper } = setup();
    client.setQueryData(runKeys.list("alpha", "fix"), []);
    const { result } = renderHook(
      () => useLaunchRunTemplateMutation("alpha", "fix"),
      { wrapper },
    );

    await expect(result.current.mutateAsync(request)).resolves.toEqual(receipt);
    expect(api.requestsTo("POST", launchUrl)[0]?.jsonBody).toEqual(request);
    await waitFor(() =>
      expect(
        client.getQueryState(runKeys.list("alpha", "fix"))?.isInvalidated,
      ).toBe(true),
    );
  });
});

describe("a launch refusal", () => {
  it("is placed at the parameter its issue names", () => {
    const error = new ApiCallError(
      "The launch's parameter values are invalid",
      "run_template_launch_invalid",
      undefined,
      undefined,
      400,
      [{ path: "parameters.ticket", message: '"ticket" is required' }],
    );
    expect(launchRefusalOf(error)).toEqual({
      message: '"ticket" is required',
      parameter: "ticket",
    });
  });

  it("says the template changed when the revision shown is no longer current", () => {
    const error = new ApiCallError(
      "Run template project:review is at revision 6",
      "run_template_changed",
      undefined,
      { currentRevision: 6 },
      409,
    );
    expect(launchRefusalOf(error)).toEqual({
      message:
        "The template was saved again since this dialog opened; it is now at revision 6. Review the latest revision, then launch it.",
    });
  });

  it("keeps any other refusal's message, unplaced", () => {
    const error = new ApiCallError(
      "Owner c-9 cannot own this run",
      "owner_not_eligible",
      undefined,
      undefined,
      409,
    );
    expect(launchRefusalOf(error)).toEqual({
      message: "Owner c-9 cannot own this run",
    });
    expect(launchRefusalOf(new TypeError("Failed to fetch"))).toEqual({
      message: "Failed to fetch",
    });
  });
});
