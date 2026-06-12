/**
 * URL vocabulary for the /conversations page.
 *
 * `?c=` selects a conversation by id; `project`+`session` (always together)
 * seed the rail's session filter on entry; `autoFocus=true` focuses the
 * prompt editor once on initial mount. Pure functions — every link site and
 * the page itself go through these helpers instead of hand-building URLs.
 */

export interface ConversationsPageHrefOpts {
  conversationId?: string;
  /** Only meaningful together with sessionName; a lone half is omitted. */
  projectName?: string;
  sessionName?: string;
  autoFocus?: boolean;
}

export interface ConversationsPageParams {
  conversationId: string | null;
  sessionFilter: { projectName: string; sessionName: string } | null;
  autoFocus: boolean;
}

export function conversationsPageHref(opts: ConversationsPageHrefOpts): string {
  const parts: string[] = [];
  if (opts.conversationId !== undefined) {
    parts.push(`c=${encodeURIComponent(opts.conversationId)}`);
  }
  if (opts.projectName !== undefined && opts.sessionName !== undefined) {
    parts.push(`project=${encodeURIComponent(opts.projectName)}`);
    parts.push(`session=${encodeURIComponent(opts.sessionName)}`);
  }
  if (opts.autoFocus === true) {
    parts.push("autoFocus=true");
  }
  if (parts.length === 0) return "/conversations";
  return `/conversations?${parts.join("&")}`;
}

export function parseConversationsPageParams(
  params: URLSearchParams,
): ConversationsPageParams {
  const projectName = params.get("project");
  const sessionName = params.get("session");
  return {
    conversationId: params.get("c"),
    sessionFilter:
      projectName !== null && sessionName !== null
        ? { projectName, sessionName }
        : null,
    autoFocus: params.get("autoFocus") === "true",
  };
}
