import { useSearchParams } from "react-router-dom";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";

const TEXTAREA_CLASS =
  "flex min-h-[24rem] w-full rounded-md border border-input bg-secondary px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * View/edit the exact playbook files ops-worker runs against real
 * infrastructure with root/sudo. Only existing, already-approved
 * playbooks (ALLOWED_PLAYBOOKS server-side) - no new ones can be added
 * here. Admin-only for saving; every save is audit-logged with the full
 * new content, same as everything else that mutates state in this app.
 * See docs/security.md for why this is a deliberate exception to "no
 * arbitrary code execution."
 */
export function PlaybookEditorSection() {
  const { hasRole } = useAuth();
  const [params] = useSearchParams();
  const requestedSource = params.get("source");
  const [names, setNames] = useState<string[]>([]);
  const [selected, setSelected] = useState("");
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.ansible.list().then((list) => {
      if (!live) return;
      setNames(list);
      setSelected(requestedSource && list.includes(requestedSource) ? requestedSource : list[0] || "");
    }).catch((err) => { if (live) setError(err instanceof Error ? err.message : "failed to load playbooks"); });
    return () => { live = false; };
  }, [requestedSource]);

  useEffect(() => {
    if (!selected) return;
    let live = true;
    setLoading(true);
    setError(null);
    setMessage(null);
    setConfirmText("");
    api.ansible
      .get(selected)
      .then((res) => {
        if (!live) return;
        setContent(res.content);
        setSavedContent(res.content);
      })
      .catch((err) => { if (live) setError(err instanceof Error ? err.message : "failed to load playbook"); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [selected]);

  const dirty = content !== savedContent;
  const confirmed = confirmText === "SAVE";

  async function handleSave() {
    if (!confirmed) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const res = await api.ansible.update(selected, content);
      setSavedContent(res.content);
      setConfirmText("");
      setMessage("Saved - ops-worker picks it up on the next run, no rebuild needed.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to save playbook");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card id="playbook-source">
      <CardHeader>
        <CardTitle>Playbook Source</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          These playbooks run with root/sudo on every managed host. Editing one takes effect for every future
          run against every host - there is no per-run review step.
        </p>
        <Select value={selected} onChange={(e) => setSelected(e.target.value)} className="w-72">
          {names.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </Select>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : (
          <textarea
            className={TEXTAREA_CLASS}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            readOnly={!hasRole("admin")}
            spellCheck={false}
          />
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        {message && <p className="text-sm text-status-ok">{message}</p>}
        {hasRole("admin") && dirty && (
          <div className="flex items-center gap-2">
            <input
              className="flex h-8 w-40 rounded-md border border-input bg-secondary px-2 text-xs"
              placeholder="Type SAVE to confirm"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
            />
            <Button size="sm" variant="destructive" disabled={!confirmed || saving} onClick={handleSave}>
              {saving ? "Saving..." : "Save"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setContent(savedContent);
                setConfirmText("");
              }}
            >
              Revert
            </Button>
          </div>
        )}
        {!hasRole("admin") && <p className="text-xs text-muted-foreground">View-only - editing requires the admin role.</p>}
      </CardContent>
    </Card>
  );
}
