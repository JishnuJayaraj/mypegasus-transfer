import { useMutation } from "@tanstack/react-query";
import { ApiProblemError, type components } from "@transfer/api-client";
import {
  Button,
  Checkbox,
  InlineNotification,
  RadioButton,
  RadioButtonGroup,
  Select,
  SelectItem,
  TextInput,
} from "@transfer/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "../api";
import { ActivationPrintView } from "./activation-print-view";
import { SheetHandover } from "./participants";

type PrintItem = components["schemas"]["BatchActivationCodeResult"]["items"][number];
type Channel = "letter" | "sheet" | "in_person";

/**
 * Lost access after activation (Slice 3 plan D24, Q130): after staff verified the person, a
 * recovery code by any channel. Issuing it ends the participant's sessions and suspends their
 * channels at once, so the panel says so before the button. A letter's or sheet's code lives only
 * in the print view; closing it drops the code.
 */
export function RecoveryPanel({
  participationId,
  projectId,
  language,
  openCode,
  onChanged,
}: {
  participationId: string;
  projectId: string;
  language: "de" | "en";
  /** An open recovery code exists: a new one needs the conscious reissue. */
  openCode: boolean;
  onChanged: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const [channel, setChannel] = useState<Channel>("letter");
  const [identityVerified, setIdentityVerified] = useState(false);
  const [identityChecked, setIdentityChecked] = useState(false);
  const [deliveryKind, setDeliveryKind] = useState<"email" | "sms">("email");
  const [deliveryAddress, setDeliveryAddress] = useState("");
  const [confirmReissue, setConfirmReissue] = useState(false);
  const [error, setError] = useState<"open_code_exists" | "failed">();
  const [printed, setPrinted] = useState<{ kind: "letter" | "sheet"; item: PrintItem }>();
  const issue = useMutation({
    mutationFn: async () => {
      const common = {
        purpose: "recovery" as const,
        language,
        identityVerified: true as const,
        replaceOpenCode: confirmReissue,
      };
      const { data } = await api.POST("/api/v1/participations/{participationId}/activation-codes", {
        params: { path: { participationId } },
        body:
          channel === "in_person"
            ? {
                ...common,
                channel,
                identityChecked: true,
                deliveryKind,
                deliveryAddress,
              }
            : { ...common, channel },
      });
      if (!data) throw new Error("Recovery failed");
      return data;
    },
    onSuccess: async (data) => {
      setIdentityVerified(false);
      setIdentityChecked(false);
      setDeliveryAddress("");
      setConfirmReissue(false);
      setError(undefined);
      if (data.item && channel !== "in_person") setPrinted({ kind: channel, item: data.item });
      await onChanged();
    },
    onError: (failure) => {
      const code = failure instanceof ApiProblemError ? failure.problem.errors?.[0]?.code : "";
      setError(code === "open_code_exists" ? "open_code_exists" : "failed");
    },
  });

  if (printed) {
    return (
      <ActivationPrintView
        kind={printed.kind}
        items={[printed.item]}
        onClose={() => setPrinted(undefined)}
        itemActions={
          printed.kind === "sheet"
            ? [
                <SheetHandover
                  key={printed.item.activationCodeId}
                  item={printed.item}
                  projectId={projectId}
                  onChanged={() => void onChanged()}
                />,
              ]
            : undefined
        }
      />
    );
  }

  const ready =
    identityVerified &&
    (!openCode || confirmReissue) &&
    (channel !== "in_person" || (identityChecked && deliveryAddress.trim() !== ""));
  return (
    <fieldset className="tp-fieldset">
      <legend>{t("activation.recovery.title")}</legend>
      <InlineNotification
        kind="warning"
        title={t("activation.recovery.warning")}
        hideCloseButton
        lowContrast
      />
      {error && (
        <InlineNotification
          kind="error"
          title={t(`activation.recovery.errors.${error}`)}
          onClose={() => setError(undefined)}
        />
      )}
      <Checkbox
        id="recovery-identity-verified"
        labelText={t("activation.recovery.identityVerified")}
        checked={identityVerified}
        onChange={(_, { checked }) => setIdentityVerified(checked)}
      />
      <RadioButtonGroup
        legendText={t("activation.detail.channel")}
        name="recovery-channel"
        valueSelected={channel}
        onChange={(value) => setChannel(value as Channel)}
        orientation="vertical"
      >
        <RadioButton
          id="recovery-letter"
          labelText={t("activation.channel.letter")}
          value="letter"
        />
        <RadioButton id="recovery-sheet" labelText={t("activation.channel.sheet")} value="sheet" />
        <RadioButton
          id="recovery-in-person"
          labelText={t("activation.channel.in_person")}
          value="in_person"
        />
      </RadioButtonGroup>
      {channel === "in_person" && (
        <>
          <Select
            id="recovery-delivery-kind"
            labelText={t("activation.detail.deliveryKind")}
            value={deliveryKind}
            onChange={(event) => setDeliveryKind(event.target.value as "email" | "sms")}
          >
            <SelectItem value="email" text={t("activation.deliveryKind.email")} />
            <SelectItem value="sms" text={t("activation.deliveryKind.sms")} />
          </Select>
          <TextInput
            id="recovery-delivery-address"
            labelText={t("activation.detail.deliveryAddress")}
            value={deliveryAddress}
            onChange={(event) => setDeliveryAddress(event.target.value)}
            autoComplete="off"
          />
          <Checkbox
            id="recovery-identity-checked"
            labelText={t("activation.detail.identityChecked")}
            checked={identityChecked}
            onChange={(_, { checked }) => setIdentityChecked(checked)}
          />
        </>
      )}
      {openCode && (
        <Checkbox
          id="recovery-confirm-reissue"
          labelText={t("activation.detail.confirmReissue")}
          checked={confirmReissue}
          onChange={(_, { checked }) => setConfirmReissue(checked)}
        />
      )}
      <Button kind="danger" disabled={!ready || issue.isPending} onClick={() => issue.mutate()}>
        {t("activation.recovery.issue")}
      </Button>
    </fieldset>
  );
}
