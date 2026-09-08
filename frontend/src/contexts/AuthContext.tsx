import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import api, { refreshAccessToken, setAccessToken, setAuthFailureHandler } from "@/lib/api";
import { assertSession, changeSession, listenForSessionChanges, sessionGeneration } from "@/lib/session";
import type { TokenResponse, User } from "@/types";

interface RegistrationInput { email: string; password: string; displayName: string; locale: "en" | "it"; termsVersion: string; privacyVersion: string; }
interface AuthState {
  user: User | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (input: RegistrationInput) => Promise<void>;
  verifyEmail: (token: string, newPassword: string) => Promise<void>;
  logout: () => Promise<void>;
  clearSession: () => void;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const activeUserId = useRef<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const clearSession = useCallback(() => {
    setAccessToken(null); setUser(null);
    if (activeUserId.current !== null) queryClient.clear();
    activeUserId.current = null;
  }, [queryClient]);

  const fetchMe = useCallback(async () => {
    const expected = sessionGeneration();
    const { data } = await api.get<User>("/users/me");
    assertSession(expected);
    if (activeUserId.current !== null && activeUserId.current !== data.id) queryClient.clear();
    activeUserId.current = data.id;
    setUser(data);
  }, [queryClient]);

  useEffect(() => {
    const expected = sessionGeneration();
    for (const storage of [localStorage, sessionStorage]) {
      storage.removeItem("access_token");
      storage.removeItem("refresh_token");
    }
    setAuthFailureHandler(clearSession);
    const stopListening = listenForSessionChanges(clearSession);
    void (async () => {
      try {
        await refreshAccessToken();
        assertSession(expected);
        await fetchMe();
      } catch {
        if (sessionGeneration() === expected) clearSession();
      } finally {
        setIsLoading(false);
      }
    })();
    return () => { stopListening(); setAuthFailureHandler(null); };
  }, [fetchMe, clearSession]);

  const login = useCallback(async (email: string, password: string) => {
    let expected = 0;
    await changeSession(() => api.post<TokenResponse>("/auth/login", { email, password }), ({ data }) => {
      setAccessToken(data.access_token);
      expected = sessionGeneration();
    });
    assertSession(expected);
    await fetchMe();
  }, [fetchMe]);

  const register = useCallback(async (input: RegistrationInput) => {
    await api.post("/auth/register", { email: input.email, password: input.password, display_name: input.displayName, locale: input.locale, accept_terms: true, terms_version: input.termsVersion, privacy_version: input.privacyVersion });
  }, []);

  const verifyEmail = useCallback(async (token: string, newPassword: string) => {
    let expected = 0;
    await changeSession(() => api.post<TokenResponse>("/auth/verify-email", { token, new_password: newPassword }), ({ data }) => {
      setAccessToken(data.access_token);
      expected = sessionGeneration();
    });
    assertSession(expected);
    await fetchMe();
  }, [fetchMe]);

  const logout = useCallback(async () => {
    await changeSession(() => api.post("/auth/logout"), clearSession);
  }, [clearSession]);

  return <AuthContext.Provider value={{ user, isLoading, login, register, verifyEmail, logout, clearSession, refreshUser: fetchMe }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
