import { describe, it, expect, beforeEach } from "vitest";
import { _useSessionsStore } from "./sessions.store";

function resetStore() {
  _useSessionsStore.setState({
    showCreateModal: false,
    deleteTarget: null,
  });
}

describe("sessions.store", () => {
  beforeEach(resetStore);

  // -----------------------------------------------------------------------
  // showCreateModal
  // -----------------------------------------------------------------------

  it("starts with showCreateModal = false", () => {
    expect(_useSessionsStore.getState().showCreateModal).toBe(false);
  });

  it("openCreateModal sets showCreateModal to true", () => {
    _useSessionsStore.getState().openCreateModal();
    expect(_useSessionsStore.getState().showCreateModal).toBe(true);
  });

  it("closeCreateModal sets showCreateModal to false", () => {
    _useSessionsStore.getState().openCreateModal();
    _useSessionsStore.getState().closeCreateModal();
    expect(_useSessionsStore.getState().showCreateModal).toBe(false);
  });

  // -----------------------------------------------------------------------
  // deleteTarget
  // -----------------------------------------------------------------------

  it("starts with deleteTarget = null", () => {
    expect(_useSessionsStore.getState().deleteTarget).toBeNull();
  });

  it("confirmDeleteSession sets the delete target", () => {
    const target = { sessionName: "my-session", projectName: "my-project" };
    _useSessionsStore.getState().confirmDeleteSession(target);
    expect(_useSessionsStore.getState().deleteTarget).toEqual(target);
  });

  it("cancelDeleteSession clears the delete target", () => {
    _useSessionsStore.getState().confirmDeleteSession({
      sessionName: "s",
      projectName: "p",
    });
    _useSessionsStore.getState().cancelDeleteSession();
    expect(_useSessionsStore.getState().deleteTarget).toBeNull();
  });
});
