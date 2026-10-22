import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { components } from "@transfer/api-client";
import {
  DocumentDeleteReason,
  DocumentReviewReason,
  type DocumentType,
  type DocumentView,
} from "@transfer/domain";
import {
  DOCUMENT_ACCEPT,
  documentFailureOf,
  formatFileSize,
  readFileAsBase64,
  SELF_SERVICE_NAMESPACE,
  type DocumentErrorCode,
} from "@transfer/self-service-ui";
import {
  Button,
  FileUploaderButton,
  formatTimestamp,
  InlineNotification,
  Modal,
  Select,
  SelectItem,
  SimpleTable,
  Stack,
} from "@transfer/ui";
import { useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import { participationDocumentsQuery, useApi } from "../api";

// The tab "Unterlagen" (data-protection.md, documents and the access matrix): the documents of the
// types the viewer may read in normal mode, with "Öffnen" (a logged opening, then a download from
// its short-lived link), "Annehmen", "Ablehnen" (a reason) and "Löschen" (a reason and a
// confirmation) as each document's capabilities say, and "Unterlagen hinzufügen" for the addable
// types. The API checks every action again. German only.

type Detail = components["schemas"]["ParticipationDetail"];
type Message =
  | "uploaded"
  | "accepted"
  | "rejected"
  | "deleted"
  | "gone"
  | "forbidden"
  | "failed"
  | `codes.${DocumentErrorCode}`;

/** Where "Öffnen" goes; an object so tests can watch it (jsdom doesn't navigate). */
export const documentNavigation = {
  assign: (url: string) => window.location.assign(url),
};

/** A refusal as the tab's message: the code's, else what kind of failure it was. */
function messageOf(error: unknown): Message {
  const failure = documentFailureOf(error);
  if (failure.kind === "refused") return `codes.${failure.code}`;
  if (failure.kind === "gone" || failure.kind === "forbidden") return failure.kind;
  return "failed";
}

export function DocumentsTab({ detail }: { detail: Detail }) {
  const { t } = useTranslation();
  const { t: ts } = useTranslation(SELF_SERVICE_NAMESPACE);
  const api = useApi();
  const queryClient = useQueryClient();
  const listQuery = participationDocumentsQuery(api, detail.id);
  const query = useQuery(listQuery);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: Message }>();
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState<DocumentView>();
  const [deleting, setDeleting] = useState<DocumentView>();
  const path = { participationId: detail.id };

  if (query.isPending) return <p>{t("participant.documents.loading")}</p>;
  if (query.isError) {
    return (
      <InlineNotification
        kind="error"
        title={t("participant.documents.failed")}
        hideCloseButton
        lowContrast
      />
    );
  }
  const { documents, addableTypes, limits } = query.data;
  const typeLabel = (type: DocumentType) => ts(`documents.types.${type}`);

  /** Runs an action; afterwards the list is read again (capabilities change with it). */
  async function act(action: () => Promise<unknown>, done: Message) {
    setBusy(true);
    setMessage(undefined);
    try {
      await action();
      setMessage({ kind: "success", text: done });
    } catch (error) {
      setMessage({ kind: "error", text: messageOf(error) });
    } finally {
      setBusy(false);
      await queryClient.invalidateQueries({ queryKey: listQuery.queryKey });
      // The missing items of the tab "Selbstauskunft" count the documents.
      await queryClient.invalidateQueries({
        queryKey: ["participations", detail.id, "self-service"],
      });
    }
  }

  async function open(document: DocumentView) {
    setMessage(undefined);
    try {
      const { data } = await api.POST(
        "/api/v1/participations/{participationId}/documents/{documentId}/opening",
        {
          params: { path: { ...path, documentId: document.id } },
          // No body, but the API takes JSON only (ADR-0010).
          headers: { "Content-Type": "application/json" },
        },
      );
      if (!data) throw new Error("No opening");
      documentNavigation.assign(data.url);
    } catch (error) {
      setMessage({ kind: "error", text: messageOf(error) });
    }
  }

  const review = (document: DocumentView, reasonCode?: DocumentReviewReason) =>
    act(
      async () => {
        const { data } = await api.POST(
          "/api/v1/participations/{participationId}/documents/{documentId}/review",
          {
            params: { path: { ...path, documentId: document.id } },
            body: reasonCode ? { decision: "rejected", reasonCode } : { decision: "accepted" },
          },
        );
        if (!data) throw new Error("No review");
      },
      reasonCode ? "rejected" : "accepted",
    );

  const remove = (document: DocumentView, reasonCode: DocumentDeleteReason) =>
    act(async () => {
      const { response } = await api.DELETE(
        "/api/v1/participations/{participationId}/documents/{documentId}",
        { params: { path: { ...path, documentId: document.id }, query: { reasonCode } } },
      );
      if (!response.ok) throw new Error("Not deleted");
    }, "deleted");

  const upload = (type: DocumentType, file: File) => {
    // Checked here so nothing too large or empty is sent; the API checks again.
    if (file.size === 0 || file.size > limits.maxBytes) {
      const code = file.size === 0 ? "file_empty" : "file_too_large";
      setMessage({ kind: "error", text: `codes.${code}` });
      return;
    }
    return act(async () => {
      const content = await readFileAsBase64(file);
      const { data } = await api.POST("/api/v1/participations/{participationId}/documents", {
        params: { path },
        body: { type, fileName: file.name, content },
      });
      if (!data) throw new Error("Not uploaded");
    }, "uploaded");
  };

  const rows = documents.map((document) => {
    const name = document.fileName ?? typeLabel(document.type);
    const { capabilities, review: state } = document;
    return {
      id: document.id,
      type: typeLabel(document.type),
      file: document.fileName ?? "—",
      size: formatFileSize(document.sizeBytes),
      added: t("participant.documents.added", {
        at: formatTimestamp(document.addedAt),
        by: t(
          `participant.documents.addedBy.${document.addedBy === "participant" ? "participant" : document.onBehalf ? "assisted" : "staff"}`,
        ),
      }),
      state:
        state.state === "rejected" && state.reasonCode
          ? ts("documents.states.rejectedBecause", {
              reason: ts(`documents.reasons.${state.reasonCode}`),
            })
          : ts(`documents.states.${state.state}`),
      actions: (
        <span className="tp-inline-actions">
          {capabilities.open && (
            <Button
              kind="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void open(document)}
              aria-label={t("participant.documents.openLabel", { name })}
            >
              {t("participant.documents.open")}
            </Button>
          )}
          {capabilities.review && (
            <>
              <Button
                kind="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void review(document)}
                aria-label={t("participant.documents.acceptLabel", { name })}
              >
                {t("participant.documents.accept")}
              </Button>
              <Button
                kind="ghost"
                size="sm"
                disabled={busy}
                onClick={() => setRejecting(document)}
                aria-label={t("participant.documents.rejectLabel", { name })}
              >
                {t("participant.documents.reject")}
              </Button>
            </>
          )}
          {capabilities.delete && (
            <Button
              kind="danger--ghost"
              size="sm"
              disabled={busy}
              onClick={() => setDeleting(document)}
              aria-label={t("participant.documents.deleteLabel", { name })}
            >
              {t("participant.documents.delete")}
            </Button>
          )}
        </span>
      ),
    };
  });

  return (
    <Stack gap={6}>
      {message && (
        <InlineNotification
          kind={message.kind}
          role={message.kind === "error" ? "alert" : "status"}
          title={t(`participant.documents.messages.${message.text}`, {
            max: formatFileSize(limits.maxBytes),
          })}
          onClose={() => setMessage(undefined)}
          lowContrast
        />
      )}
      <SimpleTable
        title={t("participant.documents.title")}
        columns={(["type", "file", "size", "added", "state", "actions"] as const).map((key) => ({
          key,
          header: t(`participant.documents.columns.${key}`),
        }))}
        rows={rows}
        emptyState={t("participant.documents.empty")}
      />
      {addableTypes.length > 0 && (
        <AddDocument
          types={addableTypes}
          busy={busy}
          onUpload={(type, file) => upload(type, file)}
        />
      )}
      <RejectDialog
        document={rejecting}
        onClose={() => setRejecting(undefined)}
        onReject={(document, reason) => {
          setRejecting(undefined);
          void review(document, reason);
        }}
      />
      <DeleteDialog
        document={deleting}
        name={deleting && (deleting.fileName ?? typeLabel(deleting.type))}
        onClose={() => setDeleting(undefined)}
        onDelete={(document, reason) => {
          setDeleting(undefined);
          void remove(document, reason);
        }}
      />
    </Stack>
  );
}

/** "Unterlagen hinzufügen": the type, then the file (uploaded at once). */
function AddDocument(props: {
  types: DocumentType[];
  busy: boolean;
  onUpload: (type: DocumentType, file: File) => unknown;
}) {
  const { t } = useTranslation();
  const { t: ts } = useTranslation(SELF_SERVICE_NAMESPACE);
  const [type, setType] = useState<DocumentType>(props.types[0]!);
  return (
    <fieldset className="tp-fieldset">
      <legend>{t("participant.documents.add")}</legend>
      <Stack gap={5}>
        <p>{t("participant.documents.addHint")}</p>
        <Select
          id="document-add-type"
          labelText={t("participant.documents.addType")}
          value={type}
          onChange={(event) => setType(event.target.value as DocumentType)}
        >
          {props.types.map((option) => (
            <SelectItem key={option} value={option} text={ts(`documents.types.${option}`)} />
          ))}
        </Select>
        <div>
          <FileUploaderButton
            id="document-add-file"
            labelText={t("participant.documents.addFile")}
            accept={DOCUMENT_ACCEPT}
            buttonKind="tertiary"
            size="md"
            disabled={props.busy}
            disableLabelChanges
            multiple={false}
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              const file = event.target.files?.[0];
              if (file) props.onUpload(type, file);
            }}
          />
        </div>
        {props.busy && <output className="tp-hint">{t("participant.documents.busy")}</output>}
      </Stack>
    </fieldset>
  );
}

/** "Ablehnen": the reason, required. */
function RejectDialog(props: {
  document: DocumentView | undefined;
  onClose: () => void;
  onReject: (document: DocumentView, reason: DocumentReviewReason) => void;
}) {
  const { t } = useTranslation();
  const { t: ts } = useTranslation(SELF_SERVICE_NAMESPACE);
  const [reason, setReason] = useState<DocumentReviewReason>();
  const close = () => {
    setReason(undefined);
    props.onClose();
  };
  return (
    <Modal
      open={props.document !== undefined}
      size="sm"
      modalHeading={t("participant.documents.rejectTitle")}
      primaryButtonText={t("participant.documents.reject")}
      secondaryButtonText={t("participant.documents.cancel")}
      primaryButtonDisabled={!reason}
      onRequestSubmit={() => {
        if (!props.document || !reason) return;
        setReason(undefined);
        props.onReject(props.document, reason);
      }}
      onRequestClose={close}
    >
      <Select
        id="document-reject-reason"
        labelText={t("participant.documents.reason")}
        value={reason ?? ""}
        onChange={(event) => setReason(event.target.value as DocumentReviewReason)}
      >
        <SelectItem value="" text={t("participant.documents.chooseReason")} />
        {DocumentReviewReason.options.map((option) => (
          <SelectItem key={option} value={option} text={ts(`documents.reasons.${option}`)} />
        ))}
      </Select>
    </Modal>
  );
}

/** "Löschen": the reason and the confirmation; the file is purged, the record stays. */
function DeleteDialog(props: {
  document: DocumentView | undefined;
  name: string | undefined;
  onClose: () => void;
  onDelete: (document: DocumentView, reason: DocumentDeleteReason) => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState<DocumentDeleteReason>();
  const close = () => {
    setReason(undefined);
    props.onClose();
  };
  return (
    <Modal
      open={props.document !== undefined}
      danger
      size="sm"
      modalHeading={t("participant.documents.deleteTitle")}
      primaryButtonText={t("participant.documents.delete")}
      secondaryButtonText={t("participant.documents.cancel")}
      primaryButtonDisabled={!reason}
      onRequestSubmit={() => {
        if (!props.document || !reason) return;
        setReason(undefined);
        props.onDelete(props.document, reason);
      }}
      onRequestClose={close}
    >
      <Stack gap={5}>
        <p>{props.name && t("participant.documents.deleteText", { name: props.name })}</p>
        <Select
          id="document-delete-reason"
          labelText={t("participant.documents.reason")}
          value={reason ?? ""}
          onChange={(event) => setReason(event.target.value as DocumentDeleteReason)}
        >
          <SelectItem value="" text={t("participant.documents.chooseReason")} />
          {DocumentDeleteReason.options.map((option) => (
            <SelectItem
              key={option}
              value={option}
              text={t(`participant.documents.deleteReasons.${option}`)}
            />
          ))}
        </Select>
      </Stack>
    </Modal>
  );
}
