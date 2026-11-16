import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import {
  api, ApiError, broadcastSession, endSession, getToken, onSessionBroadcast, renewSession, setToken,
  setUnauthorizedHandler, type Role, type User,
} from "@/lib/api";

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  login: (username: string, password: string, remember?: boolean) => Promise<void>;
  logout: () => void;
  hasRole: (minimum: Role) => boolean;
}

const ROLE_RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [generation, setGeneration] = useState(0);

  // Session ended elsewhere (401, another tab): forget it locally.
  const dropSession = useCallback(() => {
    setToken(null);
    setUser(null);
  }, []);

  // Explicit sign-out: revoke the server session and the refresh cookie too.
  const logout = useCallback(() => {
    setUser(null);
    void endSession().catch(() => { /* Local state is cleared either way. */ });
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(dropSession);
    return () => setUnauthorizedHandler(null);
  }, [dropSession]);

  useEffect(() => onSessionBroadcast(event => {
    if (event === "logout") dropSession();
    if (event === "login") setGeneration(value => value + 1);
  }), [dropSession]);

  // Resume a session from the refresh cookie on every page load.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        if (!getToken()) await renewSession(true);
        const me = await api.auth.me();
        if (!stopped && getToken()) { setUser(me); setLoading(false); }
      } catch (error) {
        if (stopped) return;
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          dropSession(); setLoading(false); return;
        }
        // Retry temporary backend/network failures; the cookie stays valid meanwhile.
        timer = setTimeout(() => void load(), 5000);
      }
    };
    void load();
    return () => { stopped = true; clearTimeout(timer); };
  }, [dropSession, generation]);

  useEffect(() => {
    if (!user) return;
    const keepAlive = () => {
      if (navigator.onLine) void renewSession().catch(() => { /* Retry next tick; 401 is handled centrally. */ });
    };
    const timer = window.setInterval(keepAlive, 60000);
    window.addEventListener("online", keepAlive);
    document.addEventListener("visibilitychange", keepAlive);
    keepAlive();
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", keepAlive);
      document.removeEventListener("visibilitychange", keepAlive);
    };
  }, [user]);

  const login = useCallback(async (username: string, password: string, remember = false) => {
    const res = await api.auth.login(username, password, remember);
    setToken(res.access_token);
    const me = await api.auth.me();
    setUser(me);
    broadcastSession("login");
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
    return () => window.removeEventListener("ops-session-changed", changed);
  }, []);
  return token;
}
