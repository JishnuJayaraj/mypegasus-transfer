import { describe, expect, it } from "vitest";
import {
  detectFileType,
  documentFileName,
  documentLimits,
  DocumentMediaType,
  generatedDocumentFileName,
} from "./files";

// Strings as Latin-1 bytes (the domain has no Node Buffer).
const bytes = (...parts: (string | number[])[]) =>
  new Uint8Array(
    parts.flatMap((part) =>
      typeof part === "string" ? [...part].map((c) => c.charCodeAt(0)) : part,
    ),
  );

const pdf = bytes("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const jpeg = bytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], "JFIF\0");
const png = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13], "IHDR");

describe("detectFileType (Q143: by content, never by name or MIME type)", () => {
  it("accepts PDF, JPEG and PNG by their magic bytes", () => {
    expect(detectFileType(pdf)).toBe("application/pdf");
    expect(detectFileType(jpeg)).toBe("image/jpeg");
    expect(detectFileType(png)).toBe("image/png");
    expect(DocumentMediaType.options).toEqual(["application/pdf", "image/jpeg", "image/png"]);
  });

  it.each([
    ["empty", bytes()],
    ["SVG", bytes('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ["HTML", bytes("<!doctype html><html><body>%PDF-1.7</body></html>")],
    ["ZIP and Office Open XML", bytes("PK\x03\x04\x14\x00\x06\x00")],
    ["legacy Office", bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])],
    ["HEIC", bytes([0, 0, 0, 0x18], "ftypheic\0\0\0\0mif1heic")],
    ["GIF", bytes("GIF89a")],
    ["a PDF header after other bytes", bytes(" %PDF-1.7\n")],
    ["a truncated PDF header", bytes("%PDF")],
    ["a truncated JPEG header", bytes([0xff, 0xd8])],
    ["a truncated PNG header", bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a])],
  ])("refuses %s", (_name, content) => {
    expect(detectFileType(content)).toBeNull();
  });

  it("goes by the content when the name says otherwise (a PNG named .pdf)", () => {
    expect(documentFileName("scan.pdf")).toBe("scan.pdf");
    expect(detectFileType(png)).toBe("image/png");
  });
});

describe("documentFileName (Q148)", () => {
  it("trims, drops path parts and control characters, and normalises to NFC", () => {
    expect(documentFileName("  Lebenslauf 2026.pdf \n")).toBe("Lebenslauf 2026.pdf");
    expect(documentFileName("C:\\Users\\Synthetic\\Zeugnis.pdf")).toBe("Zeugnis.pdf");
    expect(documentFileName("../../etc/passwd")).toBe("passwd");
    expect(documentFileName("Zeug\u0000nis\u0007.pdf")).toBe("Zeugnis.pdf");
    expect(documentFileName("cv\u202egnp.pdf")).toBe("cvgnp.pdf");
    expect(documentFileName("Bewerbung\u0085.png")).toBe("Bewerbung.png");
    expect(documentFileName("Zeugnis-Mu\u0308ller.pdf")).toBe("Zeugnis-M\u00fcller.pdf");
  });

  it("keeps 1–200 characters, counted as code points", () => {
    expect(documentFileName("a")).toBe("a");
    expect(documentFileName("ä".repeat(196) + ".pdf")).toHaveLength(200);
    expect(documentFileName("😀".repeat(200))).toBe("😀".repeat(200));
    expect(documentFileName("a".repeat(201))).toBeNull();
    for (const name of ["", "   ", "folder/", "\u0000\u0001", "C:\\"]) {
      expect([name, documentFileName(name)]).toEqual([name, null]);
    }
  });
});

describe("generated file names (Q148)", () => {
  it("names a download by its type, date and detected type", () => {
    expect(generatedDocumentFileName("asu_proof", "2026-10-22", "application/pdf")).toBe(
      "asu_proof-2026-10-22.pdf",
    );
    expect(generatedDocumentFileName("cv", "2026-10-22", "image/jpeg")).toBe("cv-2026-10-22.jpg");
    expect(generatedDocumentFileName("cv", "2026-10-22", "image/png")).toBe("cv-2026-10-22.png");
  });
});

describe("documentLimits (Q143)", () => {
  it("allows 10 MB per file, 50 live documents and 20 uploads an hour per participation", () => {
    expect(documentLimits).toEqual({
      maxBytes: 10 * 1024 * 1024,
      maxLiveDocuments: 50,
      maxUploadsPerHour: 20,
    });
  });
});
