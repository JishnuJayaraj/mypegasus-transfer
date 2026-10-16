import { useMutation } from "@tanstack/react-query";
import { ApiProblemError, type components } from "@transfer/api-client";
import { CreateProjectInput, type ProjectType } from "@transfer/domain";
import {
  Button,
  ButtonSet,
  Form,
  InlineNotification,
  RadioButton,
  RadioButtonGroup,
  Stack,
  TextInput,
} from "@transfer/ui";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "../api";

type Project = components["schemas"]["Project"];
type Field = "name" | "customerName" | "type";
type ErrorKey = "required" | "tooLong" | "invalid";

// The contractual dates live on the project's entry waves (Q79), not in this form.
const FIELDS: readonly Field[] = ["name", "customerName", "type"];

/** Maps a validation issue code (Zod's, or a domain rule's `params.code`) to a message key. */
function errorKey(code: string): ErrorKey {
  switch (code) {
    case "too_small":
    case "invalid_type":
      return "required";
    case "too_big":
      return "tooLong";
    default:
      return "invalid";
  }
}

function isField(value: unknown): value is Field {
  return FIELDS.includes(value as Field);
}

interface ProjectFormProps {
  onCreated: (project: Project) => Promise<void>;
  onCancel: () => void;
}

export function ProjectForm({ onCreated, onCancel }: ProjectFormProps) {
  const { t } = useTranslation();
  const api = useApi();
  const [name, setName] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [type, setType] = useState<ProjectType>("ta_tg");
  const [errors, setErrors] = useState<Partial<Record<Field, ErrorKey>>>({});

  const create = useMutation({
    mutationFn: async (input: CreateProjectInput) => {
      const { data } = await api.POST("/api/v1/projects", { body: input });
      if (!data) throw new Error("Project was not created");
      return data;
    },
    onSuccess: onCreated,
    onError: (error) => {
      if (!(error instanceof ApiProblemError)) return;
      const fieldErrors: Partial<Record<Field, ErrorKey>> = {};
      for (const item of error.problem.errors ?? []) {
        const field = item.pointer?.split("/")[1];
        if (isField(field)) fieldErrors[field] ??= errorKey(item.code);
      }
      setErrors(fieldErrors);
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const fieldErrors: Partial<Record<Field, ErrorKey>> = {};
    const result = CreateProjectInput.safeParse({ name, customerName, type });
    for (const issue of result.error?.issues ?? []) {
      const field = issue.path[0];
      const code = (issue as { params?: { code?: string } }).params?.code ?? issue.code;
      if (isField(field)) fieldErrors[field] ??= errorKey(code);
    }
    setErrors(fieldErrors);
    if (result.success && Object.keys(fieldErrors).length === 0) create.mutate(result.data);
  }

  const invalidText = (field: Field) => {
    const key = errors[field];
    return key && t(`errors.${key}`);
  };

  return (
    <Form className="tp-form" onSubmit={submit} noValidate>
      <Stack gap={6}>
        {create.isError &&
          !(create.error instanceof ApiProblemError && create.error.status === 400) && (
            <InlineNotification kind="error" title={t("projectForm.failed")} hideCloseButton />
          )}
        <TextInput
          id="project-name"
          labelText={t("projectForm.name")}
          value={name}
          onChange={(event) => setName(event.target.value)}
          invalid={errors.name !== undefined}
          invalidText={invalidText("name")}
        />
        <TextInput
          id="project-customer-name"
          labelText={t("projectForm.customerName")}
          value={customerName}
          onChange={(event) => setCustomerName(event.target.value)}
          invalid={errors.customerName !== undefined}
          invalidText={invalidText("customerName")}
        />
        <RadioButtonGroup
          name="project-type"
          legendText={t("projectForm.type")}
          valueSelected={type}
          onChange={(value) => setType(value as ProjectType)}
          orientation="vertical"
        >
          <RadioButton
            id="project-type-ta-tg"
            value="ta_tg"
            labelText={t("projects.types.ta_tg")}
          />
          <RadioButton
            id="project-type-ta-only"
            value="ta_only"
            labelText={t("projects.types.ta_only")}
          />
        </RadioButtonGroup>
        <p>{t("projectForm.datesOnWaves")}</p>
        <ButtonSet>
          <Button kind="secondary" onClick={onCancel}>
            {t("projectForm.cancel")}
          </Button>
          <Button type="submit" disabled={create.isPending}>
            {t("projectForm.submit")}
          </Button>
        </ButtonSet>
      </Stack>
    </Form>
  );
}
