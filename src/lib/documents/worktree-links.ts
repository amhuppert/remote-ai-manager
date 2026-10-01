import { isMarkdownPath, normalizeWorktreeLocator } from "./path";

/**
 * Resolves links in agent messages that point at files rather than web pages.
 * Agents link files by absolute path, worktree-relative path, or an
 * editor-style `path:line`; none of those work as an href on Command Center's
 * origin. Pure, so the transcript classifies links at render time.
 */

export type WorktreeLinkTarget =
  | {
      kind: "markdown";
      docPath: string;
      location: "worktree" | "external";
      fileName: string;
    }
  | { kind: "image"; imagePath: string; fileName: string };

const IMAGE_MEDIA_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
};

const URL_SCHEME = /^[a-z][a-z\d+.-]*:/i;
const LINE_SUFFIX = /:\d+(?::\d+)?$/;

/** The media type served for an image path, or null for a non-image path. */
export function imageMediaType(path: string): string | null {
  const extension = /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase();
  return extension === undefined
    ? null
    : (IMAGE_MEDIA_TYPES[extension] ?? null);
}

function linkedFilePath(href: string): string | null {
  if (href.startsWith("#") || href.startsWith("//") || URL_SCHEME.test(href)) {
    return null;
  }
  const withoutSuffix = href.split(/[?#]/, 1)[0] ?? "";
  try {
    return decodeURIComponent(withoutSuffix).replace(LINE_SUFFIX, "");
  } catch {
    return null;
  }
}

function fileNameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * Classify a message link. Markdown resolves to the viewer's canonical
 * identity, inside or outside the worktree. Images resolve only inside the
 * worktree, the one place the image endpoint serves from. Anything else is
 * null and stays an ordinary link.
 */
export function resolveWorktreeLink(
  href: string | undefined,
  worktreeRoot: string,
): WorktreeLinkTarget | null {
  const filePath = href === undefined ? null : linkedFilePath(href);
  if (!filePath) return null;

  if (isMarkdownPath(filePath)) {
    const located = normalizeWorktreeLocator(filePath, worktreeRoot);
    return {
      kind: "markdown",
      docPath: located.path,
      location: located.location,
      fileName: fileNameOf(located.path),
    };
  }

  if (imageMediaType(filePath) === null) return null;
  const located = normalizeWorktreeLocator(filePath, worktreeRoot);
  if (located.location !== "worktree") return null;
  return {
    kind: "image",
    imagePath: located.path,
    fileName: fileNameOf(located.path),
  };
}

/**
 * Whose files a message link resolves against: a session's worktree, or the
 * project root for a project conversation (`sessionName` null).
 */
export interface LinkedFileScope {
  projectName: string;
  sessionName: string | null;
}

export function worktreeImageUrl(
  scope: LinkedFileScope,
  imagePath: string,
): string {
  const project = `/api/projects/${encodeURIComponent(scope.projectName)}`;
  const owner =
    scope.sessionName === null
      ? project
      : `${project}/sessions/${encodeURIComponent(scope.sessionName)}`;
  return `${owner}/worktree-images?path=${encodeURIComponent(imagePath)}`;
}
