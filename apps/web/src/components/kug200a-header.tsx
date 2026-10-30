import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { ApiProblemError } from "@transfer/api-client";
import { Button, Form, InlineNotification, Stack, TextInput } from "@transfer/ui";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { projectConfigQuery, projectQuery, useApi } from "../api";

const keys = ["tKugNumber", "employerBetriebsnummer", "employerEconomicClass"] as const;
type Key = (typeof keys)[number];

/**
 * The Kug 200a's header on the project (ba-forms.md, the Kug 200a as built): the T-Kug-Nummer
 * (after the form's printed `TK-`) and the personalabgebender Betrieb's Betriebsnummer and
 * Branche/WK. The PL edits them (`capabilities.editKug200aHeader`), others read them; an empty
 * field clears its value, which the Kug 200a then leaves for handwriting on its checklist. A save
 * sends only the fields edited here that differ from where the edit started.
 */
export function Kug200aHeader({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const { data: project } = useSuspenseQuery(projectQuery(api, projectId));
  const { data: config } = useSuspenseQuery(projectConfigQuery(api, projectId));
  const stored = (key: Key) => project[key] ?? "";
  // The draft holds only the fields the user edited, each with the server value it started from;
  // an untouched field shows the project as refreshed and is never sent, so another PL's change
  // to it in the meantime stays.
  const [edits, setEdits] = useState<Partial<Record<Key, string>>>({});
  const [baseline, setBaseline] = useState<Partial<Record<Key, string>>>({});
  const shown = (key: Key) => edits[key] ?? stored(key);
  const edit = (key: Key, value: string) => {
    setBaseline((current) => (key in current ? current : { ...current, [key]: stored(key) }));
    setEdits((current) => ({ ...current, [key]: value }));
  };
  const [invalid, setInvalid] = useState<Partial<Record<Key, string>>>({});
  const [outcome, setOutcome] = useState<"saved" | "unchanged" | "failed">();

  const save = useMutation({
    mutationFn: async (body: Partial<Record<Key, string | null>>) => {
      await api.PATCH("/api/v1/projects/{projectId}", { params: { path: { projectId } }, body });
    },
    onSuccess: async () => {
      setInvalid({});
      setEdits({});
      setBaseline({});
      setOutcome("saved");
      await queryClient.invalidateQueries({ queryKey: projectQuery(api, projectId).queryKey });
    },
    onError: (error) => {
      const fields: Partial<Record<Key, string>> = {};
      if (error instanceof ApiProblemError && error.status === 400) {
        for (const item of error.problem.errors ?? []) {
          const key = item.pointer?.split("/")[1] as Key | undefined;
          if (key && keys.includes(key)) fields[key] ??= item.code;
        }
      }
      setInvalid(fields);
      setOutcome(Object.keys(fields).length > 0 ? undefined : "failed");
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const body = Object.fromEntries(
      keys.flatMap((key) => {
        const value = edits[key]?.trim();
        if (value === undefined || value === baseline[key]) return [];
        return [[key, value === "" ? null : value]];
      }),
    );
    if (Object.keys(body).length === 0) setOutcome("unchanged");
    else save.mutate(body);
  }

  const editable = config.capabilities.editKug200aHeader;
  return (
    <section aria-labelledby="kug200a-header" className="tp-section">
      <h2 id="kug200a-header">{t("kug200aHeader.title")}</h2>
      <p>{t("kug200aHeader.intro")}</p>
      {editable ? (
        <Form className="tp-form" onSubmit={submit} noValidate>
          <Stack gap={5}>
            {outcome && (
              <InlineNotification
                kind={outcome === "saved" ? "success" : outcome === "unchanged" ? "info" : "error"}
                title={t(`kug200aHeader.${outcome}`)}
                onClose={() => setOutcome(undefined)}
              />
            )}
            {keys.map((key) => (
              <TextInput
                key={key}
                id={`kug200a-${key}`}
                labelText={t(`kug200aHeader.fields.${key}`)}
                helperText={t(`kug200aHeader.help.${key}`)}
                value={shown(key)}
                onChange={(event) => edit(key, event.target.value)}
                {...(invalid[key] && {
                  invalid: true,
                  invalidText: t(`kug200aHeader.errors.${invalid[key]}`, {
                    defaultValue: t(`kug200aHeader.errors.${key}`),
                  }),
                })}
              />
            ))}
            <Button type="submit" kind="secondary" disabled={save.isPending}>
              {t("kug200aHeader.save")}
            </Button>
          </Stack>
        </Form>
      ) : (
        <dl className="tp-facts">
          {keys.map((key) => (
            <div key={key}>
              <dt>{t(`kug200aHeader.fields.${key}`)}</dt>
              <dd>{project[key] ?? t("kug200aHeader.unset")}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
