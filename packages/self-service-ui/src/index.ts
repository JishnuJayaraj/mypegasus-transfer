// The self-service wizard, shared by the portal and (assisted mode) the staff app. No staff
// code: the portal imports it (ADR-0001, the portal boundary rule).
export { SELF_SERVICE_NAMESPACE, selfServiceResources } from "./i18n";
export {
  currentStep,
  pageDraft,
  pageSubmission,
  progress,
  resumeStep,
  type Issue,
  type Step,
  type WizardState,
} from "./model";
export { failureOf, type Failure, type SelfServiceSource, type WizardWrite } from "./source";
export { SelfServiceWizard, type SelfServiceWizardProps } from "./wizard";
