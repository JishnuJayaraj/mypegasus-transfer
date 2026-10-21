import { Select, SelectItem } from "@transfer/ui";
import { useTranslation } from "react-i18next";
import { languages } from "../i18n";

/** The portal's language switch (de/en in the MVP). */
export function LanguageSelect({ id }: { id: string }) {
  const { t, i18n } = useTranslation();
  return (
    <Select
      id={id}
      labelText={t("language.label")}
      value={i18n.resolvedLanguage}
      onChange={(event) => void i18n.changeLanguage(event.target.value)}
      inline
    >
      {Object.entries(languages).map(([code, name]) => (
        <SelectItem key={code} value={code} text={name} lang={code} />
      ))}
    </Select>
  );
}
