# Agent instructions

## Installation

Read [docs/install.md](docs/install.md) before installing SlackDot. It is the single installation procedure; the README is the human-facing entry point. Use Codex for build/deployment/configuration and the user's Dot in ChatGPT for the native automation. Explicitly read linked files when starting from a web link.

- Follow the guide's order and completion conditions. Installation is not a request to audit, redesign or expand the application. Do not turn a dependency belonging to a later step into a blocker for the current step.
- Use the Sites and Plugin Creator skills for their supported workflows. Reuse this application and its migrations. Do not scaffold a replacement app or add temporary public setup/debug endpoints.
- Derive the Slack workspace and bot identity by calling Slack's `auth.test` directly with the bot token. The guarded `SlackService.identity()`/`slack_get_connection_info` path is for verification after configuration. Do not ask the owner for workspace information that the token supplies.
- The owner manually sets only `SLACK_APP_ID`, `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN` and `SLACK_BOT_USER_ID`. Configure the remaining variables yourself. Keep Site owner identity, Slack bot identity and the human Slack member identity distinct.
- Never print secrets, place them in source or chat, or treat a masked secret value as a usable credential. Follow the guide's secure-access branch if a tool cannot read a stored token.
- During initial deployment, leave MCP publication disabled. Enable it only after owner authorization and Slack configuration work. Do not bypass authorization to make discovery succeed.
- Preserve returned Site/version/deployment/plugin IDs and resume the existing installation. Reconcile uncertain creation before retrying. Do not create duplicate Sites, plugins or subscriptions.
- A native automation must run in the intended Dot's ChatGPT context. Do not substitute a Codex scheduled task, a polling job or a manually sent Slack reply.
- Pause for required human actions or an observed failure that blocks the current step. Report the exact operation and non-secret error, completed steps and next action. Continue independent work where possible. Do not invent successful verification or stop solely because unconfigured endpoints reject requests.

## Scope and repository edits

Keep the application entirely on Sites. Store only necessary subscription data; do not add message retention, delivery ledgers, external schedulers, diagnostics dashboards or configuration GUIs. Retain the existing scopes, including `assistant:write`; agent UI features are outside the current implementation scope.

For documentation requests, edit documentation only and do not start an installation, change a live Site or create subscriptions. Preserve the user's edits. Do not commit or push repository changes unless explicitly asked. A requested Site installation uses the Sites-managed source synchronization required for publishing in its deployment checkout; it does not authorize pushing edits to the upstream SlackDot repository.

Validate documentation links, configuration examples and `git diff --check` for documentation changes. For runtime changes, run relevant tests and type checks; use the supported Sites build before deployment. Do not repeatedly run the full acceptance suite for prose edits or ask for new evidence of already accepted live tests.
