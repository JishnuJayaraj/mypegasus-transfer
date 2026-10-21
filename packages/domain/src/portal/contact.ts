/** Private contact normalisation for delivery and later channel ownership (D28). */
export function normaliseEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) && email.length <= 254 ? email : null;
}

export function normaliseMobile(value: string): string | null {
  let number = value.trim().replace(/[\s()./-]/g, "");
  if (number.startsWith("0049")) number = `+49${number.slice(4)}`;
  else if (number.startsWith("0")) number = `+49${number.slice(1)}`;
  if (!/^\+[1-9][0-9]{7,14}$/.test(number)) return null;
  return number;
}

export type ContactKind = "email" | "sms";

export function normaliseContact(kind: ContactKind, value: string): string | null {
  return kind === "email" ? normaliseEmail(value) : normaliseMobile(value);
}

/**
 * How the portal shows a participant their own channel: enough to recognise it, never the whole
 * address in a response (data-protection.md, Authentication).
 */
export function maskContactAddress(kind: ContactKind, address: string): string {
  if (kind === "sms") return `${address.slice(0, 3)} … ${address.slice(-3)}`;
  const [local = "", domain = ""] = address.split("@");
  return `${local.slice(0, 1)}…@${domain}`;
}
