# SlackDot compatibility prototype

A TypeScript Slack bot integration for one controlling dot, deployed through ChatGPT Sites. Implements three MCP tools and one webhook event. Read plans/compatibility-prototype-results.md before treating any hosted integration as verified.

## Local development

Use Node 22.13+ (the SQLite test harness requires Node 22.13+). Install with the supported Sites installer, or npm run install:ci from a clean lockfile checkout. Run npm run typecheck, npm test, npm run build, then node tests/compatibility/worker-smoke.mjs. The smoke harness uses Miniflare supplied by the locked Wrangler dependency. It runs the built bundle and the actual D1 migration. Tests use synthetic data only.

Run `node tests/compatibility/worker-smoke.mjs --recovery` for the approximately one-minute recovery check. It injects one synthetic callback 503, restarts the Worker against the same local D1 store, rejects an early retry, then verifies delayed delivery with unchanged event bytes/ID and a fresh valid signature. The test harness supplies the retry trigger; this does not demonstrate autonomous hosted scheduling. It sends no real Slack or OpenAI requests.

Use npm run dev for local preview. Local authentication helpers are a development convenience, not evidence of hosted identity security. Never expose a direct Worker origin that bypasses Sites dispatch. Local environment files and .dev.vars are ignored; .env.example documents names only.

## Site setup

The Site identity and MCP/D1 declarations are in .openai/hosting.json. Preserve sites() in vite.config.ts and use the installed Sites plugin source/build/version/deploy workflow. Do not deploy directly through Wrangler. The public audience is required for Slack's signed webhook. /health reveals no runtime credentials or Slack data.

1. Import slack-app-manifest.json into a development Slack app. Install it, invite the bot to dedicated public/private test channels and open a one-to-one bot DM. The manifest has the agreed scopes; only message/mention subscriptions are enabled for this prototype.
2. Store SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET as Sites runtime secrets. Set SLACK_TEAM_ID, SLACK_BOT_USER_ID, SLACK_BOT_ID and SLACK_APP_ID from trusted Slack setup. The connection tool calls auth.test and checks the team/user/bot values before any tool or delivery accesses Slack.
3. Sign into /setup as the Site owner and copy that Site-scoped identity into OWNER_USER_ID. Do not use a workspace account ID or the first anonymous request. Run the hosted boundary probe with SLACKDOT_SITE_URL and tests/compatibility/hosted-check.mjs. Prove public caller identity headers are stripped and a real owner request carries the expected identity before setting SITES_IDENTITY_VERIFIED=true. Until then /mcp fails closed. Verify a second signed-in non-owner separately.
4. Generate 32 random bytes encoded as base64 for SUBSCRIPTION_ENCRYPTION_KEY and store it as a runtime secret. Keep the key stable across deployments; changing it without re-encrypting rows invalidates existing callback secrets. Configure DELIVERY_TRIGGER_SECRET with an independent random 32-byte secret.
5. Establish actual OpenAI callback origins from the authenticated integration and verified operator information. Set CALLBACK_ALLOWED_ORIGINS to a comma-separated list of those exact HTTPS origins. No guessed default, wildcard, suffix or arbitrary third-party origin is allowed. The hostname ownership and public DNS are part of this restricted policy's trust boundary. Missing origins block subscription activation. Verification and delivery reject redirects.
6. Redeploy after runtime configuration changes. Configure Slack's Events API URL from the manifest and complete the signed challenge. Connect the native Site-created plugin; do not create a replacement plugin to conceal incompatibilities. Ask the dot to monitor the dedicated conversation and reply only to explicitly designated synthetic test messages.
7. Reliable delivery needs an autonomous service invoking POST /internal/deliver with Authorization: Bearer followed by DELIVERY_TRIGGER_SECRET. No scheduler is provisioned by this repository. D1 persistence and waitUntil cannot replace that service. See the results document for the concrete proposed scheduler design and its unproven status.

## Protocol and operating limits

/mcp uses SDK-owned MCP 2026-07-28 HTTP envelopes and headers. The extension methods are events/list, events/subscribe and events/unsubscribe; event arguments require conversation_id and optionally thread_ts. Subscription refresh grants 24 hours and always returns cursor:null. Signed callbacks use Standard Webhooks and a stable eventId. There is no replay.

slack_send_message requires request_id. Repeating a completed identical request returns stored identifiers; reuse with different arguments fails. In-flight or uncertain writes return ambiguous_write and are never automatically resent, including if Slack succeeded but D1 result persistence failed. Operator reconciliation is required. Completed write records are retained seven days; do not reuse old IDs. Uncertain records are kept for reconciliation.

slack_get_thread returns Slack-sourced messages, pagination and completeness. It does not fabricate cached context when the installed token cannot read a thread. Public/private/DM behavior requires real testing.

Live public/private/DM cursor continuation is verified for the synthetic fixtures in the results document. Follow `next_cursor` until null; when combining pages, deduplicate by `message_ts` because the parent can recur. A final page's `complete=true` marks the end of pagination. Do not assume `limit` equals the total returned message count or infer ordering from one fixture.

Delivery uses leases, eight attempts, a 24-hour retry horizon, a minimum 60-second initial delay and a one-hour cap. Revocation/access is checked before delivery; expired/unsubscribed records stop sending once observed. An already in-flight HTTP send cannot be recalled. Callback 410/413 and permanent 4xx responses are terminal. Accepted receipt/event/terminal records have a seven-day retention target, maintained by the delivery runner; pending jobs and uncertain writes are preserved. Monitor trigger failure because cleanup also depends on it.

## Live evidence

Run the matrix in plans/compatibility-prototype-plan.md and record exact deployed commit/version, owner and non-owner authorization, real Slack acknowledgment times, callback verification, subscription persistence across deployment, native event discovery, thread behavior in each conversation type, and a retry at least 60 seconds later with no originating request/browser/new Slack traffic. Local tests alone do not pass these gates.
