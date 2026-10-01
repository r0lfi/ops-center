# Changelog

Notable changes to Ops Center. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/). Before 1.0.0, a minor version may
contain breaking changes; they are always listed here.

A release needs its own `## [X.Y.Z] - YYYY-MM-DD` section: the release workflow
uses it as the release notes and refuses a tag without one. See
[docs/releasing.md](docs/releasing.md).

## [Unreleased]

## [0.1.0] - 2026-10-02

First versioned release. Earlier changes were published without version
numbers; see the Git history and
[docs/releases](https://github.com/r0lfi/ops-center/tree/main/docs/releases).

### Added

- Versioned releases. A `vX.Y.Z` tag builds every application image, runs the
  whole stack from those images, publishes them to
  `ghcr.io/r0lfi/ops-center/<component>` and creates the GitHub Release.
- Image tags `X.Y.Z`, `vX.Y.Z`, `X.Y`, `X` and `latest`; prereleases are
  published only as their exact version.
- Images carry OCI labels with version, revision, source and license; the API
  reports the release version in `/api/health`; the API image has a health check.
- `scripts/test/smoke-stack.sh`: starts a disposable stack from built or
  published images and checks health, the web interface, login and persistence.
- Pull requests and branches build every application image without pushing.

### Changed

- Re-running the installer with `ops_build_images=false` now updates
  `IMAGE_PREFIX` and `IMAGE_TAG` in an existing `.env`, so upgrading to a
  published release is the same command as installing it.
- The manual "Build or publish images" workflow is replaced by the release
  workflow; `scripts/images.sh` still builds and pushes images by hand.

[Unreleased]: https://github.com/r0lfi/ops-center/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/r0lfi/ops-center/releases/tag/v0.1.0
