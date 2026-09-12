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


## Portable monitoring and PWA update — 2026-09-13

The current public source was validated separately from production:

- 280 backend/AI/release tests passed with a disposable collaboration database
  and the real Ansible interpreter using mock disk helpers. Worker and security
  suites added 8 and 10 passing tests: **298 Python tests in total**.
- The public test script also passed using fresh, component-specific virtual
  environments. Its default run skips 17 optional collaboration database tests;
  those tests passed separately with `COLLAB_TEST_DATABASE_URL` configured.
- All 41 Alembic revisions applied successfully to an empty PostgreSQL 17 database.
  Rollback-only traffic integration tests verified source isolation, history
  filters, cursor/event atomicity, retention/caps, cross-connection locks and a
  mocked Talk outbox, including disabled-source suppression and immediate auth
  notification eligibility. No real Talk messages were sent by validation.
- 65 distinct Playwright cases were checked across desktop, mobile/tablet Chrome
  and iPad WebKit. One Settings-label failure was corrected and the affected
  three-case suite passed again on both engines. Coverage includes configured
  sources, standalone/browser routes, iOS installation help, offline state,
  explicit update activation, API cache exclusion, WebSocket/SSE, token renewal,
  and authentication banners which scroll out in both page and wallboard views.
- TypeScript/Vite production build passed. ESLint reported zero errors and seven
  existing Ops Floor/chat/log hook/directive warnings. The existing large-bundle
  performance warning remains. npm audit reported **zero known vulnerabilities**
  after compatible updates to React Router, Drei, Vite, PostCSS and ESLint.
- API, Ansible worker, AI worker, security worker and frontend images built with
  isolated validation tags. API and AI-worker import checks passed with synthetic
  environment settings and networking disabled. The final frontend container
  returned HTTP 200 for direct wallboard routes, the manifest and service worker;
  manifest MIME type and no-cache entry-point headers were verified.
- All 35 application playbooks and the installer passed Ansible syntax checks;
  Compose validation passed with synthetic configuration. Public HA-generation
  tests passed and existing public HA/installer logic was retained.
- Release policy, staged Gitleaks and source-deployment-marker checks passed.
  A value-only comparison against seven private environment secrets found no
  public-source matches; no secret values were printed. PWA PNGs were visually
  reviewed and pinned by exact path and SHA-256 in the release policy.

These checks did not deploy this revision to production, expand a real disk,
install on a physical iPad, or perform a full clean-VM installation. Use the
existing installer/HA runbooks to validate your own host, firewall, TLS, storage
and external integrations. This is not a comprehensive security audit.

### Reproduce

```bash
bash scripts/test/run-tests.sh
cd frontend
npm ci
npm run lint
npm run build
npx playwright install --with-deps chromium webkit
npm test
npm audit
```

For the database checks, create disposable databases and set
`TEST_TRAFFIC_DATABASE_URL` for `backend/tests/verify_traffic_postgres.py` and
`COLLAB_TEST_DATABASE_URL` for `worker_ai/tests/test_collaboration.py`. The latter
refuses any database whose name is not `ops_collaboration_test`; it drops/recreates
its test tables. Set `OPS_TEST_ANSIBLE_PLAYBOOK` when the Ansible interpreter is
not on PATH. Public CI runs these tests with synthetic service credentials.

Before publishing, stage only reviewed sources, run `python scripts/check-release.py`
and `gitleaks git --staged --redact`, then commit. `python scripts/package.py
/tmp/ops-center-source.tar.gz` packages indexed source files without Git history,
local settings, credentials, installed dependencies or runtime/test artifacts.
