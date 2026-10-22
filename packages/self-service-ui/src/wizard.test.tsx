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
    expect(screen.getByText("Seite 1 von 8")).toBeInTheDocument();
    expect(screen.getByText("4 von 8 Seiten vollständig")).toBeInTheDocument();
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
    const state = wizardState({ stepUp: { method: "birth_date", done: true } });
    const { steps, source } = renderWizard([state], { step: "health" });
    await heading("Gesundheit");
    await user.click(screen.getByRole("button", { name: "Weiter" }));
    await heading("Übersicht");
    expect(source.saveSensitive).toHaveBeenCalledWith("health", {
      revision: 3,
      values: { healthRestrictions: null, severeDisability: null },
    });
    expect(steps).toEqual(["overview"]);
    const personal = screen.getByRole("heading", { name: "Persönliches" }).closest("li")!;
    expect(within(personal).getByText("Es fehlt noch eine Pflichtangabe:")).toBeInTheDocument();
    expect(within(personal).getByText("Geschlecht")).toBeInTheDocument();
    const contact = screen.getByRole("heading", { name: "Kontakt" }).closest("li")!;
    expect(within(contact).getByText("Vollständig")).toBeInTheDocument();
    // The sensitive pages are listed like the others: missing items by name, never a value.
    const agentur = screen.getByRole("heading", { name: "Angaben für die Agentur" }).closest("li")!;
    expect(within(agentur).getByText("Staatsangehörigkeit")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Angaben für die Agentur bearbeiten" }));
    await heading("Angaben für die Agentur");
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
    await heading("Angaben für die Agentur");
    expect(screen.getByText("Seite 3 von 8")).toBeInTheDocument();
    expect(screen.getByText("5 von 8 Seiten vollständig")).toBeInTheDocument();
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
    expect(screen.getByText("Seite 9 von 9")).toBeInTheDocument();
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

describe("Angaben für die Agentur (data-protection.md, self-service)", () => {
  const stored = {
    pensionInsuranceNumber: "12345678A123",
    nationality: { kind: "other" as const, country: "PL" },
    entryToGermanyDate: "2015-09-05",
    residenceStatus: "settlement_permit" as const,
    buergergeld: false,
  };

  it("reads the group on its own route and shows every field", async () => {
    const { source } = renderWizard([wizardState()], {
      step: "ba_details",
      sensitive: { ba_details: stored },
    });
    await heading("Angaben für die Agentur");
    expect(source.loadSensitive).toHaveBeenCalledWith("ba_details");
    expect(screen.getByLabelText("Rentenversicherungsnummer *")).toHaveValue("12345678A123");
    expect(screen.getByRole("radio", { name: "Eine andere" })).toBeChecked();
    expect(screen.getByRole("combobox", { name: "Land" })).toHaveValue("PL");
    expect(screen.getByRole("option", { name: "Polen" })).toBeInTheDocument();
    expect(screen.getByLabelText("Einreisedatum")).toHaveValue("05.09.2015");
    expect(screen.getByRole("combobox", { name: "Aufenthaltsstatus" })).toHaveValue(
      "settlement_permit",
    );
    expect(
      within(screen.getByRole("group", { name: "Bürgergeld *" })).getByRole("radio", {
        name: "Nein",
      }),
    ).toBeChecked();
  });

  it("asks entry date and residence status only for another nationality and sends them empty otherwise", async () => {
    const user = userEvent.setup();
    const { source } = renderWizard([wizardState()], { step: "ba_details" });
    await heading("Angaben für die Agentur");
    expect(screen.queryByLabelText("Einreisedatum")).toBeNull();
    await user.type(screen.getByLabelText("Rentenversicherungsnummer *"), "12 345678 a 123");
    await user.click(screen.getByRole("radio", { name: "Eine andere" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Land" }), "TR");
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Aufenthaltsstatus" }),
      "residence_permit",
    );
    await user.click(screen.getByRole("radio", { name: "Deutsch" }));
    expect(screen.queryByRole("combobox", { name: "Aufenthaltsstatus" })).toBeNull();
    await user.click(screen.getByRole("radio", { name: "Ja" }));
    await user.click(screen.getByRole("button", { name: "Weiter" }));
    await waitFor(() => expect(source.saveSensitive).toHaveBeenCalledTimes(1));
    expect(source.saveSensitive).toHaveBeenCalledWith("ba_details", {
      revision: 3,
      values: {
        pensionInsuranceNumber: "12345678A123",
        nationality: { kind: "german" },
        entryToGermanyDate: null,
        residenceStatus: null,
        buergergeld: true,
      },
    });
    expect(source.save).not.toHaveBeenCalled();
  });

  it("checks the RV-Nummer's format before saving", async () => {
    const user = userEvent.setup();
    const { source } = renderWizard([wizardState()], { step: "ba_details" });
    await heading("Angaben für die Agentur");
    await user.type(screen.getByLabelText("Rentenversicherungsnummer *"), "1234");
    await user.click(screen.getByRole("button", { name: "Weiter" }));
    expect(
      await screen.findByText(/Bitte geben Sie die zwölfstellige Rentenversicherungsnummer ein/),
    ).toBeInTheDocument();
    expect(source.saveSensitive).not.toHaveBeenCalled();
  });
});

describe("Gesundheit and the step-up (Q137)", () => {
  it("shows only the step-up until the session has it, then the yes/no questions", async () => {
    const user = userEvent.setup();
    const done = wizardState({ stepUp: { method: "birth_date", done: true } });
    const { source } = renderWizard([wizardState(), done], {
      step: "health",
      sensitive: { health: { healthRestrictions: true, severeDisability: null } },
    });
    await heading("Gesundheit");
    expect(screen.getByText(/einmal pro Anmeldung nötig/)).toBeVisible();
    expect(screen.queryByRole("group", { name: /Gesundheitliche Einschränkungen/ })).toBeNull();
    expect(source.loadSensitive).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText("Ihr Geburtsdatum"), "01.01.1970");
    await user.click(screen.getByRole("button", { name: "Bestätigen" }));
    expect(source.stepUp.birthDate).toHaveBeenCalledWith("1970-01-01");
    const restrictions = await screen.findByRole("group", {
      name: "Gesundheitliche Einschränkungen *",
    });
    expect(within(restrictions).getByRole("radio", { name: "Ja" })).toBeChecked();
    expect(screen.getByText(/nur Ja oder Nein. Bitte nennen Sie keine Diagnosen/)).toBeVisible();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("says when the birth date is wrong, and ends the view at the fifth", async () => {
    const user = userEvent.setup();
    let attempts = 0;
    renderWizard([wizardState()], {
      step: "health",
      stepUp: {
        birthDate: async () => {
          attempts += 1;
          throw refused(422, attempts < 5 ? "knowledge_check_failed" : "step_up_failed");
        },
      },
    });
    await heading("Gesundheit");
    const date = screen.getByLabelText("Ihr Geburtsdatum");
    await user.type(date, "02.01.1970");
    await user.click(screen.getByRole("button", { name: "Bestätigen" }));
    expect(await screen.findByText(/Das Geburtsdatum stimmt nicht/)).toBeInTheDocument();
    for (let i = 0; i < 4; i += 1) {
      await user.click(screen.getByRole("button", { name: "Bestätigen" }));
    }
    expect(await screen.findByText(/fünfmal falsch eingegeben/)).toBeInTheDocument();
    expect(screen.getByText("Sitzung abgelaufen")).toBeInTheDocument();
  });

  it("sends a photo-ID account a code to the channel it picks", async () => {
    const user = userEvent.setup();
    const state = wizardState({ stepUp: { method: "photo_id_and_code", done: false } });
    const done = wizardState({ stepUp: { method: "photo_id_and_code", done: true } });
    const { source } = renderWizard([state, done], {
      step: "health",
      stepUp: {
        channels: async () => [
          {
            id: "00000000-0000-4000-8000-0000000000c1",
            kind: "email",
            maskedAddress: "e***@example.org",
          },
          { id: "00000000-0000-4000-8000-0000000000c2", kind: "sms", maskedAddress: "+49 *** 00" },
        ],
      },
    });
    await heading("Gesundheit");
    expect(screen.queryByLabelText("Ihr Geburtsdatum")).toBeNull();
    await user.click(await screen.findByRole("radio", { name: "+49 *** 00" }));
    await user.click(screen.getByRole("button", { name: "Code senden" }));
    expect(source.stepUp.requestCode).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-0000000000c2",
      "de",
    );
    await user.type(await screen.findByLabelText("Bestätigungscode"), "123456");
    await user.click(screen.getByRole("button", { name: "Bestätigen" }));
    expect(source.stepUp.verifyCode).toHaveBeenCalledWith("123456");
    await screen.findByRole("group", { name: "Gesundheitliche Einschränkungen *" });
  });

  it("asks for the step-up when reading the group is refused with step_up_required", async () => {
    const done = wizardState({ stepUp: { method: "birth_date", done: true } });
    const { source } = renderWizard([done, wizardState()], {
      step: "health",
      loadSensitive: async () => Promise.reject(refused(403, "step_up_required")),
    });
    expect(await screen.findByLabelText("Ihr Geburtsdatum")).toBeInTheDocument();
    expect(source.load).toHaveBeenCalledTimes(2);
  });

  it("may be skipped, and asks again when the API wants the step-up", async () => {
    const user = userEvent.setup();
    const done = wizardState({ stepUp: { method: "birth_date", done: true } });
    const { steps, source } = renderWizard([done, wizardState()], {
      step: "health",
      saveSensitive: async () => Promise.reject(refused(403, "step_up_required")),
    });
    await heading("Gesundheit");
    await user.click(screen.getByRole("button", { name: "Weiter" }));
    expect(await screen.findByLabelText("Ihr Geburtsdatum")).toBeInTheDocument();
    expect(source.load).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole("button", { name: "Ohne diese Angaben weiter" }));
    await heading("Übersicht");
    expect(steps).toEqual(["overview"]);
  });
});

describe("staff in assisted mode (ADR-0007, assisted mode)", () => {
  it("open Gesundheit without a step-up and show only the fields the role sees", async () => {
    const { stepUp: _, ...base } = wizardState();
    const staffState = {
      ...base,
      sensitive: { severeDisability: true },
      pages: [page("health", [{ key: "severeDisability", required: true }])],
    };
    const { source } = renderWizard([staffState], {
      step: "health",
      noStepUp: true,
      sensitive: { health: { severeDisability: true } },
    });
    await heading("Gesundheit");
    const disability = await screen.findByRole("group", {
      name: "Schwerbehinderung oder Gleichstellung *",
    });
    expect(within(disability).getByRole("radio", { name: "Ja" })).toBeChecked();
    expect(screen.queryByRole("group", { name: /Gesundheitliche Einschränkungen/ })).toBeNull();
    expect(screen.queryByLabelText("Ihr Geburtsdatum")).toBeNull();
    expect(source.loadSensitive).toHaveBeenCalledWith("health");
  });

  it("show the app's ended view once the mode has ended", async () => {
    renderWizard([wizardState()], {
      noStepUp: true,
      load: async () => {
        throw refused(403, "assisted_mode_required");
      },
    });
    expect(await screen.findByText("Sitzung abgelaufen")).toBeVisible();
  });
});
