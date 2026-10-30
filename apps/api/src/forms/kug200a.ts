import { imageToPdf, mergePdfs, PdfUnavailable, type PdfRenderer } from "@transfer/adapters";
import {
  checkKug200a,
  kug200aList,
  kug200aListTemplate,
  type ContactAddress,
  type IsoDate,
  type Kug200aChecklistItem,
  type Kug200aSource,
  type Kug200bBatchArtifact,
  type TransferCompany,
} from "@transfer/domain";
import { organisationFingerprint, sha256 } from "./person";
import type { FormRegistry } from "./registry";

// A batch's official artifact as the API renders it (ba-forms.md, the Kug 200a as built;
// regional-variation.md, the accepted alternative; Q197, Q205): the Kug 200a in copies of six
// filled in process, or the alternative list rendered from our own template behind
// `PdfRenderer.renderHtml`; and its handwriting checklist for the tab, from the same sources with
// the RV-Nummer's presence only. Nothing here logs or returns a value but the file.

/** What `kug200b_batch_export_sources` returns for the Kug 200a (never a sensitive plaintext). */
export type BatchPrintSources = {
  project: {
    customerName: string;
    tKugNumber: string | null;
    employerBetriebsnummer: string | null;
    employerEconomicClass: string | null;
  };
  createdOn: IsoDate;
  members: {
    participationId: string;
    documentId: string;
    firstName: string | null;
    lastName: string | null;
    address: ContactAddress | null;
    insuranceNumberSha256: string | null;
    tgStart: IsoDate | null;
    tgEnd: IsoDate | null;
    declaration17: "in_packet" | "other_paper" | "none";
    infoEventDates: IsoDate[];
  }[];
};

/** The organisation as the Kug 200a's header prints it, with the TG's Betriebsnummer and WK. */
export const kug200aOrganisationFingerprint = (company: TransferCompany) =>
  sha256(
    JSON.stringify([
      organisationFingerprint(company),
      company.betriebsnummer ?? null,
      company.economicClass ?? null,
    ]),
  );

/** The domain's source; `insuranceNumber` gives each member's RV-Nummer (or its stand-in). */
export function kug200aSourceOf(
  sources: BatchPrintSources,
  company: TransferCompany,
  insuranceNumber: (member: BatchPrintSources["members"][number]) => string | null,
): Kug200aSource {
  return {
    header: {
      transferCompany: company,
      tKugNumber: sources.project.tKugNumber,
      employer: {
        name: sources.project.customerName,
        betriebsnummer: sources.project.employerBetriebsnummer,
        economicClass: sources.project.employerEconomicClass,
      },
    },
    members: sources.members.map((member) => ({
      participationId: member.participationId,
      identity: { firstName: member.firstName, lastName: member.lastName },
      address: member.address,
      insuranceNumber: insuranceNumber(member),
      tgStart: member.tgStart,
      tgEnd: member.tgEnd,
      declaration17: member.declaration17,
      infoEventDates: member.infoEventDates,
    })),
  };
}

/**
 * A stand-in for a recorded RV-Nummer in the checklist: an identifier is never cut, so any value
 * of the stored shape (`^[0-9]{8}[A-Z][0-9]{3}$`) lays out the same; the checklist needs its
 * presence only, and nothing is decrypted for the tab.
 */
const presentNumber = "00000000A000";

/** The handwriting checklist of an open batch's artifact, or null without a Kug 200a in use. */
export async function artifactChecklist(
  registry: FormRegistry,
  sources: BatchPrintSources,
  company: TransferCompany,
  artifact: Kug200bBatchArtifact,
  today: IsoDate,
): Promise<Kug200aChecklistItem[] | null> {
  const version = registry.inUse("kug200a", today);
  if (!version || sources.members.length === 0) return null;
  const source = kug200aSourceOf(sources, company, (member) =>
    member.insuranceNumberSha256 === null ? null : presentNumber,
  );
  if (artifact === "accepted_alternative") {
    const template = registry.template(kug200aListTemplate);
    return kug200aList(source, version.fieldMap, template, { createdOn: sources.createdOn })
      .checklist;
  }
  return checkKug200a(source, version.fieldMap, today, await registry.measure()).checklist;
}

export type ArtifactOutcome =
  | { ok: true; content: Uint8Array; fileName: string }
  | { ok: false; code: "form_version_unavailable" | "pdf_unavailable" };

/**
 * The artifact's file: the Kug 200a in use today, each copy of six filled and flattened, merged in
 * the list's order; or the alternative list (`pdf_unavailable` without an HTML renderer).
 */
export async function renderArtifact(
  registry: FormRegistry,
  renderer: PdfRenderer,
  source: Kug200aSource,
  artifact: Kug200bBatchArtifact,
  meta: { today: IsoDate; createdOn: IsoDate },
): Promise<ArtifactOutcome> {
  const version = registry.inUse("kug200a", meta.today);
  if (!version) return { ok: false, code: "form_version_unavailable" };
  if (artifact === "accepted_alternative") {
    const { document } = kug200aList(
      source,
      version.fieldMap,
      registry.template(kug200aListTemplate),
      { createdOn: meta.createdOn },
    );
    try {
      return {
        ok: true,
        content: await renderer.renderHtml(document),
        fileName: `sammelliste-kug200b-${meta.today}.pdf`,
      };
    } catch (error) {
      if (error instanceof PdfUnavailable) return { ok: false, code: "pdf_unavailable" };
      throw error;
    }
  }
  const { copies } = checkKug200a(source, version.fieldMap, meta.today, await registry.measure());
  const parts: Uint8Array[] = [];
  for (const fields of copies) {
    parts.push(
      await renderer.fillForm({ template: version.blank, fieldMap: version.fieldMap, fields }),
    );
  }
  return {
    ok: true,
    content: await mergePdfs(parts),
    fileName: `kug200a-${meta.today}.pdf`,
  };
}

/** The members' scans as one PDF, in the list's order: a PDF as it is, an image as an A4 page. */
export async function scansPdf(
  files: readonly { content: Uint8Array; mediaType: string }[],
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for (const file of files) {
    parts.push(
      file.mediaType === "application/pdf"
        ? file.content
        : await imageToPdf(file.content, file.mediaType as "image/jpeg" | "image/png"),
    );
  }
  return mergePdfs(parts);
}
