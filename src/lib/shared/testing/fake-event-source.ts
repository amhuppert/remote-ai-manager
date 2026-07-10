/**
 * Test double for the browser `EventSource` consumed by NotificationListener.
 * Tests stub it over the global (`vi.stubGlobal("EventSource", FakeEventSource)`)
 * and drive SSE frames through `emit`, which mirrors the broadcaster's wire
 * format: every real frame carries the transport envelope stamp (`_sentAt`),
 * so handlers must tolerate it — emitting the bare event would hide
 * envelope-intolerant schemas (`.strict()` schemas reject stamped frames).
 */
export class FakeEventSource {
  static instances: FakeEventSource[] = [];

  static reset(): void {
    FakeEventSource.instances = [];
  }

  listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  onerror: ((this: EventSource, ev: Event) => unknown) | null = null;
  onopen: ((this: EventSource, ev: Event) => unknown) | null = null;

  constructor(_url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  removeEventListener(type: string, listener: (event: MessageEvent) => void) {
    const existing = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      existing.filter((entry) => entry !== listener),
    );
  }

  close() {}

  emit(type: string, data: unknown) {
    const listeners = this.listeners.get(type) ?? [];
    const envelope =
      data !== null && typeof data === "object"
        ? { ...data, _sentAt: 1_700_000_000_000 }
        : data;
    const event = { data: JSON.stringify(envelope) } as MessageEvent;
    for (const listener of listeners) {
      listener(event);
    }
  }
}
