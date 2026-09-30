"use client";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Topbar from "@/components/Topbar";
import WorkRailMain from "@/components/WorkRailMain";
import { SubscriptionWorkspace } from "@/components/subscriptions/SubscriptionWorkspace";
import { subscriptionScopeSchema } from "@/lib/subscriptions/controls-schemas";
export default function SubscriptionsPage() {
  return (
    <Suspense>
      <SubscriptionsPageInner />
    </Suspense>
  );
}
function SubscriptionsPageInner() {
  const params = useSearchParams();
  const query = Object.fromEntries(
    Array.from(params?.entries() ?? []).filter(([key]) =>
      ["project", "session", "conversation", "sourceKind", "sourceId"].includes(
        key,
      ),
    ),
  );
  const scope = subscriptionScopeSchema.safeParse(query);
  return (
    <div className="app" data-page="subscriptions">
      <Topbar
        page="subscriptions"
        breadcrumbs={[
          { label: "projects", href: "/projects" },
          { label: "subscriptions" },
        ]}
      />
      <WorkRailMain enableRailSearchHotkey={false}>
        <main className="mx-auto w-full max-w-[1320px] p-4 max-768:p-0">
          <SubscriptionWorkspace
            key={params?.toString()}
            initialScope={scope.success ? scope.data : {}}
            source={
              scope.success && scope.data.sourceKind && scope.data.sourceId
                ? { kind: scope.data.sourceKind, id: scope.data.sourceId }
                : undefined
            }
            initialSelected={params?.get("selected") ?? null}
          />
        </main>
      </WorkRailMain>
    </div>
  );
}
