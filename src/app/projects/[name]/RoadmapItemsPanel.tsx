"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import type { RoadmapItem, RoadmapItemType } from "@/types";
import { useRoadmapItemsQuery } from "@/lib/queries";
import {
  useCreateRoadmapItemMutation,
  useUpdateRoadmapItemMutation,
  useDeleteRoadmapItemMutation,
  useStartRoadmapFocusMutation,
} from "@/lib/mutations";
import {
  useShowArchivedRoadmapItems,
  useToggleArchivedRoadmapItems,
} from "@/stores/roadmap-items.store";
import ConfirmDialog from "@/components/ConfirmDialog";

const TYPE_LABELS: Record<RoadmapItemType, string> = {
  bug: "Bug",
  feature: "Feature",
  idea: "Idea",
};

interface RoadmapItemsPanelProps {
  projectName: string;
}

export default function RoadmapItemsPanel({
  projectName,
}: RoadmapItemsPanelProps) {
  const router = useRouter();
  const { data: items = [] } = useRoadmapItemsQuery(projectName);
  const createMutation = useCreateRoadmapItemMutation(projectName);
  const updateMutation = useUpdateRoadmapItemMutation(projectName);
  const deleteMutation = useDeleteRoadmapItemMutation(projectName);
  const focusMutation = useStartRoadmapFocusMutation(projectName);

  const showArchived = useShowArchivedRoadmapItems();
  const toggleArchived = useToggleArchivedRoadmapItems();

  const [collapsed, setCollapsed] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  // Add form state
  const [newTitle, setNewTitle] = useState("");
  const [newType, setNewType] = useState<RoadmapItemType>("feature");
  const [newDescription, setNewDescription] = useState("");

  const archivedCount = useMemo(
    () => items.filter((i) => i.archived).length,
    [items],
  );

  const visibleItems = useMemo(() => {
    if (showArchived) return items;
    return items.filter((i) => !i.archived);
  }, [items, showArchived]);

  const activeCount = items.filter((i) => !i.archived).length;

  function handleSubmit() {
    const title = newTitle.trim();
    if (!title) return;
    createMutation.mutate(
      {
        title,
        type: newType,
        description: newDescription.trim() || undefined,
      },
      {
        onSuccess: () => {
          setNewTitle("");
          setNewType("feature");
          setNewDescription("");
          setShowAddForm(false);
        },
      },
    );
  }

  function handleCancel() {
    setNewTitle("");
    setNewType("feature");
    setNewDescription("");
    setShowAddForm(false);
  }

  function handleToggleStatus(item: RoadmapItem) {
    updateMutation.mutate({
      itemId: item.id,
      status: item.status === "done" ? "incomplete" : "done",
    });
  }

  function handleArchive(itemId: string, archived: boolean) {
    updateMutation.mutate({ itemId, archived });
  }

  function handleDelete(itemId: string) {
    setDeleteTarget(itemId);
  }

  function confirmDelete() {
    if (deleteTarget) {
      deleteMutation.mutate(deleteTarget);
      setDeleteTarget(null);
    }
  }

  function handleStartFocus(itemId: string) {
    focusMutation.mutate(itemId, {
      onSuccess: (data) => {
        const sessionName = data.session.sessionName;
        router.push(
          `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(sessionName)}`,
        );
      },
    });
  }

  return (
    <div className="roadmap-panel">
      {/* Header */}
      <div className="roadmap-header">
        <button
          className="roadmap-header-toggle"
          onClick={() => setCollapsed(!collapsed)}
        >
          <span className={`roadmap-chevron ${collapsed ? "collapsed" : ""}`}>
            ▾
          </span>
          <span className="roadmap-label">Roadmap</span>
          <span className="roadmap-count">({activeCount})</span>
        </button>

        <div className="roadmap-header-actions">
          {archivedCount > 0 && (
            <button
              className={`btn btn-sm btn-toggle ${showArchived ? "active" : ""}`}
              onClick={toggleArchived}
            >
              Archived ({archivedCount})
            </button>
          )}
          <button
            className="btn btn-primary btn-sm"
            onClick={() => setShowAddForm(!showAddForm)}
          >
            <span className="btn-icon">+</span> Add Item
          </button>
        </div>
      </div>

      {/* Collapsed — hide everything below */}
      {!collapsed && (
        <>
          {/* Add form */}
          {showAddForm && (
            <div className="roadmap-add-form">
              <div className="roadmap-add-row">
                <input
                  className="roadmap-add-input"
                  type="text"
                  placeholder="Item title..."
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newTitle.trim()) handleSubmit();
                    if (e.key === "Escape") handleCancel();
                  }}
                  autoFocus
                />
              </div>
              <div className="roadmap-add-row">
                <div className="roadmap-type-selector">
                  {(["bug", "feature", "idea"] as const).map((type) => (
                    <button
                      key={type}
                      className={`roadmap-type-btn ${newType === type ? `selected ${type}` : ""}`}
                      onClick={() => setNewType(type)}
                    >
                      {TYPE_LABELS[type]}
                    </button>
                  ))}
                </div>
                <div className="roadmap-add-actions">
                  <button className="btn btn-sm" onClick={handleCancel}>
                    Cancel
                  </button>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={handleSubmit}
                    disabled={!newTitle.trim() || createMutation.isPending}
                  >
                    {createMutation.isPending ? "Adding..." : "Add"}
                  </button>
                </div>
              </div>
              <div className="roadmap-add-row">
                <textarea
                  className="roadmap-add-textarea"
                  placeholder="Optional description..."
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                />
              </div>
            </div>
          )}

          {/* Item list */}
          {visibleItems.length > 0 ? (
            <div className="roadmap-list">
              {visibleItems.map((item) => (
                <div
                  key={item.id}
                  className={`roadmap-item ${item.status === "done" ? "done" : ""} ${item.archived ? "archived" : ""}`}
                >
                  <button
                    className={`roadmap-checkbox ${item.status === "done" ? "checked" : ""}`}
                    onClick={() => handleToggleStatus(item)}
                    aria-label={
                      item.status === "done" ? "Mark incomplete" : "Mark done"
                    }
                  >
                    {item.status === "done" && "✓"}
                  </button>

                  <span className={`roadmap-type ${item.type}`}>
                    {TYPE_LABELS[item.type]}
                  </span>

                  <span className="roadmap-item-title">{item.title}</span>

                  <div className="roadmap-item-actions">
                    {item.status !== "done" && (
                      <button
                        className="roadmap-btn-focus"
                        data-tooltip="Start Focus Session"
                        onClick={() => handleStartFocus(item.id)}
                        disabled={focusMutation.isPending}
                      >
                        ▶
                      </button>
                    )}
                    <button
                      className="btn-icon-only"
                      data-tooltip={item.archived ? "Unarchive" : "Archive"}
                      onClick={() => handleArchive(item.id, !item.archived)}
                    >
                      {item.archived ? "↩" : "↓"}
                    </button>
                    <button
                      className="btn-icon-only danger"
                      data-tooltip="Delete"
                      onClick={() => handleDelete(item.id)}
                    >
                      ×
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="roadmap-empty">
              <div className="roadmap-empty-icon">✦</div>
              <div className="roadmap-empty-text">
                No roadmap items yet. Add bugs, features, or ideas to track.
              </div>
            </div>
          )}
        </>
      )}

      {/* Delete confirmation dialog */}
      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete Roadmap Item"
        message="This will permanently remove this item. This action cannot be undone."
        confirmLabel="Delete"
        danger
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
