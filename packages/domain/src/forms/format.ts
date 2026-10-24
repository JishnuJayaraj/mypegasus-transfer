import { isValidIsoDate, type IsoDate } from "../iso-date";

// How values are written on the official forms (ba-forms.md, validation before rendering):
// dates `TT.MM.JJJJ`, times `hh:mm`, and only the characters the embedded font prints.

/** `2025-03-14` → `14.03.2025`; throws on an impossible date, which validation refuses first. */
export function formatFormDate(date: IsoDate): string {
  if (!isValidIsoDate(date)) throw new RangeError("Expected a real calendar date (YYYY-MM-DD)");
  const [year, month, day] = date.split("-");
  return `${day}.${month}.${year}`;
}

/** A real calendar date written `TT.MM.JJJJ`: `03.14.1998` (month 14) is not. */
export function isFormDate(value: string): boolean {
  const match = /^([0-9]{2})\.([0-9]{2})\.([0-9]{4})$/.exec(value);
  return match !== null && isValidIsoDate(`${match[3]}-${match[2]}-${match[1]}`);
}

/** A time of day `hh:mm`, 00:00 to 23:59. */
export function isFormTime(value: string): boolean {
  return /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(value);
}

/** A decimal as the forms write it, with a comma: `38.5` → `38,5`. */
export function formatFormNumber(value: number): string {
  return String(value).replace(".", ",");
}

/**
 * The code points of the committed Noto Sans subset (`packages/forms/fonts`): Latin with its
 * extensions, combining marks, punctuation, `€`, `№`, `™`. A registry test checks the font
 * covers every one; any other character can't be printed and refuses generation.
 */
export const printableRanges: readonly (readonly [number, number])[] = [
  [0x20, 0x7e],
  [0xa0, 0x24f],
  [0x259, 0x259],
  [0x2bb, 0x2bc],
  [0x2c6, 0x2c7],
  [0x2d8, 0x2dd],
  [0x300, 0x36f],
  [0x1e00, 0x1eff],
  [0x2010, 0x2027],
  [0x2030, 0x203a],
  [0x20ac, 0x20ac],
  [0x2116, 0x2116],
  [0x2122, 0x2122],
];

const printable = (codePoint: number) =>
  printableRanges.some(([from, to]) => codePoint >= from && codePoint <= to);

/** Whether the embedded font prints the text (line breaks only where the field has lines). */
export function isPrintable(text: string, multiline: boolean): boolean {
  for (const char of text) {
    const codePoint = char.codePointAt(0)!;
    if (multiline && codePoint === 0x0a) continue;
    if (!printable(codePoint)) return false;
  }
  return true;
}
