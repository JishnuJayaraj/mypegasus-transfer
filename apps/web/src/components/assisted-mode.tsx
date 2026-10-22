import { useNavigate } from "@tanstack/react-router";
import { ApiProblemError, type ApiClient } from "@transfer/api-client";
import {
  SELF_SERVICE_NOTICE_VERSION,
  type AssistedModeHow,
  type AssistedSelfService,
  type AssistedSelfServiceWrite,
} from "@transfer/domain";
import type { SelfServiceSource } from "@transfer/self-service-ui";
import {
  Button,
  Checkbox,
  InlineNotification,
  Modal,
  RadioButton,
  RadioButtonGroup,
  Stack,
} from "@transfer/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "../api";

// Assisted mode (ADR-0007, assisted mode; Q136): staff open the participant's wizard after the
// confirmation and how. Every assisted request names the mode; the API answers only what the role
// sees in it, and `403 assisted_mode_required` once it has ended (the wizard then shows `expired`).

const noData = () => new Error("No assisted-mode data");

/** The wizard's source in assisted mode: the staff routes, no step-up. */
export function assistedSource(
  api: ApiClient,
  participationId: string,
  assistedModeId: string,
): SelfServiceSource {
  const query = { assistedModeId };
  return {
    queryKey: ["assisted-self-service", participationId, assistedModeId],
    load: async () => {
      const { data } = await api.GET(
        "/api/v1/participations/{participationId}/assisted/self-service",
        { params: { path: { participationId }, query } },
      );
      if (!data) throw noData();
      return data as AssistedSelfService;
    },
    acknowledge: async (language) => {
      await api.POST("/api/v1/participations/{participationId}/assisted/self-service/notice", {
        params: { path: { participationId }, query },
        body: { version: SELF_SERVICE_NOTICE_VERSION, language },
      });
    },
    save: async (page, body) => {
      const { data } = await api.PUT(
        "/api/v1/participations/{participationId}/assisted/self-service/pages/{page}",
        { params: { path: { participationId, page }, query }, body },
      );
      if (!data) throw noData();
      return data as AssistedSelfServiceWrite;
    },
    loadSensitive: async (group) => {
      const { data } = await api.GET(
        "/api/v1/participations/{participationId}/assisted/self-service/sensitive/{group}",
        { params: { path: { participationId, group }, query } },
      );
      if (!data) throw noData();
      return data;
    },
    saveSensitive: async (group, body) => {
      const { data } = await api.PUT(
        "/api/v1/participations/{participationId}/assisted/self-service/sensitive/{group}",
        { params: { path: { participationId, group }, query }, body },
      );
      if (!data) throw noData();
      return data as AssistedSelfServiceWrite;
    },
  };
}

/**
 * "Assistierte Erfassung starten": the confirmation dialog (the person is present or on the phone
 * and asked for help, and how), then the wizard in assisted mode.
 */
export function StartAssistedMode(props: { projectId: string; participationId: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [how, setHow] = useState<AssistedModeHow>();
  const [failure, setFailure] = useState<"failed" | "closed">();
  const [busy, setBusy] = useState(false);

  const close = () => {
    setOpen(false);
    setConfirmed(false);
    setHow(undefined);
    setFailure(undefined);
  };

  async function start() {
    if (!confirmed || !how) return;
    setBusy(true);
    try {
      const { data } = await api.POST("/api/v1/participations/{participationId}/assisted-mode", {
        params: { path: { participationId: props.participationId } },
        body: { confirmed: true, how },
      });
      if (!data) throw noData();
      await navigate({
        to: "/projects/$projectId/participations/$participationId/assisted",
        params: { projectId: props.projectId, participationId: props.participationId },
        search: { assistedModeId: data.assistedModeId, how },
      });
    } catch (error) {
      const closed =
        error instanceof ApiProblemError &&
        error.problem.errors?.some((item) => item.code === "participation_closed");
      setFailure(closed ? "closed" : "failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button kind="secondary" onClick={() => setOpen(true)}>
        {t("participant.assisted.start")}
      </Button>
      <Modal
        open={open}
        modalHeading={t("participant.assisted.start")}
        primaryButtonText={t("participant.assisted.submit")}
        secondaryButtonText={t("participant.assisted.cancel")}
        primaryButtonDisabled={!confirmed || !how || busy}
        onRequestSubmit={() => void start()}
        onRequestClose={close}
        size="sm"
      >
        <Stack gap={5}>
          {failure && (
            <InlineNotification
              kind="error"
              title={t(`participant.assisted.${failure}`)}
              hideCloseButton
              lowContrast
            />
          )}
          <p>{t("participant.assisted.intro")}</p>
          <Checkbox
            id="assisted-confirm"
            labelText={t("participant.assisted.confirm")}
            checked={confirmed}
            onChange={(_, { checked }) => setConfirmed(checked)}
          />
          <RadioButtonGroup
            name="assisted-how"
            legendText={t("participant.assisted.how")}
            orientation="vertical"
            valueSelected={how}
            onChange={(value) => setHow(value as AssistedModeHow)}
          >
            <RadioButton
              id="assisted-how-in-person"
              value="in_person"
              labelText={t("participant.assisted.in_person")}
            />
            <RadioButton
              id="assisted-how-phone"
              value="phone"
              labelText={t("participant.assisted.phone")}
            />
          </RadioButtonGroup>
        </Stack>
      </Modal>
    </>
  );
}

/** "Assistierte Erfassung für … · Beenden": whom the wizard is for, and the end of the mode. */
export function AssistedBanner(props: {
  name: string;
  how: AssistedModeHow | undefined;
  onEnd: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  async function end() {
    setBusy(true);
    try {
      await props.onEnd();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="tp-assisted-banner" aria-label={t("participant.assisted.region")}>
      <p>
        {props.how
          ? t("participant.assisted.banner", {
              name: props.name,
              how: t(`participant.assisted.howInline.${props.how}`),
            })
          : `${t("participant.assisted.region")}: ${props.name}`}
      </p>
      {failed && (
        <InlineNotification
          kind="error"
          title={t("participant.assisted.endFailed")}
          hideCloseButton
          lowContrast
        />
      )}
      <Button kind="primary" size="sm" disabled={busy} onClick={() => void end()}>
        {t("participant.assisted.end")}
      </Button>
    </section>
  );
}
