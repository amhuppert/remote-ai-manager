import { describe, expect, it } from "vitest";
import {
  createSubscriptionSourcePresentationReader,
  type SubscriptionSourcePresentationDeps,
} from "./overview-production";

const recipient = {
  projectPath: "/repo space",
  conversationId: "conversation",
};
function harness() {
  const deps: SubscriptionSourcePresentationDeps = {
    async findNotepad() {
      return { name: "Shared notes", scope: "global", projectPath: null };
    },
    async findTicket() {
      return {
        title: "Notification controls",
        number: 170,
        projectPath: recipient.projectPath,
      };
    },
    async findSpec() {
      return {
        name: "Subscriptions",
        slug: "subscription controls",
        projectPath: recipient.projectPath,
      };
    },
    findWorkflowAddress() {
      return {
        projectPath: recipient.projectPath,
        sessionName: "session space",
      };
    },
    findWorkflow() {
      return { id: "workflow", launchDocument: { name: "Delivery workflow" } };
    },
    findValidation() {
      return {
        projectPath: recipient.projectPath,
        commandName: "test",
        sessionName: "session space",
        conversationId: "conversation",
      };
    },
    findJob() {
      return {
        jobType: "merge",
        projectName: "repo space",
        sessionName: "session space",
      };
    },
  };
  return { deps, read: createSubscriptionSourcePresentationReader(deps) };
}
describe("subscription source presentation", () => {
  it("resolves all source titles and existing browser destinations with encoded identities", async () => {
    const h = harness();
    expect(await h.read(recipient, { kind: "notepad", id: "notes" })).toEqual({
      title: "Shared notes",
      href: null,
    });
    expect(await h.read(recipient, { kind: "ticket", id: "ticket" })).toEqual({
      title: "Notification controls",
      href: "/tickets/repo%20space/170",
    });
    expect(await h.read(recipient, { kind: "spec", id: "spec" })).toEqual({
      title: "Subscriptions",
      href: "/specs/repo%20space/subscription%20controls",
    });
    expect(
      await h.read(recipient, { kind: "workflow", id: "workflow" }),
    ).toEqual({
      title: "Delivery workflow",
      href: "/projects/repo%20space/session%20space/workflow?execution=workflow",
    });
    expect(await h.read(recipient, { kind: "validation", id: "run" })).toEqual({
      title: "test validation",
      href: "/conversations?c=conversation",
    });
    expect(await h.read(recipient, { kind: "git_job", id: "job" })).toEqual({
      title: "merge session space",
      href: "/projects/repo%20space/session%20space",
    });
  });
  it("keeps missing or differently owned sources from linking to another project's resource", async () => {
    const h = harness();
    const other = { projectPath: "/other", conversationId: "conversation" };
    for (const kind of [
      "ticket",
      "spec",
      "workflow",
      "validation",
      "git_job",
    ] as const) {
      expect(await h.read(other, { kind, id: "foreign" })).toEqual({
        title: `${kind} foreign`,
        href: null,
      });
    }
    h.deps.findNotepad = async () => ({
      name: "Private",
      scope: "project",
      projectPath: "/other",
    });
    expect(await h.read(recipient, { kind: "notepad", id: "private" })).toEqual(
      { title: "notepad private", href: null },
    );
    h.deps.findSpec = async () => null;
    expect(await h.read(recipient, { kind: "spec", id: "gone" })).toEqual({
      title: "spec gone",
      href: null,
    });
  });
  it("navigates validation runs through their canonical conversation, session or project surface", async () => {
    const h = harness();
    h.deps.findValidation = () => ({
      projectPath: recipient.projectPath,
      commandName: "seams",
      sessionName: null,
      conversationId: "project conversation",
    });
    expect(
      (await h.read(recipient, { kind: "validation", id: "run" })).href,
    ).toBe("/projects/repo%20space?focus=project%20conversation");
    h.deps.findValidation = () => ({
      projectPath: recipient.projectPath,
      commandName: "seams",
      sessionName: "session space",
      conversationId: null,
    });
    expect(
      (await h.read(recipient, { kind: "validation", id: "run" })).href,
    ).toBe("/projects/repo%20space/session%20space");
    h.deps.findValidation = () => ({
      projectPath: recipient.projectPath,
      commandName: "seams",
      sessionName: null,
      conversationId: null,
    });
    expect(
      (await h.read(recipient, { kind: "validation", id: "run" })).href,
    ).toBe("/projects/repo%20space");
  });
});
