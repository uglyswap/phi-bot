import { useState, type FormEvent } from "react";
import { KeyRound, LoaderCircle } from "lucide-react";
import { authApi } from "../../api/auth";
import { useOptionalToastActions } from "../../context/ToastContext";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { describePhiBotPasswordError, phibotText } from "./phibot-text";

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

/**
 * Settings > Profile: change the account password (Better Auth
 * POST /api/auth/change-password). Other sessions are revoked; the current
 * one receives a fresh session cookie.
 */
export function PhiBotChangePasswordCard() {
  const text = phibotText();
  const toast = useOptionalToastActions();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!currentPassword) {
      setError(text.passwordErrors.currentPasswordRequired);
      return;
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH || newPassword.length > MAX_PASSWORD_LENGTH) {
      setError(text.passwordErrors.newPasswordLength);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError(text.passwordErrors.passwordMismatch);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await authApi.changePassword({ currentPassword, newPassword });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      toast?.pushToast({ title: text.passwordChangedToast, tone: "success" });
    } catch (caught) {
      setError(describePhiBotPasswordError(caught, text));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="block space-y-4 p-6" data-testid="phibot-change-password">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">{text.passwordTitle}</h2>
        </div>
        <p className="text-sm text-muted-foreground">{text.passwordLede}</p>
      </div>
      <form className="grid gap-4 md:grid-cols-3" onSubmit={(event) => void handleSubmit(event)}>
        <div className="space-y-2">
          <Label htmlFor="phibot-current-password">{text.currentPasswordLabel}</Label>
          <Input
            id="phibot-current-password"
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            disabled={busy}
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="phibot-new-password">{text.newPasswordLabel}</Label>
          <Input
            id="phibot-new-password"
            name="newPassword"
            type="password"
            autoComplete="new-password"
            maxLength={MAX_PASSWORD_LENGTH}
            disabled={busy}
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="phibot-confirm-password">{text.confirmPasswordLabel}</Label>
          <Input
            id="phibot-confirm-password"
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            maxLength={MAX_PASSWORD_LENGTH}
            disabled={busy}
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
          />
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive md:col-span-3">
            {error}
          </p>
        )}
        <div className="flex justify-end md:col-span-3">
          <Button type="submit" disabled={busy}>
            {busy ? <LoaderCircle className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
            {text.passwordSubmitLabel}
          </Button>
        </div>
      </form>
    </Card>
  );
}
