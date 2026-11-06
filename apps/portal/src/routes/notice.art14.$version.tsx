import { createFileRoute, notFound } from "@tanstack/react-router";
import { organisation } from "@transfer/config";
import { ART14_NOTICE_VERSION, art14Notice } from "@transfer/domain";
import { useTranslation } from "react-i18next";

export const Route = createFileRoute("/notice/art14/$version")({
  beforeLoad: ({ params }) => {
    if (params.version !== ART14_NOTICE_VERSION) throw notFound();
  },
  component: Article14Notice,
});

/**
 * Public, static and personal-data-free: no API request and no participant context. Its language
 * is the header's switch.
 */
function Article14Notice() {
  const { i18n } = useTranslation();
  const language = i18n.resolvedLanguage === "en" ? "en" : "de";
  const notice = art14Notice(language, organisation);
  return (
    <article>
      <h1>{notice.title}</h1>
      {notice.text.split("\n\n").map((paragraph) => (
        <p key={paragraph}>{paragraph}</p>
      ))}
    </article>
  );
}
