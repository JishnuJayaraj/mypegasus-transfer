import { escapeHtml, fillTemplate, type HtmlTemplate, type PrintDocument } from "../forms/anlage";
import { formatFormDate } from "../forms/format";
import type { TransferCompany } from "../forms/input";
import type { IsoDate } from "../iso-date";
import type { DsvSource } from "./generation";

// The DSV's print document (ADR-0009, own documents; D1): the template version's fixed wording
// with only the variable parts filled, each HTML-escaped. A missing birth date or address prints a
// line for the hand (the checklist names it). The template carries its own stamp: `dsv:v1` is the
// synthetic sample, "Muster – nicht zur Verwendung" on every page.

export type DsvDocument = Pick<
  DsvSource,
  | "firstName"
  | "lastName"
  | "birthDate"
  | "street"
  | "postalCode"
  | "city"
  | "country"
  | "customerName"
> & {
  company: Pick<TransferCompany, "name" | "street" | "houseNumber" | "postalCode" | "city">;
  tgStart: IsoDate;
  tgEnd: IsoDate;
  offerDeadline: IsoDate;
};

/** A line left for handwriting. */
const blank = '<span class="blank"></span>';

/** The placeholders every DSV template version fills, as text (for the mock and tests). */
export function dsvValues(document: DsvDocument): Record<string, string | null> {
  const { street, postalCode, city, country, company } = document;
  const place = [postalCode, city].filter((part) => part !== null).join(" ");
  const address =
    street === null
      ? null
      : // the country only when it isn't Germany's (the address holds `DE` today)
        [street, place, country === "DE" ? "" : (country ?? "")]
          .filter((part) => part !== "")
          .join(", ");
  return {
    participant: `${document.firstName} ${document.lastName}`,
    birthDate: document.birthDate === null ? null : formatFormDate(document.birthDate),
    address,
    customer: document.customerName,
    company: company.name,
    companyAddress: `${company.street} ${company.houseNumber}, ${company.postalCode} ${company.city}`,
    tgStart: formatFormDate(document.tgStart),
    tgEnd: formatFormDate(document.tgEnd),
    offerDeadline: formatFormDate(document.offerDeadline),
  };
}

/** The DSV rendered with a template version: page, header, footer and the same as text. */
export function renderDsv(template: HtmlTemplate, document: DsvDocument): PrintDocument {
  const values = dsvValues(document);
  const html = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, value === null ? blank : escapeHtml(value)]),
  );
  const person = escapeHtml(values.participant!);
  const text = (key: string) => values[key] ?? "________________";
  return {
    html: fillTemplate(template.index, html),
    headerHtml: fillTemplate(template.header, { person }),
    footerHtml: fillTemplate(template.footer, {}),
    text: {
      pageHeader: ["Dreiseitiger Vertrag – Muster – nicht zur Verwendung", values.participant!],
      blocks: [
        { kind: "heading", text: "Dreiseitiger Vertrag" },
        {
          kind: "table",
          columns: ["Partei", "Angaben"],
          rows: [
            ["Arbeitnehmer·in", `${text("participant")}, geb. ${text("birthDate")}`],
            ["Anschrift", text("address")],
            ["Bisheriger Arbeitgeber", text("customer")],
            ["Transfergesellschaft", `${text("company")}, ${text("companyAddress")}`],
          ],
        },
        {
          kind: "paragraph",
          text: `Beginn ${text("tgStart")}, Ende ${text("tgEnd")}. Angebot gültig bis ${text("offerDeadline")}.`,
        },
      ],
    },
  };
}
