import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/components/ui/Toast";

// One sign-out at a time across the menu item and the sidebar button: a second
// logout() would supersede the first and report a false failure.
let inFlight: Promise<void> | null = null;

/**
 * Signs out once the server has revoked the session, then goes home. A failed
 * revocation leaves the user signed in and says so. Repeated calls while a
 * sign-out runs join it instead of starting another.
 */
export function useSignOut(): { signOut: () => Promise<void>; pending: boolean } {
  const { t } = useTranslation();
  const { logout } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [pending, setPending] = useState(false);

  const signOut = useCallback(() => {
    if (inFlight) return inFlight;
    setPending(true);
    // Deferred a tick so inFlight is set before any of the flow runs.
    const run = Promise.resolve().then(async () => {
      try {
        await logout();
        navigate("/");
      } catch {
        toast(t("auth.logoutFailed"), "error");
      } finally {
        inFlight = null;
        setPending(false);
      }
    });
    inFlight = run;
    return run;
  }, [logout, navigate, toast, t]);

  return { signOut, pending };
}
