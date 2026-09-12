import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { api, ApiError, getToken, renewSession, setToken, setUnauthorizedHandler, type Role, type User } from "@/lib/api";

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  hasRole: (minimum: Role) => boolean;
}

const ROLE_RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(logout);
    return () => setUnauthorizedHandler(null);
  }, [logout]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      const token = getToken();
      if (!token) { if (!stopped) setLoading(false); return; }
      try {
        const me = await api.auth.me();
        if (!stopped && getToken()) { setUser(me); setLoading(false); }
      } catch (error) {
        if (stopped) return;
        if (error instanceof ApiError && error.status === 401) {
          if (getToken() === token || !getToken()) { logout(); setLoading(false); return; }
        }
        // Retry temporary backend/network failures without deleting the saved login.
        timer = setTimeout(() => void load(), 5000);
      }
    };
    void load();
    return () => { stopped = true; clearTimeout(timer); };
  }, [logout]);

  useEffect(() => {
    if (!user) return;
    const keepAlive = () => {
      if (navigator.onLine) void renewSession().catch(() => { /* Retry next tick; 401 is handled centrally. */ });
    };
    const changed = (event: StorageEvent) => {
      if (event.key === "ops_center_token" && !event.newValue) logout();
    };
    const timer = window.setInterval(keepAlive, 60000);
    window.addEventListener("online", keepAlive);
    document.addEventListener("visibilitychange", keepAlive);
    window.addEventListener("storage", changed);
    keepAlive();
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", keepAlive);
      document.removeEventListener("visibilitychange", keepAlive);
      window.removeEventListener("storage", changed);
    };
  }, [user, logout]);

  const login = useCallback(async (username: string, password: string) => {
    const res = await api.auth.login(username, password);
    setToken(res.access_token);
    const me = await api.auth.me();
    setUser(me);
  }, []);

  const hasRole = useCallback(
    (minimum: Role) => !!user && ROLE_RANK[user.role] >= ROLE_RANK[minimum],
    [user],
  );

  const value = useMemo(() => ({ user, loading, login, logout, hasRole }), [user, loading, login, logout, hasRole]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}


// Read-only streaming connections must reconnect using the renewed token.
export function useSessionToken(): string | null {
  const [token, update] = useState(getToken);
  useEffect(() => {
    const changed = () => update(getToken());
    window.addEventListener("ops-session-changed", changed);
    window.addEventListener("storage", changed);
    return () => {
      window.removeEventListener("ops-session-changed", changed);
      window.removeEventListener("storage", changed);
    };
  }, []);
  return token;
}
