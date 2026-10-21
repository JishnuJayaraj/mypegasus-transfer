import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { customPage, page, wizardState } from "./testing/fixtures";
import { refused, renderWizard } from "./testing/render";

// The self-service wizard over a fake source (regional-variation.md, "Self-service wizard";
// data-protection.md, self-service). Synthetic values only.

const heading = (name: string) => screen.findByRole("heading", { level: 1, name });

describe("the purposes notice", () => {
  it("comes first and is acknowledged in the language shown", async () => {
    const user = userEvent.setup();
    const before = wizardState({
      notice: { version: "self-service-purposes:v1", acknowledged: false },
    });
    const { source } = renderWizard([before, wizardState()], { step: "contact" });
    await heading("Wofür wir Ihre Angaben verwenden");
    expect(screen.getByText(/Bitte tragen Sie keine Diagnosen ein/)).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Gelesen, weiter" }));
    expect(source.acknowledge).toHaveBeenCalledWith("de");
    // The page asked for follows the notice.
    await heading("Kontakt");
  });
});

describe("a page from its definition", () => {
  it("renders the fields, required markers, help texts and the progress", async () => {
    const state = wizardState();
    state.pages[0] = page(
      "personal",
      [
        { key: "gender", required: true, help: { de: "So wie im Ausweis.", en: "As in your ID." } },
        "maritalStatus",
      ],
      false,
    );
    renderWizard([state]);
    await heading("Persönliches");
    expect(screen.getByRole("group", { name: "Geschlecht *" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Familienstand" })).toBeInTheDocument();
    expect(screen.getByText("So wie im Ausweis.")).toBeInTheDocument();
    expect(screen.getByText("Seite 1 von 6")).toBeInTheDocument();
    expect(screen.getByText("4 von 6 Seiten vollständig")).toBeInTheDocument();
    expect(screen.getByText(/Mit \* gekennzeichnete Angaben sind Pflichtangaben/)).toBeVisible();
    expect(screen.getByText(/mit Ihrer Beraterin oder Ihrem Berater ergänzen/)).toBeVisible();
    expect(screen.getByText(/keine Diagnosen/)).toBeVisible();
    // The first page has no way back.
    expect(screen.queryByRole("button", { name: "Zurück" })).toBeNull();
  });

  it("switches between German and English", async () => {
    const state = wizardState();
    state.pages[0] = page("personal", [
      { key: "gender", required: true, help: { de: "So wie im Ausweis.", en: "As in your ID." } },
    ]);
    const { i18n } = renderWizard([state], { step: "personal" });
    await heading("Persönliches");
    await act(() => i18n.changeLanguage("en"));
    await heading("Personal details");
    expect(screen.getByRole("group", { name: "Gender *" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Not specified" })).toBeInTheDocument();
    expect(screen.getByText("As in your ID.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeInTheDocument();
  });

  it("shows names and birth date read-only on the contact page", async () => {
    renderWizard([wizardState()], { step: "contact" });
    await heading("Kontakt");
    expect(screen.getByText("Erika Beispiel")).toBeInTheDocument();
    expect(screen.getByText("01.01.1970")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /Name/ })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Straße und Hausnummer" })).toBeInTheDocument();
  });
});

describe("saving on Weiter", () => {
  it("saves the page whole with the revision and goes to the next page", async () => {
    const user = userEvent.setup();
    const { source, steps } = renderWizard([wizardState()]);
    await heading("Persönliches");
    await user.click(screen.getByRole("radio", { name: "Weiblich" }));
    await user.click(screen.getByRole("button", { name: "Weiter" }));
    expect(source.save).toHaveBeenCalledWith("personal", {
      revision: 3,
      values: { gender: "female", maritalStatus: null },
    });
    await heading("Kontakt");
    expect(steps).toEqual(["contact"]);
    await user.click(screen.getByRole("button", { name: "Zurück" }));
    await heading("Persönliches");
  });

  it("goes from the last page to the overview, which lists what is missing", async () => {
    const user = userEvent.setup();
    const { steps } = renderWizard([wizardState()], { step: "job_wish" });
    await heading("Arbeitswunsch");
    await user.click(screen.getByRole("button", { name: "Weiter" }));
    await heading("Übersicht");
    expect(steps).toEqual(["overview"]);
    const personal = screen.getByRole("heading", { name: "Persönliches" }).closest("li")!;
    expect(within(personal).getByText("Es fehlt noch eine Pflichtangabe:")).toBeInTheDocument();
    expect(within(personal).getByText("Geschlecht")).toBeInTheDocument();
    const contact = screen.getByRole("heading", { name: "Kontakt" }).closest("li")!;
    expect(within(contact).getByText("Vollständig")).toBeInTheDocument();
    // The sensitive pages are listed with their missing items, without a link yet.
    const agentur = screen.getByRole("heading", { name: "Angaben für die Agentur" }).closest("li")!;
    expect(within(agentur).getByText("Staatsangehörigkeit")).toBeInTheDocument();
    expect(within(agentur).getByText(/Diese Angaben können Sie bald hier eintragen/)).toBeVisible();
    expect(within(agentur).queryByRole("button")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Persönliches bearbeiten" }));
    await heading("Persönliches");
  });

  it("enters dates as TT.MM.JJJJ, refuses impossible ones and sends ISO", async () => {
    const user = userEvent.setup();
    const { source } = renderWizard([wizardState()], { step: "job_wish" });
    const date = await screen.findByLabelText("Frühester Arbeitsbeginn");
    await user.type(date, "31.02.2027");
    await user.click(screen.getByRole("button", { name: "Weiter" }));
    expect(
      await screen.findByText("Bitte geben Sie ein gültiges Datum im Format TT.MM.JJJJ ein."),
    ).toBeInTheDocument();
    expect(screen.getByText("Bitte prüfen Sie die markierten Angaben.")).toBeInTheDocument();
    expect(source.save).not.toHaveBeenCalled();
    await user.clear(date);
    await user.type(date, "1.3.2027");
    await user.click(screen.getByRole("button", { name: "Weiter" }));
    await waitFor(() => expect(source.save).toHaveBeenCalledTimes(1));
    expect(source.save.mock.calls[0]![1].values).toMatchObject({ earliestStartDate: "2027-03-01" });
  });

  it("shows the API's codes at their fields (422)", async () => {
    const user = userEvent.setup();
    renderWizard([wizardState()], {
      step: "contact",
      save: async () => {
        throw refused(422, "too_long", "/values/address/city");
      },
    });
    await heading("Kontakt");
    await user.type(screen.getByLabelText("Straße und Hausnummer"), "Musterweg 1");
    await user.type(screen.getByLabelText("Postleitzahl"), "10115");
    await user.type(screen.getByLabelText("Ort"), "Berlin");
    await user.click(screen.getByRole("button", { name: "Weiter" }));
    expect(await screen.findByText("Dieser Text ist zu lang.")).toBeInTheDocument();
    expect(screen.getByLabelText("Ort")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Kontakt");
  });

  it("reloads on a stale revision (409) and says so", async () => {
    const user = userEvent.setup();
    const newer = wizardState({
      revision: 4,
      values: { ...wizardState().values, gender: "male" },
    });
    const { source } = renderWizard([wizardState(), newer], {
      step: "personal",
      save: async () => {
        throw refused(409, "stale_revision");
      },
    });
    await heading("Persönliches");
    await user.click(screen.getByRole("radio", { name: "Weiblich" }));
    await user.click(screen.getByRole("button", { name: "Weiter" }));
    expect(
      await screen.findByText(/Ihre Angaben wurden inzwischen an anderer Stelle geändert/),
    ).toBeInTheDocument();
    expect(source.load).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("radio", { name: "Männlich" })).toBeChecked();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Persönliches");
  });

  it("shows the notice again when a new version is required (409)", async () => {
    const user = userEvent.setup();
    const unacknowledged = wizardState({
      notice: { version: "self-service-purposes:v1", acknowledged: false },
    });
    renderWizard([wizardState(), unacknowledged], {
      step: "personal",
      save: async () => {
        throw refused(409, "notice_required");
      },
    });
    await heading("Persönliches");
    await user.click(screen.getByRole("button", { name: "Weiter" }));
    await heading("Wofür wir Ihre Angaben verwenden");
    expect(screen.getByText(/Die Hinweise haben sich geändert/)).toBeInTheDocument();
  });

  it("explains a closed participation and an ended session", async () => {
    const user = userEvent.setup();
    let call = 0;
    renderWizard([wizardState()], {
      step: "personal",
      save: async () => {
        throw call++ === 0 ? refused(422, "participation_closed") : refused(401, "unauthenticated");
      },
    });
    await heading("Persönliches");
    await user.click(screen.getByRole("button", { name: "Weiter" }));
    expect(await screen.findByText(/Ihre Teilnahme ist abgeschlossen/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Weiter" }));
    expect(await screen.findByText("Sitzung abgelaufen")).toBeInTheDocument();
  });
});

describe("resume", () => {
  it("opens the first page with missing items", async () => {
    const pages = wizardState().pages.map((p) =>
      p.page === "personal" ? { ...p, complete: true } : p,
    );
    renderWizard([wizardState({ pages })]);
    await heading("Schule und Ausbildung");
    expect(screen.getByText("Seite 3 von 6")).toBeInTheDocument();
    expect(screen.getByText("5 von 6 Seiten vollständig")).toBeInTheDocument();
  });

  it("says when loading failed or the session ended", async () => {
    renderWizard([], { load: async () => Promise.reject(new Error("offline")) });
    expect(await screen.findByText(/konnten nicht geladen werden/)).toBeInTheDocument();
  });

  it("hands an ended session to the app", async () => {
    renderWizard([], { load: async () => Promise.reject(refused(401, "unauthenticated")) });
    expect(await screen.findByText("Sitzung abgelaufen")).toBeInTheDocument();
  });
});

describe("row tables", () => {
  it("adds and removes rows within the limit and warns when von is after bis", async () => {
    const user = userEvent.setup();
    const { source } = renderWizard([wizardState()], { step: "education" });
    await heading("Schule und Ausbildung");
    expect(screen.getByText("Noch keine Einträge.")).toBeInTheDocument();
    expect(screen.getByText("Höchstens 20 Einträge.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Eintrag hinzufügen" }));
    await user.click(screen.getByRole("button", { name: "Eintrag hinzufügen" }));
    const first = screen.getByRole("group", { name: "Ausbildung 1" });
    await user.type(within(first).getByLabelText("Von"), "01.09.1990");
    await user.type(within(first).getByLabelText("Bis"), "30.06.1986");
    await user.type(within(first).getByLabelText("Schule, Betrieb oder Hochschule"), "Schule");
    await user.type(within(first).getByLabelText("Ausbildung oder Abschluss"), "Abitur");
    await user.selectOptions(within(first).getByLabelText("Abgeschlossen?"), "yes");
    expect(within(first).getByText(/liegt nach dem Datum „bis“/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Eintrag 2 entfernen" }));
    expect(screen.queryByRole("group", { name: "Ausbildung 2" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Weiter" }));
    await waitFor(() => expect(source.save).toHaveBeenCalledTimes(1));
    expect(source.save).toHaveBeenCalledWith("education", {
      revision: 3,
      values: {
        educationHistory: [
          {
            from: "1990-09-01",
            to: "1986-06-30",
            institution: "Schule",
            qualification: "Abitur",
            completed: true,
          },
        ],
      },
    });
  });

  it("offers no more rows than the form allows", async () => {
    const row = { from: "2001-01-01", to: null, employer: "Werk", activity: "Montage" };
    const state = wizardState({
      values: { ...wizardState().values, workHistory: Array.from({ length: 20 }, () => row) },
    });
    renderWizard([state], { step: "work_history" });
    await heading("Beruflicher Werdegang");
    expect(screen.getByRole("button", { name: "Eintrag hinzufügen" })).toBeDisabled();
    expect(screen.getAllByRole("group", { name: /^Tätigkeit \d+$/ })).toHaveLength(20);
  });

  it("takes driving licence classes or keinen Führerschein", async () => {
    const user = userEvent.setup();
    const { source } = renderWizard([wizardState()], { step: "languages_mobility" });
    await heading("Sprachen und Mobilität");
    await user.click(screen.getByRole("checkbox", { name: "BE" }));
    await user.click(screen.getByRole("checkbox", { name: "B" }));
    await user.click(screen.getByRole("checkbox", { name: "Keinen Führerschein" }));
    expect(screen.getByRole("checkbox", { name: "B" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "B" })).not.toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: "Keinen Führerschein" }));
    await user.click(screen.getByRole("checkbox", { name: "BE" }));
    await user.click(screen.getByRole("checkbox", { name: "B" }));
    await user.click(screen.getByRole("checkbox", { name: "C1" }));
    await user.click(screen.getByRole("checkbox", { name: "C1" }));
    await user.selectOptions(screen.getByLabelText("Deutsch"), "business_fluent");
    await user.click(screen.getByRole("button", { name: "Eintrag hinzufügen" }));
    await user.type(screen.getByLabelText("Sprache"), "Englisch");
    await user.selectOptions(screen.getByLabelText("Kenntnisse"), "basic");
    await user.click(screen.getByRole("radio", { name: "Ja" }));
    await user.click(screen.getByRole("button", { name: "Weiter" }));
    await waitFor(() => expect(source.save).toHaveBeenCalledTimes(1));
    expect(source.save.mock.calls[0]![1].values).toEqual({
      languageSkills: {
        german: "business_fluent",
        others: [{ language: "Englisch", level: "basic" }],
      },
      drivingLicence: ["B", "BE"],
      vehicleAvailable: true,
    });
  });
});

describe("the job wish page", () => {
  it("collects working time, wishes, locations and distance", async () => {
    const user = userEvent.setup();
    const { source } = renderWizard([wizardState()], { step: "job_wish" });
    await heading("Arbeitswunsch");
    await user.click(screen.getByRole("radio", { name: "Teilzeit" }));
    await user.type(screen.getByLabelText("Stunden pro Woche"), "30");
    await user.type(screen.getByLabelText("Gewünschte Verteilung der Arbeitszeit"), "vormittags");
    await user.type(screen.getByLabelText("Gewünschte Tätigkeit"), "Lagerlogistik");
    await user.type(screen.getByLabelText("Gewünschte Arbeitsorte"), "Beispielstadt");
    await user.click(screen.getByRole("radio", { name: "Bis zu einer Entfernung" }));
    await user.type(screen.getByLabelText("Entfernung in km"), "40");
    await user.click(screen.getByRole("button", { name: "Weiter" }));
    await waitFor(() => expect(source.save).toHaveBeenCalledTimes(1));
    expect(source.save.mock.calls[0]![1].values).toEqual({
      workingTimePreferences: {
        employmentType: "part_time",
        weeklyHours: 30,
        distribution: "vormittags",
      },
      jobWishes: { desired: "Lagerlogistik", alternative: null },
      desiredWorkLocations: "Beispielstadt",
      maxCommuteDistance: { kind: "km", km: 40 },
      earliestStartDate: null,
    });
  });
});

describe("custom fields (Weitere Angaben)", () => {
  it("renders them from their field schema and validates them in the browser", async () => {
    const user = userEvent.setup();
    const state = wizardState();
    state.pages.push(customPage(false));
    const { source } = renderWizard([state], { step: "further" });
    await heading("Weitere Angaben");
    expect(screen.getByText("Seite 7 von 7")).toBeInTheDocument();
    const number = screen.getByLabelText("Nachweis-Nr. (Beispiel) *");
    expect(screen.getByText("Oben rechts auf dem Nachweis.")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Beispiel ja/nein" })).toBeInTheDocument();
    await user.type(number, "12a");
    await user.click(screen.getByRole("button", { name: "Weiter" }));
    expect(await screen.findByText("Das Format dieser Angabe stimmt nicht.")).toBeInTheDocument();
    expect(source.save).not.toHaveBeenCalled();
    await user.clear(number);
    await user.type(number, "123");
    await user.click(screen.getByRole("radio", { name: "Nein" }));
    await user.click(screen.getByRole("button", { name: "Weiter" }));
    await waitFor(() => expect(source.save).toHaveBeenCalledTimes(1));
    expect(source.save).toHaveBeenCalledWith("further", {
      revision: 3,
      values: { "custom.beispiel_nr": "123", "custom.beispiel_ja": false },
    });
  });
});

describe("the sensitive pages", () => {
  it("are a placeholder until their own path exists", async () => {
    const user = userEvent.setup();
    renderWizard([wizardState()], { step: "health" });
    await heading("Gesundheit");
    expect(screen.getByText(/Diese Angaben können Sie bald hier eintragen/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Weiter" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Zur Übersicht" }));
    await heading("Übersicht");
  });
});
