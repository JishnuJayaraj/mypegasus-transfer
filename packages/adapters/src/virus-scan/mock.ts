import { ScannerUnavailable, type ScanVerdict, type VirusScanner } from "./virus-scan";

// The distinctive part of the EICAR test file; the full test string is never committed (tests
// assemble it at runtime), so no virus scanner flags this repository.
const eicarMarker = "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!";

/**
 * Development and tests: `infected` for the EICAR test file, `unscannable` for an encrypted PDF
 * (`/Encrypt`), `clean` otherwise; `available = false` makes it throw `ScannerUnavailable`.
 * Never wired with `NODE_ENV=production`.
 */
export class MockVirusScanner implements VirusScanner {
  available = true;

  async scan(content: Uint8Array): Promise<ScanVerdict> {
    if (!this.available) throw new ScannerUnavailable();
    const bytes = Buffer.from(content.buffer, content.byteOffset, content.byteLength);
    if (bytes.includes(eicarMarker, 0, "latin1")) return "infected";
    const pdf = bytes.subarray(0, 5).toString("latin1") === "%PDF-";
    return pdf && bytes.includes("/Encrypt", 0, "latin1") ? "unscannable" : "clean";
  }
}
