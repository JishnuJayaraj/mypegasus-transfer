import { useDocumentTitle } from "@transfer/ui";
import { useTranslation } from "react-i18next";

/**
 * The document title of a page: its parts, most specific first, then the product name
 * ("Teilnehmende · Projekt Nord – Transferplattform"). Never a participant's name or any other
 * personal data: the browser keeps titles in its history (data-protection.md, page titles).
 */
export function usePageTitle(...parts: (string | undefined)[]) {
  const { t } = useTranslation();
  useDocumentTitle(t("app.name"), ...parts);
}
