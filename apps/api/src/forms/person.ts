import type { IsoDate, TransferCompany } from "@transfer/domain";
import { createHash } from "node:crypto";
import type { SelfServiceRecord } from "../participations/self-service";

// What a generated form printed of the person without a revision of its own, as the database's
// `form_person` reads it (data-protection.md, generated forms): compared again when the
// generation is recorded, so a change since the read refuses it (`source_changed`).

export type FormPerson = {
  firstName: string;
  lastName: string;
  birthDate: IsoDate | null;
  street: string | null;
  postalCode: string | null;
  city: string | null;
  country: string | null;
  phone: string | null;
  mobile: string | null;
  privateEmail: string | null;
  tgStart: IsoDate | null;
  tgEnd: IsoDate | null;
};

/** The person of a self-service record with the effective contractual TG dates. */
export function formPersonOf(
  record: Pick<SelfServiceRecord, "identity" | "values">,
  tgStart: IsoDate | null,
  tgEnd: IsoDate | null,
): FormPerson {
  const address = record.values.address;
  return {
    firstName: record.identity.firstName,
    lastName: record.identity.lastName,
    birthDate: record.identity.birthDate,
    street: address?.street ?? null,
    postalCode: address?.postalCode ?? null,
    city: address?.city ?? null,
    country: address?.country ?? null,
    phone: record.values.phone,
    mobile: record.values.mobile,
    privateEmail: record.values.privateEmail,
    tgStart,
    tgEnd,
  };
}

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The delivering legal entity a form prints, as a fingerprint (its version is the deployment's file). */
export function organisationFingerprint(company: TransferCompany): string {
  return sha256(
    JSON.stringify([
      company.name,
      company.street,
      company.houseNumber,
      company.postalCode,
      company.city,
    ]),
  );
}
