import { useQueryClient } from "@tanstack/react-query";
import type { components } from "@transfer/api-client";
import { DOCUMENT_ACCEPT, readFileAsBase64 } from "@transfer/self-service-ui";
import {
  ActionButton,
  Button,
  Card,
  Checkbox,
  DateField,
  FileUploaderButton,
  InlineNotification,
  Select,
  SelectItem,
  SidePanel,
  Stack,
  formatDate,
  parseDisplayDate,
} from "@transfer/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi, participationQuery } from "../api";
import { useCorrectionRequest } from "./evidence-correction";
import { usePanelNavigationGuard } from "./panel-guard";

type View = components["schemas"]["DsvView"];
type Scan = View["scans"][number];
type Action = "review" | "reject" | "quarantine" | "delete" | "signed";
type Target = { kind: "upload"; offerId: string } | { kind: Action; scan: Scan; version: number };
const kinds = ["participant", "customer", "transfergesellschaft"] as const;

/**
 * The signed paper of the tab "DSV": the participant's scans of the offer (`scan`) or the
 * cancellation of the signed contract (`cancellation`; process-and-lifecycle.md, the cancellation,
 * Q46 verify): uploaded with the dates on the paper and its receipt, nothing preset; reviewed by
 * confirming each signature (the cancellation needs all three); quarantine and deletion as built.
 */
export function DsvScans({
  view,
  projectId,
  onOpen,
  paper = "scan",
}: {
  view: View;
  projectId: string;
  onOpen: (id: string) => Promise<void>;
  paper?: "scan" | "cancellation";
}) {
  const { t } = useTranslation();
  const cancellation = paper === "cancellation";
  const list = cancellation ? view.cancellations : view.scans;
  const paperType = cancellation ? "dsv_cancellation" : "dsv_signed_scan";
  const signatureCorrection = useCorrectionRequest({
    participationId: view.participationId,
    projectId,
  });
  const api = useApi();
  const cache = useQueryClient();
  const [target, setTarget] = useState<Target | null>(null);
  const [dates, setDates] = useState({
    participant: "",
    customer: "",
    transfergesellschaft: "",
    receivedOn: "",
  });
  const [receiver, setReceiver] = useState("");
  const [file, setFile] = useState<File>();
  const [terms, setTerms] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const dirty = Object.values(dates).some(Boolean) || !!receiver || !!file || terms || !!reason;
  const navigation = usePanelNavigationGuard(target !== null && dirty);
  const close = () => {
    setTarget(null);
    setDates({ participant: "", customer: "", transfergesellschaft: "", receivedOn: "" });
    setReceiver("");
    setFile(undefined);
    setTerms(false);
    setReason("");
    setError(false);
  };
  const parsed = Object.fromEntries(
    Object.entries(dates).map(([key, value]) => {
      const d = parseDisplayDate(value);
      return [key, d.ok ? d.value : null];
    }),
  );
  const signatures = Object.fromEntries(
    kinds.filter((k) => parsed[k]).map((k) => [k, parsed[k]!]),
  ) as Record<string, string>;
  // The open offer takes the participant's paper; the signed offer the countersigned original
  // and the cancellation of the signed contract.
  const signedOffer =
    view.track === "dsv_signed" ? view.offers.find((o) => o.endedAs === "signed") : undefined;
  const offer = cancellation
    ? signedOffer
    : (view.offers.find((o) => o.endedAs === null) ?? signedOffer);
  const mayUpload = cancellation
    ? view.capabilities.uploadCancellation
    : view.capabilities.uploadScan;
  const documentPath = (scan: Scan) => ({
    participationId: view.participationId,
    documentId: scan.document.id,
  });
  async function perform(run: () => Promise<{ error?: unknown }>, finish = true) {
    setBusy(true);
    setError(false);
    try {
      const result = await run();
      if (result.error) throw result.error;
      if (finish) close();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
      const detail = cache.getQueryData(participationQuery(api, view.participationId).queryKey);
      await Promise.all([
        cache.invalidateQueries({ queryKey: ["participations", view.participationId] }),
        ...(detail
          ? [
              cache.invalidateQueries({
                queryKey: ["projects", detail.projectId, "participations"],
              }),
            ]
          : []),
      ]);
    }
  }
  async function submit() {
    if (!target) return;
    if (target.kind === "upload") {
      await perform(async () => {
        const body = {
          offerId: target.offerId,
          receivedBy: receiver,
          receivedOn: parsed.receivedOn!,
          signatures,
          file: { fileName: file!.name, content: await readFileAsBase64(file!) },
        };
        const params = { path: { participationId: view.participationId } };
        return cancellation
          ? api.POST("/api/v1/participations/{participationId}/dsv/cancellation-scans", {
              params,
              body,
            })
          : api.POST("/api/v1/participations/{participationId}/dsv/scans", { params, body });
      });
      return;
    }
    const path = documentPath(target.scan);
    if (target.kind === "review" || target.kind === "reject")
      await perform(() =>
        api.POST("/api/v1/participations/{participationId}/documents/{documentId}/review", {
          params: { path },
          body:
            target.kind === "review"
              ? {
                  decision: "accepted",
                  // The cancellation confirms its three signatures; the terms are the offer's.
                  dsv: cancellation ? { signatures } : { signatures, termsConfirmed: terms },
                }
              : { decision: "rejected", reasonCode: reason as "unreadable" },
        }),
      );
    else if (target.kind === "quarantine")
      await perform(() =>
        api.POST("/api/v1/participations/{participationId}/documents/{documentId}/quarantine", {
          params: { path },
          body: { reasonCode: reason as "suspected_wrong_person" },
        }),
      );
    else if (target.kind === "delete")
      await perform(() =>
        api.DELETE("/api/v1/participations/{participationId}/documents/{documentId}", {
          params: { path, query: { reasonCode: reason as "wrong_file" } },
        }),
      );
    else
      await perform(() =>
        api.POST("/api/v1/participations/{participationId}/dsv/signed", {
          params: { path: { participationId: view.participationId } },
          body: { scanId: target.scan.document.id, statusVersion: target.version },
        }),
      );
  }
  const needsDates = target?.kind === "upload" || target?.kind === "review";
  const external =
    !cancellation &&
    target?.kind === "review" &&
    view.offers.find((o) => o.id === target.scan.metadata.offerId)?.origin === "external_paper";
  const invalid =
    (needsDates && kinds.some((k) => dates[k] && !parsed[k])) ||
    (target?.kind === "upload" && (!file || !receiver || !parsed.receivedOn)) ||
    (external && !terms) ||
    (cancellation && target?.kind === "review" && kinds.some((k) => !parsed[k])) ||
    (target && ["reject", "quarantine", "delete"].includes(target.kind) && !reason);
  const reasons =
    target?.kind === "reject"
      ? ["unreadable", "wrong_document", "incomplete"]
      : target?.kind === "delete"
        ? ["wrong_person", "wrong_file"]
        : ["suspected_wrong_person", "suspected_wrong_acceptance"];
  return (
    <Card title={t(cancellation ? "dsv.cancellation.title" : "dsv.scans.title")} level={3}>
      <Stack gap={4}>
        {error && !target && (
          <InlineNotification kind="error" title={t("dsv.scans.failed")} lowContrast />
        )}
        {cancellation && <p>{t("dsv.cancellation.hint")}</p>}
        {cancellation && view.facts.dsvCancellation && (
          <p>
            {t("dsv.cancellation.counting", {
              date: formatDate(view.facts.dsvCancellation.validOn),
            })}
          </p>
        )}
        {offer && mayUpload && (
          <Button kind="tertiary" onClick={() => setTarget({ kind: "upload", offerId: offer.id })}>
            {t(cancellation ? "dsv.cancellation.upload" : "dsv.scans.upload")}
          </Button>
        )}
        {signatureCorrection.element}
        {!list.length && <p>{t(cancellation ? "dsv.cancellation.empty" : "dsv.scans.empty")}</p>}
        {list.map((scan) => (
          <Stack key={scan.document.id} gap={3}>
            <p>
              {t("dsv.scans.receivedOn")}
              {": "}
              {formatDate(scan.metadata.receivedOn)}
              {" · "}
              {t(`dsv.scans.states.${scan.document.review.state}`)}
              {scan.document.quarantine ? ` · ${t("dsv.scans.quarantined")}` : ""}
            </p>
            {kinds
              .filter((k) => scan.metadata.signatures[k])
              .map((k) => {
                // A wrong signature date on accepted paper is superseded, never edited
                // (process-and-lifecycle.md, the DSV signature-date supersession).
                const pending = view.signatureCorrections.pending.some(
                  (c) =>
                    c.offerId === scan.metadata.offerId &&
                    c.paper === paperType &&
                    c.signature === k,
                );
                return (
                  <p key={k}>
                    {t(`dsv.scans.${k}`)}
                    {": "}
                    {formatDate(scan.metadata.signatures[k]!)}
                    {pending && ` · ${t("corrections.pending")}`}
                    {scan.document.review.state === "accepted" &&
                      !pending &&
                      view.signatureCorrections.mayRequest &&
                      signatureCorrection.button({
                        kind: "dsv_signature",
                        id: `${scan.metadata.offerId}-${paperType}-${k}`,
                        offerId: scan.metadata.offerId,
                        paper: paperType,
                        signature: k,
                        label: `${t(`dsv.scans.${k}`)} (${formatDate(scan.metadata.signatures[k]!)})`,
                      })}
                  </p>
                );
              })}
            <div>
              {scan.document.capabilities.open && (
                <Button kind="ghost" onClick={() => void onOpen(scan.document.id)}>
                  {t("dsv.scans.open")}
                </Button>
              )}
              {(["review", "reject", "quarantine", "delete", "signed"] as const)
                .filter((action) =>
                  action === "signed"
                    ? !cancellation && view.capabilities.sign
                    : action === "reject"
                      ? scan.document.capabilities.review
                      : scan.document.capabilities[action],
                )
                .map((action) => (
                  <ActionButton
                    key={action}
                    kind="ghost"
                    unavailableReason={
                      action === "signed" && !scan.counting ? t("dsv.scans.evidenceRequired") : null
                    }
                    onClick={() => setTarget({ kind: action, scan, version: view.statusVersion })}
                  >
                    {t(`dsv.scans.${action}`)}
                  </ActionButton>
                ))}
              {scan.document.capabilities.liftQuarantine && (
                <Button
                  kind="ghost"
                  disabled={busy}
                  onClick={() =>
                    void perform(
                      () =>
                        api.POST(
                          "/api/v1/participations/{participationId}/documents/{documentId}/quarantine-lift",
                          {
                            params: { path: documentPath(scan) },
                            headers: { "Content-Type": "application/json" },
                          },
                        ),
                      false,
                    )
                  }
                >
                  {t("dsv.scans.lift")}
                </Button>
              )}
            </div>
          </Stack>
        ))}
      </Stack>
      <SidePanel
        open={target !== null}
        title={
          cancellation && (target?.kind ?? "upload") === "upload"
            ? t("dsv.cancellation.upload")
            : t(`dsv.scans.${target?.kind ?? "upload"}`)
        }
        dirty={dirty}
        onClose={close}
        pendingNavigation={navigation}
      >
        {target && (
          <Stack gap={4}>
            {error && <InlineNotification kind="error" title={t("dsv.scans.failed")} lowContrast />}
            {target.kind === "upload" && (
              <>
                <FileUploaderButton
                  labelText={t("dsv.scans.file")}
                  accept={DOCUMENT_ACCEPT}
                  onChange={(e) => setFile(e.target.files?.[0])}
                />
                {file && <p>{file.name}</p>}
                <Select
                  id="dsv-receiver"
                  labelText={t("dsv.scans.receiver")}
                  value={receiver}
                  onChange={(e) => setReceiver(e.target.value)}
                >
                  <SelectItem value="" text={t("dsv.scans.choose")} />
                  {view.receivers.map((r) => (
                    <SelectItem key={r.id} value={r.id} text={r.name} />
                  ))}
                </Select>
                <DateField
                  id="dsv-received"
                  labelText={t("dsv.scans.receivedOn")}
                  onChange={(value) => setDates((d) => ({ ...d, receivedOn: value }))}
                />
              </>
            )}
            {needsDates && (
              <>
                <p>{t(cancellation ? "dsv.cancellation.datesHint" : "dsv.scans.datesHint")}</p>
                {kinds.map((k) => (
                  <DateField
                    key={k}
                    id={`dsv-date-${k}`}
                    labelText={t(`dsv.scans.${k}`)}
                    onChange={(value) => setDates((d) => ({ ...d, [k]: value }))}
                  />
                ))}
              </>
            )}
            {external && (
              <Checkbox
                id="dsv-terms"
                labelText={t("dsv.scans.terms")}
                checked={terms}
                onChange={(_, data) => setTerms(data.checked)}
              />
            )}
            {["reject", "quarantine", "delete"].includes(target.kind) && (
              <Select
                id="dsv-reason"
                labelText={t("dsv.scans.reason")}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              >
                <SelectItem value="" text={t("dsv.scans.choose")} />
                {reasons.map((r) => (
                  <SelectItem key={r} value={r} text={t(`dsv.scans.reasons.${r}` as never)} />
                ))}
              </Select>
            )}
            {target.kind === "signed" && <p>{t("dsv.scans.signHint")}</p>}
            <ActionButton
              disabled={busy}
              unavailableReason={invalid ? t("dsv.scans.complete") : null}
              onClick={() => void submit()}
            >
              {t("dsv.scans.save")}
            </ActionButton>
          </Stack>
        )}
      </SidePanel>
    </Card>
  );
}
