import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { ApiProblemError, type ApiClient, type components } from "@transfer/api-client";
import { RelaxationReasonCode } from "@transfer/domain";
import {
  Button,
  ButtonSet,
  Form,
  formatDate,
  InlineNotification,
  Select,
  SelectItem,
  SimpleTable,
  Stack,
  useToast,
} from "@transfer/ui";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { meQuery, projectConfigQuery, useApi } from "../api";

type ProjectConfig = components["schemas"]["ProjectConfig"];
type Action = (api: ApiClient, config: ProjectConfig) => Promise<{ data?: ProjectConfig }>;
type Done = "requested" | "approved" | "rejected" | "withdrawn" | "removed";

/**
 * Rule relaxations in the Konfiguration section (Slice 2 plan 5.9, 5.13): the approved ones and
 * the open requests; the PL requests, withdraws and removes, the regional operations manager
 * approves or rejects. Every action follows a server-derived capability (round 26), never the
 * role; the API's checks stay the enforcement.
 */
export function Relaxations({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const query = projectConfigQuery(api, projectId);
  const { data: config } = useSuspenseQuery(query);
  const me = useQuery(meQuery(api)).data;
  const [error, setError] = useState<string>();
  const [reasonCode, setReasonCode] = useState("");
  const [chosen, setRuleId] = useState("");
  // A requested rule leaves the list, so the choice falls back to the first one left.
  const ruleId = config.relaxableRules.some((r) => r.ruleId === chosen)
    ? chosen
    : (config.relaxableRules[0]?.ruleId ?? "");
  // No staff directory before Slice 3 (Q109): the viewer's own name, else never an id.
  const person = (id: string) => (id === me?.id ? me.displayName : t("overrides.otherStaff"));

  const relaxationChange = useMutation({
    mutationFn: async ({ send }: { send: Action; done: Done }) => {
      const { data } = await send(api, config);
      if (!data) throw new Error("Relaxation was not changed");
      return data;
    },
    onSuccess: (next, { done }) => {
      setError(undefined);
      queryClient.setQueryData(query.queryKey, next);
      showToast({ title: t(`relaxations.done.${done}`) });
    },
    onError: async (failure) => {
      const problem = failure instanceof ApiProblemError ? failure : undefined;
      const status = problem?.status;
      const code = status === 422 ? problem?.problem.errors?.at(-1)?.code : undefined;
      setError(status === 409 ? "conflict" : status === 403 ? "forbidden" : (code ?? "failed"));
      if (status === 409) await queryClient.invalidateQueries({ queryKey: query.queryKey });
    },
  });
  /** A click handler that sends `send` and toasts `done` when it succeeds. */
  const handlerFor = (done: Done, send: Action) => () => relaxationChange.mutate({ send, done });

  // An approval writes an override version, so it names the one it was shown (409 when stale).
  const decision = (requestId: string, approve: boolean) =>
    handlerFor(approve ? "approved" : "rejected", (client, current) =>
      client.POST("/api/v1/config/relaxations/{requestId}/decision", {
        params: { path: { requestId } },
        body: approve
          ? { decision: "approved", expectedVersion: current.override.version }
          : { decision: "rejected" },
      }),
    );
  const button = (
    label: string,
    onClick: () => void,
    kind: "ghost" | "danger--ghost" = "ghost",
  ) => (
    <Button
      key={label}
      kind={kind}
      size="sm"
      disabled={relaxationChange.isPending}
      onClick={onClick}
    >
      {label}
    </Button>
  );

  const approved = config.override.relaxations.map((relaxation) => ({
    id: relaxation.ruleId,
    rule: relaxation.ruleId,
    reason: t(`relaxations.reasons.${relaxation.reasonCode}`),
    person: person(relaxation.approvedBy),
    date: formatDate(relaxation.approvedOn),
    actions:
      config.capabilities.changeOverride &&
      button(
        t("relaxations.remove", { rule: relaxation.ruleId }),
        handlerFor("removed", (client, current) =>
          client.DELETE("/api/v1/projects/{projectId}/config/relaxations/{ruleId}", {
            params: {
              path: { projectId, ruleId: relaxation.ruleId },
              query: { expectedVersion: current.override.version },
            },
          }),
        ),
        "danger--ghost",
      ),
  }));
  const open = config.relaxationRequests.map((request) => ({
    id: request.id,
    rule: request.ruleId,
    reason: t(`relaxations.reasons.${request.reasonCode}`),
    person: person(request.requestedBy),
    date: formatDate(request.requestedOn),
    actions: (
      <ButtonSet>
        {request.capabilities.decide && [
          button(t("relaxations.approve", { rule: request.ruleId }), decision(request.id, true)),
          button(
            t("relaxations.reject", { rule: request.ruleId }),
            decision(request.id, false),
            "danger--ghost",
          ),
        ]}
        {request.capabilities.withdraw &&
          button(
            t("relaxations.withdraw", { rule: request.ruleId }),
            handlerFor("withdrawn", (client) =>
              client.POST("/api/v1/config/relaxations/{requestId}/withdrawal", {
                params: { path: { requestId: request.id } },
                body: {},
              }),
            ),
          )}
      </ButtonSet>
    ),
  }));
  const columns = (
    who: "approvedBy" | "requestedBy",
    date: "approvedOn" | "requestedOn",
    actions: boolean,
  ) =>
    (
      [
        ["rule", "rule"],
        ["reason", "reason"],
        ["person", who],
        ["date", date],
        ...(actions ? ([["actions", "actions"]] as const) : []),
      ] as const
    ).map(([key, header]) => ({ key, header: t(`relaxations.columns.${header}`) }));

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!ruleId || !reasonCode) return setError("choose");
    handlerFor("requested", (client) =>
      client.POST("/api/v1/projects/{projectId}/config/relaxations", {
        params: { path: { projectId } },
        body: { ruleId, reasonCode: reasonCode as RelaxationReasonCode },
      }),
    )();
  }

  return (
    <>
      <h3>{t("relaxations.title")}</h3>
      <p>{t("relaxations.intro")}</p>
      {error && (
        <InlineNotification
          kind="error"
          title={t(`relaxations.errors.${error}`, { defaultValue: t("relaxations.errors.failed") })}
          hideCloseButton
        />
      )}
      <SimpleTable
        title={t("relaxations.approvedTitle")}
        columns={columns("approvedBy", "approvedOn", config.capabilities.changeOverride)}
        rows={approved}
        emptyState={t("relaxations.approvedEmpty")}
      />
      <SimpleTable
        title={t("relaxations.openTitle")}
        columns={columns(
          "requestedBy",
          "requestedOn",
          config.relaxationRequests.some(({ capabilities: may }) => may.decide || may.withdraw),
        )}
        rows={open}
        emptyState={t("relaxations.openEmpty")}
      />
      {config.capabilities.requestRelaxation && config.relaxableRules.length > 0 && (
        <Form className="tp-form" onSubmit={submit} noValidate>
          <Stack gap={5}>
            <h4>{t("relaxations.requestTitle")}</h4>
            <Select
              id="relaxation-rule"
              labelText={t("relaxations.columns.rule")}
              value={ruleId}
              onChange={(event) => setRuleId(event.target.value)}
            >
              {config.relaxableRules.map((r) => (
                <SelectItem
                  key={r.ruleId}
                  value={r.ruleId}
                  text={`${r.ruleId} (${t(`relaxations.steps.${r.step}`)})`}
                />
              ))}
            </Select>
            <Select
              id="relaxation-reason"
              labelText={t("relaxations.columns.reason")}
              value={reasonCode}
              onChange={(event) => setReasonCode(event.target.value)}
            >
              <SelectItem value="" text={t("overrides.chooseSource")} />
              {RelaxationReasonCode.options.map((code) => (
                <SelectItem key={code} value={code} text={t(`relaxations.reasons.${code}`)} />
              ))}
            </Select>
            <Button type="submit" disabled={relaxationChange.isPending}>
              {t("relaxations.request")}
            </Button>
          </Stack>
        </Form>
      )}
    </>
  );
}
