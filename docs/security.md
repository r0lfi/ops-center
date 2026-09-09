# Security and release boundaries

The public source has no deployment `.env`, SSH credentials, runtime database, private inventory or inherited Git history. Provider secrets are created on the target after installation. Tests contain explicitly synthetic credentials; these are never deployment defaults.

The installer generates independent random secrets with Python's `secrets` module, uses URL-safe hexadecimal values for database URLs, creates `.env` exclusively with mode 0600 and never rotates existing credentials implicitly. Administrator input travels through stdin to the container under Ansible `no_log`; it is not included in argv or committed files.

Docker access is powerful. The security worker mounts the Docker socket and can control the host's containers; this effectively grants host-level privileges. Only deploy Ops Center where its administrators are trusted with that access. A read-only socket bind would not make the Docker API read-only. Optional cAdvisor also accesses host files and the Docker socket.

Only the web proxy is published by default, bound to loopback. PostgreSQL, Redis, monitoring services and Loki have no host ports. Use an authenticated HTTPS reverse proxy for shared access. Do not expose an unauthenticated Loki push endpoint or legacy wg-easy/go2rtc endpoints publicly.

Existing SSH automation disables host-key verification in parts of the application and Ansible configuration. Establish trusted management-network access before onboarding hosts; this is not a hardened zero-trust deployment. Optional camera streams use a short-lived token in the request URL, so avoid logging those query strings in external proxies.

SELinux bind mounts use shared `:z` labels on dedicated application files. Do not point data directories at sensitive host directories. The installer does not disable SELinux or reconfigure the firewall.

Release checks complement Gitleaks and human review. Run them against both the working tree and Git history before publication. Backups include secrets and must remain private and encrypted at rest. Never attach them to public issues.

Report suspected vulnerabilities privately to the repository maintainer. Do not include live credentials or exploit details in a public issue.
