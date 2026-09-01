import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import type { JobStatusEvent } from "@/lib/jobs/schemas";
import { normalizeTicketListFilters } from "./list-filters";
import { resolveMergeDoneTicketPrompt } from "./merge-done-prompt";
import { ticketKeys } from "./query-keys";
import type {
  TicketDetail,
  TicketLinkSummary,
  TicketListItem,
  TicketStatus,
} from "./schemas";

function jobEvent(overrides: Partial<JobStatusEvent> = {}): JobStatusEvent {
  return {
    type: "job-status",
    jobType: "merge",
    status: "completed",
    projectName: "proj",
    sessionName: "sess",
    jobId: "job-1",
    branchName: "csm/x",
    ...overrides,
  };
}

function linkSummary(
  overrides: Partial<TicketLinkSummary> = {},
): TicketLinkSummary {
  return {
    ticketId: "ticket-1",
    projectName: "proj",
    number: 37,
    title: "Suggest moving ticket to Done on merge",
    active: false,
    linkedAt: "2026-07-30T00:00:00.000Z",
    endedAt: "2026-07-31T00:00:00.000Z",
    ...overrides,
  };
}

function listItem(status: TicketStatus): TicketListItem {
  return {
    id: "ticket-1",
    projectPath: "/repos/proj",
    projectName: "proj",
    number: 37,
    title: "Suggest moving ticket to Done on merge",
    workType: "feature",
    status,
    attachmentCount: 0,
    activeSessionName: null,
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z",
  };
}

interface SeedInput {
  links?: Record<string, TicketLinkSummary>;
  listStatus?: TicketStatus;
  detailStatus?: TicketStatus;
}

function seed({ links, listStatus, detailStatus }: SeedInput): QueryClient {
  const queryClient = new QueryClient();
  if (links !== undefined) {
    queryClient.setQueryData(ticketKeys.sessionLinks("proj"), links);
  }
  if (listStatus !== undefined) {
    queryClient.setQueryData(
      ticketKeys.list(normalizeTicketListFilters({ projectName: "proj" })),
      [listItem(listStatus)],
    );
  }
  if (detailStatus !== undefined) {
    const detail: TicketDetail = {
      id: "ticket-1",
      projectPath: "/repos/proj",
      projectName: "proj",
      number: 37,
      title: "Suggest moving ticket to Done on merge",
      description: "",
      workType: "feature",
      status: detailStatus,
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-31T00:00:00.000Z",
      attachments: [],
      sessions: [],
      relationships: [],
      statusUpdates: { total: 0, recent: [] },
    };
    queryClient.setQueryData(ticketKeys.detail("proj", 37), detail);
  }
  return queryClient;
}

describe("resolveMergeDoneTicketPrompt", () => {
  it("suggests Done for the ticket linked to a session whose merge completed", () => {
    const queryClient = seed({
      links: { sess: linkSummary() },
      listStatus: "in_progress",
    });

    expect(resolveMergeDoneTicketPrompt(queryClient, jobEvent())).toEqual({
      jobId: "job-1",
      projectName: "proj",
      sessionName: "sess",
      ticketNumber: 37,
      ticketTitle: "Suggest moving ticket to Done on merge",
    });
  });

  it("suggests Done when a conflict-resolution job publishes the merge", () => {
    const queryClient = seed({
      links: { sess: linkSummary() },
      listStatus: "in_progress",
    });

    expect(
      resolveMergeDoneTicketPrompt(
        queryClient,
        jobEvent({ jobType: "resolve-conflicts" }),
      ),
    ).not.toBeNull();
  });

  it("stays silent until the merge fully succeeds", () => {
    const queryClient = seed({
      links: { sess: linkSummary() },
      listStatus: "in_progress",
    });

    for (const status of [
      "running",
      "ready-to-land",
      "conflicts",
      "failed",
      "discarded",
    ] as const) {
      expect(
        resolveMergeDoneTicketPrompt(queryClient, jobEvent({ status })),
      ).toBeNull();
    }
  });

  it("ignores non-merge job types that complete", () => {
    const queryClient = seed({
      links: { sess: linkSummary() },
      listStatus: "in_progress",
    });

    for (const jobType of ["commit", "rebase"] as const) {
      expect(
        resolveMergeDoneTicketPrompt(queryClient, jobEvent({ jobType })),
      ).toBeNull();
    }
  });

  it("stays silent for a session with no ticket link", () => {
    const queryClient = seed({ links: { other: linkSummary() } });

    expect(resolveMergeDoneTicketPrompt(queryClient, jobEvent())).toBeNull();
  });

  it("stays silent when the ticket already reached a terminal status", () => {
    for (const status of ["done", "closed"] as const) {
      const queryClient = seed({
        links: { sess: linkSummary() },
        listStatus: status,
      });
      expect(resolveMergeDoneTicketPrompt(queryClient, jobEvent())).toBeNull();
    }
  });

  it("reads the ticket status from the detail cache when no list is cached", () => {
    const queryClient = seed({
      links: { sess: linkSummary() },
      detailStatus: "done",
    });

    expect(resolveMergeDoneTicketPrompt(queryClient, jobEvent())).toBeNull();
  });

  it("still suggests Done when the ticket's current status is not cached", () => {
    const queryClient = seed({ links: { sess: linkSummary() } });

    expect(
      resolveMergeDoneTicketPrompt(queryClient, jobEvent()),
    ).not.toBeNull();
  });
});
