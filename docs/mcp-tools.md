# Reviewed MCP tool catalog

This is an explicit catalog. New REST routes require review and a catalog update. All writes require a separate human decision. Current role, client policy, grant and token scopes still apply.

| Tool | Role | Scope | REST operation |
| --- | --- | --- | --- |
| `ops_health` | viewer | `ops:health:read` | `GET /api/health` |
| `ops_list_audit_log` | admin | `ops:audit:read` | `GET /api/audit` |
| `ops_list_hosts` | viewer | `ops:hosts:read` | `GET /api/hosts` |
| `ops_create_host` | admin | `ops:hosts:write` | `POST /api/hosts` |
| `ops_get_host` | viewer | `ops:hosts:read` | `GET /api/hosts/{host_id}` |
| `ops_update_host` | admin | `ops:hosts:write` | `PATCH /api/hosts/{host_id}` |
| `ops_delete_host` | admin | `ops:hosts:write` | `DELETE /api/hosts/{host_id}` |
| `ops_verify_host` | operator | `ops:hosts:write` | `POST /api/hosts/{host_id}/verify` |
| `ops_list_host_groups` | viewer | `ops:host_groups:read` | `GET /api/host-groups` |
| `ops_create_host_group` | admin | `ops:host_groups:write` | `POST /api/host-groups` |
| `ops_update_host_group` | admin | `ops:host_groups:write` | `PATCH /api/host-groups/{group_id}` |
| `ops_delete_host_group` | admin | `ops:host_groups:write` | `DELETE /api/host-groups/{group_id}` |
| `ops_add_host_to_group` | admin | `ops:host_groups:write` | `POST /api/host-groups/{group_id}/hosts/{host_id}` |
| `ops_remove_host_from_group` | admin | `ops:host_groups:write` | `DELETE /api/host-groups/{group_id}/hosts/{host_id}` |
| `ops_run_group_now` | operator | `ops:host_groups:write` | `POST /api/host-groups/{group_id}/run-now` |
| `ops_list_playbooks` | viewer | `ops:automation:read` | `GET /api/automation/playbooks` |
| `ops_run_automation` | operator | `ops:automation:write` | `POST /api/automation/run` |
| `ops_list_jobs` | viewer | `ops:jobs:read` | `GET /api/jobs` |
| `ops_get_job` | viewer | `ops:jobs:read` | `GET /api/jobs/{job_id}` |
| `ops_cancel_job` | operator | `ops:jobs:write` | `POST /api/jobs/{job_id}/cancel` |
| `ops_list_alerts` | viewer | `ops:alerts:read` | `GET /api/alerts` |
| `ops_list_services` | viewer | `ops:services:read` | `GET /api/services` |
| `ops_add_service_check` | admin | `ops:services:write` | `POST /api/hosts/{host_id}/services` |
| `ops_remove_service_check` | admin | `ops:services:write` | `DELETE /api/hosts/{host_id}/services/{check_id}` |
| `ops_patch_check` | operator | `ops:patching:write` | `POST /api/hosts/{host_id}/patch-check` |
| `ops_patch_security` | operator | `ops:patching:write` | `POST /api/hosts/{host_id}/patch-security` |
| `ops_patch_all` | operator | `ops:patching:write` | `POST /api/hosts/{host_id}/patch-all` |
| `ops_get_host_patches` | viewer | `ops:patching:read` | `GET /api/hosts/{host_id}/patches` |
| `ops_list_patches` | viewer | `ops:patching:read` | `GET /api/patches` |
| `ops_patch_reports` | viewer | `ops:patching:read` | `GET /api/patching/reports` |
| `ops_patch_report` | viewer | `ops:patching:read` | `GET /api/patching/reports/{job_id}` |
| `ops_patch_security_for_vulnerability` | operator | `ops:security:write` | `POST /api/security/vulnerabilities/{vulnerability_id}/patch-security` |
| `ops_patch_security_for_advisory` | operator | `ops:security:write` | `POST /api/security/advisories/{advisory_id}/patch-security` |
| `ops_list_vulnerabilities` | viewer | `ops:security:read` | `GET /api/security/vulnerabilities` |
| `ops_what_needs_attention` | viewer | `ops:security:read` | `GET /api/security/attention` |
| `ops_list_advisories` | viewer | `ops:security:read` | `GET /api/security/advisories` |
| `ops_security_summary` | viewer | `ops:security:read` | `GET /api/security/summary` |
| `ops_security_root` | viewer | `ops:security:read` | `GET /api/security` |
| `ops_scan_host` | operator | `ops:security:write` | `POST /api/hosts/{host_id}/scan` |
| `ops_list_containers` | viewer | `ops:containers:read` | `GET /api/containers` |
| `ops_start_container` | admin | `ops:containers:write` | `POST /api/containers/{hostname}/{name}/start` |
| `ops_stop_container` | admin | `ops:containers:write` | `POST /api/containers/{hostname}/{name}/stop` |
| `ops_restart_container` | admin | `ops:containers:write` | `POST /api/containers/{hostname}/{name}/restart` |
| `ops_list_stacks` | viewer | `ops:containers:read` | `GET /api/docker-hosts/{hostname}/stacks` |
| `ops_adopt_preview` | viewer | `ops:containers:read` | `GET /api/docker-hosts/{hostname}/stacks/{name}/adopt-preview` |
| `ops_get_stack` | admin | `ops:containers:read` | `GET /api/docker-hosts/{hostname}/stacks/{name}` |
| `ops_get_stack_containers` | viewer | `ops:containers:read` | `GET /api/docker-hosts/{hostname}/stacks/{name}/containers` |
| `ops_deploy_stack` | admin | `ops:containers:write` | `POST /api/docker-hosts/{hostname}/stacks` |
| `ops_remove_stack` | admin | `ops:containers:write` | `DELETE /api/docker-hosts/{hostname}/stacks/{name}` |
| `ops_run_stack_action` | admin | `ops:containers:write` | `POST /api/docker-hosts/{hostname}/stacks/{name}/{action}` |
| `ops_list_docker_hosts` | viewer | `ops:containers:read` | `GET /api/docker-hosts` |
| `ops_get_docker_host` | viewer | `ops:containers:read` | `GET /api/docker-hosts/{hostname}` |
| `ops_list_docker_images` | viewer | `ops:containers:read` | `GET /api/docker-hosts/{hostname}/images` |
| `ops_list_docker_networks` | viewer | `ops:containers:read` | `GET /api/docker-hosts/{hostname}/networks` |
| `ops_list_docker_volumes` | viewer | `ops:containers:read` | `GET /api/docker-hosts/{hostname}/volumes` |
| `ops_list_docker_events` | viewer | `ops:containers:read` | `GET /api/docker-hosts/{hostname}/events` |
| `ops_inspect_container_route` | viewer | `ops:containers:read` | `GET /api/containers/{hostname}/{name}/inspect` |
| `ops_container_logs_route` | viewer | `ops:containers:read` | `GET /api/containers/{hostname}/{name}/logs` |
| `ops_container_stats_route` | viewer | `ops:containers:read` | `GET /api/containers/{hostname}/{name}/stats` |
| `ops_bulk_container_action` | admin | `ops:containers:write` | `POST /api/containers/{hostname}/bulk-action` |
| `ops_image_update_status` | viewer | `ops:containers:read` | `GET /api/images/update-status` |
| `ops_pull_image_route` | admin | `ops:containers:write` | `POST /api/docker-hosts/{hostname}/images/pull` |
| `ops_recreate_container_route` | admin | `ops:containers:write` | `POST /api/containers/{hostname}/{name}/recreate` |
| `ops_container_vulnerabilities` | viewer | `ops:containers:read` | `GET /api/containers/{hostname}/{name}/vulnerabilities` |
| `ops_get_cluster_status` | viewer | `ops:cluster:read` | `GET /api/cluster/status` |
| `ops_trigger_switchover` | admin | `ops:cluster:write` | `POST /api/cluster/postgres/switchover` |
| `ops_get_cameras_status` | viewer | `ops:cameras:read` | `GET /api/cameras/status` |
| `ops_list_peers` | viewer | `ops:vpn:read` | `GET /api/vpn/peers` |
| `ops_create_peer` | operator | `ops:vpn:write` | `POST /api/vpn/peers` |
| `ops_delete_peer` | operator | `ops:vpn:write` | `DELETE /api/vpn/peers/{peer_id}` |
| `ops_get_app_catalog_settings` | viewer | `ops:app_catalog:read` | `GET /api/app-catalog/settings` |
| `ops_update_app_catalog_settings` | admin | `ops:app_catalog:write` | `PUT /api/app-catalog/settings` |
| `ops_list_app_templates` | viewer | `ops:app_catalog:read` | `GET /api/app-catalog/templates` |
| `ops_render_app_template` | operator | `ops:app_catalog:write` | `POST /api/app-catalog/templates/{template_id}/render` |
| `ops_query_logs` | viewer | `ops:logs:read` | `GET /api/logs` |
| `ops_host_metrics` | viewer | `ops:metrics:read` | `GET /api/metrics/hosts` |
| `ops_service_status` | viewer | `ops:metrics:read` | `GET /api/metrics/services` |
| `ops_list_playbooks_6284d7` | viewer | `ops:ansible:read` | `GET /api/ansible/playbooks` |
| `ops_get_playbook` | viewer | `ops:ansible:read` | `GET /api/ansible/playbooks/{name}` |
| `ops_update_playbook` | admin | `ops:ansible:write` | `PUT /api/ansible/playbooks/{name}` |
| `ops_live_traffic` | viewer | `ops:traffic:read` | `GET /api/traffic/live` |
| `ops_traffic_history` | viewer | `ops:traffic:read` | `GET /api/traffic/history` |
| `ops_traffic_security` | viewer | `ops:traffic:read` | `GET /api/traffic/security` |
| `ops_review_traffic_security` | admin | `ops:traffic:write` | `POST /api/traffic/security/{alert_id}/review` |
| `ops_traffic_authentication_banner` | viewer | `ops:traffic:read` | `GET /api/traffic/security/banner` |
| `ops_settings` | viewer | `ops:ai_collaboration:read` | `GET /api/ai/collaboration/settings` |
| `ops_update_settings` | admin | `ops:ai_collaboration:write` | `PUT /api/ai/collaboration/settings` |
| `ops_boards` | viewer | `ops:ai_collaboration:read` | `GET /api/ai/collaboration/boards` |
| `ops_detail` | viewer | `ops:ai_collaboration:read` | `GET /api/ai/collaboration/boards/{task_id}` |
| `ops_stop` | operator | `ops:ai_collaboration:write` | `POST /api/ai/collaboration/boards/{task_id}/stop` |
| `ops_start` | operator | `ops:ai_collaboration:write` | `POST /api/ai/collaboration/boards` |
| `ops_list_memory` | viewer | `ops:ai_memory:read` | `GET /api/ai/memory` |
| `ops_set_preference` | operator | `ops:ai_memory:write` | `PUT /api/ai/memory/preferences` |
| `ops_save_memory` | operator | `ops:ai_memory:write` | `PUT /api/ai/memory` |
| `ops_delete_memory` | operator | `ops:ai_memory:write` | `DELETE /api/ai/memory/{memory_id}` |
| `ops_history` | viewer | `ops:ai_memory:read` | `GET /api/ai/history` |
| `ops_list_providers` | viewer | `ops:ai:read` | `GET /api/ai/providers` |
| `ops_create_provider` | admin | `ops:ai:write` | `POST /api/ai/providers` |
| `ops_update_provider` | admin | `ops:ai:write` | `PATCH /api/ai/providers/{provider_id}` |
| `ops_list_agents` | viewer | `ops:ai:read` | `GET /api/ai/agents` |
| `ops_create_agent` | admin | `ops:ai:write` | `POST /api/ai/agents` |
| `ops_get_agent` | viewer | `ops:ai:read` | `GET /api/ai/agents/{agent_id}` |
| `ops_update_agent` | admin | `ops:ai:write` | `PATCH /api/ai/agents/{agent_id}` |
| `ops_delete_agent` | admin | `ops:ai:write` | `DELETE /api/ai/agents/{agent_id}` |
| `ops_ask_ops_ai` | operator | `ops:ai:write` | `POST /api/ai/ask` |
| `ops_list_tasks` | viewer | `ops:ai:read` | `GET /api/ai/tasks` |
| `ops_usage_by_day` | viewer | `ops:ai:read` | `GET /api/ai/usage` |
| `ops_cancel_task` | operator | `ops:ai:write` | `POST /api/ai/tasks/{task_id}/cancel` |
| `ops_get_task` | viewer | `ops:ai:read` | `GET /api/ai/tasks/{task_id}` |
| `ops_list_findings` | viewer | `ops:ai:read` | `GET /api/ai/findings` |
| `ops_list_actions` | viewer | `ops:ai:read` | `GET /api/ai/actions` |
| `ops_get_traffic_settings` | admin | `ops:settings:read` | `GET /api/settings/traffic` |
| `ops_put_traffic_settings` | admin | `ops:settings:write` | `PUT /api/settings/traffic` |

## Human-only and transport boundaries

| REST operation | Reason |
| --- | --- |
| `DELETE /api/ai/providers/{provider_id}/key` | Credential material and credential administration remain human-only. |
| `DELETE /api/credentials/{credential_id}` | Credential material and credential administration remain human-only. |
| `DELETE /api/registries/{registry_id}` | Credential material and credential administration remain human-only. |
| `DELETE /api/users/{user_id}` | Identity and account administration use the web UI. |
| `GET /api/ai/agents/stream` | Use bounded status, log or task tools instead of streaming transports. |
| `GET /api/auth/me` | Identity and account administration use the web UI. |
| `GET /api/cameras/{name}/stream.mjpeg` | Use bounded status, log or task tools instead of streaming transports. |
| `GET /api/credentials` | Credential material and credential administration remain human-only. |
| `GET /api/jobs/{job_id}/stream` | Use bounded status, log or task tools instead of streaming transports. |
| `GET /api/registries` | Credential material and credential administration remain human-only. |
| `GET /api/users` | Identity and account administration use the web UI. |
| `GET /api/vpn/peers/{peer_id}/config` | Credential material and credential administration remain human-only. |
| `PATCH /api/users/{user_id}` | Identity and account administration use the web UI. |
| `POST /api/ai/actions/{action_id}/approve` | Approval authority remains human-only. |
| `POST /api/ai/actions/{action_id}/reject` | Approval authority remains human-only. |
| `POST /api/ai/providers/{provider_id}/key` | Credential material and credential administration remain human-only. |
| `POST /api/auth/login` | Identity and account administration use the web UI. |
| `POST /api/auth/refresh` | Identity and account administration use the web UI. |
| `POST /api/credentials` | Credential material and credential administration remain human-only. |
| `POST /api/integrations/talk/webhook` | Signed integration ingress is not an operational tool. |
| `POST /api/registries` | Credential material and credential administration remain human-only. |
| `POST /api/users` | Identity and account administration use the web UI. |

MCP administration, consent, grant issuance and decision routes are also human-only. WebSocket consoles are not MCP tools. Read status/log/task tools instead of media or event streams.
