import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { ApiProblemError, type components } from "@transfer/api-client";
import {
  Button,
  ButtonSet,
  Form,
  InlineNotification,
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
import { participantsQuery, projectTeamQuery, staffDirectoryQuery, useApi } from "../api";

type ProjectRole = components["schemas"]["ProjectRole"];
const projectRoles: readonly ProjectRole[] = ["project_lead", "consultant", "back_office"];
const columns = ["displayName", "roles", "actions"] as const;

/** A refusal's code (e.g. `last_project_lead`), or null for anything else. */
const refusalCode = (error: unknown) =>
  error instanceof ApiProblemError ? (error.problem.errors?.[0]?.code ?? null) : null;

/**
 * The project's team (Q61, Q126): members with their project roles. The PL adds and removes
 * roles; a global admin only adds a replacement PL (never themselves, which the API refuses).
 * What is offered follows the server's capabilities; the API decides again.
 */
export function ProjectTeam({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const query = projectTeamQuery(api, projectId);
  const { data: team } = useSuspenseQuery(query);
  const { capabilities } = team;
  const [error, setError] = useState<string | null>(null);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: query.queryKey }),
      // Removing consultant ends assignments: the list's consultants change too.
      queryClient.invalidateQueries({ queryKey: participantsQuery(api, projectId).queryKey }),
    ]);

  const remove = useMutation({
    mutationFn: async ({ staffUserId, role }: { staffUserId: string; role: ProjectRole }) => {
      await api.DELETE("/api/v1/projects/{projectId}/members/{staffUserId}/{role}", {
        params: { path: { projectId, staffUserId, role } },
      });
    },
    onSuccess: async () => {
      setError(null);
      await refresh();
      showToast({ title: t("team.removed") });
    },
    onError: (failure) => setError(refusalCode(failure) ?? "failed"),
  });

  const rows = team.members.map((member) => ({
    id: member.staffUserId,
    displayName: member.deactivated
      ? t("team.deactivatedMember", { name: member.displayName })
      : member.displayName,
    roles: (
      <>
        {member.roles.map((role) => (
          <Tag key={role} type="gray" size="sm">
            {t(`session.roles.${role}`)}
          </Tag>
        ))}
      </>
    ),
    actions: capabilities.manageMembers && (
      <>
        {member.roles.map((role) => (
          <Button
            key={role}
            kind="ghost"
            size="sm"
            disabled={remove.isPending}
            onClick={() => remove.mutate({ staffUserId: member.staffUserId, role })}
          >
            {t("team.removeRole", {
              role: t(`session.roles.${role}`),
              name: member.displayName,
            })}
          </Button>
        ))}
      </>
    ),
  }));

  return (
    <section aria-labelledby="project-team" className="tp-section">
      <h2 id="project-team">{t("team.title")}</h2>
      {error && (
        <InlineNotification
          kind="error"
          title={t(`team.errors.${error}`, { defaultValue: t("team.errors.failed") })}
          onClose={() => setError(null)}
        />
      )}
      <SimpleTable
        title={t("team.members")}
        columns={columns.map((key) => ({ key, header: t(`team.columns.${key}`) }))}
        rows={rows}
        emptyState={t("team.empty")}
      />
      {(capabilities.manageMembers || capabilities.addReplacementLead) && (
        <AddMember
          projectId={projectId}
          roles={capabilities.manageMembers ? projectRoles : ["project_lead"]}
          onAdded={async () => {
            setError(null);
            await refresh();
            showToast({ title: t("team.added") });
          }}
          onRefused={setError}
        />
      )}
    </section>
  );
}

/** Find a person by name in the staff directory, choose the role, add. */
function AddMember({
  projectId,
  roles,
  onAdded,
  onRefused,
}: {
  projectId: string;
  roles: readonly ProjectRole[];
  onAdded: () => Promise<void>;
  onRefused: (code: string) => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const [search, setSearch] = useState("");
  const [staffUserId, setStaffUserId] = useState("");
  const [role, setRole] = useState<ProjectRole>(roles[0]!);
  const directory = useQuery(staffDirectoryQuery(api, search));

  const add = useMutation({
    mutationFn: async () => {
      await api.POST("/api/v1/projects/{projectId}/members", {
        params: { path: { projectId } },
        body: { staffUserId, role },
      });
    },
    onSuccess: async () => {
      setStaffUserId("");
      setSearch("");
      await onAdded();
    },
    onError: (failure) => onRefused(refusalCode(failure) ?? "failed"),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (staffUserId) add.mutate();
  }

  return (
    <Form className="tp-form" onSubmit={submit} aria-label={t("team.add")}>
      <Stack gap={5}>
        <h3>{roles.length === 1 ? t("team.addReplacementLead") : t("team.add")}</h3>
        <TextInput
          id="team-search"
          labelText={t("team.search")}
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setStaffUserId("");
          }}
        />
        <Select
          id="team-person"
          labelText={t("team.person")}
          value={staffUserId}
          onChange={(event) => setStaffUserId(event.target.value)}
          disabled={!directory.data?.length}
        >
          <SelectItem value="" text={t("team.choosePerson")} />
          {(directory.data ?? []).map((entry) => (
            <SelectItem key={entry.id} value={entry.id} text={entry.displayName} />
          ))}
        </Select>
        <Select
          id="team-role"
          labelText={t("team.role")}
          value={role}
          onChange={(event) => setRole(event.target.value as ProjectRole)}
        >
          {roles.map((option) => (
            <SelectItem key={option} value={option} text={t(`session.roles.${option}`)} />
          ))}
        </Select>
        <ButtonSet>
          <Button type="submit" disabled={!staffUserId || add.isPending}>
            {t("team.submit")}
          </Button>
        </ButtonSet>
      </Stack>
    </Form>
  );
}

/** The project's consultants (Q62): whom participations may be assigned to. */
export function useConsultants(projectId: string) {
  const { data: team } = useSuspenseQuery(projectTeamQuery(useApi(), projectId));
  return {
    consultants: team.members.filter((m) => m.roles.includes("consultant") && !m.deactivated),
    mayAssign: team.capabilities.assignParticipations,
  };
}
