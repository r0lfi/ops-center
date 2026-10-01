# Releasing

Releases are cut by pushing a version tag. Everything after that is automated
by [`.github/workflows/release.yml`](../.github/workflows/release.yml), and
nothing is published unless every step before it passed.

```text
tag vX.Y.Z pushed
  -> check tag format, CHANGELOG.md section, tag is on main
  -> validate.yml: release policy, Gitleaks, Python/browser tests, migrations,
     installer syntax, all image builds
  -> build the six images, push them only as sha-<commit>
  -> smoke test: run the whole stack from exactly those images
  -> add the version tags to the tested images (no rebuild)
  -> create the GitHub Release
```

## Cutting a release

1. Make sure `main` is green in **Actions -> Validate source**.
2. In `CHANGELOG.md`, rename `## [Unreleased]` to the new version and date and
   start a new empty `## [Unreleased]` above it:

   ```markdown
   ## [Unreleased]

   ## [0.2.0] - 2026-11-01
   ```

   Write the entries for users: what changed, what they must do when
   upgrading (migrations, new settings), and anything that breaks. This
   section becomes the top of the GitHub Release.
3. Commit that to `main`, then tag the commit and push the tag:

   ```bash
   git tag -a v0.2.0 -m "Ops Center 0.2.0"
   git push origin v0.2.0
   ```

4. Follow the run in **Actions -> Release**. When it finishes, the release is
   on the Releases page and the images are on GHCR.

A failed run publishes nothing under the version: fix the problem on `main`,
delete the tag (`git push --delete origin v0.2.0 && git tag -d v0.2.0`), and
tag again. A tag that was already released should not be moved; release a new
patch version instead.

## Versions

[Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`. While the
major version is 0, a minor release may contain breaking changes, and the
changelog says so.

| Tag | Published image tags | GitHub Release |
| --- | --- | --- |
| `v0.2.0` | `0.2.0`, `v0.2.0`, `0.2`, `0`, `latest`, `sha-<commit>` | Release |
| `v0.3.0-rc.1` | `0.3.0-rc.1`, `v0.3.0-rc.1`, `sha-<commit>` | Prerelease |

`latest`, `X.Y` and `X` move only with stable releases. Commits on `main` and
pull requests build every image but push nothing.

## Images

One image per application component, under the repository's namespace:

| Image | Built from |
| --- | --- |
| `ghcr.io/r0lfi/ops-center/api` | `backend/Dockerfile` |
| `ghcr.io/r0lfi/ops-center/frontend` | `frontend/Dockerfile` |
| `ghcr.io/r0lfi/ops-center/worker` | `worker/Dockerfile` (also runs the scheduler) |
| `ghcr.io/r0lfi/ops-center/ai-worker` | `worker_ai/Dockerfile` |
| `ghcr.io/r0lfi/ops-center/security-worker` | `security/Dockerfile` |
| `ghcr.io/r0lfi/ops-center/postgres-ha` | `ha/postgres/Dockerfile` (HA only) |

Images are `linux/amd64`, carry OCI labels (version, revision, source, license),
a provenance attestation and an SBOM. The API reports its version in
`/api/health`. A local build reports `0.0.0-dev`.

## One-time GitHub settings

The workflow authenticates with the built-in `GITHUB_TOKEN`; no personal
access token or repository secret is needed.

- **Settings -> Actions -> General -> Workflow permissions:** either setting
  works, because each job declares the permissions it needs.
- **Package visibility.** GHCR creates each package as *private* the first time
  it is pushed, even from a public repository. After the first release, make
  each of the six packages public once, so `docker pull` works without logging
  in: **github.com/r0lfi -> Packages -> `ops-center/<component>` -> Package
  settings -> Danger Zone -> Change visibility -> Public.** The setting is kept
  for every later release.
- **Package access.** The packages are linked to this repository through the
  `org.opencontainers.image.source` label. If a later run fails to push with
  `denied`, check **Package settings -> Manage Actions access** lists
  `r0lfi/ops-center` with the **Write** role.

Check anonymous access from a machine that is not logged in to GHCR:

```bash
docker logout ghcr.io
docker pull ghcr.io/r0lfi/ops-center/api:latest
```

## Testing images before tagging

The same smoke test the release runs works on any Docker host with images built
locally (about 4 GB of free memory for the whole stack):

```bash
IMAGE_PREFIX=ops-center IMAGE_TAG=local bash scripts/images.sh build
IMAGE_PREFIX=ops-center IMAGE_TAG=local bash scripts/test/smoke-stack.sh
```

It uses a separate Compose project (`ops-center-smoke`), a loopback port
(`18080`), throwaway credentials and a temporary data directory, and removes all
of it afterwards. On a small host, start only the core services and let their
dependencies follow:

```bash
SMOKE_SERVICES="proxy ops-worker ops-scheduler ops-ai-worker" \
IMAGE_PREFIX=ops-center IMAGE_TAG=local bash scripts/test/smoke-stack.sh
```
