import { createInstance, type i18n, type Resource } from "i18next";
import { initReactI18next } from "react-i18next";

/**
 * Creates an initialised i18next instance (synchronous, bundled catalogs). UI text goes through
 * i18n only (CLAUDE.md); `dir()` gives the text direction for RTL languages.
 */
export function createI18n(resources: Resource, lng: string, supportedLngs = [lng]): i18n {
  const instance = createInstance();
  void instance.use(initReactI18next).init({
    resources,
    lng,
    fallbackLng: lng,
    supportedLngs,
    initAsync: false,
    interpolation: { escapeValue: false },
    returnNull: false,
  });
  return instance;
}
