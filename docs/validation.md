# Release validation

Validation performed on 2026-09-09:

- Frontend production build passed (TypeScript and Vite). Vite reported large output chunks, a performance warning rather than a build failure.
- All 99 Python tests passed, including release-policy tests and tests verifying that generated secrets are unique, mode 0600 and preserved on reruns.
- Compose configuration validation passed using temporary synthetic environment values.
- Installer Ansible syntax validation passed.
- All 34 bundled automation playbooks passed Ansible syntax validation.
- All five custom images built successfully using local rootless Podman: API, frontend, Ansible worker, AI worker and security worker, tagged `0.1.0`.
- Gitleaks 8.24.3 found no secrets in the release working tree. Its downloaded archive was checked against the published checksum list.
- Release-file checks passed against both indexed content and the working copy. They reject runtime files, credential files, private inventory, binary payloads and private-network address literals.
- A read-only comparison on the source host checked the packaged source against 25 private values derived from its environment and seven credential files. No matching release file was found; secret values were not returned or logged.

The system-changing Ansible installation has not been run against a fresh AlmaLinux/RHEL VM. Successful image builds and syntax checks do not establish full deployment compatibility, SELinux behavior, recovery correctness or external integration compatibility. Validate a fresh installation on a disposable dedicated server before relying on it for production operations.

Optional integrations were not exercised against real external accounts or equipment. These checks are not a comprehensive security audit.


## HA update — 2026-09-10

- All 112 Python tests passed, including generated-topology consistency, private
  file modes, overwrite rejection, Sentinel parsing, candidate validation, and
  viewer/operator denial before a Patroni administrative request.
- TypeScript/Vite production build passed; the existing large-chunk warning remains.
- All five generated Compose documents (two data/app pairs and a witness) passed
  Compose configuration validation. The HA preparation playbook passed Ansible
  syntax validation.
- The PostgreSQL 17/Patroni image built successfully. An isolated rootless Podman
  test started two database nodes and three etcd/Sentinel voters. It verified
  primary/replica initialization, authenticated PostgreSQL switchover, agreement
  of all three Sentinels after Redis-primary loss, and a PostgreSQL connection
  through the generated HAProxy configuration to a writable primary. The test
  pods were stopped after verification.
- Release-file policy and Gitleaks 8.24.3 scans of the public file set and Git
  history passed. A separate scan found no known source-environment host/domain
  markers or private-network literals in the release files.

The HA runtime test used isolated containers on one development host, not three
independent machines. It does not validate physical host loss, network partitions,
firewall policy, external HTTPS ingress, shared-file synchronization, or the full
Ansible installation on clean servers. Follow the failover checklist in
[the HA guide](ha.md) before deployment.
