# Public distribution rules

This repository is the public distribution of Ops Center, intended for other
people to install from GitHub.

- Maintain functional parity with the maintained private Ops Center application.
  Port applicable features and fixes, including HA/cluster functionality, while
  preserving the public distribution's configurable installation defaults.
- Functional parity never means copying a deployment. Never publish real users,
  passwords, API keys, tokens, private keys, session data, databases, backups,
  agent/provider records, private inventories, or deployment-specific settings.
- Do not copy internal hostnames, addresses, domains, personal identifiers,
  screenshots, logs, or operational documentation from the source environment.
  Use configuration variables and synthetic documentation examples instead.
- Generate fresh installation secrets locally and keep runtime configuration
  outside the source tree. Never bake secrets into images or release archives.
- Review private-source changes selectively. Do not merge private Git history or
  overwrite public configuration with files from a running deployment.
- Before publishing, review the complete staged diff and release file set, run
  the release-policy check and secret scanning, and check for source-environment
  identifiers. Review images and external attachments separately; text scanners
  cannot establish that screenshots are safe.
- Preserve existing public installer and security improvements when porting
  features. Test the affected functionality and document deployment requirements
  or remaining differences honestly; do not claim full parity without checking.
- Use a GitHub noreply email for public commits. Previously published sensitive
  material needs separate remediation; removing it from the current tree does
  not erase history, external attachments, or caches. Do not rewrite shared
  history or force-push without explicit authorization.

Apply these rules to every future change and public release.
