/**
 * Scans an upload before anything is stored (ADR-0006; Q144 *assumed*). An infected or
 * unscannable file (e.g. an encrypted PDF) is never stored. A real scanner (ClamAV in the
 * cluster) comes with its contract test before the pilot (Q149); until then production has none.
 */
export type ScanVerdict = "clean" | "infected" | "unscannable";

export interface VirusScanner {
  /** Throws `ScannerUnavailable` when the scanner can't be reached: nothing is stored then. */
  scan(content: Uint8Array): Promise<ScanVerdict>;
}

export class ScannerUnavailable extends Error {
  constructor() {
    super("Virus scanner unavailable");
    this.name = "ScannerUnavailable";
  }
}
