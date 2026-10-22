import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { ApiProblemError } from "@transfer/api-client";
import type { DocumentList, PortalSensitiveValues } from "@transfer/domain";
import { createI18n } from "@transfer/ui";
import { useState } from "react";
import { I18nextProvider } from "react-i18next";
import { vi } from "vitest";
import { SELF_SERVICE_NAMESPACE, selfServiceResources } from "../i18n";
import type { WizardState } from "../model";
import type { DocumentSource } from "../documents";
import type { SelfServiceSource, StepUpSource } from "../source";
import { SelfServiceWizard } from "../wizard";

// The wizard over a fake source, for the component tests (synthetic data only).

/** A participant's empty document list with the three own types addable. */
export const emptyDocuments = (): DocumentList => ({
  documents: [],
  addableTypes: ["cv", "participant_upload", "qualification_certificate"],
  limits: { maxBytes: 10 * 1024 * 1024, maxLiveDocuments: 50, maxUploadsPerHour: 20 },
});

/** A fake document source over a list the test changes. */
export function fakeDocuments(list: DocumentList = emptyDocuments()) {
  return {
    queryKey: ["documents"],
    list: vi.fn<DocumentSource["list"]>(async () => list),
    upload: vi.fn<DocumentSource["upload"]>(async () => {
      throw new Error("not wired");
    }),
    open: vi.fn<DocumentSource["open"]>(async () => ({
      url: "/api/v1/document-content/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      expiresAt: "2026-10-22T10:01:00.000Z",
    })),
    remove: vi.fn<NonNullable<DocumentSource["remove"]>>(async () => {}),
  } satisfies DocumentSource;
}

/** The i18n instance of the tests: the wizard's namespace, German first. */
export const testI18n = () =>
  createI18n(
    {
      de: { [SELF_SERVICE_NAMESPACE]: selfServiceResources.de },
      en: { [SELF_SERVICE_NAMESPACE]: selfServiceResources.en },
    },
    "de",
    ["de", "en"],
  );

export const refused = (status: number, code: string, pointer = "") =>
  new ApiProblemError({
    type: "urn:transfer:problem:x",
    title: "x",
    status,
    errors: [{ code, pointer, detail: "x" }],
  });

export function renderWizard(
  states: WizardState[],
  options: {
    step?: string;
    load?: SelfServiceSource["load"];
    save?: SelfServiceSource["save"];
    /** The groups' stored values (synthetic). */
    sensitive?: Partial<Record<"ba_details" | "health", PortalSensitiveValues["values"]>>;
    loadSensitive?: SelfServiceSource["loadSensitive"];
    saveSensitive?: SelfServiceSource["saveSensitive"];
    stepUp?: Partial<StepUpSource>;
    /** A source without a step-up, as staff in assisted mode have. */
    noStepUp?: boolean;
    documents?: DocumentSource;
  } = {},
) {
  let loads = 0;
  const steps: string[] = [];
  const source = {
    queryKey: ["self-service"],
    load: vi.fn<SelfServiceSource["load"]>(
      options.load ?? (async () => states[Math.min(loads++, states.length - 1)]!),
    ),
    acknowledge: vi.fn<SelfServiceSource["acknowledge"]>(async () => {}),
    save: vi.fn<SelfServiceSource["save"]>(
      options.save ??
        (async (_page, input) => ({
          ...states.at(-1)!,
          revision: input.revision + 1,
          warnings: [],
        })),
    ),
    loadSensitive: vi.fn<SelfServiceSource["loadSensitive"]>(
      options.loadSensitive ??
        (async (group) => ({ group, values: options.sensitive?.[group] ?? {} })),
    ),
    saveSensitive: vi.fn<SelfServiceSource["saveSensitive"]>(
      options.saveSensitive ??
        (async (_group, input) => ({
          ...states.at(-1)!,
          revision: input.revision + 1,
          warnings: [],
        })),
    ),
    stepUp: {
      birthDate: vi.fn<StepUpSource["birthDate"]>(
        options.stepUp?.birthDate ?? (async () => ({ method: "birth_date", done: true })),
      ),
      channels: vi.fn<StepUpSource["channels"]>(
        options.stepUp?.channels ??
          (async () => [
            {
              id: "00000000-0000-4000-8000-0000000000c1",
              kind: "email",
              maskedAddress: "e***@example.org",
            },
          ]),
      ),
      requestCode: vi.fn<StepUpSource["requestCode"]>(
        options.stepUp?.requestCode ?? (async () => {}),
      ),
      verifyCode: vi.fn<StepUpSource["verifyCode"]>(
        options.stepUp?.verifyCode ?? (async () => ({ method: "photo_id_and_code", done: true })),
      ),
    },
    documents: options.documents ?? fakeDocuments(),
  } satisfies SelfServiceSource;
  const i18n = testI18n();
  const { stepUp: _, ...withoutStepUp } = source;
  function Harness() {
    const [step, setStep] = useState(options.step);
    return (
      <SelfServiceWizard
        source={options.noStepUp ? withoutStepUp : source}
        step={step}
        onStep={(next) => {
          steps.push(next);
          setStep(next);
        }}
        expired={<p>{"Sitzung abgelaufen"}</p>}
      />
    );
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <Harness />
      </QueryClientProvider>
    </I18nextProvider>,
  );
  return { source, steps, i18n };
}
