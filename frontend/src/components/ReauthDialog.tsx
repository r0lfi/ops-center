import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, needsReauth } from "@/lib/api";
import { useAuth } from "@/lib/auth";

type Run = <T>(action: () => Promise<T>) => Promise<T>;
const ReauthContext = createContext<Run | null>(null);

/**
 * Sensitive actions (approving a change for production, revoking other
 * users' sessions) need a password confirmed within the last few minutes.
 * withReauth runs the action; when the server asks for it, the password
 * dialog opens and the action runs once more after confirmation.
 */
export function ReauthProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const waiting = useRef<{ resolve: () => void; reject: (e: unknown) => void } | null>(null);

  const ask = useCallback(() => new Promise<void>((resolve, reject) => {
    waiting.current = { resolve, reject };
    setPassword(""); setError(null); setOpen(true);
  }), []);

  const withReauth: Run = useCallback(async action => {
    try { return await action(); } catch (e) {
      if (!needsReauth(e)) throw e;
      await ask();
      return action();
    }
  }, [ask]);

  const cancel = () => {
    if (busy) return;
    setOpen(false);
    waiting.current?.reject(new Error("Confirmation cancelled"));
    waiting.current = null;
  };

  const confirm = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.auth.reauth(password);
      setOpen(false); setPassword("");
      waiting.current?.resolve(); waiting.current = null;
    } catch {
      setError("Password incorrect");
    } finally { setBusy(false); }
  };

  return (
    <ReauthContext.Provider value={withReauth}>
      {children}
      <Dialog open={open} onOpenChange={next => { if (!next) cancel(); }}>
        <DialogContent>
          <form onSubmit={confirm} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Confirm it is you</DialogTitle>
              <DialogDescription>This action needs your password again. It stays confirmed for 5 minutes.</DialogDescription>
            </DialogHeader>
            <input type="text" name="username" autoComplete="username" value={user?.username ?? ""} readOnly hidden />
            <div className="space-y-1.5">
              <Label htmlFor="reauth-password">Password</Label>
              <Input id="reauth-password" type="password" autoComplete="current-password" autoFocus required
                value={password} onChange={e => setPassword(e.target.value)} />
            </div>
            {error && <p role="alert" className="text-sm text-status-critical">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={cancel}>Cancel</Button>
              <Button type="submit" disabled={busy || !password}>{busy ? "Checking…" : "Confirm"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </ReauthContext.Provider>
  );
}

export function useReauth(): Run {
  const run = useContext(ReauthContext);
  if (!run) throw new Error("useReauth must be used within ReauthProvider");
  return run;
}
