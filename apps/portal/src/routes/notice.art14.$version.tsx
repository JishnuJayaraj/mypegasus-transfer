import { createFileRoute, notFound } from "@tanstack/react-router";
import { organisation } from "@transfer/config";
import { ART14_NOTICE_VERSION, art14Notice } from "@transfer/domain";
import { Select, SelectItem, Stack } from "@transfer/ui";
import { useTranslation } from "react-i18next";
import { languages } from "../i18n";

export const Route = createFileRoute("/notice/art14/$version")({
  beforeLoad: ({ params }) => {
    if (params.version !== ART14_NOTICE_VERSION) throw notFound();
  },
  component: Article14Notice,
});

/** Public, static and personal-data-free: no API request and no participant context. */
function Article14Notice() {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage === "en" ? "en" : "de";
  const notice = art14Notice(language, organisation);
  return (
    <Stack gap={6}>
      <Select
        id="notice-language"
        labelText={t("language.label")}
        value={language}
        onChange={(event) => void i18n.changeLanguage(event.target.value)}
        inline
      >
        {Object.entries(languages).map(([code, name]) => (
          <SelectItem key={code} value={code} text={name} lang={code} />
        ))}
      </Select>
      <article>
        <h1>{notice.title}</h1>
        {notice.text.split("\n\n").map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
      </article>
    </Stack>
  );
}
