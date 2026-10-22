// The work list's name search (data-protection.md, the work list and the dashboard): it runs in
// the browser over the snapshot and never leaves it. Both the indexed text and the term are
// folded the same way.

/** Lower case without diacritics, `ß` as `ss`, whitespace collapsed. */
export function searchKey(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replaceAll("ß", "ss")
    .replace(/\s+/g, " ")
    .trim();
}

/** Whether every word of the term occurs in the indexed key (`searchKey` of the listed fields). */
export function matchesSearch(indexKey: string, term: string): boolean {
  return searchKey(term)
    .split(" ")
    .every((word) => indexKey.includes(word));
}
