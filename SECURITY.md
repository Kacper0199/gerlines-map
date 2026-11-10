# Security policy

## Supported versions

GerLines has no releases yet. Only the `main` branch is supported; fixes land there.

## Report a vulnerability

Report security problems privately through GitHub private vulnerability reporting: open the **Security** tab of
this repository and choose **Report a vulnerability**. Do not open a public issue, pull request or discussion for a
security problem. There is no e-mail address for security reports.

Include what you found, where (file, endpoint or commit), how to reproduce it and what an attacker could do with it.
If you found a secret such as an API key in the code or the git history, report it the same way and do not use it.

This is a volunteer project. We aim to acknowledge a report within seven days and to agree with you on a date for
disclosure once a fix is ready. There is no bug bounty.

## Scope

In scope: the code in this repository, including the web client, the API, the recorder, the realtime processor, the
live engine, the pipelines, the Compose files and the GitHub Actions workflows.

Out of scope: the data providers and services GerLines reads from (DELFI, Deutsche Bahn, map tile providers
and others); report problems with them to their operators. Findings that need physical access to a
maintainer's machine are also out of scope.

## How the project handles secrets

Keys live only in a local `.env` file that git ignores; `.env.example` lists the names. A pre-commit hook and CI run
secretlint, and CI runs gitleaks over the full history. Outbound requests identify the project with a `User-Agent`
and contact address. Details: [docs/development.md](docs/development.md), section Secret scanning.
