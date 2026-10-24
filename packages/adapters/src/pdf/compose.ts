import { PDFDocument } from "pdf-lib";

// Pure pdf-lib helpers (ADR-0006): a packet of several PDFs (a form and its Anlage, a batch's
// scans) and a JPEG or PNG scan as an A4 page.

/** The pages of every part, in order, as one PDF. */
export async function mergePdfs(parts: readonly Uint8Array[]): Promise<Uint8Array> {
  const merged = await PDFDocument.create({ updateMetadata: false });
  for (const part of parts) {
    const doc = await PDFDocument.load(part, { updateMetadata: false });
    for (const page of await merged.copyPages(doc, doc.getPageIndices())) merged.addPage(page);
  }
  return merged.save();
}

const a4 = { width: 595.28, height: 841.89 };

/** A scan as one A4 page, scaled to fit with its proportions kept and centred. */
export async function imageToPdf(
  image: Uint8Array,
  mediaType: "image/jpeg" | "image/png",
): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const embedded =
    mediaType === "image/jpeg" ? await doc.embedJpg(image) : await doc.embedPng(image);
  const scale = Math.min(a4.width / embedded.width, a4.height / embedded.height);
  const width = embedded.width * scale;
  const height = embedded.height * scale;
  doc.addPage([a4.width, a4.height]).drawImage(embedded, {
    x: (a4.width - width) / 2,
    y: (a4.height - height) / 2,
    width,
    height,
  });
  return doc.save();
}
