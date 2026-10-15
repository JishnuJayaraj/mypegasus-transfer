import { createI18n } from "@transfer/ui";
import de from "./locales/de/translation.json";

// The staff UI is German only (Q39); keys are typed through i18next.d.ts.
export const i18n = createI18n({ de: { translation: de } }, "de");
