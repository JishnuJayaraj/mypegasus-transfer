import type { components } from "@transfer/api-client";
import { Button, formatTimestamp } from "@transfer/ui";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

type ActivationItem = components["schemas"]["BatchActivationCodeResult"]["items"][number];
type NoticeItem = components["schemas"]["PrivacyNoticeBatchResult"]["items"][number];

function QrCode({ value }: { value: string }) {
  const [source, setSource] = useState("");
  useEffect(() => {
    let current = true;
    void QRCode.toDataURL(value, { errorCorrectionLevel: "M", margin: 1, width: 180 }).then(
      (url) => current && setSource(url),
    );
    return () => {
      current = false;
    };
  }, [value]);
  return source ? <img className="tp-print-qr" src={source} alt="" /> : null;
}

/** Ephemeral print output: the parent drops these items (and therefore every code) on close. */
export function ActivationPrintView({
  kind,
  items,
  onClose,
  itemActions,
  footerActions,
}: {
  kind: "letter" | "sheet";
  items: ActivationItem[];
  onClose: () => void;
  itemActions?: React.ReactNode[];
  footerActions?: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <section className="tp-print-view" aria-label={t(`activation.print.${kind}`)}>
      <div className="tp-print-controls">
        <Button onClick={() => window.print()}>{t("activation.print.print")}</Button>
        <Button kind="secondary" onClick={onClose}>
          {t("activation.print.close")}
        </Button>
      </div>
      {items.map((item, index) => (
        <article className={`tp-print-page tp-print-${kind}`} key={item.activationCodeId}>
          {kind === "letter" && item.address && (
            <address className="tp-window-address">
              {item.firstName} {item.lastName}
              <br />
              {item.address.street}
              <br />
              {item.address.postalCode} {item.address.city}
              <br />
              {item.address.country}
            </address>
          )}
          <h2>{item.noticeTitle}</h2>
          <p className="tp-print-code" aria-label={t("activation.print.code")}>
            {item.code}
          </p>
          <p>{t("activation.print.expires", { at: formatTimestamp(item.expiresAt) })}</p>
          <QrCode value={item.activationUrl} />
          <div className="tp-notice-text">{item.noticeText}</div>
          {itemActions?.[index]}
        </article>
      ))}
      {footerActions}
    </section>
  );
}

export function NoticePrintView({ items, onClose }: { items: NoticeItem[]; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <section className="tp-print-view" aria-label={t("activation.print.notice")}>
      <div className="tp-print-controls">
        <Button onClick={() => window.print()}>{t("activation.print.print")}</Button>
        <Button kind="secondary" onClick={onClose}>
          {t("activation.print.close")}
        </Button>
      </div>
      {items.map((item) => (
        <article className="tp-print-page tp-print-letter" key={item.participationId}>
          {item.address && (
            <address className="tp-window-address">
              {item.firstName} {item.lastName}
              <br />
              {item.address.street}
              <br />
              {item.address.postalCode} {item.address.city}
              <br />
              {item.address.country}
            </address>
          )}
          <h2>{item.noticeTitle}</h2>
          <div className="tp-notice-text">{item.noticeText}</div>
        </article>
      ))}
    </section>
  );
}
