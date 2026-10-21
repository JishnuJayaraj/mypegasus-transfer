/** Crockford base32 without I, L, O and U (D12). Twelve symbols carry 60 bits. */
export const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const CODE_LENGTH = 12;
const codePattern = new RegExp(`^[${CROCKFORD_ALPHABET}]{${CODE_LENGTH}}$`);

export function formatActivationCode(code: string): string {
  if (!codePattern.test(code)) throw new RangeError("Expected a normalised activation code");
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
}

/** User input aliases follow Crockford: O→0 and I/L→1; spaces and hyphens are ignored. */
export function normaliseActivationCode(input: string): string | null {
  const normalised = input
    .toUpperCase()
    .replace(/[ -]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  return codePattern.test(normalised) ? normalised : null;
}
