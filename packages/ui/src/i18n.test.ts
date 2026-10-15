import { describe, expect, it } from "vitest";
import { createI18n, syncDocumentLanguage } from "./i18n";

const resources = {
  de: { translation: { hello: "Hallo" } },
  en: { translation: { hello: "Hello" } },
};

// A stand-in for `document.documentElement` (this project runs in node).
const fakeDocument = () => ({ documentElement: { lang: "", dir: "" } });

describe("syncDocumentLanguage", () => {
  it("sets <html lang> and <html dir> now and on every language change", async () => {
    const i18n = createI18n(resources, "de", ["de", "en"]);
    const doc = fakeDocument();
    syncDocumentLanguage(i18n, doc);
    expect(doc.documentElement).toEqual({ lang: "de", dir: "ltr" });

    await i18n.changeLanguage("en");
    expect(doc.documentElement).toEqual({ lang: "en", dir: "ltr" });
    expect(i18n.t("hello")).toBe("Hello");
  });

  it("sets dir=rtl for a right-to-left language (AC-18; there is no ar catalog yet)", async () => {
    const i18n = createI18n(resources, "de", ["de", "en", "ar"]);
    const doc = fakeDocument();
    syncDocumentLanguage(i18n, doc);
    await i18n.changeLanguage("ar");
    expect(i18n.dir("ar")).toBe("rtl");
    expect(doc.documentElement).toEqual({ lang: "ar", dir: "rtl" });
  });
});
