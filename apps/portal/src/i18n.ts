import { createI18n } from "@transfer/ui";
import de from "./locales/de/translation.json";
import en from "./locales/en/translation.json";

/** Portal languages in the MVP (de default; v1.1 adds more, incl. RTL), named in themselves. */
export const languages = { de: "Deutsch", en: "English" } as const;

// Keys are typed through i18next.d.ts; the catalogs have identical keys (locales.test.ts).
export const i18n = createI18n(
  { de: { translation: de }, en: { translation: en } },
  "de",
  Object.keys(languages),
);
