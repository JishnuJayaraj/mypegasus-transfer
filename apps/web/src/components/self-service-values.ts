import type { EducationRow, MaxCommuteDistance, WorkRow } from "@transfer/domain";
import { formatDate } from "@transfer/ui";

const countries = new Intl.DisplayNames(["de"], { type: "region" });

/** A translation in the wizard's namespace (`fields.<key>.…`). */
type Translate = (key: string) => string;

const period = (row: { from: string; to: string | null }, text: Translate) =>
  `${formatDate(row.from)} – ${row.to ? formatDate(row.to) : text("fields.educationHistory.running")}`;

/**
 * A self-service value as one line of text for the "Selbstauskunft" tab: codes as their labels,
 * dates as TT.MM.JJJJ, row tables one entry per line; `—` where nothing is recorded.
 */
export function formatSelfServiceValue(key: string, value: unknown, text: Translate): string {
  if (value === null || value === undefined || value === "") return "—";
  const option = (code: string) => text(`fields.${key}.${code}`);
  switch (key) {
    case "gender":
    case "maritalStatus":
    case "residenceStatus":
      return option(value as string);
    case "address": {
      const { street, postalCode, city } = value as Record<string, string>;
      return `${street}, ${postalCode} ${city}`;
    }
    case "earliestStartDate":
    case "entryToGermanyDate":
      return formatDate(value as string);
    case "educationHistory":
      return (value as EducationRow[])
        .map((row) => `${period(row, text)}: ${row.qualification}, ${row.institution}`)
        .join("\n");
    case "workHistory":
      return (value as WorkRow[])
        .map((row) => `${period(row, text)}: ${row.activity}, ${row.employer}`)
        .join("\n");
    case "languageSkills": {
      const { german, others } = value as {
        german: string;
        others: { language: string; level: string }[];
      };
      return [
        `${option("german")}: ${option(german)}`,
        ...others.map((row) => `${row.language}: ${option(row.level)}`),
      ].join("\n");
    }
    case "drivingLicence":
      return value === "none" ? option("none") : (value as string[]).join(", ");
    case "workingTimePreferences": {
      const { employmentType, weeklyHours, distribution } = value as {
        employmentType: string;
        weeklyHours: number | null;
        distribution: string | null;
      };
      return [
        option(employmentType),
        weeklyHours !== null && `${weeklyHours} ${option("weeklyHours")}`,
        distribution,
      ]
        .filter(Boolean)
        .join(", ");
    }
    case "jobWishes": {
      const { desired, alternative } = value as { desired: string; alternative: string | null };
      return alternative ? `${desired}; ${option("alternative")}: ${alternative}` : desired;
    }
    case "maxCommuteDistance": {
      const distance = value as MaxCommuteDistance;
      return distance.kind === "km" ? `${distance.km} km` : option(distance.kind);
    }
    case "nationality": {
      const nationality = value as { kind: "german" } | { kind: "other"; country: string };
      if (nationality.kind === "german") return option("german");
      return countries.of(nationality.country) ?? nationality.country;
    }
    default:
      if (typeof value === "boolean") return text(value ? "options.yes" : "options.no");
      return String(value);
  }
}
