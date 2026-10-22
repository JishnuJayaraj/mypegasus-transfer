import "i18next";
import type { selfServiceResources } from "@transfer/self-service-ui";
import type de from "./locales/de/translation.json";

declare module "i18next" {
  interface CustomTypeOptions {
    resources: { translation: typeof de; selfService: (typeof selfServiceResources)["de"] };
  }
}
