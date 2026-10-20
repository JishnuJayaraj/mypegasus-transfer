import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ApiProblemError, type components } from "@transfer/api-client";
import { CreateRegionInput } from "@transfer/domain";
import {
  Button,
  ButtonSet,
  Form,
  InlineNotification,
  PageHeader,
  SimpleTable,
  Stack,
  TextInput,
  useToast,
} from "@transfer/ui";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { regionsQuery, useApi } from "../../api";
import { RouteError } from "../../components/route-error";

type Region = components["schemas"]["Region"];

export const Route = createFileRoute("/admin/regions")({
  loader: ({ context: { api, queryClient } }) => queryClient.ensureQueryData(regionsQuery(api)),
  component: RegionsPage,
  errorComponent: RouteError,
});

const columns = ["code", "name", "actions"] as const;

/** The regions (Niederlassungen, Q35): the global admin creates and renames them (Q126). */
function RegionsPage() {
  const { t } = useTranslation();
  const { data: regions } = useSuspenseQuery(regionsQuery(useApi()));
  // "new", a region's id, or no form.
  const [editing, setEditing] = useState<string | null>(null);
  const rows = regions.map((region) => ({
    id: region.id,
    code: region.code,
    name: region.name,
    actions: (
      <Button kind="ghost" size="sm" onClick={() => setEditing(region.id)}>
        {t("adminRegions.edit", { code: region.code })}
      </Button>
    ),
  }));
  return (
    <>
      <PageHeader title={t("adminRegions.title")} />
      <SimpleTable
        title={t("adminRegions.title")}
        columns={columns.map((key) => ({ key, header: t(`adminRegions.columns.${key}`) }))}
        rows={rows}
        emptyState={t("adminRegions.empty")}
      />
      {editing === null ? (
        <Button className="tp-load-more" onClick={() => setEditing("new")}>
          {t("adminRegions.create")}
        </Button>
      ) : (
        <RegionForm
          key={editing}
          region={regions.find((region) => region.id === editing)}
          onDone={() => setEditing(null)}
        />
      )}
    </>
  );
}

function RegionForm({ region, onDone }: { region: Region | undefined; onDone: () => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const [code, setCode] = useState(region?.code ?? "");
  const [name, setName] = useState(region?.name ?? "");
  const [invalid, setInvalid] = useState<"code" | "name" | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: async () => {
      if (region) {
        await api.PATCH("/api/v1/regions/{regionId}", {
          params: { path: { regionId: region.id } },
          body: {
            ...(code !== region.code && { code }),
            ...(name !== region.name && { name }),
          },
        });
      } else {
        await api.POST("/api/v1/regions", { body: { code, name } });
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: regionsQuery(api).queryKey });
      showToast({ title: t("adminRegions.saved"), subtitle: code });
      onDone();
    },
    onError: (error) =>
      setRefusal(
        error instanceof ApiProblemError ? (error.problem.errors?.[0]?.code ?? "failed") : "failed",
      ),
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    const result = CreateRegionInput.safeParse({ code, name });
    const field = result.error?.issues[0]?.path[0];
    setInvalid(field === "code" || field === "name" ? field : null);
    if (!result.success) return;
    if (region && code === region.code && name === region.name) onDone();
    else save.mutate();
  }
  return (
    <Form className="tp-form" onSubmit={submit} noValidate>
      <Stack gap={6}>
        {refusal && (
          <InlineNotification
            kind="error"
            title={t(`adminRegions.errors.${refusal}`, {
              defaultValue: t("adminRegions.errors.failed"),
            })}
            onClose={() => setRefusal(null)}
          />
        )}
        <TextInput
          id="region-code"
          labelText={t("adminRegions.columns.code")}
          helperText={t("adminRegions.codeHelp")}
          value={code}
          onChange={(event) => setCode(event.target.value.toUpperCase())}
          invalid={invalid === "code"}
          invalidText={t("errors.invalid")}
        />
        <TextInput
          id="region-name"
          labelText={t("adminRegions.columns.name")}
          value={name}
          onChange={(event) => setName(event.target.value)}
          invalid={invalid === "name"}
          invalidText={t("errors.required")}
        />
        <ButtonSet>
          <Button kind="secondary" onClick={onDone}>
            {t("projectForm.cancel")}
          </Button>
          <Button type="submit" disabled={save.isPending}>
            {t("adminRegions.save")}
          </Button>
        </ButtonSet>
      </Stack>
    </Form>
  );
}
