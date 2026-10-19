import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { ApiProblemError, type components } from "@transfer/api-client";
import {
  checkImportDecisions,
  ImportTarget,
  importLimits,
  type ImportDecisions,
  type ImportPlan,
} from "@transfer/domain";
import {
  Button,
  Checkbox,
  FileUploaderButton,
  InlineNotification,
  RadioButton,
  RadioButtonGroup,
  Select,
  SelectItem,
  SimpleTable,
  Stack,
} from "@transfer/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { entryWavesQuery, projectQuery, useApi } from "../api";

type Schemas = components["schemas"];
type Preview = Schemas["ImportPreview"];
type Result = Schemas["ImportResult"];
type Mapping = Preview["mapping"];
type Row = NonNullable<Preview["report"]>["rows"][number];
type Issue = Preview["mappingIssues"][number];

const delimiterKeys = { ";": "semicolon", ",": "comma", "\t": "tab" } as const;
const delimiters = Object.keys(delimiterKeys) as (keyof typeof delimiterKeys)[];
const encodings = ["utf-8", "windows-1252"] as const;

/** What the PL chose about the file; the file's own detection fills the rest. */
type Options = {
  sheet: string | null;
  headerRow: number;
  delimiter: (typeof delimiters)[number] | null;
  encoding: (typeof encodings)[number] | null;
  /** The whole-import country (round 32): `DE` or none (a column of the file). */
  country: "DE" | null;
  waveId: string | null;
};
const initialOptions: Options = {
  sheet: null,
  headerRow: 1,
  delimiter: null,
  encoding: null,
  country: null,
  waveId: null,
};

/** The request body shared by the preview and the confirm. */
const bodyOf = (file: string, options: Options, mapping?: Mapping) => ({
  file,
  headerRow: options.headerRow,
  ...(options.sheet && { sheet: options.sheet }),
  ...((options.delimiter || options.encoding) && {
    csv: {
      ...(options.delimiter && { delimiter: options.delimiter }),
      ...(options.encoding && { encoding: options.encoding }),
    },
  }),
  ...(options.country && { country: options.country }),
  ...(options.waveId && { waveId: options.waveId }),
  ...(mapping && { mapping }),
});

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCodePoint(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(text);
}

/** The codes of a problem, and `forbidden` for a 403 (the API's check stays authoritative). */
function codesOf(error: unknown): string[] {
  if (!(error instanceof ApiProblemError)) return [];
  if (error.status === 403) return ["forbidden"];
  return (error.problem.errors ?? []).map((item) => item.code);
}

/** The ids of the project's waves, only for a `ta_tg` project (the selection of 5.6). */
function WaveSelect(props: {
  projectId: string;
  value: string | null;
  onChange: (waveId: string | null) => void;
}) {
  const { t } = useTranslation();
  const { data: waves } = useSuspenseQuery(entryWavesQuery(useApi(), props.projectId));
  return (
    <Select
      id="import-wave"
      labelText={t("import.mapping.wave")}
      value={props.value ?? ""}
      onChange={(event) => props.onChange(event.target.value || null)}
    >
      <SelectItem value="" text={t("import.mapping.waveNone")} />
      {waves.map((wave) => (
        <SelectItem key={wave.id} value={wave.id} text={`${wave.code} · ${wave.name}`} />
      ))}
    </Select>
  );
}

/**
 * The import wizard (Slice 2 plan 5.13): upload → sheet and header row → mapping (suggestions the
 * PL confirms; a whole-import country) → report (errors, warnings, possible duplicates, updates
 * with old and new values) → confirm. It is rendered only with the server's
 * `capabilities.importParticipations`; the API's checks stay the enforcement. Refusals go to the
 * parent, which outlives the wizard; after each one the wizard reads the state again.
 */
export function ImportWizard(props: {
  projectId: string;
  onDone: (result: Result) => void;
  onRefused: (codes: string[]) => void;
}) {
  const { projectId, onDone, onRefused } = props;
  const { t } = useTranslation();
  const api = useApi();
  const { data: project } = useSuspenseQuery(projectQuery(api, projectId));
  const [file, setFile] = useState<string | null>(null);
  const [options, setOptions] = useState<Options>(initialOptions);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Mapping>([]);
  const [reviewed, setReviewed] = useState(false);
  const [decisions, setDecisions] = useState<ImportDecisions>({
    confirmWarnings: false,
    possibleDuplicates: {},
  });

  const path = { params: { path: { projectId } } };
  /** A preview; without a mapping it answers sheets, headers and suggestions. */
  const run = useMutation({
    mutationFn: async (args: { file: string; options: Options; mapping?: Mapping }) => {
      const { data } = await api.POST("/api/v1/projects/{projectId}/imports/preview", {
        ...path,
        body: bodyOf(args.file, args.options, args.mapping),
      });
      if (!data) throw new Error("No preview");
      return data;
    },
    onError: (error) => onRefused(codesOf(error)),
  });

  const adopt = (shown: Preview, next: Options, fresh: boolean) => {
    setPreview(shown);
    setOptions(next);
    if (fresh) {
      setMapping(shown.suggestedMapping.map(({ column, target }) => ({ column, target })));
      setReviewed(false);
    } else {
      setReviewed(shown.report !== null);
    }
    setDecisions({ confirmWarnings: false, possibleDuplicates: {} });
  };

  /** Reads the file again with other options; the mapping starts from the new suggestions. */
  const reload = (source: string, next: Options) =>
    run.mutate(
      { file: source, options: next },
      {
        onSuccess: (shown) => {
          setFile(source);
          adopt(shown, next, true);
        },
      },
    );

  const choose = async (chosen: File | undefined) => {
    if (!chosen) return;
    if (chosen.size > importLimits.fileBytes) return onRefused(["file_too_large"]);
    reload(toBase64(await chosen.arrayBuffer()), initialOptions);
  };

  const check = (source: string, current: Mapping, from: Options = options) =>
    run.mutate(
      { file: source, options: from, mapping: current },
      { onSuccess: (shown) => adopt(shown, from, false) },
    );

  const confirm = useMutation({
    mutationFn: async (args: { file: string; token: string }) => {
      const { data } = await api.POST("/api/v1/projects/{projectId}/imports", {
        ...path,
        body: {
          ...bodyOf(args.file, options, mapping),
          mapping,
          decisions,
          previewToken: args.token,
        },
      });
      if (!data) throw new Error("No result");
      return data;
    },
    onSuccess: onDone,
    onError: (error, args) => {
      onRefused(codesOf(error));
      // Read the state again: a stale preview is replaced by a new one to check.
      if (codesOf(error).includes("import_preview_stale")) check(args.file, mapping);
    },
  });

  if (!file || !preview) {
    return (
      <Stack gap={5} className="tp-form">
        <p>{t("import.intro")}</p>
        <FileUploaderButton
          labelText={t("import.upload.label")}
          accept={[".xlsx", ".csv"]}
          disableLabelChanges
          onChange={(event) => choose(event.target.files?.[0])}
        />
        <p>{t("import.upload.hint")}</p>
        {run.isPending && <p>{t("import.upload.reading")}</p>}
      </Stack>
    );
  }

  const label = (target: string) => t(`import.targets.${target as "address"}`);
  const message = (code: string) =>
    t(`import.issues.${code as "failed"}`, { defaultValue: t("import.issues.failed") });
  const csv = preview.csv;

  return (
    <Stack gap={5} className="tp-form">
      <Button kind="ghost" size="sm" onClick={() => setFile(null)}>
        {t("import.file.change")}
      </Button>
      <h3>{t("import.file.title")}</h3>
      {preview.format === "xlsx" && preview.sheets.length > 1 && (
        <Select
          id="import-sheet"
          labelText={t("import.file.sheet")}
          value={options.sheet ?? preview.sheet ?? ""}
          onChange={(event) => reload(file, { ...options, sheet: event.target.value })}
        >
          {preview.sheets.map((sheet) => (
            <SelectItem key={sheet} value={sheet} text={sheet} />
          ))}
        </Select>
      )}
      <Select
        id="import-header-row"
        labelText={t("import.file.headerRow")}
        value={String(preview.headerRow)}
        onChange={(event) => reload(file, { ...options, headerRow: Number(event.target.value) })}
      >
        {Array.from({ length: importLimits.headerRowChoices }, (_, i) => (
          <SelectItem
            key={i}
            value={String(i + 1)}
            text={t("import.file.headerRowOption", { row: i + 1 })}
          />
        ))}
      </Select>
      {preview.headerLooksLikeData && (
        <InlineNotification
          kind="warning"
          title={t("import.file.headerLooksLikeData")}
          hideCloseButton
          lowContrast
        />
      )}
      {csv && (
        <>
          <Select
            id="import-delimiter"
            labelText={t("import.file.delimiter")}
            value={csv.delimiter}
            onChange={(event) =>
              reload(file, { ...options, delimiter: event.target.value as Options["delimiter"] })
            }
          >
            {delimiters.map((delimiter) => (
              <SelectItem
                key={delimiter}
                value={delimiter}
                text={t(`import.file.delimiters.${delimiterKeys[delimiter]}`)}
              />
            ))}
          </Select>
          <Select
            id="import-encoding"
            labelText={t("import.file.encoding")}
            helperText={t("import.file.encodingHint")}
            value={csv.encoding}
            onChange={(event) =>
              reload(file, { ...options, encoding: event.target.value as Options["encoding"] })
            }
          >
            {encodings.map((encoding) => (
              <SelectItem
                key={encoding}
                value={encoding}
                text={t(`import.file.encodings.${encoding}`)}
              />
            ))}
          </Select>
        </>
      )}

      {reviewed && preview.report ? (
        <Report
          preview={preview}
          decisions={decisions}
          onDecisions={setDecisions}
          pending={confirm.isPending}
          label={label}
          message={message}
          onBack={() => setReviewed(false)}
          onConfirm={() => confirm.mutate({ file, token: preview.previewToken! })}
        />
      ) : (
        <>
          <h3>{t("import.mapping.title")}</h3>
          <p>{t("import.mapping.confirmHint")}</p>
          <SimpleTable
            title={t("import.mapping.title")}
            columns={(["column", "header", "target"] as const).map((key) => ({
              key,
              header: t(`import.mapping.${key}`),
            }))}
            rows={preview.headers.map((header, column) => {
              const target = mapping.find((m) => m.column === column)?.target ?? "";
              const suggestion = preview.suggestedMapping.find((s) => s.column === column);
              const text = header || t("import.mapping.emptyHeader");
              return {
                id: String(column),
                column: String(column + 1),
                header: text,
                target: (
                  <>
                    <Select
                      id={`import-map-${column}`}
                      labelText={t("import.mapping.selectFor", {
                        column: column + 1,
                        header: text,
                      })}
                      hideLabel
                      size="sm"
                      value={target}
                      onChange={(event) => {
                        const chosen = event.target.value as
                          | (typeof ImportTarget.options)[number]
                          | "";
                        setMapping([
                          ...mapping.filter((m) => m.column !== column),
                          ...(chosen ? [{ column, target: chosen }] : []),
                        ]);
                      }}
                    >
                      <SelectItem value="" text={t("import.mapping.none")} />
                      {ImportTarget.options.map((option) => (
                        <SelectItem key={option} value={option} text={label(option)} />
                      ))}
                    </Select>
                    {suggestion && suggestion.target === target && (
                      <span className="tp-hint">
                        {t("import.mapping.suggested", {
                          source: t(`import.mapping.sources.${suggestion.source}`),
                        })}
                      </span>
                    )}
                  </>
                ),
              };
            })}
            emptyState=""
          />
          <Select
            id="import-country"
            labelText={t("import.mapping.country")}
            value={options.country ?? ""}
            onChange={(event) =>
              setOptions({ ...options, country: event.target.value ? "DE" : null })
            }
          >
            <SelectItem value="" text={t("import.mapping.countryNone")} />
            <SelectItem value="DE" text={t("import.mapping.countryGermany")} />
          </Select>
          {project.type === "ta_tg" && (
            <WaveSelect
              projectId={projectId}
              value={options.waveId}
              onChange={(waveId) => setOptions({ ...options, waveId })}
            />
          )}
          {preview.mappingIssues.length > 0 && (
            <div role="alert">
              <h4>{t("import.mapping.issues")}</h4>
              <ul className="tp-list">
                {preview.mappingIssues.map((issue, i) => (
                  <li key={i}>{issueText(issue, label, message)}</li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <Button disabled={run.isPending} onClick={() => check(file, mapping)}>
              {t("import.mapping.check")}
            </Button>
          </div>
        </>
      )}
    </Stack>
  );
}

const issueText = (
  issue: Pick<Issue, "target" | "code">,
  label: (target: string) => string,
  message: (code: string) => string,
) => (issue.target ? `${label(issue.target)}: ${message(issue.code)}` : message(issue.code));

/** The plan the report describes, in the shape `checkImportDecisions` takes (the same rule as the API). */
const planOf = (rows: Row[]): ImportPlan =>
  ({
    rows: rows.map(({ row, outcome, issues }) => ({ row, outcome, issues })),
    counts: { create: 0, update: 0, unchanged: 0, skip: 0, error: 0 },
    missing: 0,
  }) as ImportPlan;

function Report(props: {
  preview: Preview;
  decisions: ImportDecisions;
  onDecisions: (decisions: ImportDecisions) => void;
  pending: boolean;
  label: (target: string) => string;
  message: (code: string) => string;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const { preview, decisions, onDecisions, label, message } = props;
  const { t } = useTranslation();
  const report = preview.report!;
  const { counts, rows } = report;
  const name = (row: Row) =>
    row.personnelNumber
      ? t("import.report.rowWithNumber", { row: row.row, number: row.personnelNumber })
      : t("import.report.rowLabel", { row: row.row });
  /** "Zeile 5 (BSP-0005): …" followed by the parts. */
  const line = (row: Row, parts: string[]) => `${name(row)}: ${parts.join("; ")}`;
  const errors = rows.filter((row) => row.outcome === "error");
  const duplicates = rows.filter((row) => row.issues.some((i) => i.code === "possible_duplicate"));
  const updates = rows.filter((row) => row.outcome === "update");
  const skipped = rows.filter((row) => row.outcome === "skip");
  const warned = rows.filter(
    (row) =>
      row.outcome !== "error" &&
      row.issues.some((i) => i.severity === "warning" && i.code !== "possible_duplicate"),
  );
  const checked = checkImportDecisions(planOf(rows), decisions);
  const needsWarnings =
    !checked.ok && checked.issues.some((i) => i.code === "warnings_unconfirmed");
  const undecided = !checked.ok && checked.issues.some((i) => i.code !== "warnings_unconfirmed");

  return (
    <>
      <h3>{t("import.report.title")}</h3>
      <p>{t("import.report.summary", { ...counts })}</p>

      <h4>{t("import.report.errors")}</h4>
      {errors.length === 0 ? (
        <p>{t("import.report.noErrors")}</p>
      ) : (
        <div role="alert">
          <p>{t("import.report.errorsBlock")}</p>
          <ul className="tp-list">
            {errors.map((row) => (
              <li key={row.row}>
                {line(
                  row,
                  row.issues
                    .filter((i) => i.severity === "error")
                    .map((i) => issueText(i, label, message)),
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {duplicates.length > 0 && (
        <>
          <h4>{t("import.report.duplicates")}</h4>
          {duplicates.map((row) => (
            <RadioButtonGroup
              key={row.row}
              name={`duplicate-${row.row}`}
              legendText={`${name(row)}: ${message("possible_duplicate")}`}
              valueSelected={decisions.possibleDuplicates[String(row.row)]}
              onChange={(value) =>
                onDecisions({
                  ...decisions,
                  possibleDuplicates: {
                    ...decisions.possibleDuplicates,
                    [String(row.row)]: value as "create" | "skip",
                  },
                })
              }
            >
              <RadioButton
                id={`duplicate-${row.row}-skip`}
                value="skip"
                labelText={t("import.report.skip")}
              />
              <RadioButton
                id={`duplicate-${row.row}-create`}
                value="create"
                labelText={t("import.report.create")}
              />
            </RadioButtonGroup>
          ))}
        </>
      )}

      {updates.length > 0 && (
        <>
          <h4>{t("import.report.updates")}</h4>
          <ul className="tp-list">
            {updates.map((row) => (
              <li key={row.row}>
                {line(
                  row,
                  (row.changes ?? []).map((change) =>
                    t("import.report.changeFrom", {
                      field: label(change.target),
                      old: change.old ?? t("import.report.changeEmpty"),
                      new: change.new,
                    }),
                  ),
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {warned.length > 0 && (
        <>
          <h4>{t("import.report.warnings")}</h4>
          <ul className="tp-list">
            {warned.map((row) => (
              <li key={row.row}>
                {line(row, [
                  ...row.issues
                    .filter((i) => i.severity === "warning")
                    .filter((i) => i.code !== "kept_existing" && i.code !== "possible_duplicate")
                    .map((i) => issueText(i, label, message)),
                  ...(row.kept ?? []).map((kept) =>
                    t("import.report.kept", { field: label(kept.target), value: kept.value }),
                  ),
                ])}
              </li>
            ))}
          </ul>
        </>
      )}

      {skipped.length > 0 && (
        <>
          <h4>{t("import.report.skipped")}</h4>
          <ul className="tp-list">
            {skipped.map((row) => (
              <li key={row.row}>
                {line(
                  row,
                  row.issues.map((i) => message(i.code)),
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {(needsWarnings || decisions.confirmWarnings) && (
        <Checkbox
          id="import-confirm-warnings"
          labelText={t("import.report.confirmWarnings")}
          checked={decisions.confirmWarnings}
          onChange={(_, { checked: confirmed }) =>
            onDecisions({ ...decisions, confirmWarnings: confirmed })
          }
        />
      )}
      {undecided && <p>{t("import.report.needDecisions")}</p>}
      <div>
        <Button kind="secondary" onClick={props.onBack}>
          {t("import.report.back")}
        </Button>{" "}
        <Button
          disabled={props.pending || !preview.previewToken || !checked.ok}
          onClick={props.onConfirm}
        >
          {t("import.report.confirm")}
        </Button>
      </div>
    </>
  );
}
