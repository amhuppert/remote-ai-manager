import { create } from "zustand";

/**
 * A file linked from an agent message, previewed in a dialog. Each entry is
 * self-contained so the preview outlives the surface that opened it — a
 * sidebar peek closes itself as the preview opens.
 */
export type FilePreview =
  | {
      kind: "image";
      src: string;
      fileName: string;
      imagePath: string;
      alt: string;
    }
  | {
      kind: "markdown";
      projectName: string;
      sessionName: string;
      docPath: string;
      title: string;
    };

export interface FilePreviewState {
  preview: FilePreview | null;
  /** The control that opened the preview; focus returns to it on close. */
  returnFocusTo: HTMLElement | null;
  openPreview(preview: FilePreview, returnFocusTo: HTMLElement | null): void;
  closePreview(): void;
}

export const useFilePreviewStore = create<FilePreviewState>()((set) => ({
  preview: null,
  returnFocusTo: null,
  openPreview: (preview, returnFocusTo) => set({ preview, returnFocusTo }),
  closePreview: () => set({ preview: null, returnFocusTo: null }),
}));
