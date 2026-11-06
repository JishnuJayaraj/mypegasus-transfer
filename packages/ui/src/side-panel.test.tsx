import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { SidePanel, type PendingNavigation } from "./side-panel";
import { renderUi } from "./test-utils";

// C4 (ui-patterns.md, drafts): edited input is never discarded silently.
function Harness({
  onClose,
  pendingNavigation,
}: {
  onClose: () => void;
  pendingNavigation?: PendingNavigation;
}) {
  const [name, setName] = useState("");
  return (
    <SidePanel
      open
      title="Region bearbeiten"
      dirty={name !== ""}
      onClose={onClose}
      pendingNavigation={pendingNavigation}
      footer={<button type="button">{"Speichern"}</button>}
    >
      <label>
        {"Name"}
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
    </SidePanel>
  );
}

/** Dispatches a `beforeunload`; whether the page asked to stay. */
const beforeUnload = () => {
  const e = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
};

/** A button that opens a panel, which gives the focus back on close. */
function Launcher() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        {"Öffnen"}
      </button>
      <SidePanel open={open} title="Region anlegen" onClose={() => setOpen(false)}>
        <p>{"Inhalt"}</p>
      </SidePanel>
    </>
  );
}

const closeButton = () => screen.getByRole("button", { name: "Schließen" });

describe("SidePanel", () => {
  it("is a labelled dialog that closes directly without changes", async () => {
    const onClose = vi.fn<() => void>();
    renderUi(<Harness onClose={onClose} />);
    expect(screen.getByRole("dialog", { name: "Region bearbeiten" })).toBeInTheDocument();
    await userEvent.click(closeButton());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("asks before discarding edited input, with the focus on the safe choice", async () => {
    const onClose = vi.fn<() => void>();
    renderUi(<Harness onClose={onClose} />);
    await userEvent.type(screen.getByLabelText("Name"), "Nord");
    await userEvent.click(closeButton());
    expect(onClose).not.toHaveBeenCalled();
    const ask = screen.getByRole("alertdialog", { name: "Änderungen verwerfen?" });
    expect(ask).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Weiter bearbeiten" })).toHaveFocus(),
    );
    expect(screen.queryByRole("button", { name: "Speichern" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Verwerfen" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps the input on Escape, first from the panel and then from the question", async () => {
    const onClose = vi.fn<() => void>();
    renderUi(<Harness onClose={onClose} />);
    await userEvent.type(screen.getByLabelText("Name"), "Nord");
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("Nord");
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));
  });

  it("asks the same question for a navigation the router holds back", async () => {
    const navigation = { proceed: vi.fn<() => void>(), reset: vi.fn<() => void>() };
    const onClose = vi.fn<() => void>();
    const { rerender } = renderUi(<Harness onClose={onClose} />);
    await userEvent.type(screen.getByLabelText("Name"), "Nord");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    rerender(<Harness onClose={onClose} pendingNavigation={navigation} />);
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Weiter bearbeiten" }));
    expect(navigation.reset).toHaveBeenCalledOnce();
    rerender(<Harness onClose={onClose} pendingNavigation={navigation} />);
    await userEvent.click(screen.getByRole("button", { name: "Verwerfen" }));
    expect(navigation.proceed).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("asks the browser before a reload while dirty, and stores nothing", async () => {
    renderUi(<Harness onClose={() => {}} />);
    expect(beforeUnload()).toBe(false);
    await userEvent.type(screen.getByLabelText("Name"), "Nord");
    expect(beforeUnload()).toBe(true);
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  it("returns the focus to its launcher on close", async () => {
    renderUi(<Launcher />);
    const launcher = screen.getByRole("button", { name: "Öffnen" });
    await userEvent.click(launcher);
    await userEvent.click(closeButton());
    await waitFor(() => expect(launcher).toHaveFocus());
  });
});
