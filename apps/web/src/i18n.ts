import { SELF_SERVICE_NAMESPACE, selfServiceResources } from "@transfer/self-service-ui";
import { createI18n } from "@transfer/ui";
import de from "./locales/de/translation.json";

// The staff UI is German only (Q39); keys are typed through i18next.d.ts. The wizard of assisted
// mode brings its own namespace (@transfer/self-service-ui), in German here.
export const i18n = createI18n(
  { de: { translation: de, [SELF_SERVICE_NAMESPACE]: selfServiceResources.de } },
  "de",
);
