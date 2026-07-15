/**
 * OS-level browser notification for background-tab attention events.
 * Only fires when the document is hidden — a visible tab already surfaces the
 * same information through in-app toasts. Permission is requested lazily on
 * first use rather than at app load.
 */
export interface BrowserNotificationInput {
  title: string;
  body: string;
  tag: string;
}

export function showBrowserNotification(input: BrowserNotificationInput): void {
  if (!document.hidden || !("Notification" in window)) return;
  if (Notification.permission === "granted") {
    const n = new Notification(input.title, {
      body: input.body,
      tag: input.tag,
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
    return;
  }
  if (Notification.permission !== "denied") {
    void Notification.requestPermission();
  }
}
