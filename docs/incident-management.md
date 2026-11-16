# IM tasks and Talk notifications

Ops Center collects monitoring and authentication/security alerts into a persistent incident inbox at **IM tasks**. Each IM has a stable number, handling history, current source state, last observation and Talk delivery status.

## Handling an incident

- **New**: first observation of a problem.
- **Approved / acknowledge**: an operator has acknowledged the IM.
- **In progress**: work has started.
- **Completed**: the operator has finished handling it. Add a handling note when useful.

All authenticated users can read the inbox. Operators and administrators can change status; only administrators can change routing and trusted origins. Concurrent edits are rejected using a revision check. IM acknowledgement never approves a repair or gives an agent operational permission. IM endpoints are deliberately excluded from the MCP tool catalog.

The underlying alert remains visible after an IM is completed. The monitor keeps updating the same IM while the condition continues. There are no repeated Talk reminders, completion notices or periodic resource digests. Optional automatic investigations are configured separately.

## What counts as the same problem?

Resource identity uses the alert family and affected resource, without timestamps, values or severity. Disk warning, disk critical and inode pressure for one filesystem share one IM. Shared NFS/CIFS mounts on different clients use the remote device identity. High/critical CPU alerts are also combined.

A completed IM stays closed through repeated observations, severity increases and restarts. A new IM for the same condition requires at least **30 minutes of continuously observed recovery**, followed by another occurrence. Administrators can increase that period. An IM that is still open absorbs a recurrence into the same case.

Missing data, disabled collectors, analysis overflow, source errors and monitoring gaps do not establish recovery. Traffic signals remain active while recent evidence exists; repeated activity on the same source/rule/domain/IP updates the same IM. A different resource or security condition can produce a separate IM.

## Choose what reaches Talk

Under **Settings → IM tasks & Talk notifications**, configure:

- Delivery of new IM notifications.
- Categories and severities.
- Exact rule and resource exclusions (copy the values from IM details).
- Confirmed recovery period.
- Optional progress updates for conversations started in Talk; these default to off.

IM collection continues when Talk notifications are disabled. The deployment Talk transport and active administrator room bindings must also be configured. The existing authentication notification switch is an additional filter for authentication IMs. Changes affect new IMs and unclaimed notices; enabling a filter does not replay muted history.

Conversation replies and operational approval requests remain independent of proactive IM routing.

## Delivery semantics

PostgreSQL stores one delivery record per IM and configured administrator room. An exclusive claim is committed **before** contacting Talk. Other API replicas and restarted processes cannot claim it again. Settings, active administrator bindings and incident completion are checked before claiming.

Talk does not provide a confirmed exactly-once delivery transaction with this database. A send that provably never reached Nextcloud (connection failure, or HTTP 502/503) stays pending and retries every two minutes for six hours from when the incident was created, then becomes **failed**. Any other outcome makes **at most one delivery attempt**: a read timeout, acknowledgement failure or process interruption becomes **unknown** and is not retried automatically. Inspect Talk before taking further action. Completing a task suppresses any still-unclaimed notice.

## Trusted authentication origins

Traffic settings accept explicit IPv4/IPv6 addresses in **Trusted IP addresses**, alongside dynamic DNS and country rules. Defaults contain no trusted addresses.

An explicit IP is trusted for SSH/application/VPN origin classification. This does not grant account access, change firewall rules, bypass authentication, or suppress general attack-pattern detection. Rejected application logins remain evidence even from a trusted origin. Removing an IP takes effect on the next policy read without waiting for the DNS cache.

## Upgrade and recovery

Apply migration **0043** and deploy matching API, frontend and AI-worker code. Preserve environment variables, Talk bindings and traffic configuration. Stop the old API notification producers before activating the new watcher on both HA nodes.

The migration is additive. Keep IM condition/delivery tables in backups: deleting them loses suppression history and delivery claims. Deduplication identities have no automatic expiry. Existing telemetry history is retained; historic authentication events from before IM activation are not replayed.

Rollback should preserve the additive schema and IM records. Restoring the previous Talk watcher reintroduces periodic notifications.

## Verification

The isolated PostgreSQL suite covers repeated disk alerts, HA admission, completion suppression, recovery, source outages, delivery claims, uncertain delivery, routing changes and role/revision checks. Browser tests cover acknowledgement/completion, read-only access, unavailable data, routing settings and trusted IP entry on desktop, mobile and tablet.

The assembled-application regression also checks IM authentication and route availability with MCP enabled and disabled. REST routes must be registered before the optional MCP catch-all mount.


## Automatic incoming investigations

Administrators can enable automatic investigations in IM settings and choose an enabled agent. Enabling records the administrator's immutable owner ID and the server time. Only fresh, firing incidents created after that activation are eligible; existing backlog is preserved without automatic replay. Silences, category/severity choices and exact exclusions also apply. Talk notification delivery and investigation admission have independent switches.

Each incident receives at most one owned AI task, including after failures or cancellation. A durable database link and shared transaction lock prevent duplicate creation on HA nodes. Uncertain broker delivery retries the same task ID after one minute; the worker's atomic claim prevents duplicate execution. The default is two active investigations (configurable from one to four); pending operational approvals occupy a slot as well. Provider calls use the same global weekly money budget as other agents.

The worker rechecks the current owner, active administrator account, configured agent/provider, automation switch and incident state. Revoked configuration, a closed/recovered incident or stale monitoring stops further work. Automatic assignment does not approve a repair. Existing operational permissions and human approval remain mandatory. The agent must not perform disk cleanup or delete data. IM completion remains an operator decision, and source recovery remains independently observed by the monitor.

The incident detail shows generic investigation status to inbox readers; the task link and detailed findings belong to its owner. Memory settings are checked for that owner. Relevant previous IM investigations and actual action statuses are included as bounded historical context, and memory search also finds earlier owned web/Talk troubleshooting. An agent response is labelled unverified; an executed action is not labelled a successful repair. No additional learning model call is made.

Deploy migration 0045 and matching API/AI workers before enabling automatic investigation. Preserve the investigation table and task archive in backups. Do not downgrade while investigation records exist because the links preserve ownership and duplicate suppression.
