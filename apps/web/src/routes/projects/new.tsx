import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { PageHeader, useToast } from "@transfer/ui";
import { useTranslation } from "react-i18next";
import { ProjectForm } from "../../components/project-form";
import { usePageTitle } from "../../page-title";

export const Route = createFileRoute("/projects/new")({ component: NewProjectPage });

function NewProjectPage() {
  const { t } = useTranslation();
  usePageTitle(t("projects.create"));
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const showToast = useToast();

  return (
    <>
      <PageHeader title={t("projects.create")} />
      <ProjectForm
        onCancel={() => void navigate({ to: "/projects" })}
        onCreated={async (project) => {
          await queryClient.invalidateQueries({ queryKey: ["projects"] });
          showToast({ title: t("projects.created"), subtitle: project.name });
          await navigate({ to: "/projects" });
        }}
      />
    </>
  );
}
