import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { DetailHeader } from "./detail-header";
import { Facts } from "./facts";
import { Funnel } from "./funnel";
import { NextSteps } from "./next-steps";
import { SectionCard } from "./section-card";
import { Split } from "./layout";
import { StepList } from "./step-list";
import { TrackBar } from "./track-bar";
import { renderUi } from "./test-utils";

// The kit's second layer (ui-patterns.md, which pattern). Synthetic values only.

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe("DetailHeader", () => {
  const facts = ["A", "B", "C", "D", "E", "F"].map((label) => ({ label, value: `Wert ${label}` }));

  it("has one h1, the metadata line, the tags, the one primary action and at most five facts", () => {
    renderUi(
      <DetailHeader
        title="Beispiel, Erika"
        breadcrumbs={[
          <a key="projects" href="/projects">
            {"Projekte"}
          </a>,
        ]}
        metadata="Personalnummer BSP-0001"
        tags={<span>{"Status: Informiert"}</span>}
        facts={facts}
        primaryAction={<button type="button">{"Profilingbogen erzeugen"}</button>}
        menuActions={[
          { label: "Löschen", onClick: () => {}, danger: true },
          { label: "Erinnern", onClick: () => {} },
        ]}
      />,
    );
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Beispiel, Erika");
    expect(screen.getByText("Personalnummer BSP-0001")).toBeInTheDocument();
    expect(screen.getByText("Status: Informiert")).toBeInTheDocument();
    expect(
      within(screen.getByRole("navigation", { name: "Navigationspfad" })).getByRole("link"),
    ).toHaveTextContent("Projekte");
    expect(screen.getAllByRole("term").map((term) => term.textContent)).toEqual([
      "A",
      "B",
      "C",
      "D",
      "E",
    ]);
    expect(screen.getByRole("button", { name: "Profilingbogen erzeugen" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Aktionen" })).toBeInTheDocument();
  });

  it("renders no menu and no facts without any", () => {
    renderUi(<DetailHeader title="Projekt" />);
    expect(screen.queryByRole("button", { name: "Aktionen" })).not.toBeInTheDocument();
    expect(screen.queryByRole("term")).not.toBeInTheDocument();
  });
});

describe("SectionCard", () => {
  it("collapses to its title and summary, opens on its heading's button, stores nothing", async () => {
    renderUi(
      <SectionCard title="Welle und Vertragsdaten" summary="W1 · 01.03.2027 – 29.02.2028">
        <p>{"Inhalt"}</p>
      </SectionCard>,
    );
    const card = screen.getByRole("region", { name: "Welle und Vertragsdaten" });
    const toggle = within(card).getByRole("button", { name: "Welle und Vertragsdaten" });
    expect(toggle.closest("h2")).not.toBeNull();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(card).getByText("W1 · 01.03.2027 – 29.02.2028")).toBeInTheDocument();
    expect(screen.queryByText("Inhalt")).not.toBeInTheDocument();

    toggle.focus();
    await userEvent.keyboard("{Enter}");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)).toContainElement(
      screen.getByText("Inhalt"),
    );
    // Open, the content stands for itself: no summary.
    expect(within(card).queryByText("W1 · 01.03.2027 – 29.02.2028")).not.toBeInTheDocument();
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  it("starts open with defaultOpen, as an h3 on request", () => {
    renderUi(
      <SectionCard title="Stammdaten" level={3} defaultOpen>
        <p>{"Inhalt"}</p>
      </SectionCard>,
    );
    expect(screen.getByRole("heading", { level: 3, name: "Stammdaten" })).toBeInTheDocument();
    expect(screen.getByText("Inhalt")).toBeInTheDocument();
  });

  it("never starts open with protected content, and renders it only once opened", async () => {
    renderUi(
      <SectionCard title="Gesundheit" defaultOpen protectedContent>
        <p>{"besonders geschützt"}</p>
      </SectionCard>,
    );
    expect(screen.queryByText("besonders geschützt")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Gesundheit" }));
    expect(screen.getByText("besonders geschützt")).toBeInTheDocument();
  });
});

describe("Facts", () => {
  it("is a definition list with a dash for a missing value", () => {
    const { container } = renderUi(
      <Facts
        columns={4}
        labels="above"
        items={[
          { label: "Nachname", value: "Beispiel" },
          { label: "Mobil", value: null },
          { label: "Telefon", value: "" },
        ]}
      />,
    );
    const list = container.querySelector("dl")!;
    expect(list).toHaveClass("tp-fact-grid--4", "tp-fact-grid--above");
    expect(screen.getAllByRole("definition").map((d) => d.textContent)).toEqual([
      "Beispiel",
      "–",
      "–",
    ]);
  });
});

describe("NextSteps", () => {
  it("lists the open items with their tone as text and each one's own action", () => {
    renderUi(
      <NextSteps
        title="Als Nächstes"
        summary="2 von 6 offenen Punkten"
        emptyText="Nichts offen."
        more={<a href="#all">{"Alle 6 anzeigen"}</a>}
        items={[
          {
            id: "asu",
            tone: "danger",
            toneLabel: "Überfällig",
            title: "Arbeitsuchendmeldung fehlt",
            detail: "seit 2 Tagen überfällig · 05.02.2027",
            action: <button type="button">{"Meldung erfassen"}</button>,
          },
          { id: "dsv", tone: "warning", toneLabel: "Bald fällig", title: "DSV zurückerwartet" },
        ]}
      />,
    );
    const card = within(screen.getByRole("region", { name: "Als Nächstes" }));
    const items = card.getAllByRole("listitem");
    expect(items.map((item) => item.querySelector(".tp-next-steps-text")!.textContent)).toEqual([
      "Überfällig: Arbeitsuchendmeldung fehltseit 2 Tagen überfällig · 05.02.2027",
      "Bald fällig: DSV zurückerwartet",
    ]);
    expect(within(items[0]!).getByRole("button", { name: "Meldung erfassen" })).toBeInTheDocument();
    expect(within(items[1]!).queryByRole("button")).not.toBeInTheDocument();
    expect(card.getByRole("link", { name: "Alle 6 anzeigen" })).toBeInTheDocument();
  });

  it("says so when nothing is open", () => {
    renderUi(<NextSteps title="Als Nächstes" emptyText="Nichts offen." items={[]} />);
    expect(screen.getByText("Nichts offen.")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });
});

describe("SectionCard, held by its caller", () => {
  it("is as open as the caller says and reports a toggle", async () => {
    const toggles: boolean[] = [];
    const { rerender } = renderUi(
      <SectionCard title="Welle" open={false} onToggle={(open) => toggles.push(open)}>
        <p>{"Inhalt"}</p>
      </SectionCard>,
    );
    expect(screen.queryByText("Inhalt")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Welle" }));
    expect(toggles).toEqual([true]);
    rerender(
      <SectionCard title="Welle" open onToggle={() => {}}>
        <p>{"Inhalt"}</p>
      </SectionCard>,
    );
    expect(screen.getByText("Inhalt")).toBeInTheDocument();
  });
});

describe("StepList", () => {
  const steps = [
    { id: "data", title: "Angaben prüfen", state: "done" as const, children: <p>{"geprüft"}</p> },
    {
      id: "form",
      title: "Bogen erzeugen",
      state: "current" as const,
      status: "bereit",
      children: <button type="button">{"Profilingbogen erzeugen"}</button>,
    },
    {
      id: "sign",
      title: "Unterschrift",
      state: "blocked" as const,
      status: "wartet auf den Bogen",
    },
    { id: "send", title: "An die Agentur", state: "open" as const },
  ];

  it("names its track, starts on the current step and says each step's state", () => {
    renderUi(<StepList label="Profiling" steps={steps} />);
    const list = within(screen.getByRole("navigation", { name: "Profiling" }));
    expect(list.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Angaben prüfenErledigt",
      "Bogen erzeugenAktuell: bereit",
      "UnterschriftBlockiert: wartet auf den Bogen",
      "An die AgenturOffen",
    ]);
    expect(list.getByRole("button", { name: /Bogen erzeugen/ })).toHaveAttribute(
      "aria-current",
      "step",
    );
    const panel = within(screen.getByRole("region", { name: "Bogen erzeugen" }));
    expect(panel.getByRole("button", { name: "Profilingbogen erzeugen" })).toBeInTheDocument();
    expect(screen.queryByText("geprüft")).not.toBeInTheDocument();
  });

  it("opens another step by keyboard, one at a time", async () => {
    renderUi(<StepList label="Profiling" steps={steps} />);
    const first = screen.getByRole("button", { name: /Angaben prüfen/ });
    first.focus();
    await userEvent.keyboard("{Enter}");
    expect(first).toHaveAttribute("aria-current", "step");
    expect(screen.getByRole("button", { name: /Bogen erzeugen/ })).not.toHaveAttribute(
      "aria-current",
    );
    expect(screen.getByRole("region", { name: "Angaben prüfen" })).toHaveTextContent("geprüft");
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  it("keeps an unselected step's input when asked to, hidden from everyone", async () => {
    const withInput = [{ ...steps[0]!, children: <input aria-label="Notiz" /> }, steps[1]!];
    renderUi(<StepList label="Profiling" steps={withInput} keepMounted />);
    expect(screen.queryByRole("textbox", { name: "Notiz" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Angaben prüfen/ }));
    await userEvent.type(screen.getByRole("textbox", { name: "Notiz" }), "Entwurf");
    await userEvent.click(screen.getByRole("button", { name: /Bogen erzeugen/ }));
    expect(screen.queryByRole("textbox", { name: "Notiz" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Angaben prüfen/ }));
    expect(screen.getByRole("textbox", { name: "Notiz" })).toHaveValue("Entwurf");
  });

  it("shows the step its caller selects and reports a choice", async () => {
    const chosen: string[] = [];
    renderUi(
      <StepList
        label="Profiling"
        steps={steps}
        selected="data"
        onSelect={(id) => chosen.push(id)}
      />,
    );
    expect(screen.getByRole("region", { name: "Angaben prüfen" })).toHaveTextContent("geprüft");
    await userEvent.click(screen.getByRole("button", { name: /An die Agentur/ }));
    expect(chosen).toEqual(["send"]);
  });

  it("starts on the first step when none is current", () => {
    renderUi(<StepList label="Einrichtung" steps={[steps[0]!, steps[3]!]} level={2} />);
    expect(screen.getByRole("heading", { level: 2, name: "Angaben prüfen" })).toBeInTheDocument();
  });
});

describe("TrackBar", () => {
  it("is one named track: its steps with the current one, done ones said so, and its tag", () => {
    renderUi(
      <TrackBar
        title="Profiling"
        steps={["Offen", "Angenommen", "In Arbeit", "Abgeschlossen"]}
        current={2}
        tag={<span>{"In Arbeit (Tag)"}</span>}
      >
        {"Schritt 3 von 4"}
      </TrackBar>,
    );
    const track = within(screen.getByRole("region", { name: "Profiling" }));
    const list = track.getByRole("list", { name: "Schritte: Profiling" });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Offen (erledigt)", "Angenommen (erledigt)", "In Arbeit", "Abgeschlossen"]);
    expect(within(list).getByText("In Arbeit").closest("li")).toHaveAttribute(
      "aria-current",
      "step",
    );
    expect(track.getByText("In Arbeit (Tag)")).toBeInTheDocument();
    expect(track.getByText("Schritt 3 von 4")).toBeInTheDocument();
  });

  it("has no bar for a status off the path", () => {
    renderUi(
      <TrackBar title="Status" steps={["Importiert"]} current={-1} tag={<span>{"Tag"}</span>} />,
    );
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });
});

describe("Split", () => {
  it("puts the side column after the main one in the document", () => {
    renderUi(<Split side={<p>{"Seite"}</p>}>{<p>{"Haupt"}</p>}</Split>);
    expect(screen.getByText("Haupt").compareDocumentPosition(screen.getByText("Seite"))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
});

describe("Funnel", () => {
  it("is one named row of stages; a stage with a link opens its rows", () => {
    renderUi(
      <Funnel
        label="Verlauf"
        stages={[
          {
            key: "imported",
            count: 6,
            label: "Importiert",
            renderLink: ({ className, children }) => (
              <a href="/list?status=imported" className={className}>
                {children}
              </a>
            ),
          },
          { key: "exited", count: 3, label: "Ausgetreten", ended: true },
        ]}
      />,
    );
    const row = within(screen.getByRole("list", { name: "Verlauf" }));
    expect(row.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "6 Importiert",
      "3 Ausgetreten",
    ]);
    expect(row.getByRole("link", { name: "6 Importiert" })).toHaveAttribute(
      "href",
      "/list?status=imported",
    );
    expect(row.getByText("Ausgetreten").closest(".tp-funnel-stage")).toHaveClass(
      "tp-funnel-stage--ended",
    );
  });
});
