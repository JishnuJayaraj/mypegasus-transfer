import de from "./locales/de.json";
import en from "./locales/en.json";

/** The wizard's own i18n namespace; each SPA adds it to its instance (UI text through i18n only). */
export const SELF_SERVICE_NAMESPACE = "selfService";

/** The wizard's catalogs (de, en), with identical keys (locales.test.ts). */
export const selfServiceResources = { de, en } as const;
