# SlackDot compatibility prototype

A TypeScript Slack bot integration for one controlling dot, deployed through ChatGPT Sites. Implements three MCP tools and one webhook event. Read plans/compatibility-prototype-results.md before treating any hosted integration as verified.

## Local development

Use Node 22.13+ (the SQLite test harness requires Node 22.13+). Install with the supported Sites installer, or npm run install:ci from a clean lockfile checkout. Run npm run typecheck, npm test, npm run build, then node tests/compatibility/worker-smoke.mjs. The smoke harness uses Miniflare supplied by the locked Wrangler dependency. It runs the built bundle and the actual D1 migration. Tests use synthetic data only.

The built-Worker harness accepts `--scenario=success`, `retry`, `exhaustion`, `permanent`, `rate-limit`, `notice-failure`, `timeout`, or `interrupt`. These fixtures exercise automatic post-acceptance delivery without a manual trigger, hold callback completion until Slack acknowledgment, verify signatures and persisted states, and check duplicate/bot-loop suppression. The timeout scenario takes approximately 15 seconds. Interruption verifies retained state without promising autonomous recovery. All outbound services are synthetic; no real Slack or OpenAI requests are sent by this local harness.

Use npm run dev for local preview. Local authentication helpers are a development convenience, not evidence of hosted identity security. Never expose a direct Worker origin that bypasses Sites dispatch. Local environment files and .dev.vars are ignored; .env.example documents names only.

## Site setup

The Site identity and MCP/D1 declarations are in .openai/hosting.json. Preserve sites() in vite.config.ts and use the installed Sites plugin source/build/version/deploy workflow. Do not deploy directly through Wrangler. The public audience is required for Slack's signed webhook. /health reveals no runtime credentials or Slack data.

1. Import slack-app-manifest.json into a development Slack app. Install it, invite the bot to dedicated public/private test channels and open a one-to-one bot DM. The manifest has the agreed scopes; only message/mention subscriptions are enabled for this prototype.
2. Store SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET as Sites runtime secrets. Set SLACK_TEAM_ID, SLACK_BOT_USER_ID, SLACK_BOT_ID and SLACK_APP_ID from trusted Slack setup. The connection tool calls auth.test and checks the team/user/bot values before any tool or delivery accesses Slack.
3. Sign into /setup as the Site owner and copy that Site-scoped identity into OWNER_USER_ID. Do not use a workspace account ID or the first anonymous request. Run the hosted boundary probe with SLACKDOT_SITE_URL and tests/compatibility/hosted-check.mjs. Prove public caller identity headers are stripped and a real owner request carries the expected identity before setting SITES_IDENTITY_VERIFIED=true. Until then /mcp fails closed. Verify a second signed-in non-owner separately.
4. Generate 32 random bytes encoded as base64 for SUBSCRIPTION_ENCRYPTION_KEY and store it as a runtime secret. Keep the key stable across deployments; changing it without re-encrypting rows invalidates existing callback secrets. Configure DELIVERY_TRIGGER_SECRET with an independent random 32-byte secret.
5. Establish actual OpenAI callback origins from the authenticated integration and verified operator information. Set CALLBACK_ALLOWED_ORIGINS to a comma-separated list of those exact HTTPS origins. No guessed default, wildcard, suffix or arbitrary third-party origin is allowed. The hostname ownership and public DNS are part of this restricted policy's trust boundary. Missing origins block subscription activation. Verification and delivery reject redirects.
6. Redeploy after runtime configuration changes. Configure Slack's Events API URL from the manifest and complete the signed challenge. Connect the native Site-created plugin; do not create a replacement plugin to conceal incompatibilities. Ask the dot to monitor the dedicated conversation and reply only to explicitly designated synthetic test messages.
7. Sites-only deployment is mandatory; external schedulers/services are disallowed. Committed Slack events automatically start delivery through the request's `waitUntil()` context. Normal operation needs no manual trigger. Authenticated POST /internal/deliver is an operator diagnostic and never resets original deadlines or revives terminal jobs. It can also run retention cleanup; no timed cleanup is promised without an invocation.

## Protocol and operating limits

/mcp uses SDK-owned MCP 2026-07-28 HTTP envelopes and headers. The extension methods are events/list, events/subscribe and events/unsubscribe; event arguments require conversation_id and optionally thread_ts. Subscription creation/refresh grants 72 hours by default, capped at 72 hours, and honors shorter requested lifetimes. ChatGPT automatically renews subscriptions before the returned refreshBefore deadline. Existing records keep their granted expiration until renewed. Subscription responses always return cursor:null. Signed callbacks use Standard Webhooks and a stable eventId. There is no replay.

slack_send_message requires request_id. Repeating a completed identical request returns stored identifiers; reuse with different arguments fails. In-flight or uncertain writes return ambiguous_write and are never automatically resent, including if Slack succeeded but D1 result persistence failed. Operator reconciliation is required. Completed write records are retained seven days; do not reuse old IDs. Uncertain records are kept for reconciliation.

slack_get_thread returns Slack-sourced messages, pagination and completeness. It does not fabricate cached context when the installed token cannot read a thread. Public/private/DM behavior requires real testing.

Live public/private/DM cursor continuation is verified for the synthetic fixtures in the results document. Follow `next_cursor` until null; when combining pages, deduplicate by `message_ts` because the parent can recur. A final page's `complete=true` marks the end of pagination. Do not assume `limit` equals the total returned message count or infer ordering from one fixture.

Delivery uses atomic claims and up to three attempts within the original event's 20-second budget, with one- and two-second retry delays. Callback calls are capped at four seconds; Slack authorization/notice calls at two seconds each and the remaining operation budget. Retry-After is honored even when it means no further attempt fits. Multiple subscriptions share the original deadline and use bounded concurrency. The next five seconds are reserved for one best-effort failure notice in the source thread; duplicates share persisted notice state. A successful callback suppresses generic failure feedback, regardless of how long Dot takes to reply. Notice failures/uncertain writes are recorded without blind resend. Revocation, unsubscribe, and expiration stop sending once observed. Interruption can prevent both delivery and feedback; persisted state is not a guarantee of resumed execution. Operational records have a seven-day retention target; ambiguous writes/notices remain for reconciliation.

## Live evidence

Run the matrix in plans/compatibility-prototype-plan.md and record exact deployed commit/version, authorization, real Slack acknowledgment times, callback verification, persistence, native discovery, and thread behavior. Verify automatic hosted delivery without manual triggers, bounded transient retry, terminal failure feedback, and the accepted interruption limits. Earlier manual-trigger/60-second recovery results are historical evidence; local tests alone do not pass the new hosted checks.
