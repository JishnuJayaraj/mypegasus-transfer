import {
  DrivingLicenceClass,
  EmploymentType,
  ForeignCountry,
  LanguageLevel,
  ResidenceStatus,
  rowLimits,
} from "@transfer/domain";
import type { WizardField } from "@transfer/domain";
import {
  Button,
  Checkbox,
  DateField,
  RadioButton,
  RadioButtonGroup,
  Select,
  SelectItem,
  Stack,
  TextArea,
  TextInput,
} from "@transfer/ui";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { SELF_SERVICE_NAMESPACE } from "./i18n";
import {
  customKind,
  emptyEducation,
  emptyLanguage,
  emptyWork,
  foreignNationality,
  type AddressForm,
  type Draft,
  type DistanceForm,
  type DrivingLicenceForm,
  type EducationForm,
  type JobWishesForm,
  type LanguageSkillsForm,
  type NationalityForm,
  type WorkForm,
  type WorkingTimeForm,
} from "./model";

// One editor per catalog field of a page, and the custom fields from their field schema
// (regional-variation.md, "Self-service wizard"). Required fields carry `*`; help texts come
// from the participation's chain; issues show at the input they belong to.

export type FormContext = {
  draft: Draft;
  set: (key: string, value: unknown) => void;
  /** The translated issue at a path below the page's values. */
  error: (path: string) => string | undefined;
  /** Rows with `von > bis`, as `<field>/<index>`. */
  warnings: readonly string[];
  language: "de" | "en";
};

export const Form = createContext<FormContext | null>(null);
const useForm = () => useContext(Form)!;
const useT = () => useTranslation(SELF_SERVICE_NAMESPACE).t;

const idOf = (path: string) => `self-service-${path.replaceAll(/[./]/g, "-")}`;

/** The label of a field, `*` when it is required. */
function useLabel(field: WizardField) {
  const t = useT();
  const { language } = useForm();
  const label = field.custom
    ? (field.custom.label[language] ?? field.custom.label.de)
    : t(`fields.${field.key}.label`);
  return field.required ? t("required", { label }) : label;
}

/** The chain's help text in the language shown, else German. */
function useHelp(field: WizardField, fallback?: string) {
  const { language } = useForm();
  return field.helpText?.[language] ?? field.helpText?.de ?? fallback;
}

/** Invalid props for a Carbon input at `path`. */
function useInvalid(path: string) {
  const text = useForm().error(path);
  return { invalid: text !== undefined, invalidText: text };
}

/**
 * Carbon's text inputs point `aria-errormessage` at their message; the message is also their
 * description, so it is read with the field (axe: aria-valid-attr-value).
 */
const describedBy = (path: string, invalid: boolean) =>
  invalid ? { "aria-describedby": `${idOf(path)}-error-msg` } : {};

function Text(props: {
  path: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  help?: string | undefined;
  type?: "text" | "tel" | "email";
  inputMode?: "numeric" | "decimal";
  autoComplete?: string;
}) {
  const invalid = useInvalid(props.path);
  return (
    <TextInput
      id={idOf(props.path)}
      labelText={props.label}
      helperText={props.help}
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
      type={props.type ?? "text"}
      inputMode={props.inputMode}
      autoComplete={props.autoComplete}
      {...invalid}
      {...describedBy(props.path, invalid.invalid)}
    />
  );
}

function LongText(props: {
  path: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  help?: string | undefined;
}) {
  const invalid = useInvalid(props.path);
  return (
    <TextArea
      id={idOf(props.path)}
      labelText={props.label}
      helperText={props.help}
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
      rows={3}
      {...invalid}
      {...describedBy(props.path, invalid.invalid)}
    />
  );
}

/** `TT.MM.JJJJ`, sent as ISO. Uncontrolled: a row keeps its input by its id. */
function DateText(props: {
  path: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  help?: string | undefined;
}) {
  const text = useForm().error(props.path);
  return (
    <Stack gap={2}>
      <DateField
        id={idOf(props.path)}
        labelText={props.label}
        defaultValue={props.value}
        onChange={props.onChange}
        invalidText={text}
      />
      {props.help && <span className="tp-hint">{props.help}</span>}
    </Stack>
  );
}

function Choice(props: {
  path: string;
  legend: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
  help?: string | undefined;
}) {
  const invalid = useInvalid(props.path);
  return (
    <RadioButtonGroup
      legendText={props.legend}
      name={idOf(props.path)}
      valueSelected={props.value}
      onChange={(value) => props.onChange(String(value))}
      orientation="vertical"
      helperText={props.help}
      {...invalid}
    >
      {props.options.map((option) => (
        <RadioButton
          key={option.value}
          id={`${idOf(props.path)}-${option.value}`}
          labelText={option.label}
          value={option.value}
        />
      ))}
    </RadioButtonGroup>
  );
}

function Dropdown(props: {
  path: string;
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
  help?: string | undefined;
}) {
  const t = useT();
  const invalid = useInvalid(props.path);
  return (
    <Select
      id={idOf(props.path)}
      labelText={props.label}
      helperText={props.help}
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
      {...invalid}
    >
      <SelectItem value="" text={t("options.choose")} />
      {props.options.map((option) => (
        <SelectItem key={option.value} value={option.value} text={option.label} />
      ))}
    </Select>
  );
}

function Group(props: { legend: string; help?: string | undefined; children: ReactNode }) {
  return (
    <fieldset className="tp-fieldset">
      <legend>{props.legend}</legend>
      {props.help && <span className="tp-hint">{props.help}</span>}
      {props.children}
    </fieldset>
  );
}

/** A bounded row table (ba-forms.md, row limits): one group per row, add and remove. */
function Rows<T extends { id: number }>(props: {
  path: string;
  legend: string;
  help?: string | undefined;
  rows: T[];
  max: number;
  rowLabel: (number: number) => string;
  empty: () => T;
  onChange: (rows: T[]) => void;
  children: (row: T, index: number, update: (patch: Partial<T>) => void) => ReactNode;
}) {
  const t = useT();
  const { error, warnings } = useForm();
  const tableError = error(props.path);
  return (
    <Group legend={props.legend} help={props.help}>
      {props.rows.length === 0 && <p>{t("rows.empty")}</p>}
      {props.rows.map((row, index) => (
        <fieldset key={row.id} className="tp-fieldset tp-row">
          <legend>{props.rowLabel(index + 1)}</legend>
          {props.children(row, index, (patch) =>
            props.onChange(props.rows.map((r) => (r.id === row.id ? { ...r, ...patch } : r))),
          )}
          {warnings.includes(`${props.path}/${index}`) && (
            <p className="tp-warning">{t("warnings.from_after_to")}</p>
          )}
          <Button
            kind="ghost"
            size="sm"
            onClick={() => props.onChange(props.rows.filter((r) => r.id !== row.id))}
          >
            {t("actions.removeRow", { number: index + 1 })}
          </Button>
        </fieldset>
      ))}
      {tableError && (
        <p className="tp-error" role="alert">
          {tableError}
        </p>
      )}
      <Button
        kind="tertiary"
        size="sm"
        disabled={props.rows.length >= props.max}
        onClick={() => props.onChange([...props.rows, props.empty()])}
      >
        {t("actions.addRow")}
      </Button>
      <span className="tp-hint">{t("rows.limit", { max: props.max })}</span>
    </Group>
  );
}

const yesNoOptions = (t: ReturnType<typeof useT>) => [
  { value: "yes", label: t("options.yes") },
  { value: "no", label: t("options.no") },
];

/** The editor of one field of a page. */
export function FieldEditor({ field }: { field: WizardField }) {
  const t = useT();
  const { draft, set } = useForm();
  const label = useLabel(field);
  const help = useHelp(field);
  const { key } = field;
  const value = draft[key];
  const change = (next: unknown) => set(key, next);
  const sub = (name: string) => t(`fields.${key}.${name}`);
  const options = (values: readonly string[]) => values.map((v) => ({ value: v, label: sub(v) }));

  if (field.custom) return <CustomEditor field={field} label={label} help={help} />;

  switch (key) {
    case "gender":
      return (
        <Choice
          path={key}
          legend={label}
          help={help}
          value={value as string}
          onChange={change}
          options={options(["male", "female", "diverse", "not_specified"])}
        />
      );
    case "maritalStatus":
      return (
        <Choice
          path={key}
          legend={label}
          help={help}
          value={value as string}
          onChange={change}
          options={options(["single", "married"])}
        />
      );
    case "address": {
      const address = value as AddressForm;
      const part = (name: keyof AddressForm, autoComplete: string) => (
        <Text
          path={`${key}/${name}`}
          label={sub(name)}
          value={address[name]}
          onChange={(text) => change({ ...address, [name]: text })}
          autoComplete={autoComplete}
        />
      );
      return (
        <Group legend={label} help={help}>
          {part("street", "street-address")}
          {part("postalCode", "postal-code")}
          {part("city", "address-level2")}
        </Group>
      );
    }
    case "phone":
    case "mobile":
      return (
        <Text
          path={key}
          label={label}
          help={help}
          value={value as string}
          onChange={change}
          type="tel"
          autoComplete="tel"
        />
      );
    case "privateEmail":
      return (
        <Text
          path={key}
          label={label}
          help={help ?? sub("hint")}
          value={value as string}
          onChange={change}
          type="email"
          autoComplete="email"
        />
      );
    case "educationHistory":
      return (
        <Rows<EducationForm>
          path={key}
          legend={label}
          help={help}
          rows={value as EducationForm[]}
          max={rowLimits.educationHistory}
          rowLabel={(number) => t(`fields.${key}.row`, { number })}
          empty={emptyEducation}
          onChange={change}
        >
          {(row, index, update) => (
            <>
              <DateText
                path={`${key}/${index}/from`}
                label={sub("from")}
                value={row.from}
                onChange={(from) => update({ from })}
              />
              <DateText
                path={`${key}/${index}/to`}
                label={sub("to")}
                help={sub("toHint")}
                value={row.to}
                onChange={(to) => update({ to })}
              />
              <Text
                path={`${key}/${index}/institution`}
                label={sub("institution")}
                value={row.institution}
                onChange={(institution) => update({ institution })}
              />
              <Text
                path={`${key}/${index}/qualification`}
                label={sub("qualification")}
                value={row.qualification}
                onChange={(qualification) => update({ qualification })}
              />
              <Dropdown
                path={`${key}/${index}/completed`}
                label={sub("completed")}
                value={row.completed}
                onChange={(completed) => update({ completed })}
                options={[...yesNoOptions(t), { value: "running", label: sub("running") }]}
              />
              {/* One row at most: marking it unmarks the others (Q196). */}
              <Checkbox
                id={idOf(`${key}/${index}/highestSchool`)}
                labelText={sub("highestSchool")}
                helperText={sub("highestSchoolHint")}
                checked={row.highestSchool}
                onChange={(_event, { checked }) =>
                  change(
                    (value as EducationForm[]).map((other) => ({
                      ...other,
                      highestSchool: other.id === row.id && checked,
                    })),
                  )
                }
              />
            </>
          )}
        </Rows>
      );
    case "workHistory":
      return (
        <Rows<WorkForm>
          path={key}
          legend={label}
          help={help ?? sub("hint")}
          rows={value as WorkForm[]}
          max={rowLimits.workHistory}
          rowLabel={(number) => t(`fields.${key}.row`, { number })}
          empty={emptyWork}
          onChange={change}
        >
          {(row, index, update) => (
            <>
              <DateText
                path={`${key}/${index}/from`}
                label={sub("from")}
                value={row.from}
                onChange={(from) => update({ from })}
              />
              <DateText
                path={`${key}/${index}/to`}
                label={sub("to")}
                help={sub("toHint")}
                value={row.to}
                onChange={(to) => update({ to })}
              />
              <Text
                path={`${key}/${index}/employer`}
                label={sub("employer")}
                value={row.employer}
                onChange={(employer) => update({ employer })}
              />
              <Text
                path={`${key}/${index}/activity`}
                label={sub("activity")}
                value={row.activity}
                onChange={(activity) => update({ activity })}
              />
            </>
          )}
        </Rows>
      );
    case "languageSkills": {
      const skills = value as LanguageSkillsForm;
      const levels = options(LanguageLevel.options);
      return (
        <Group legend={label} help={help}>
          <Dropdown
            path={`${key}/german`}
            label={sub("german")}
            value={skills.german}
            onChange={(german) => change({ ...skills, german })}
            options={levels}
          />
          <Rows
            path={`${key}/others`}
            legend={sub("others")}
            rows={skills.others}
            max={rowLimits.languages - 1}
            rowLabel={(number) => t(`fields.${key}.row`, { number })}
            empty={emptyLanguage}
            onChange={(others) => change({ ...skills, others })}
          >
            {(row, index, update) => (
              <>
                <Text
                  path={`${key}/others/${index}/language`}
                  label={sub("language")}
                  value={row.language}
                  onChange={(language) => update({ language })}
                />
                <Dropdown
                  path={`${key}/others/${index}/level`}
                  label={sub("level")}
                  value={row.level}
                  onChange={(level) => update({ level })}
                  options={levels}
                />
              </>
            )}
          </Rows>
        </Group>
      );
    }
    case "drivingLicence":
      return <DrivingLicenceEditor field={field} label={label} help={help} />;
    case "vehicleAvailable":
      return (
        <Choice
          path={key}
          legend={label}
          help={help}
          value={value as string}
          onChange={change}
          options={yesNoOptions(t)}
        />
      );
    case "workingTimePreferences": {
      const time = value as WorkingTimeForm;
      return (
        <Group legend={label} help={help}>
          <Choice
            path={`${key}/employmentType`}
            legend={sub("employmentType")}
            value={time.employmentType}
            onChange={(employmentType) => change({ ...time, employmentType })}
            options={options(EmploymentType.options)}
          />
          <Text
            path={`${key}/weeklyHours`}
            label={sub("weeklyHours")}
            value={time.weeklyHours}
            onChange={(weeklyHours) => change({ ...time, weeklyHours })}
            inputMode="decimal"
          />
          <LongText
            path={`${key}/distribution`}
            label={sub("distribution")}
            value={time.distribution}
            onChange={(distribution) => change({ ...time, distribution })}
          />
        </Group>
      );
    }
    case "jobWishes": {
      const wishes = value as JobWishesForm;
      return (
        <Group legend={label} help={help}>
          <Text
            path={`${key}/desired`}
            label={sub("desired")}
            value={wishes.desired}
            onChange={(desired) => change({ ...wishes, desired })}
          />
          <Text
            path={`${key}/alternative`}
            label={sub("alternative")}
            value={wishes.alternative}
            onChange={(alternative) => change({ ...wishes, alternative })}
          />
        </Group>
      );
    }
    case "desiredWorkLocations":
      return (
        <LongText path={key} label={label} help={help} value={value as string} onChange={change} />
      );
    case "maxCommuteDistance": {
      const distance = value as DistanceForm;
      return (
        <Group legend={label} help={help}>
          <Choice
            path={`${key}/kind`}
            legend={sub("label")}
            value={distance.kind}
            onChange={(kind) => change({ ...distance, kind })}
            options={options(["km", "nationwide", "international"])}
          />
          {distance.kind === "km" && (
            <Text
              path={`${key}/km`}
              label={sub("kmValue")}
              value={distance.km}
              onChange={(km) => change({ ...distance, km })}
              inputMode="numeric"
            />
          )}
        </Group>
      );
    }
    case "earliestStartDate":
      return (
        <DateText path={key} label={label} help={help} value={value as string} onChange={change} />
      );
    case "pensionInsuranceNumber":
      return (
        <Text
          path={key}
          label={label}
          help={help ?? sub("hint")}
          value={value as string}
          onChange={change}
          autoComplete="off"
        />
      );
    case "nationality":
      return <NationalityEditor field={field} label={label} help={help} />;
    // Entry date and residence status only with another nationality, never required (TL 407).
    case "entryToGermanyDate":
      return foreignNationality(draft) ? (
        <DateText path={key} label={label} help={help} value={value as string} onChange={change} />
      ) : null;
    case "residenceStatus":
      return foreignNationality(draft) ? (
        <Dropdown
          path={key}
          label={label}
          help={help}
          value={value as string}
          onChange={change}
          options={options(ResidenceStatus.options)}
        />
      ) : null;
    // Yes or no only (Q135): never a diagnosis.
    case "buergergeld":
    case "healthRestrictions":
    case "severeDisability":
      return (
        <Choice
          path={key}
          legend={label}
          help={help ?? sub("hint")}
          value={value as string}
          onChange={change}
          options={yesNoOptions(t)}
        />
      );
    default:
      return (
        <Text path={key} label={label} help={help} value={value as string} onChange={change} />
      );
  }
}

/** German, or another nationality with its country, named in the language shown (TL 407). */
function NationalityEditor(props: { field: WizardField; label: string; help: string | undefined }) {
  const t = useT();
  const { draft, set, language } = useForm();
  const value = draft.nationality as NationalityForm;
  const change = (patch: Partial<NationalityForm>) => set("nationality", { ...value, ...patch });
  const countries = useMemo(() => {
    const names = new Intl.DisplayNames([language], { type: "region" });
    return ForeignCountry.options
      .map((code) => ({ value: code, label: names.of(code) ?? code }))
      .toSorted((a, b) => a.label.localeCompare(b.label, language));
  }, [language]);
  return (
    <Group legend={props.label} help={props.help}>
      <Choice
        path="nationality"
        legend={t("fields.nationality.kind")}
        value={value.kind}
        onChange={(kind) => change({ kind })}
        options={[
          { value: "german", label: t("fields.nationality.german") },
          { value: "other", label: t("fields.nationality.other") },
        ]}
      />
      {value.kind === "other" && (
        <Dropdown
          path="nationality/country"
          label={t("fields.nationality.country")}
          value={value.country}
          onChange={(country) => change({ country })}
          options={countries}
        />
      )}
    </Group>
  );
}

/** The EU classes or "keinen Führerschein" (an answer of its own, ba-forms.md). */
function DrivingLicenceEditor(props: {
  field: WizardField;
  label: string;
  help: string | undefined;
}) {
  const t = useT();
  const { draft, set, error } = useForm();
  const { key } = props.field;
  const licence = draft[key] as DrivingLicenceForm;
  const text = error(key);
  return (
    <Group legend={props.label} help={props.help}>
      <Checkbox
        id={idOf(`${key}/none`)}
        labelText={t(`fields.${key}.none`)}
        checked={licence.none}
        onChange={(_event, { checked }) =>
          set(key, { none: checked, classes: checked ? [] : licence.classes })
        }
      />
      <fieldset className="tp-fieldset">
        <legend>{t(`fields.${key}.classes`)}</legend>
        <div className="tp-checkbox-grid">
          {DrivingLicenceClass.options.map((value) => (
            <Checkbox
              key={value}
              id={idOf(`${key}/${value}`)}
              labelText={value}
              disabled={licence.none}
              checked={licence.classes.includes(value)}
              onChange={(_event, { checked }) =>
                set(key, {
                  none: false,
                  classes: checked
                    ? DrivingLicenceClass.options.filter(
                        (c) => c === value || licence.classes.includes(c),
                      )
                    : licence.classes.filter((c) => c !== value),
                })
              }
            />
          ))}
        </div>
      </fieldset>
      {text && (
        <p className="tp-error" role="alert">
          {text}
        </p>
      )}
    </Group>
  );
}

/** A custom field rendered from its field schema (the profile's scalar types only). */
function CustomEditor(props: { field: WizardField; label: string; help: string | undefined }) {
  const t = useT();
  const { draft, set } = useForm();
  const { key, custom } = props.field;
  const schema = custom!.schema;
  const value = draft[key] as string;
  const change = (next: string) => set(key, next);
  switch (customKind(schema)) {
    case "boolean":
      return (
        <Choice
          path={key}
          legend={props.label}
          help={props.help}
          value={value}
          onChange={change}
          options={yesNoOptions(t)}
        />
      );
    case "enum":
      return (
        <Dropdown
          path={key}
          label={props.label}
          help={props.help}
          value={value}
          onChange={change}
          options={(schema.enum as unknown[]).map((option) => ({
            value: String(option),
            label: String(option),
          }))}
        />
      );
    case "date":
      return (
        <DateText
          path={key}
          label={props.label}
          help={props.help}
          value={value}
          onChange={change}
        />
      );
    case "number":
      return (
        <Text
          path={key}
          label={props.label}
          help={props.help}
          value={value}
          onChange={change}
          inputMode="decimal"
        />
      );
    default:
      return (
        <Text path={key} label={props.label} help={props.help} value={value} onChange={change} />
      );
  }
}
