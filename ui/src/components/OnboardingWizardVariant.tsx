import { PhiBotSetup } from "./phibot/PhiBotSetup";

/**
 * Phi Bot: the first-run setup replaces the Paperclip onboarding wizard.
 * The original wizard (./OnboardingWizard) stays in the tree, unused.
 */
export function OnboardingWizardVariant() {
  return <PhiBotSetup />;
}
