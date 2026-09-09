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

Optional integrations were not exercised against real external accounts or equipment. No source code or image has been published as part of this validation. This is release preparation, not a comprehensive security audit.
