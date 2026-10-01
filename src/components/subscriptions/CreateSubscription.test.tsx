// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithQuery } from "@/test/component-mocks";
import { installFetchFixture } from "@/test/fetch-fixture";
import { subscriptionCatalog } from "@/lib/subscriptions/catalog";
import { CreateSubscription } from "./CreateSubscription";
import { subscriptionFixture } from "./fixtures";
afterEach(cleanup);
describe("create subscription source selection", () => {
  it("pages recipients without submitting and creates only for the recipient deliberately selected before submission", async () => {
    const api = installFetchFixture();
    const row = subscriptionFixture();
    const owners = Array.from({ length: 11 }, (_, index) => ({
      ...row.owner,
      target: { ...row.owner.target, conversationId: `recipient-${index + 1}` },
      conversationTitle: `Recipient ${index + 1}`,
    }));
    api.json("GET", "/api/subscriptions/catalog", subscriptionCatalog);
    api.reply("GET", "/api/subscriptions/recipients", (request) => {
      const offset = Number(request.searchParams.get("offset") ?? 0);
      return {
        json: {
          items: owners.slice(offset, offset + 10),
          total: 11,
          offset,
          limit: 10,
        },
      };
    });
    const postPath =
      /^\/api\/projects\/command-center\/sessions\/Notifications\/conversations\/recipient-\d+\/subscriptions$/;
    api.json("POST", postPath, {
      subscription: row.subscription,
      wait: null,
      batch: null,
    });
    const user = userEvent.setup();
    try {
      renderWithQuery(<CreateSubscription source={row.subscription.source} />);
      await user.click(screen.getByRole("button", { name: "+ Subscribe" }));
      await user.click(
        await screen.findByRole("button", { name: /^Recipient 1 ·/ }),
      );
      await user.type(
        screen.getByLabelText("Purpose"),
        "Follow current decisions",
      );
      await user.click(screen.getByRole("button", { name: "Next" }));
      expect(await screen.findByText("11–11 of 11")).toBeInTheDocument();
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(api.requestsTo("POST", postPath)).toHaveLength(0);

      const previous = screen.getByRole("button", {
        name: "Previous",
      });
      previous.focus();
      await user.keyboard("{Enter}");
      expect(await screen.findByText("1–10 of 11")).toBeInTheDocument();
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(api.requestsTo("POST", postPath)).toHaveLength(0);

      await user.click(screen.getByRole("button", { name: "Next" }));
      await user.click(
        await screen.findByRole("button", { name: /^Recipient 11 ·/ }),
      );
      await user.click(screen.getByRole("button", { name: "Subscribe" }));
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      const requests = api.requestsTo("POST", postPath);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.pathname).toBe(
        "/api/projects/command-center/sessions/Notifications/conversations/recipient-11/subscriptions",
      );
      expect(requests[0]?.jsonBody).toEqual({
        source: row.subscription.source,
        mode: "passive",
        reason: "Follow current decisions",
        eventKinds: null,
      });
      expect(api.unmatched).toHaveLength(0);
    } finally {
      api.restore();
    }
  });

  it("clears the entered source id on every kind change, including a return to the supplied source kind", async () => {
    const api = installFetchFixture();
    api.json("GET", "/api/subscriptions/catalog", subscriptionCatalog);
    const row = subscriptionFixture();
    const user = userEvent.setup();
    try {
      renderWithQuery(
        <CreateSubscription
          target={row.owner.target}
          source={row.subscription.source}
        />,
      );
      await user.click(screen.getByRole("button", { name: "+ Subscribe" }));
      expect(await screen.findByLabelText("Notepad ID")).toHaveValue(
        "notepad-1",
      );
      await user.click(screen.getByRole("combobox", { name: "Source type" }));
      await user.click(screen.getByRole("option", { name: "Ticket" }));
      const id = screen.getByPlaceholderText("Paste source ID");
      fireEvent.change(id, { target: { value: "ticket-uuid" } });
      await user.click(screen.getByRole("combobox", { name: "Source type" }));
      await user.click(screen.getByRole("option", { name: "Notepad" }));
      expect(id).toHaveValue("");
    } finally {
      api.restore();
    }
  });
});
