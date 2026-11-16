import { Link } from "react-router-dom";

import { McpAgentAccess } from "@/components/ai/McpAgentAccess";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/lib/auth";

/** Which Ops Center MCP tools each agent may use right now, and renewal of expired access. */
export default function AIMcpAccess() {
  const { hasRole } = useAuth();
  const admin = hasRole("admin");
  return (
    <div className="space-y-4">
      <PageHeader title="MCP access" description="Which operational MCP tools each agent can use for your tasks, and when that access expires." />
      <Card>
        <CardHeader><CardTitle className="text-base">Agent access</CardTitle></CardHeader>
        <CardContent>
          <McpAgentAccess admin={admin} />
          {!admin && <p className="mt-3 text-xs text-muted-foreground">Only an administrator can grant or renew access.</p>}
        </CardContent>
      </Card>
      {admin && (
        <p className="text-sm text-muted-foreground">
          External MCP clients, per-tool grants, change requests and the audit log are under{" "}
          <Link className="text-primary hover:underline" to="/settings?tab=mcp">Settings → MCP access</Link>.
        </p>
      )}
    </div>
  );
}
