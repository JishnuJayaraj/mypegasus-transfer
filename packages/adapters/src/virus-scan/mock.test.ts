import { describe, expect, it } from "vitest";
import { MockVirusScanner } from "./mock";
import { ScannerUnavailable } from "./virus-scan";

// The EICAR test file, assembled at runtime so the repository never holds it.
const eicar = () =>
  [
    "X5O!P%@AP[4\\PZX54(P^)7CC)7}$",
    ["EICAR", "STANDARD", "ANTIVIRUS", "TEST", "FILE!"].join("-"),
    "$H+H*",
  ].join("");
const text = (value: string) => new Uint8Array(Buffer.from(value, "latin1"));

describe("MockVirusScanner (Q144)", () => {
  it("finds the EICAR test file, alone or inside another file", async () => {
    const scanner = new MockVirusScanner();
    expect(eicar()).toHaveLength(68);
    expect(await scanner.scan(text(eicar()))).toBe("infected");
    expect(await scanner.scan(text(`%PDF-1.7\n${eicar()}\n%%EOF`))).toBe("infected");
  });

  it("can't scan an encrypted PDF", async () => {
    const scanner = new MockVirusScanner();
    const encrypted = "%PDF-1.7\ntrailer\n<< /Root 1 0 R /Encrypt 5 0 R >>\n%%EOF";
    expect(await scanner.scan(text(encrypted))).toBe("unscannable");
  });

  it("passes other files, including a non-PDF that mentions /Encrypt", async () => {
    const scanner = new MockVirusScanner();
    expect(await scanner.scan(text("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF"))).toBe("clean");
    expect(await scanner.scan(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("clean");
    expect(await scanner.scan(text("/Encrypt"))).toBe("clean");
    expect(await scanner.scan(new Uint8Array())).toBe("clean");
  });

  it("reads only the bytes of the view it is given", async () => {
    const scanner = new MockVirusScanner();
    const buffer = text(`${eicar()}%PDF-1.7\n%%EOF`);
    expect(await scanner.scan(buffer.subarray(68))).toBe("clean");
  });

  it("throws ScannerUnavailable when switched off", async () => {
    const scanner = new MockVirusScanner();
    scanner.available = false;
    await expect(scanner.scan(text("%PDF-1.7"))).rejects.toBeInstanceOf(ScannerUnavailable);
    scanner.available = true;
    expect(await scanner.scan(text("%PDF-1.7"))).toBe("clean");
  });
});
