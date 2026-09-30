import { getGlobalValue, setGlobalValue } from "@/lib/shared/global-singleton";
export interface SubscriptionWakeWithdrawal {
  projectPath: string;
  sessionName: string;
  conversationId: string;
  batchId: string;
  allowMissing: boolean;
  commit(): void;
}
export interface SubscriptionWakeQueueControl {
  withdraw(input: SubscriptionWakeWithdrawal): Promise<boolean>;
}
/** The queue supplies its operation so subscription composition does not import the queue singleton. */
export function registerSubscriptionWakeQueueControl(
  control: SubscriptionWakeQueueControl,
): void {
  setGlobalValue("__cc_subscription_wake_queue_control", control);
}
export async function withdrawSubscriptionWakeFromQueue(
  input: SubscriptionWakeWithdrawal,
): Promise<boolean> {
  const control = getGlobalValue<SubscriptionWakeQueueControl>(
    "__cc_subscription_wake_queue_control",
  );
  if (!control)
    throw Error("The subscription wake queue control is not initialized");
  return control.withdraw(input);
}
