import { render, type RenderResult } from "@testing-library/react";
import type { ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { createI18n, UI_NAMESPACE, uiResources } from "./i18n";

/** The status labels the tests need; the apps' catalogs hold the real ones (statusTag). */
const translation = {
  participants: {
    statuses: { informed: "Informiert" },
    dsvStatuses: { dsv_signed: "Unterschrieben" },
  },
  worklist: { deadlineStates: { overdue: "Überschritten" } },
};

/** Renders with the kit's catalog (de) and a few app labels (synthetic). */
export function renderUi(ui: ReactNode): RenderResult {
  const i18n = createI18n({ de: { translation, [UI_NAMESPACE]: uiResources.de } }, "de");
  const wrap = (node: ReactNode) => <I18nextProvider i18n={i18n}>{node}</I18nextProvider>;
  const result = render(wrap(ui));
  return { ...result, rerender: (node: ReactNode) => result.rerender(wrap(node)) };
}
