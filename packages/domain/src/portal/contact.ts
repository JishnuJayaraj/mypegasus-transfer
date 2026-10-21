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
