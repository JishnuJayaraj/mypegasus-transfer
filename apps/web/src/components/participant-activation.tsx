import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createLink } from "@tanstack/react-router";
import type { components } from "@transfer/api-client";
import {
  Button,
  SectionCard,
  Checkbox,
  formatDate,
  formatTimestamp,
  InlineNotification,
  Link,
  Select,
  SelectItem,
  Stack,
  TextInput,
  useToast,
} from "@transfer/ui";
import { useLayoutEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { participationActivationQuery, participationQuery, useApi, worklistQuery } from "../api";
import { RecoveryPanel, type RecoveryPrinted } from "./recovery";

// "Portalaktivierung und Datenschutzhinweis" on the participant overview (data-protection.md,
// activation issuance and Article 14 notices): the derived status, dates and channel kinds as a
// card; sending a code in person, the recovery and the notice's handover each in a side panel
// (ui-patterns.md, C4), revoking an open code in the card. The capabilities decide what exists.

type Detail = components["schemas"]["ParticipationDetail"];
const RouterLink = createLink(Link);

/** The side panels of this card; the page header's "Aktionen" opens them too. */
export type ActivationPanelKind = "send" | "recovery" | "notice";

/** Which of the panels the viewer may open now (the capabilities and the state). */
export function activationPanels(detail: Detail): ActivationPanelKind[] {
  const { capabilities: may, activationStatus, privacyNoticeState } = detail;
  const activated = activationStatus.account === "activated";
  return [
    ...(may.issueActivationCode && !activated ? (["send"] as const) : []),
    ...(may.issueActivationCode && activated ? (["recovery"] as const) : []),
    ...(may.providePrivacyNotice && privacyNoticeState.state !== "provided"
      ? (["notice"] as const)
      : []),
  ];
}

/** Whether the card reads the activation record (any activation capability). */
const mayRead = (detail: Detail) =>
  Object.values({
    issue: detail.capabilities.issueActivationCode,
    handover: detail.capabilities.recordHandover,
    revoke: detail.capabilities.revokeActivationCode,
    notice: detail.capabilities.providePrivacyNotice,
  }).some(Boolean);

/** Reads the activation record, the detail and the work list again after a change. */
function useRefresh(detail: Detail, projectId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: participationActivationQuery(api, detail.id).queryKey,
      }),
      queryClient.invalidateQueries({ queryKey: participationQuery(api, detail.id).queryKey }),
      queryClient.invalidateQueries({ queryKey: worklistQuery(api, projectId).queryKey }),
    ]);
  };
}

/** The portal account's state in words, as the card and the page header name it. */
export function useActivationText() {
  const { t } = useTranslation();
  return (status: Detail["activationStatus"]): string =>
    status.account === "activated"
      ? status.code === "none"
        ? t("activation.status.activated")
        : t("activation.status.activatedRecovery", { code: t(`activation.code.${status.code}`) })
      : t(`activation.code.${status.code}`);
}

export function ActivationCard({
  detail,
  projectId,
  onOpen,
  card,
}: {
  detail: Detail;
  projectId: string;
  onOpen: (panel: ActivationPanelKind) => void;
  /** The card's open state, held by the overview (collapsed to its summary otherwise). */
  card: { open: boolean; onToggle: (open: boolean) => void };
}) {
  const { t } = useTranslation();
  const api = useApi();
  const statusText = useActivationText();
  const refresh = useRefresh(detail, projectId);
  const query = useQuery({
    ...participationActivationQuery(api, detail.id),
    enabled: mayRead(detail),
  });
  const [failed, setFailed] = useState(false);
  const revoke = useMutation({
    mutationFn: async () => {
      const activationCodeId = query.data?.current?.activationCodeId;
      if (!activationCodeId) throw new Error("No activation code");
      const { data } = await api.POST(
        "/api/v1/participations/{participationId}/activation-codes/revocation",
        {
          params: { path: { participationId: detail.id } },
          body: { activationCodeId, reason: "lost" },
        },
      );
      if (!data) throw new Error("Revocation failed");
    },
    onSuccess: async () => {
      setFailed(false);
      await refresh();
    },
    onError: () => setFailed(true),
  });
  const status = query.data?.status ?? detail.activationStatus;
  const current = query.data?.current;
  // Expired codes are still open in the database; locked and used ones can't be revoked.
  const revocable = ["printed", "open", "delivery_unknown", "expired"].includes(status.code);
  const panels = activationPanels(detail);
  const label: Record<ActivationPanelKind, string> = {
    send: t("activation.detail.sendInPerson"),
    recovery: t("activation.recovery.open"),
    notice: t("activation.detail.noticeHandedOver"),
  };
  const notice = t(`activation.notice.${detail.privacyNoticeState.state}`, {
    dueOn: formatDate(detail.privacyNoticeState.dueOn),
  });
  return (
    <SectionCard
      id="participant-activation"
      title={t("activation.detail.title")}
      summary={`${statusText(status)} · ${t("activation.detail.notice")}: ${notice}`}
      {...card}
    >
      <Stack gap={5}>
        {failed && (
          <InlineNotification
            kind="error"
            title={t("activation.detail.failed")}
            onClose={() => setFailed(false)}
          />
        )}
        <dl className="tp-facts">
          <div>
            <dt>{t("activation.detail.status")}</dt>
            <dd>{statusText(status)}</dd>
          </div>
          {query.data?.account && (
            <>
              <div>
                <dt>{t("activation.detail.activatedAt")}</dt>
                <dd>{formatTimestamp(query.data.account.activatedAt)}</dd>
              </div>
              <div>
                <dt>{t("activation.detail.identityAssurance")}</dt>
                <dd>{t(`activation.assurance.${query.data.account.identityAssurance}`)}</dd>
              </div>
            </>
          )}
          <div>
            <dt>{t("activation.detail.notice")}</dt>
            <dd>{notice}</dd>
          </div>
          {current && (
            <>
              <div>
                <dt>{t("activation.detail.purpose")}</dt>
                <dd>{t(`activation.purpose.${current.purpose}`)}</dd>
              </div>
              <div>
                <dt>{t("activation.detail.channel")}</dt>
                <dd>{t(`activation.channel.${current.channel}`)}</dd>
              </div>
              <div>
                <dt>{t("activation.detail.issuedAt")}</dt>
                <dd>{formatTimestamp(current.issuedAt)}</dd>
              </div>
              <div>
                <dt>{t("activation.detail.issuedBy")}</dt>
                <dd>{current.issuedByDisplayName}</dd>
              </div>
              <div>
                <dt>{t("activation.detail.expiresAt")}</dt>
                <dd>{formatTimestamp(current.expiresAt)}</dd>
              </div>
              <div>
                <dt>{t("activation.detail.delivery")}</dt>
                <dd>
                  {current.deliveryStatus
                    ? t(`activation.delivery.${current.deliveryStatus}`)
                    : "—"}
                </dd>
              </div>
              <div>
                <dt>{t("activation.detail.attempts")}</dt>
                <dd>{current.attemptsLeft}</dd>
              </div>
            </>
          )}
        </dl>
        {query.data && query.data.channels.length > 0 && (
          <div>
            <h3>{t("activation.detail.channels")}</h3>
            {/* Q123 (data-protection.md): kind, states and dates; the address never reaches staff. */}
            <ul className="tp-list">
              {query.data.channels.map((channel) => (
                <li key={channel.id}>
                  {t("activation.detail.channelLine", {
                    kind: t(`activation.deliveryKind.${channel.kind}`),
                    verifiedAt: formatTimestamp(channel.verifiedAt),
                    verifiedBy: t(`activation.verifiedBy.${channel.verifiedBy}`),
                    consentGivenAt: formatTimestamp(channel.consentGivenAt),
                  })}{" "}
                  {t("activation.detail.consentVersion", { version: channel.consentVersion })}{" "}
                  {channel.noticeSentAt
                    ? t("activation.detail.noticeSent", {
                        at: formatTimestamp(channel.noticeSentAt),
                      })
                    : t("activation.detail.noticePending")}
                  {channel.suspendedAt &&
                    !channel.removedAt &&
                    ` ${t("activation.detail.suspended", { at: formatTimestamp(channel.suspendedAt) })}`}
                  {channel.removedAt &&
                    ` ${t("activation.detail.removed", { at: formatTimestamp(channel.removedAt) })}`}
                </li>
              ))}
            </ul>
          </div>
        )}
        {(panels.length > 0 ||
          (detail.capabilities.revokeActivationCode && current && revocable)) && (
          <div className="tp-button-row">
            {panels.map((panel) => (
              <Button key={panel} kind="tertiary" size="md" onClick={() => onOpen(panel)}>
                {label[panel]}
              </Button>
            ))}
            {detail.capabilities.revokeActivationCode && current && revocable && (
              <Button
                kind="danger--tertiary"
                size="md"
                disabled={revoke.isPending}
                onClick={() => revoke.mutate()}
              >
                {t("activation.detail.revoke")}
              </Button>
            )}
          </div>
        )}
        {detail.capabilities.issueActivationCode && status.account !== "activated" && (
          <p>
            <RouterLink to="/projects/$projectId/participants" params={{ projectId }}>
              {t("activation.detail.issuePrint")}
            </RouterLink>
          </p>
        )}
      </Stack>
    </SectionCard>
  );
}

/** "Persönlich senden": the in-person code after the photo-ID check (process-and-lifecycle.md). */
export function SendInPersonForm({
  detail,
  projectId,
  onDirtyChange,
  onSaved,
}: {
  detail: Detail;
  projectId: string;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const showToast = useToast();
  const refresh = useRefresh(detail, projectId);
  const query = useQuery(participationActivationQuery(api, detail.id));
  const [language, setLanguage] = useState<"de" | "en">("de");
  const [deliveryKind, setDeliveryKind] = useState<"email" | "sms">("email");
  const [deliveryAddress, setDeliveryAddress] = useState("");
  const [identityChecked, setIdentityChecked] = useState(false);
  const [confirmReissue, setConfirmReissue] = useState(false);
  const dirty =
    language !== "de" ||
    deliveryKind !== "email" ||
    deliveryAddress !== "" ||
    identityChecked ||
    confirmReissue;
  // A layout effect, so an Escape right after typing already asks (ui-patterns.md, side panel).
  useLayoutEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  const status = query.data?.status ?? detail.activationStatus;
  const requiresReissueConfirmation = ["printed", "open", "delivery_unknown"].includes(status.code);
  const send = useMutation({
    mutationFn: async () => {
      const { data } = await api.POST(
        "/api/v1/participations/{participationId}/activation-codes/in-person",
        {
          params: { path: { participationId: detail.id } },
          body: {
            deliveryKind,
            deliveryAddress,
            language,
            identityChecked: true,
            replaceOpenCode: confirmReissue,
          },
        },
      );
      if (!data) throw new Error("Activation delivery failed");
      return data;
    },
    onSuccess: async () => {
      onDirtyChange(false);
      showToast({ title: t("activation.detail.sent") });
      onSaved();
      await refresh();
    },
  });
  return (
    <Stack gap={5}>
      {send.isError && (
        <InlineNotification kind="error" title={t("activation.detail.failed")} hideCloseButton />
      )}
      <LanguageSelect id="activation-detail-language" value={language} onChange={setLanguage} />
      <Select
        id="activation-delivery-kind"
        labelText={t("activation.detail.deliveryKind")}
        value={deliveryKind}
        onChange={(event) => setDeliveryKind(event.target.value as "email" | "sms")}
      >
        <SelectItem value="email" text={t("activation.deliveryKind.email")} />
        <SelectItem value="sms" text={t("activation.deliveryKind.sms")} />
      </Select>
      <TextInput
        id="activation-delivery-address"
        labelText={t("activation.detail.deliveryAddress")}
        value={deliveryAddress}
        onChange={(event) => setDeliveryAddress(event.target.value)}
        autoComplete="off"
      />
      <Checkbox
        id="activation-identity-checked"
        labelText={t("activation.detail.identityChecked")}
        checked={identityChecked}
        onChange={(_, { checked }) => setIdentityChecked(checked)}
      />
      {requiresReissueConfirmation && (
        <Checkbox
          id="activation-confirm-reissue"
          labelText={t("activation.detail.confirmReissue")}
          checked={confirmReissue}
          onChange={(_, { checked }) => setConfirmReissue(checked)}
        />
      )}
      <div>
        <Button
          disabled={
            !deliveryAddress ||
            !identityChecked ||
            (requiresReissueConfirmation && !confirmReissue) ||
            send.isPending
          }
          onClick={() => send.mutate()}
        >
          {t("activation.detail.send")}
        </Button>
      </div>
    </Stack>
  );
}

/** "Zugang wiederherstellen" (Q130): the language, then the recovery form. */
export function RecoveryForm({
  detail,
  projectId,
  onDirtyChange,
  onPrinted,
}: {
  detail: Detail;
  projectId: string;
  onDirtyChange: (dirty: boolean) => void;
  /** A printed letter or sheet: the panel closes and the page shows the print view. */
  onPrinted: (printed: RecoveryPrinted) => void;
}) {
  const api = useApi();
  const refresh = useRefresh(detail, projectId);
  const query = useQuery(participationActivationQuery(api, detail.id));
  const [language, setLanguage] = useState<"de" | "en">("de");
  const [formDirty, setFormDirty] = useState(false);
  const dirty = formDirty || language !== "de";
  useLayoutEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  const status = query.data?.status ?? detail.activationStatus;
  return (
    <Stack gap={5}>
      <LanguageSelect id="activation-recovery-language" value={language} onChange={setLanguage} />
      <RecoveryPanel
        participationId={detail.id}
        projectId={projectId}
        language={language}
        openCode={["printed", "open", "delivery_unknown"].includes(status.code)}
        onChanged={refresh}
        onPrinted={(printed) => {
          onDirtyChange(false);
          onPrinted(printed);
        }}
        onDirtyChange={setFormDirty}
      />
    </Stack>
  );
}

/** The Article 14 notice handed over in person, printed in the chosen language. */
export function NoticeHandoverForm({
  detail,
  projectId,
  onDirtyChange,
  onSaved,
}: {
  detail: Detail;
  projectId: string;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const showToast = useToast();
  const refresh = useRefresh(detail, projectId);
  const [language, setLanguage] = useState<"de" | "en">("de");
  useLayoutEffect(() => onDirtyChange(language !== "de"), [language, onDirtyChange]);
  const provide = useMutation({
    mutationFn: async () => {
      const { data, response } = await api.POST(
        "/api/v1/participations/{participationId}/privacy-notices",
        {
          params: { path: { participationId: detail.id } },
          body: { language, method: "in_person_print", handedOver: true },
        },
      );
      if (!data && response.status !== 201) throw new Error("Notice handover failed");
    },
    onSuccess: async () => {
      onDirtyChange(false);
      showToast({ title: t("activation.detail.noticeRecorded") });
      onSaved();
      await refresh();
    },
  });
  return (
    <Stack gap={5}>
      {provide.isError && (
        <InlineNotification kind="error" title={t("activation.detail.failed")} hideCloseButton />
      )}
      <p>{t("activation.detail.noticeIntro")}</p>
      <LanguageSelect id="activation-notice-language" value={language} onChange={setLanguage} />
      <div>
        <Button disabled={provide.isPending} onClick={() => provide.mutate()}>
          {t("activation.detail.noticeSubmit")}
        </Button>
      </div>
    </Stack>
  );
}

function LanguageSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: "de" | "en";
  onChange: (language: "de" | "en") => void;
}) {
  const { t } = useTranslation();
  return (
    <Select
      id={id}
      labelText={t("activation.bulk.language")}
      value={value}
      onChange={(event) => onChange(event.target.value as "de" | "en")}
    >
      <SelectItem value="de" text="Deutsch" />
      <SelectItem value="en" text="English" />
    </Select>
  );
}
