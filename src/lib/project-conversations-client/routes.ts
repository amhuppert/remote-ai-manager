export function projectConversationFocusHref(
  projectName: string,
  conversationId: string,
): string {
  return `/projects/${encodeURIComponent(projectName)}?focus=${encodeURIComponent(conversationId)}`;
}
