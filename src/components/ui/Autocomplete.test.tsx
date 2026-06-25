// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  AutocompleteListbox,
  AutocompleteOption,
  AutocompleteMatchText,
  AutocompleteNavFooter,
  autocompletePopupClass,
  autocompleteItemClass,
  conversationItemClass,
} from "./Autocomplete";

describe("AutocompleteListbox", () => {
  it("renders a role=listbox region with the given accessible name", () => {
    render(
      <AutocompleteListbox label="Commands">
        <AutocompleteOption active onSelect={() => {}} onHover={() => {}}>
          item
        </AutocompleteOption>
      </AutocompleteListbox>,
    );
    expect(
      screen.getByRole("listbox", { name: "Commands" }),
    ).toBeInTheDocument();
  });

  it("applies the popup recipe and passes through the max-height utility", () => {
    const { container } = render(
      <AutocompleteListbox label="Files" maxHeightClassName="max-h-[340px]">
        <span>row</span>
      </AutocompleteListbox>,
    );
    const popup = container.firstElementChild as HTMLElement;
    // The popup recipe's first token plus the caller's max-height are both present.
    expect(popup.className).toContain(autocompletePopupClass.split(" ")[0]);
    expect(popup.className).toContain("max-h-[340px]");
  });

  it("renders header and footer slots outside the listbox", () => {
    render(
      <AutocompleteListbox
        label="Files"
        header={<div>HEADER</div>}
        footer={<div>FOOTER</div>}
      >
        <span>row</span>
      </AutocompleteListbox>,
    );
    const listbox = screen.getByRole("listbox");
    expect(screen.getByText("HEADER")).toBeInTheDocument();
    expect(screen.getByText("FOOTER")).toBeInTheDocument();
    // Slots are not inside the listbox element (APG: listbox children are options).
    expect(listbox).not.toContainElement(screen.getByText("HEADER"));
    expect(listbox).not.toContainElement(screen.getByText("FOOTER"));
  });

  it("renders the loading slot and marks the listbox busy when loading", () => {
    render(
      <AutocompleteListbox
        label="Files"
        loading
        loadingLabel="Scanning files..."
      >
        <span>row</span>
      </AutocompleteListbox>,
    );
    expect(screen.getByText("Scanning files...")).toBeInTheDocument();
    expect(screen.getByRole("listbox")).toHaveAttribute("aria-busy", "true");
    // Status chrome must not be a child of the listbox (APG: listbox children
    // are options/groups only).
    expect(screen.getByRole("listbox")).not.toContainElement(
      screen.getByText("Scanning files..."),
    );
    // Options are not rendered while loading.
    expect(screen.queryByText("row")).not.toBeInTheDocument();
  });

  it("renders the error slot outside the listbox when error is set", () => {
    render(
      <AutocompleteListbox label="Files" error="Network failure">
        <span>row</span>
      </AutocompleteListbox>,
    );
    expect(screen.getByText("Network failure")).toBeInTheDocument();
    expect(screen.getByRole("listbox")).not.toContainElement(
      screen.getByText("Network failure"),
    );
    // Error states surface as an alert live region for assistive tech.
    expect(screen.getByRole("alert")).toHaveTextContent("Network failure");
    expect(screen.queryByText("row")).not.toBeInTheDocument();
  });

  it("renders the empty slot outside the listbox when isEmpty and not loading/error", () => {
    render(
      <AutocompleteListbox label="Files" isEmpty empty={<>No matching files</>}>
        <span>row</span>
      </AutocompleteListbox>,
    );
    expect(screen.getByText("No matching files")).toBeInTheDocument();
    expect(screen.getByRole("listbox")).not.toContainElement(
      screen.getByText("No matching files"),
    );
    expect(screen.queryByText("row")).not.toBeInTheDocument();
  });

  it("renders option children when not loading/error/empty", () => {
    render(
      <AutocompleteListbox label="Files">
        <AutocompleteOption active onSelect={() => {}} onHover={() => {}}>
          the-row
        </AutocompleteOption>
      </AutocompleteListbox>,
    );
    expect(screen.getByText("the-row")).toBeInTheDocument();
    expect(screen.getByRole("listbox")).not.toHaveAttribute(
      "aria-busy",
      "true",
    );
  });
});

describe("AutocompleteOption", () => {
  it("exposes role=option with aria-selected and data-active reflecting active", () => {
    const { rerender } = render(
      <AutocompleteOption active onSelect={() => {}} onHover={() => {}}>
        row
      </AutocompleteOption>,
    );
    const option = screen.getByRole("option");
    expect(option).toHaveAttribute("aria-selected", "true");
    expect(option).toHaveAttribute("data-active", "true");

    rerender(
      <AutocompleteOption active={false} onSelect={() => {}} onHover={() => {}}>
        row
      </AutocompleteOption>,
    );
    expect(screen.getByRole("option")).toHaveAttribute(
      "aria-selected",
      "false",
    );
    expect(screen.getByRole("option")).toHaveAttribute("data-active", "false");
  });

  it("forwards a stable id for aria-activedescendant wiring", () => {
    render(
      <AutocompleteOption
        active
        id="opt-3"
        onSelect={() => {}}
        onHover={() => {}}
      >
        row
      </AutocompleteOption>,
    );
    expect(screen.getByRole("option")).toHaveAttribute("id", "opt-3");
  });

  it("calls onSelect on click and onHover on mouse enter", () => {
    const onSelect = vi.fn();
    const onHover = vi.fn();
    render(
      <AutocompleteOption active onSelect={onSelect} onHover={onHover}>
        row
      </AutocompleteOption>,
    );
    const option = screen.getByRole("option");
    fireEvent.mouseEnter(option);
    expect(onHover).toHaveBeenCalledTimes(1);
    fireEvent.click(option);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("uses the default item recipe by default and the conversation recipe for the conversation variant", () => {
    const { rerender } = render(
      <AutocompleteOption active onSelect={() => {}} onHover={() => {}}>
        row
      </AutocompleteOption>,
    );
    expect(screen.getByRole("option").className).toBe(autocompleteItemClass);

    rerender(
      <AutocompleteOption
        active
        variant="conversation"
        onSelect={() => {}}
        onHover={() => {}}
      >
        row
      </AutocompleteOption>,
    );
    expect(screen.getByRole("option").className).toBe(conversationItemClass);
  });

  it("flags archived rows via data-archived when archived is provided", () => {
    render(
      <AutocompleteOption
        active
        variant="conversation"
        archived
        onSelect={() => {}}
        onHover={() => {}}
      >
        row
      </AutocompleteOption>,
    );
    expect(screen.getByRole("option")).toHaveAttribute("data-archived", "true");
  });
});

describe("AutocompleteNavFooter", () => {
  it("renders the standard navigate/select/close hints", () => {
    render(<AutocompleteNavFooter />);
    expect(screen.getByText(/navigate/)).toBeInTheDocument();
    expect(screen.getByText(/select/)).toBeInTheDocument();
    expect(screen.getByText(/close/)).toBeInTheDocument();
  });

  it("appends an extra hint slot", () => {
    render(<AutocompleteNavFooter extra={<span>Alt+A archived</span>} />);
    expect(screen.getByText("Alt+A archived")).toBeInTheDocument();
  });
});

describe("AutocompleteMatchText", () => {
  it("renders the full text and wraps matched indices in the match class", () => {
    const { container } = render(
      <AutocompleteMatchText text="parser" indices={[0, 1]} />,
    );
    expect(container.textContent).toBe("parser");
    const matched = container.querySelectorAll(".text-cyan");
    expect(matched.length).toBeGreaterThan(0);
    const matchedText = Array.from(matched)
      .map((n) => n.textContent)
      .join("");
    expect(matchedText).toBe("pa");
  });

  it("renders plain text with no match spans when indices is empty", () => {
    const { container } = render(
      <AutocompleteMatchText text="parser" indices={[]} />,
    );
    expect(container.textContent).toBe("parser");
    expect(container.querySelectorAll(".text-cyan")).toHaveLength(0);
  });
});
