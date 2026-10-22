import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { DocumentType, DocumentView, MissingItem } from "@transfer/domain";
import {
  Button,
  FileUploaderButton,
  InlineNotification,
  Modal,
  Stack,
  Tag,
  formatTimestamp,
} from "@transfer/ui";
import { useEffect, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  documentFailureOf,
  formatFileSize,
  readFileAsBase64,
  type DocumentErrorCode,
  type DocumentSource,
} from "./documents";
import { SELF_SERVICE_NAMESPACE } from "./i18n";

// "Unterlagen" (regional-variation.md, self-service wizard; data-protection.md, documents): one
// section per document type with its documents and their review state, "Öffnen" and "Löschen"
// where the API's capabilities allow, and an upload where the type is addable. PDF, JPG or PNG up
// to the API's limit; the size is checked before anything is sent, the type by the API from the
// content. The copy asks for no health documents.

/** The file types the picker offers; the API decides by the content (PDF, JPEG, PNG). */
export const DOCUMENT_ACCEPT = [".pdf", ".jpg", ".jpeg", ".png"];

type Notice = {
  type: DocumentType;
  kind: "success" | "error";
  message: DocumentErrorCode | "uploaded" | "deleted" | "gone" | "forbidden" | "failed";
};

export interface DocumentsPageProps {
  source: DocumentSource;
  /** The sections, in order. */
  types: readonly DocumentType[];
  /** The wizard's missing document items (codes). */
  missing: readonly MissingItem[];
  /** After an upload or deletion: completeness may have changed. */
  onChanged: () => void;
  /** The session (or the assisted mode) has ended. */
  onExpired: () => void;
  /** Where "Öffnen" goes: the opening's link, a top-level download. */
  assign?: (url: string) => void;
}

const useT = () => useTranslation(SELF_SERVICE_NAMESPACE);
const followLink = (url: string) => window.location.assign(url);

export function DocumentsPage(props: DocumentsPageProps) {
  const { t, i18n } = useT();
  const language = i18n.resolvedLanguage === "en" ? "en" : "de";
  const { source, onExpired } = props;
  const assign = props.assign ?? followLink;
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: source.queryKey, queryFn: () => source.list(), retry: false });
  const [busy, setBusy] = useState<DocumentType>();
  const [notice, setNotice] = useState<Notice>();
  const [deleting, setDeleting] = useState<DocumentView>();
  const expired = query.isError && documentFailureOf(query.error).kind === "expired";
  useEffect(() => {
    if (expired) onExpired();
  }, [expired, onExpired]);

  if (query.isPending || expired) return <p>{t("loading")}</p>;
  if (query.isError) {
    return <InlineNotification kind="error" title={t("documents.loadFailed")} hideCloseButton />;
  }
  const { documents, addableTypes, limits } = query.data;
  const max = formatFileSize(limits.maxBytes, language);
  const name = (document: DocumentView) =>
    document.fileName ?? t(`documents.types.${document.type}`);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: source.queryKey });
    props.onChanged();
  };

  /** A refusal as the section's message; an ended session ends the page. */
  const refused = async (type: DocumentType, error: unknown) => {
    const failure = documentFailureOf(error);
    switch (failure.kind) {
      case "expired":
        onExpired();
        return;
      case "gone":
        setNotice({ type, kind: "error", message: "gone" });
        await refresh();
        return;
      case "refused":
        setNotice({ type, kind: "error", message: failure.code });
        return;
      default:
        setNotice({ type, kind: "error", message: failure.kind });
    }
  };

  async function upload(type: DocumentType, file: File | undefined) {
    if (!file) return;
    setNotice(undefined);
    // Checked here so nothing too large or empty is sent; the API checks again.
    if (file.size === 0) return setNotice({ type, kind: "error", message: "file_empty" });
    if (file.size > limits.maxBytes) {
      return setNotice({ type, kind: "error", message: "file_too_large" });
    }
    setBusy(type);
    try {
      const content = await readFileAsBase64(file);
      await source.upload({ type, fileName: file.name, content });
      setNotice({ type, kind: "success", message: "uploaded" });
      await refresh();
    } catch (error) {
      await refused(type, error);
    } finally {
      setBusy(undefined);
    }
  }

  async function open(document: DocumentView) {
    setNotice(undefined);
    try {
      const { url } = await source.open(document.id);
      assign(url);
    } catch (error) {
      await refused(document.type, error);
    }
  }

  async function remove(document: DocumentView) {
    if (!source.remove) return;
    setDeleting(undefined);
    setNotice(undefined);
    setBusy(document.type);
    try {
      await source.remove(document.id);
      setNotice({ type: document.type, kind: "success", message: "deleted" });
      await refresh();
    } catch (error) {
      await refused(document.type, error);
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <Stack gap={6}>
      <Stack gap={3}>
        <p>{t("documents.intro")}</p>
        <p>{t("documents.formats", { max })}</p>
        <p>{t("documents.noHealth")}</p>
      </Stack>
      {props.types.map((type) => {
        const own = documents.filter((document) => document.type === type);
        const missing = props.missing.find((item) => item.key === type);
        const title = t(`documents.types.${type}`);
        return (
          <section key={type} className="tp-documents" aria-label={title}>
            <Stack gap={4}>
              <h2>{title}</h2>
              <p className="tp-hint">{t(`documents.hints.${type}`)}</p>
              {missing && <p className="tp-warning">{t(`documents.missing.${missing.reason}`)}</p>}
              {own.length === 0 ? (
                <p>{t("documents.none")}</p>
              ) : (
                <ul className="tp-document-list">
                  {own.map((document) => (
                    <li key={document.id}>
                      <DocumentItem
                        document={document}
                        name={name(document)}
                        language={language}
                        busy={busy !== undefined}
                        onOpen={() => void open(document)}
                        onDelete={source.remove ? () => setDeleting(document) : undefined}
                      />
                    </li>
                  ))}
                </ul>
              )}
              {notice?.type === type && (
                <InlineNotification
                  kind={notice.kind}
                  role={notice.kind === "error" ? "alert" : "status"}
                  title={t(`documents.messages.${notice.message}`, { max })}
                  hideCloseButton
                  lowContrast
                />
              )}
              {busy === type && <output className="tp-hint">{t("documents.busy")}</output>}
              {addableTypes.includes(type) && (
                <div>
                  <FileUploaderButton
                    id={`document-upload-${type}`}
                    labelText={t("documents.upload", { type: title })}
                    accept={DOCUMENT_ACCEPT}
                    buttonKind="tertiary"
                    size="md"
                    disabled={busy !== undefined}
                    disableLabelChanges
                    multiple={false}
                    onChange={(event: ChangeEvent<HTMLInputElement>) =>
                      void upload(type, event.target.files?.[0])
                    }
                  />
                </div>
              )}
            </Stack>
          </section>
        );
      })}
      <Modal
        open={deleting !== undefined}
        danger
        size="sm"
        modalHeading={t("documents.delete.title")}
        primaryButtonText={t("documents.delete.confirm")}
        secondaryButtonText={t("documents.delete.cancel")}
        onRequestSubmit={() => deleting && void remove(deleting)}
        onRequestClose={() => setDeleting(undefined)}
      >
        <p>{deleting && t("documents.delete.text", { name: name(deleting) })}</p>
      </Modal>
    </Stack>
  );
}

function DocumentItem(props: {
  document: DocumentView;
  name: string;
  language: "de" | "en";
  busy: boolean;
  onOpen: () => void;
  onDelete: (() => void) | undefined;
}) {
  const { t } = useT();
  const { document, name } = props;
  const { review, capabilities } = document;
  return (
    <Stack gap={3}>
      <p className="tp-document-name">{name}</p>
      <p className="tp-hint">
        {t("documents.facts", {
          size: formatFileSize(document.sizeBytes, props.language),
          at: formatTimestamp(document.addedAt),
          by: t(`documents.addedBy.${document.addedBy}`),
        })}
      </p>
      <div>
        <Tag
          type={
            review.state === "accepted" ? "green" : review.state === "rejected" ? "red" : "gray"
          }
        >
          {review.state === "rejected" && review.reasonCode
            ? t("documents.states.rejectedBecause", {
                reason: t(`documents.reasons.${review.reasonCode}`),
              })
            : t(`documents.states.${review.state}`)}
        </Tag>
      </div>
      <div className="tp-wizard-actions">
        {capabilities.open && (
          <Button
            kind="tertiary"
            size="sm"
            disabled={props.busy}
            onClick={props.onOpen}
            aria-label={t("documents.openLabel", { name })}
          >
            {t("documents.open")}
          </Button>
        )}
        {capabilities.delete && props.onDelete && (
          <Button
            kind="danger--ghost"
            size="sm"
            disabled={props.busy}
            onClick={props.onDelete}
            aria-label={t("documents.deleteLabel", { name })}
          >
            {t("documents.delete.action")}
          </Button>
        )}
      </div>
    </Stack>
  );
}
