import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { ApiProblemError } from "@transfer/api-client";
import type { PortalSelfService } from "@transfer/domain";
import { createI18n } from "@transfer/ui";
import { useState } from "react";
import { I18nextProvider } from "react-i18next";
import { vi } from "vitest";
import { SELF_SERVICE_NAMESPACE, selfServiceResources } from "../i18n";
import type { SelfServiceSource } from "../source";
import { SelfServiceWizard } from "../wizard";

// The wizard over a fake source, for the component tests (synthetic data only).

export const refused = (status: number, code: string, pointer = "") =>
  new ApiProblemError({
    type: "urn:transfer:problem:x",
    title: "x",
    status,
    errors: [{ code, pointer, detail: "x" }],
  });

export function renderWizard(
  states: PortalSelfService[],
  options: {
    step?: string;
    load?: SelfServiceSource["load"];
    save?: SelfServiceSource["save"];
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
  } satisfies SelfServiceSource;
  const i18n = createI18n(
    {
      de: { [SELF_SERVICE_NAMESPACE]: selfServiceResources.de },
      en: { [SELF_SERVICE_NAMESPACE]: selfServiceResources.en },
    },
    "de",
    ["de", "en"],
  );
  function Harness() {
    const [step, setStep] = useState(options.step);
    return (
      <SelfServiceWizard
        source={source}
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
