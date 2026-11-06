import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ApiProblemError, type components } from "@transfer/api-client";
import { CreateRegionInput } from "@transfer/domain";
import {
  Add,
  Button,
  DataTable,
  EmptyState,
  Form,
  InlineNotification,
  PageHeader,
  SidePanel,
  Stack,
  TextInput,
  useToast,
} from "@transfer/ui";
import { useLayoutEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { regionsQuery, useApi } from "../../api";
import { usePanelNavigationGuard } from "../../components/panel-guard";
import { RouteError } from "../../components/route-error";
import { usePageTitle } from "../../page-title";

type Region = components["schemas"]["Region"];

export const Route = createFileRoute("/admin/regions")({
  loader: ({ context: { api, queryClient } }) => queryClient.ensureQueryData(regionsQuery(api)),
  component: RegionsPage,
  errorComponent: RouteError,
});

/**
 * The regions (Niederlassungen, Q35): the global admin creates and renames them (Q126). A new or
 * the chosen region opens in a side panel.
 */
function RegionsPage() {
  const { t } = useTranslation();
  usePageTitle(t("adminRegions.title"));
  const { data: regions } = useSuspenseQuery(regionsQuery(useApi()));
  // "new", a region's id, or no panel; the focus returns to the row's menu.
  const [editing, setEditing] = useState<string | null>(null);
  const [launcher, setLauncher] = useState<HTMLElement | null>(null);
  const [dirty, setDirty] = useState(false);
  const pendingNavigation = usePanelNavigationGuard(editing !== null && dirty);
  const chosen = regions.find((region) => region.id === editing);
  const close = () => {
    setEditing(null);
    setDirty(false);
  };
  return (
    <>
      <PageHeader
        title={t("adminRegions.title")}
        primaryAction={
          <Button
            renderIcon={Add}
            onClick={() => {
              setLauncher(null);
              setEditing("new");
            }}
          >
            {t("adminRegions.create")}
          </Button>
        }
      />
      <DataTable
        title={t("adminRegions.title")}
        items={regions}
        columns={[
          {
            key: "code",
            header: t("adminRegions.columns.code"),
            render: (region) => region.code,
            sortValue: (region) => region.code,
            alwaysVisible: true,
          },
          {
            key: "name",
            header: t("adminRegions.columns.name"),
            render: (region) => region.name,
            sortValue: (region) => region.name,
          },
        ]}
        rowLabel={(region) => region.code}
        rowActions={(region) => [
          {
            label: t("adminRegions.editAction"),
            onClick: (trigger) => {
              setLauncher(trigger);
              setEditing(region.id);
            },
          },
        ]}
        emptyState={
          <EmptyState
            variant="noData"
            title={t("adminRegions.empty")}
            description={t("adminRegions.emptyText")}
          />
        }
      />
      <SidePanel
        open={editing === "new" || chosen !== undefined}
        title={chosen ? chosen.code : t("adminRegions.create")}
        label={t("adminRegions.title")}
        dirty={editing !== null && dirty}
        onClose={close}
        pendingNavigation={pendingNavigation}
        returnFocusTo={launcher}
      >
        {editing !== null && (
          <RegionForm key={editing} region={chosen} onDone={close} onDirtyChange={setDirty} />
        )}
      </SidePanel>
    </>
  );
}

function RegionForm({
  region,
  onDone,
  onDirtyChange,
}: {
  region: Region | undefined;
  onDone: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const [code, setCode] = useState(region?.code ?? "");
  const [name, setName] = useState(region?.name ?? "");
  const [invalid, setInvalid] = useState<"code" | "name" | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const dirty = code !== (region?.code ?? "") || name !== (region?.name ?? "");
  // A layout effect, so an Escape right after typing already sees it (C4).
  useLayoutEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
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
        {/* Closing is the panel's (×, Escape), which asks before discarding (C4). */}
        <div>
          <Button type="submit" disabled={save.isPending}>
            {t("adminRegions.save")}
          </Button>
        </div>
      </Stack>
    </Form>
  );
}
