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

/**
 * Keeps `<html lang>` and `<html dir>` in step with the language, so screen readers pick the
 * right voice and RTL languages lay out right to left (CSS logical properties do the rest).
 */
export function syncDocumentLanguage(
  instance: i18n,
  doc: { documentElement: { lang: string; dir: string } } = document,
): void {
  const apply = (lng: string) => {
    doc.documentElement.lang = lng;
    doc.documentElement.dir = instance.dir(lng);
  };
  apply(instance.resolvedLanguage ?? instance.language);
  instance.on("languageChanged", apply);
}
