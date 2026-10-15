import { useMutation } from "@tanstack/react-query";
import { ApiProblemError, type components } from "@transfer/api-client";
import { CreateProjectInput, projectRuleCodes, type ProjectType } from "@transfer/domain";
import {
  Button,
  ButtonSet,
  DateField,
  Form,
  InlineNotification,
  parseDisplayDate,
  RadioButton,
  RadioButtonGroup,
  Stack,
  TextInput,
} from "@transfer/ui";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useApi } from "../api";

type Project = components["schemas"]["Project"];
type Field = "name" | "customerName" | "type" | DateFieldName;
type DateFieldName = (typeof DATE_FIELDS)[number];
type ErrorKey =
  | "required"
  | "tooLong"
  | "invalidDate"
  | "tgEndBeforeStart"
  | "notAllowedForTaOnly"
  | "invalid";

const DATE_FIELDS = ["signingDeadline", "defaultTgStart", "defaultTgEnd"] as const;
const FIELDS: readonly Field[] = ["name", "customerName", "type", ...DATE_FIELDS];

/** Maps a validation issue code (Zod's, or a domain rule's `params.code`) to a message key. */
function errorKey(code: string): ErrorKey {
  switch (code) {
    case "too_small":
    case "invalid_type":
      return "required";
    case "too_big":
      return "tooLong";
    case "invalid_date":
      return "invalidDate";
    case projectRuleCodes.tgEndBeforeStart:
      return "tgEndBeforeStart";
    case projectRuleCodes.notAllowedForTaOnly:
      return "notAllowedForTaOnly";
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
  const [dates, setDates] = useState<Record<DateFieldName, string>>({
    signingDeadline: "",
    defaultTgStart: "",
    defaultTgEnd: "",
  });
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
    const isoDates: Partial<Record<DateFieldName, string>> = {};
    // A ta_only project has no signing deadline and no TG dates; their fields are hidden.
    if (type === "ta_tg") {
      for (const field of DATE_FIELDS) {
        const parsed = parseDisplayDate(dates[field]);
        if (!parsed.ok) fieldErrors[field] = "invalidDate";
        else if (parsed.value) isoDates[field] = parsed.value;
      }
    }
    const result = CreateProjectInput.safeParse({ name, customerName, type, ...isoDates });
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
        {type === "ta_tg" &&
          DATE_FIELDS.map((field) => (
            <DateField
              key={field}
              id={`project-${field}`}
              labelText={t(`projectForm.${field}`)}
              defaultValue={dates[field]}
              onChange={(text) => setDates((current) => ({ ...current, [field]: text }))}
              invalidText={invalidText(field)}
            />
          ))}
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
