import { SELF_SERVICE_NAMESPACE, selfServiceResources } from "@transfer/self-service-ui";
import { createI18n, UI_NAMESPACE, uiResources } from "@transfer/ui";
import de from "./locales/de/translation.json";
import en from "./locales/en/translation.json";

/** Portal languages in the MVP (de default; v1.1 adds more, incl. RTL), named in themselves. */
export const languages = { de: "Deutsch", en: "English" } as const;

// Keys are typed through i18next.d.ts; the catalogs have identical keys (locales.test.ts). The
// wizard and the UI kit bring their own namespaces (@transfer/self-service-ui, @transfer/ui).
export const i18n = createI18n(
  {
    de: {
      translation: de,
      [SELF_SERVICE_NAMESPACE]: selfServiceResources.de,
      [UI_NAMESPACE]: uiResources.de,
    },
    en: {
      translation: en,
      [SELF_SERVICE_NAMESPACE]: selfServiceResources.en,
      [UI_NAMESPACE]: uiResources.en,
    },
  },
  "de",
  Object.keys(languages),
);
