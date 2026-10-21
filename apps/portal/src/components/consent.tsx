import { organisation } from "@transfer/config";
import { portalContactConsent, type NoticeLanguage } from "@transfer/domain";
import { Checkbox, Stack } from "@transfer/ui";
import { useTranslation } from "react-i18next";

/**
 * The consent text of the portal contact purpose (Q123) and the participant's
 * agreement: each channel has its own consent record, at activation and when one is added.
 */
export function Consent({
  language,
  checked,
  onChange,
}: {
  language: NoticeLanguage;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const { t } = useTranslation();
  const consent = portalContactConsent(language, organisation);
  return (
    <Stack gap={3}>
      <h2>{consent.title}</h2>
      {consent.text.split("\n\n").map((paragraph) => (
        <p key={paragraph}>{paragraph}</p>
      ))}
      <Checkbox
        id="portal-contact-consent"
        labelText={t("activate.consent.label")}
        checked={checked}
        onChange={(_event, { checked: value }) => onChange(value)}
      />
    </Stack>
  );
}
