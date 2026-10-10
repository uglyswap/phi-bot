import type { PhiBotProvider } from "@paperclipai/adapter-phi-local/ui";
import { ApiError } from "../../api/client";
import { AuthApiError } from "../../api/auth";
import { PhiBotSetupError, type PhiBotErrorCode } from "../../lib/phibot-llm";

export type PhiBotLocale = "fr" | "en";

type PhiBotMessageCode = PhiBotErrorCode | "adminOnly" | "testBlocked" | "generic";

type PhiBotPasswordErrorCode =
  | "currentPasswordRequired"
  | "newPasswordLength"
  | "passwordMismatch"
  | "currentPasswordInvalid";

export interface PhiBotText {
  setupProviderTitle: string;
  setupProviderLede: string;
  setupModelTitle: string;
  setupModelLede: string;
  companyNameLabel: string;
  defaultCompanyName: string;
  providerLabel: string;
  customProviderLabel: string;
  customAnthropicProviderLabel: string;
  providerSummary: (provider: string) => string;
  apiKeyLabel: string;
  apiKeyPlaceholder: string;
  apiKeyKeepPlaceholder: string;
  apiKeyHint: string;
  baseUrlLabel: string;
  baseUrlHint: string;
  baseUrlAnthropicHint: string;
  modelLabel: string;
  modelPlaceholder: string;
  modelsLoading: string;
  modelHint: string;
  companyDefaultModelLabel: string;
  continueLabel: string;
  startLabel: string;
  backLabel: string;
  laterLabel: string;
  workingLabel: string;
  ceoName: string;
  firstTaskTitle: string;
  approvalNote: string;
  settingsTitle: string;
  settingsLede: string;
  statusConfigured: string;
  statusNotConfigured: string;
  keySaved: (version: number, date: string) => string;
  keyMissing: string;
  saveLabel: string;
  savedToast: string;
  testLabel: string;
  testPassed: string;
  testWarn: string;
  testFailed: string;
  providerChangeWarning: string;
  sessionRestartWarning: string;
  adminOnlyNote: string;
  selectCompany: string;
  passwordTitle: string;
  passwordLede: string;
  currentPasswordLabel: string;
  newPasswordLabel: string;
  confirmPasswordLabel: string;
  passwordSubmitLabel: string;
  passwordChangedToast: string;
  errors: Record<PhiBotMessageCode, string>;
  passwordErrors: Record<PhiBotPasswordErrorCode, string>;
}

const FR: PhiBotText = {
  setupProviderTitle: "Connectez votre fournisseur IA",
  setupProviderLede:
    "Phi Bot fonctionne avec votre propre clé API. Elle est chiffrée et enregistrée comme secret de votre entreprise.",
  setupModelTitle: "Choisissez votre modèle par défaut",
  setupModelLede: "Tous vos agents l'utiliseront, sauf si vous leur attribuez un autre modèle.",
  companyNameLabel: "Nom de l'entreprise",
  defaultCompanyName: "Mon entreprise",
  providerLabel: "Fournisseur IA",
  customProviderLabel: "Compatible OpenAI (URL personnalisée)",
  customAnthropicProviderLabel: "Compatible Anthropic (URL personnalisée)",
  providerSummary: (provider) => `Fournisseur : ${provider}`,
  apiKeyLabel: "Clé API",
  apiKeyPlaceholder: "Collez votre clé API",
  apiKeyKeepPlaceholder: "Clé enregistrée : laissez vide pour la conserver",
  apiKeyHint: "Chiffrée et stockée comme secret de l'entreprise. Elle n'est jamais réaffichée.",
  baseUrlLabel: "URL de base de l'API",
  baseUrlHint: "Adresse compatible OpenAI, par exemple https://api.example.com/v1",
  baseUrlAnthropicHint: "Adresse compatible Anthropic (API Messages), par exemple https://api.example.com",
  modelLabel: "Modèle par défaut",
  modelPlaceholder: "Choisissez ou saisissez un identifiant de modèle",
  modelsLoading: "Chargement des modèles...",
  modelHint: "Suggestions fournies par Phi. Vous pouvez aussi saisir l'identifiant exact du modèle.",
  companyDefaultModelLabel: "Modèle par défaut de l'entreprise",
  continueLabel: "Continuer",
  startLabel: "Démarrer",
  backLabel: "Retour",
  laterLabel: "Plus tard",
  workingLabel: "Patientez...",
  ceoName: "CEO",
  firstTaskTitle: "Démarrage de Phi Bot",
  approvalNote: "Approuvé pendant la configuration de Phi Bot.",
  settingsTitle: "Fournisseur IA",
  settingsLede:
    "Le fournisseur, la clé API et le modèle par défaut s'appliquent à tous les agents de l'entreprise, y compris ceux créés plus tard.",
  statusConfigured: "Configuré",
  statusNotConfigured: "Non configuré : vos agents ne peuvent pas travailler.",
  keySaved: (version, date) => `Clé enregistrée (version ${version}, mise à jour le ${date})`,
  keyMissing: "Aucune clé enregistrée",
  saveLabel: "Enregistrer",
  savedToast: "Fournisseur IA enregistré",
  testLabel: "Tester la connexion",
  testPassed: "Connexion réussie",
  testWarn: "Connexion à vérifier",
  testFailed: "Échec de la connexion",
  providerChangeWarning:
    "Changer de fournisseur efface le modèle par défaut. Les agents qui ont leur propre modèle devront être mis à jour.",
  sessionRestartWarning:
    "Changer de fournisseur, de clé ou de modèle redémarre la session de chaque tâche à son prochain run : les agents repartent sans l'historique de leur conversation.",
  adminOnlyNote: "La première configuration est réservée à l'administrateur de l'instance.",
  selectCompany: "Sélectionnez une entreprise.",
  passwordTitle: "Changer le mot de passe",
  passwordLede: "Vos autres sessions ouvertes seront déconnectées.",
  currentPasswordLabel: "Mot de passe actuel",
  newPasswordLabel: "Nouveau mot de passe",
  confirmPasswordLabel: "Confirmer le nouveau mot de passe",
  passwordSubmitLabel: "Changer le mot de passe",
  passwordChangedToast: "Mot de passe changé",
  errors: {
    providerRequired: "Choisissez un fournisseur IA.",
    apiKeyRequired: "Collez votre clé API.",
    apiKeyFormat: "Clé API invalide : sans espace, entre 8 et 16384 caractères.",
    baseUrlRequired: "Indiquez l'URL de base de l'API.",
    baseUrlInvalid: "L'URL doit commencer par https:// ou http://.",
    modelRequired: "Choisissez un modèle par défaut.",
    modelInvalid: "Identifiant de modèle invalide : sans espace, 200 caractères au plus.",
    companyNameRequired: "Indiquez le nom de l'entreprise.",
    environmentMissing: "Environnement d'exécution local introuvable. Redémarrez Phi Bot puis réessayez.",
    secretMissing: "Un secret Phi Bot est introuvable. Enregistrez de nouveau.",
    adminOnly: "Action réservée à l'administrateur de l'instance.",
    testBlocked: "Le test de connexion a échoué. Corrigez les points signalés puis réessayez.",
    generic: "Une erreur est survenue. Réessayez.",
  },
  passwordErrors: {
    currentPasswordRequired: "Saisissez votre mot de passe actuel.",
    newPasswordLength: "Le nouveau mot de passe doit contenir entre 8 et 128 caractères.",
    passwordMismatch: "Les deux nouveaux mots de passe ne sont pas identiques.",
    currentPasswordInvalid: "Mot de passe actuel incorrect.",
  },
};

const EN: PhiBotText = {
  setupProviderTitle: "Connect your AI provider",
  setupProviderLede:
    "Phi Bot runs on your own API key. It is encrypted and stored as a secret of your organization.",
  setupModelTitle: "Choose your default model",
  setupModelLede: "All your agents use it unless you assign them another model.",
  companyNameLabel: "Organization name",
  defaultCompanyName: "My organization",
  providerLabel: "AI provider",
  customProviderLabel: "OpenAI-compatible (custom URL)",
  customAnthropicProviderLabel: "Anthropic-compatible (custom URL)",
  providerSummary: (provider) => `Provider: ${provider}`,
  apiKeyLabel: "API key",
  apiKeyPlaceholder: "Paste your API key",
  apiKeyKeepPlaceholder: "Key saved: leave empty to keep it",
  apiKeyHint: "Encrypted and stored as an organization secret. It is never shown again.",
  baseUrlLabel: "API base URL",
  baseUrlHint: "OpenAI-compatible endpoint, for example https://api.example.com/v1",
  baseUrlAnthropicHint: "Anthropic-compatible endpoint (Messages API), for example https://api.example.com",
  modelLabel: "Default model",
  modelPlaceholder: "Choose or type a model ID",
  modelsLoading: "Loading models...",
  modelHint: "Suggestions come from Phi. You can also type the exact model ID.",
  companyDefaultModelLabel: "Organization default model",
  continueLabel: "Continue",
  startLabel: "Start",
  backLabel: "Back",
  laterLabel: "Later",
  workingLabel: "Please wait...",
  ceoName: "CEO",
  firstTaskTitle: "Phi Bot onboarding",
  approvalNote: "Approved during Phi Bot setup.",
  settingsTitle: "AI provider",
  settingsLede:
    "The provider, API key and default model apply to every agent of the organization, including agents created later.",
  statusConfigured: "Configured",
  statusNotConfigured: "Not configured: your agents cannot work.",
  keySaved: (version, date) => `Key saved (version ${version}, updated ${date})`,
  keyMissing: "No key saved",
  saveLabel: "Save",
  savedToast: "AI provider saved",
  testLabel: "Test the connection",
  testPassed: "Connection succeeded",
  testWarn: "Connection needs attention",
  testFailed: "Connection failed",
  providerChangeWarning:
    "Changing the provider clears the default model. Agents with their own model must be updated.",
  sessionRestartWarning:
    "Changing the provider, key or model restarts the session of every task at its next run: agents start again without their conversation history.",
  adminOnlyNote: "The first setup is reserved to the instance administrator.",
  selectCompany: "Select an organization.",
  passwordTitle: "Change password",
  passwordLede: "Your other open sessions will be signed out.",
  currentPasswordLabel: "Current password",
  newPasswordLabel: "New password",
  confirmPasswordLabel: "Confirm the new password",
  passwordSubmitLabel: "Change password",
  passwordChangedToast: "Password changed",
  errors: {
    providerRequired: "Choose an AI provider.",
    apiKeyRequired: "Paste your API key.",
    apiKeyFormat: "Invalid API key: no spaces, 8 to 16384 characters.",
    baseUrlRequired: "Enter the API base URL.",
    baseUrlInvalid: "The URL must start with https:// or http://.",
    modelRequired: "Choose a default model.",
    modelInvalid: "Invalid model ID: no spaces, at most 200 characters.",
    companyNameRequired: "Enter the organization name.",
    environmentMissing: "Local execution environment not found. Restart Phi Bot and try again.",
    secretMissing: "A Phi Bot secret is missing. Save again.",
    adminOnly: "Only the instance administrator can do this.",
    testBlocked: "The connection test failed. Fix the reported checks and try again.",
    generic: "Something went wrong. Try again.",
  },
  passwordErrors: {
    currentPasswordRequired: "Enter your current password.",
    newPasswordLength: "The new password must be 8 to 128 characters long.",
    passwordMismatch: "The two new passwords do not match.",
    currentPasswordInvalid: "Current password is incorrect.",
  },
};

/** French when the browser prefers French, English otherwise (the rest of the UI is English). */
export function phibotLocale(): PhiBotLocale {
  const language = typeof navigator === "undefined" ? "" : navigator.language;
  return language.toLowerCase().startsWith("fr") ? "fr" : "en";
}

export function phibotText(locale: PhiBotLocale = phibotLocale()): PhiBotText {
  return locale === "fr" ? FR : EN;
}

/** Name shown for a provider: the two custom endpoints are translated, the others are brand names. */
export function phiBotProviderName(provider: PhiBotProvider, text: PhiBotText): string {
  if (provider.id === "custom") return text.customProviderLabel;
  if (provider.id === "custom-anthropic") return text.customAnthropicProviderLabel;
  return provider.label;
}

/** A message for any failure of the Phi Bot screens. */
export function describePhiBotError(error: unknown, text: PhiBotText): string {
  if (error instanceof PhiBotSetupError) return text.errors[error.code];
  if (error instanceof ApiError && error.status === 403) return text.errors.adminOnly;
  if (error instanceof Error && error.message) return error.message;
  return text.errors.generic;
}

/** A message for a failed password change (Better Auth error codes). */
export function describePhiBotPasswordError(error: unknown, text: PhiBotText): string {
  if (error instanceof AuthApiError) {
    if (error.code === "INVALID_PASSWORD") return text.passwordErrors.currentPasswordInvalid;
    if (error.code === "PASSWORD_TOO_SHORT" || error.code === "PASSWORD_TOO_LONG") {
      return text.passwordErrors.newPasswordLength;
    }
  }
  if (error instanceof Error && error.message) return error.message;
  return text.errors.generic;
}
