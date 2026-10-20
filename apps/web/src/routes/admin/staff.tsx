import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseInfiniteQuery,
} from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ApiProblemError, type components } from "@transfer/api-client";
import { CreateStaffUserInput } from "@transfer/domain";
import {
  Button,
  ButtonSet,
  Checkbox,
  Form,
  InlineNotification,
  PageHeader,
  Select,
  SelectItem,
  SimpleTable,
  Stack,
  Tag,
  TextInput,
  useToast,
} from "@transfer/ui";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { regionsQuery, staffAccountsQuery, useApi } from "../../api";
import { RouteError } from "../../components/route-error";

type Account = components["schemas"]["StaffAccount"];
type Grant = components["schemas"]["OrgRoleGrant"];
type OrgRole = Grant["role"];
const orgRoles: readonly OrgRole[] = ["admin", "regional_admin", "regional_operations_manager"];

export const Route = createFileRoute("/admin/staff")({
  loader: ({ context: { api, queryClient } }) =>
    Promise.all([
      queryClient.ensureInfiniteQueryData(staffAccountsQuery(api)),
      queryClient.ensureQueryData(regionsQuery(api)),
    ]),
  component: StaffPage,
  errorComponent: RouteError,
});

const columns = [
  "displayName",
  "email",
  "orgRoles",
  "mayCreateProjects",
  "state",
  "actions",
] as const;

/** The code of a refusal, or "failed". */
const codeOf = (error: unknown) =>
  error instanceof ApiProblemError ? (error.problem.errors?.[0]?.code ?? "failed") : "failed";

/**
 * Staff accounts (Q7, Q126): only the global admin creates and changes them, grants org roles
 * (admin global, the regional roles per region), sets "may create projects" and deactivates them.
 * Accounts are never deleted (Q59). The API refuses everyone else.
 */
function StaffPage() {
  const { t } = useTranslation();
  const api = useApi();
  const query = useSuspenseInfiniteQuery(staffAccountsQuery(api));
  const regions = useQuery(regionsQuery(api));
  const regionLabel = (id: string | null) =>
    regions.data?.find((region) => region.id === id)?.code ?? "";
  // "new", an account's id, or no form.
  const [editing, setEditing] = useState<string | null>(null);
  const accounts = query.data.pages.flatMap((page) => page.items);
  const rows = accounts.map((account) => ({
    id: account.id,
    displayName: account.displayName,
    email: account.email,
    orgRoles: (
      <>
        {account.orgRoles.map((grant) => (
          <Tag key={`${grant.role}:${grant.regionId}`} type="gray" size="sm">
            {[t(`session.roles.${grant.role}`), regionLabel(grant.regionId)]
              .filter(Boolean)
              .join(" · ")}
          </Tag>
        ))}
      </>
    ),
    mayCreateProjects: account.mayCreateProjects ? t("adminStaff.yes") : t("adminStaff.no"),
    state: account.deactivatedAt ? t("adminStaff.deactivated") : t("adminStaff.active"),
    actions: !account.deactivatedAt && (
      <Button kind="ghost" size="sm" onClick={() => setEditing(account.id)}>
        {t("adminStaff.edit", { name: account.displayName })}
      </Button>
    ),
  }));
  const chosen = accounts.find((account) => account.id === editing);
  return (
    <>
      <PageHeader title={t("adminStaff.title")} />
      <SimpleTable
        title={t("adminStaff.title")}
        columns={columns.map((key) => ({ key, header: t(`adminStaff.columns.${key}`) }))}
        rows={rows}
        emptyState={t("adminStaff.empty")}
      />
      {query.hasNextPage && (
        <Button
          className="tp-load-more"
          kind="tertiary"
          disabled={query.isFetchingNextPage}
          onClick={() => query.fetchNextPage()}
        >
          {t("projects.loadMore")}
        </Button>
      )}
      {editing === null && (
        <Button className="tp-load-more" onClick={() => setEditing("new")}>
          {t("adminStaff.create")}
        </Button>
      )}
      {editing === "new" && <AccountForm key="new" onDone={() => setEditing(null)} />}
      {chosen && (
        <Stack gap={7} key={chosen.id}>
          <AccountForm account={chosen} onDone={() => setEditing(null)} />
          <OrgRoles account={chosen} />
          <Deactivation account={chosen} onDone={() => setEditing(null)} />
        </Stack>
      )}
    </>
  );
}

function useRefresh() {
  const api = useApi();
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: staffAccountsQuery(api).queryKey });
}

/** A new account, or the name, email and project-creation flag of an existing one. */
function AccountForm({ account, onDone }: { account?: Account; onDone: () => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const refresh = useRefresh();
  const showToast = useToast();
  const [displayName, setDisplayName] = useState(account?.displayName ?? "");
  const [email, setEmail] = useState(account?.email ?? "");
  const [mayCreateProjects, setMayCreateProjects] = useState(account?.mayCreateProjects ?? false);
  const [invalid, setInvalid] = useState<ReadonlySet<string>>(new Set());
  const [refusal, setRefusal] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: async () => {
      if (!account) {
        await api.POST("/api/v1/staff-users", { body: { displayName, email, mayCreateProjects } });
        return;
      }
      await api.PATCH("/api/v1/staff-users/{staffUserId}", {
        params: { path: { staffUserId: account.id } },
        body: {
          ...(displayName !== account.displayName && { displayName }),
          ...(email !== account.email && { email }),
          ...(mayCreateProjects !== account.mayCreateProjects && { mayCreateProjects }),
        },
      });
    },
    onSuccess: async () => {
      await refresh();
      showToast({ title: t("adminStaff.saved"), subtitle: displayName });
      if (!account) onDone();
    },
    onError: (error) => setRefusal(codeOf(error)),
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    const result = CreateStaffUserInput.safeParse({ displayName, email, mayCreateProjects });
    setInvalid(new Set(result.error?.issues.map((issue) => String(issue.path[0])) ?? []));
    if (!result.success) return;
    const unchanged =
      account &&
      displayName === account.displayName &&
      email === account.email &&
      mayCreateProjects === account.mayCreateProjects;
    if (!unchanged) save.mutate();
  }
  return (
    <Form className="tp-form" onSubmit={submit} noValidate aria-label={t("adminStaff.account")}>
      <Stack gap={6}>
        <h2>{account ? account.displayName : t("adminStaff.create")}</h2>
        {refusal && (
          <InlineNotification
            kind="error"
            title={t(`adminStaff.errors.${refusal}`, {
              defaultValue: t("adminStaff.errors.failed"),
            })}
            onClose={() => setRefusal(null)}
          />
        )}
        <TextInput
          id="staff-display-name"
          labelText={t("adminStaff.columns.displayName")}
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          invalid={invalid.has("displayName")}
          invalidText={t("errors.required")}
        />
        <TextInput
          id="staff-email"
          type="email"
          labelText={t("adminStaff.columns.email")}
          helperText={t("adminStaff.emailHelp")}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          invalid={invalid.has("email")}
          invalidText={t("errors.invalid")}
        />
        <Checkbox
          id="staff-may-create-projects"
          labelText={t("adminStaff.mayCreateProjects")}
          checked={mayCreateProjects}
          onChange={(_, { checked }) => setMayCreateProjects(checked)}
        />
        <ButtonSet>
          <Button kind="secondary" onClick={onDone}>
            {account ? t("adminStaff.close") : t("projectForm.cancel")}
          </Button>
          <Button type="submit" disabled={save.isPending}>
            {account ? t("adminStaff.save") : t("adminStaff.create")}
          </Button>
        </ButtonSet>
      </Stack>
    </Form>
  );
}

/** The account's org roles as one set: removed and added here, saved together (PUT). */
function OrgRoles({ account }: { account: Account }) {
  const { t } = useTranslation();
  const api = useApi();
  const refresh = useRefresh();
  const showToast = useToast();
  const { data: regions = [] } = useQuery(regionsQuery(api));
  const [grants, setGrants] = useState<Grant[]>(account.orgRoles);
  const [role, setRole] = useState<OrgRole>("regional_admin");
  const [regionId, setRegionId] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const key = (grant: Grant) => `${grant.role}:${grant.regionId ?? ""}`;
  const candidate: Grant | null =
    role === "admin" ? { role, regionId: null } : regionId ? { role, regionId } : null;
  const save = useMutation({
    mutationFn: () =>
      api.PUT("/api/v1/staff-users/{staffUserId}/org-roles", {
        params: { path: { staffUserId: account.id } },
        body: { orgRoles: grants },
      }),
    onSuccess: async () => {
      setRefusal(null);
      await refresh();
      showToast({ title: t("adminStaff.rolesSaved"), subtitle: account.displayName });
    },
    onError: (error) => setRefusal(codeOf(error)),
  });
  const label = (grant: Grant) => {
    const region = regions.find((r) => r.id === grant.regionId);
    return [t(`session.roles.${grant.role}`), region && `${region.name} (${region.code})`]
      .filter(Boolean)
      .join(" · ");
  };
  return (
    <section aria-labelledby="staff-org-roles" className="tp-section tp-form">
      <h2 id="staff-org-roles">{t("adminStaff.orgRoles")}</h2>
      {refusal && (
        <InlineNotification
          kind="error"
          title={t(`adminStaff.errors.${refusal}`, { defaultValue: t("adminStaff.errors.failed") })}
          onClose={() => setRefusal(null)}
        />
      )}
      {grants.length === 0 ? (
        <p>{t("adminStaff.noOrgRoles")}</p>
      ) : (
        <ul>
          {grants.map((grant) => (
            <li key={key(grant)}>
              {label(grant)}{" "}
              <Button
                kind="ghost"
                size="sm"
                onClick={() => setGrants(grants.filter((g) => key(g) !== key(grant)))}
              >
                {t("adminStaff.removeRole", { role: label(grant) })}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="tp-bulk-actions">
        <Select
          id="staff-org-role"
          labelText={t("adminStaff.role")}
          value={role}
          onChange={(event) => setRole(event.target.value as OrgRole)}
        >
          {orgRoles.map((option) => (
            <SelectItem key={option} value={option} text={t(`session.roles.${option}`)} />
          ))}
        </Select>
        {role !== "admin" && (
          <Select
            id="staff-org-role-region"
            labelText={t("projectForm.region")}
            value={regionId}
            onChange={(event) => setRegionId(event.target.value)}
          >
            <SelectItem value="" text={t("projectForm.chooseRegion")} />
            {regions.map((region) => (
              <SelectItem
                key={region.id}
                value={region.id}
                text={`${region.name} (${region.code})`}
              />
            ))}
          </Select>
        )}
        <Button
          kind="tertiary"
          disabled={!candidate || grants.some((g) => key(g) === key(candidate))}
          onClick={() => candidate && setGrants([...grants, candidate])}
        >
          {t("adminStaff.addRole")}
        </Button>
      </div>
      <Button disabled={save.isPending} onClick={() => save.mutate()}>
        {t("adminStaff.saveRoles")}
      </Button>
    </section>
  );
}

/**
 * Deactivation (Q59, Q126): ends the account's sessions, memberships and assignments at once; it
 * can't be undone here, so it is confirmed first. Refused for a project's last active PL.
 */
function Deactivation({ account, onDone }: { account: Account; onDone: () => void }) {
  const { t } = useTranslation();
  const api = useApi();
  const refresh = useRefresh();
  const showToast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const deactivate = useMutation({
    mutationFn: () =>
      api.POST("/api/v1/staff-users/{staffUserId}/deactivation", {
        params: { path: { staffUserId: account.id } },
        body: {},
      }),
    onSuccess: async () => {
      await refresh();
      showToast({ title: t("adminStaff.deactivatedToast"), subtitle: account.displayName });
      onDone();
    },
    onError: (error) => {
      setConfirming(false);
      setRefusal(codeOf(error));
    },
  });
  return (
    <section aria-labelledby="staff-deactivation" className="tp-section tp-form">
      <h2 id="staff-deactivation">{t("adminStaff.deactivation")}</h2>
      {refusal && (
        <InlineNotification
          kind="error"
          title={t(`adminStaff.errors.${refusal}`, { defaultValue: t("adminStaff.errors.failed") })}
          onClose={() => setRefusal(null)}
        />
      )}
      {confirming ? (
        <>
          <InlineNotification
            kind="warning"
            title={t("adminStaff.confirmDeactivation", { name: account.displayName })}
            subtitle={t("adminStaff.deactivationEffects")}
            hideCloseButton
          />
          <ButtonSet>
            <Button kind="secondary" onClick={() => setConfirming(false)}>
              {t("projectForm.cancel")}
            </Button>
            <Button
              kind="danger"
              disabled={deactivate.isPending}
              onClick={() => deactivate.mutate()}
            >
              {t("adminStaff.deactivate")}
            </Button>
          </ButtonSet>
        </>
      ) : (
        <Button kind="danger--tertiary" onClick={() => setConfirming(true)}>
          {t("adminStaff.deactivate")}
        </Button>
      )}
    </section>
  );
}
