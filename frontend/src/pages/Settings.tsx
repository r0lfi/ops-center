import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { api, type AuditLogEntry, type Credential, type Role, type User } from "@/lib/api";
import { useAuth } from "@/lib/auth";

const ROLES: Role[] = ["viewer", "operator", "admin"];
const CREDENTIAL_TYPES = ["ssh_key", "ssh_password"];

function CreateCredentialDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    name: "",
    description: "",
    credential_type: "ssh_key",
    ssh_user: "",
    secret_filename: "",
    public_key: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.credentials.create({
        name: form.name,
        description: form.description || null,
        credential_type: form.credential_type,
        ssh_user: form.ssh_user || null,
        secret_filename: form.secret_filename,
        public_key: form.public_key || null,
      });
      setOpen(false);
      setForm({ name: "", description: "", credential_type: "ssh_key", ssh_user: "", secret_filename: "", public_key: "" });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to create credential");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>Add credential</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add credential</DialogTitle>
        </DialogHeader>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <p className="text-xs text-muted-foreground">
            The private key/password file must already exist on the host under{" "}
            <code>/data/ops-center/secrets/credentials/</code> - place it there first (e.g. with{" "}
            <code>scripts/credentials/generate-ssh-key.sh</code>), then reference just its filename here. Raw key
            material is never accepted over this form.
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="cred-name">Name</Label>
            <Input id="cred-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cred-desc">Description</Label>
            <Input
              id="cred-desc"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cred-type">Type</Label>
            <Select
              id="cred-type"
              value={form.credential_type}
              onChange={(e) => setForm({ ...form, credential_type: e.target.value })}
            >
              {CREDENTIAL_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cred-user">SSH user</Label>
            <Input id="cred-user" value={form.ssh_user} onChange={(e) => setForm({ ...form, ssh_user: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cred-file">Secret filename (already placed under secrets/credentials/)</Label>
            <Input
              id="cred-file"
              value={form.secret_filename}
              onChange={(e) => setForm({ ...form, secret_filename: e.target.value })}
              required
            />
          </div>
          {form.credential_type === "ssh_key" && (
            <div className="space-y-1.5">
              <Label htmlFor="cred-pubkey">Public key (optional, safe to paste - shown to help add it to the target server)</Label>
              <Input
                id="cred-pubkey"
                value={form.public_key}
                onChange={(e) => setForm({ ...form, public_key: e.target.value })}
                placeholder="ssh-ed25519 AAAA... ops-center:name"
              />
            </div>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Creating..." : "Create credential"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CredentialManagement() {
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.credentials
      .list()
      .then((data) => {
        setCredentials(data);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "failed to load credentials"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(refresh, [refresh]);

  async function removeCredential(c: Credential) {
    if (!confirm(`Delete credential "${c.name}"? Servers using it fall back to no credential.`)) return;
    await api.credentials.remove(c.id);
    refresh();
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle>Credentials</CardTitle>
        <CreateCredentialDialog onCreated={refresh} />
      </CardHeader>
      <CardContent>
        {loading && <p className="text-sm text-muted-foreground">Loading...</p>}
        {error && <p className="text-sm text-destructive">{error}</p>}
        {!loading && !error && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">Name</th>
                  <th className="py-2 pr-4 font-medium">Type</th>
                  <th className="py-2 pr-4 font-medium">SSH user</th>
                  <th className="py-2 pr-4 font-medium">Public key</th>
                  <th className="py-2 pr-4 font-medium" />
                </tr>
              </thead>
              <tbody>
                {credentials.map((c) => (
                  <tr key={c.id} className="border-b border-border/50">
                    <td className="py-2 pr-4 font-medium">{c.name}</td>
                    <td className="py-2 pr-4">{c.credential_type}</td>
                    <td className="py-2 pr-4 text-muted-foreground">{c.ssh_user ?? "-"}</td>
                    <td className="py-2 pr-4 font-mono text-xs">
                      {c.public_key ? (
                        <button
                          className="hover:underline"
                          title="Copy public key"
                          onClick={() => navigator.clipboard.writeText(c.public_key ?? "")}
                        >
                          {c.public_key_fingerprint ?? "copy"}
                        </button>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td className="py-2 pr-4 text-right">
                      <Button size="sm" variant="destructive" onClick={() => removeCredential(c)}>
                        Delete
                      </Button>
                    </td>
                  </tr>
                ))}
                {credentials.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-4 text-center text-muted-foreground">
                      No credentials yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CreateUserDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.users.create({ username, password, role });
      setOpen(false);
      setUsername("");
      setPassword("");
      setRole("viewer");
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to create user");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>Add user</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add user</DialogTitle>
        </DialogHeader>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-1.5">
            <Label htmlFor="new-username">Username</Label>
            <Input id="new-username" value={username} onChange={(e) => setUsername(e.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-password">Password (min 12 characters)</Label>
            <Input
              id="new-password"
              type="password"
              minLength={12}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-role">Role</Label>
            <Select id="new-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Creating..." : "Create user"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const ROLE_BADGE: Record<Role, "critical" | "warning" | "ok"> = {
  admin: "critical",
  operator: "warning",
  viewer: "ok",
};

function UserManagement() {
  const { user: currentUser } = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.users
      .list()
      .then((data) => {
        setUsers(data);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "failed to load users"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(refresh, [refresh]);

  async function toggleActive(u: User) {
    await api.users.update(u.id, { is_active: !u.is_active });
    refresh();
  }

  async function changeRole(u: User, role: Role) {
    await api.users.update(u.id, { role });
    refresh();
  }

  async function removeUser(u: User) {
    if (!confirm(`Delete user "${u.username}"? This cannot be undone.`)) return;
    await api.users.remove(u.id);
    refresh();
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle>Users</CardTitle>
        <CreateUserDialog onCreated={refresh} />
      </CardHeader>
      <CardContent>
        {loading && <p className="text-sm text-muted-foreground">Loading...</p>}
        {error && <p className="text-sm text-destructive">{error}</p>}
        {!loading && !error && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">Username</th>
                  <th className="py-2 pr-4 font-medium">Role</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 pr-4 font-medium">Last login</th>
                  <th className="py-2 pr-4 font-medium" />
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-b border-border/50">
                    <td className="py-2 pr-4 font-medium">{u.username}</td>
                    <td className="py-2 pr-4">
                      <Select
                        className="h-7 w-28 py-0 text-xs"
                        value={u.role}
                        disabled={u.id === currentUser?.id}
                        onChange={(e) => changeRole(u, e.target.value as Role)}
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td className="py-2 pr-4">
                      <Badge variant={u.is_active ? "ok" : "unknown"}>{u.is_active ? "Active" : "Disabled"}</Badge>
                    </td>
                    <td className="py-2 pr-4 text-muted-foreground">
                      {u.last_login_at ? new Date(u.last_login_at).toLocaleString() : "never"}
                    </td>
                    <td className="py-2 pr-4 text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={u.id === currentUser?.id}
                          onClick={() => toggleActive(u)}
                        >
                          {u.is_active ? "Disable" : "Enable"}
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={u.id === currentUser?.id}
                          onClick={() => removeUser(u)}
                        >
                          Delete
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AuditLog() {
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.audit
      .list(200)
      .then((data) => {
        setEntries(data);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "failed to load audit log"))
      .finally(() => setLoading(false));
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Audit Log</CardTitle>
      </CardHeader>
      <CardContent>
        {loading && <p className="text-sm text-muted-foreground">Loading...</p>}
        {error && <p className="text-sm text-destructive">{error}</p>}
        {!loading && !error && (
          <div className="max-h-[32rem] overflow-y-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">Time</th>
                  <th className="py-2 pr-4 font-medium">User</th>
                  <th className="py-2 pr-4 font-medium">Source IP</th>
                  <th className="py-2 pr-4 font-medium">Action</th>
                  <th className="py-2 pr-4 font-medium">Target</th>
                  <th className="py-2 pr-4 font-medium">Result</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id} className="border-b border-border/50 align-top">
                    <td className="whitespace-nowrap py-2 pr-4 text-muted-foreground">
                      {new Date(e.created_at).toLocaleString()}
                    </td>
                    <td className="py-2 pr-4">{e.user ?? "unknown"}</td>
                    <td className="py-2 pr-4 text-muted-foreground">{e.source_ip ?? "-"}</td>
                    <td className="py-2 pr-4">{e.action}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{e.target}</td>
                    <td className="py-2 pr-4">
                      <Badge variant={e.result.startsWith("2") ? "ok" : "critical"}>{e.result}</Badge>
                    </td>
                  </tr>
                ))}
                {entries.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-4 text-center text-muted-foreground">
                      No audit entries yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function Settings() {
  const { user, hasRole } = useAuth();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Settings</h1>
        <div className="text-sm text-muted-foreground">
          Signed in as <span className="font-medium text-foreground">{user?.username}</span>{" "}
          <Badge variant={user ? ROLE_BADGE[user.role] : "unknown"}>{user?.role}</Badge>
        </div>
      </div>

      {hasRole("admin") ? (
        <>
          <UserManagement />
          <CredentialManagement />
          <AuditLog />
        </>
      ) : (
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground">
            User management and the audit log are only visible to administrators.
          </CardContent>
        </Card>
      )}
    </div>
  );
}
