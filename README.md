# SlackDot

A lightweight Slack bridge for one controlling dot, deployed entirely on ChatGPT Sites. The runtime implements 14 MCP tools and five native event types. The [implementation plan](plans/implementation-plan.md) tracks deployment and acceptance evidence.

## Local development

Use Node 22.13+. Install with the supported Sites installer, or `npm run install:ci` from a clean lockfile checkout. Run `npm test`, `npm run typecheck` and the Sites build helper. After building, run `node tests/compatibility/worker-smoke.mjs --scenario=success` and `node tests/compatibility/catalog-smoke.mjs`. The catalog smoke exercises all 14 tools and five event types through the built SDK/Worker.

Worker scenarios are `success`, `retry`, `exhaustion`, `permanent`, `rate-limit`, `notice-failure`, `timeout`, `interrupt`, `fanout` and `duplicate`. They run the built Worker with synthetic Slack/callback services and the actual database migrations. The final database has only subscriptions; no delivery result is read from a diagnostic table. The interruption check confirms subscriptions survive while no event resumes. The duplicate check confirms separate Slack requests can deliver the same stable event ID again.

Use `npm run dev` for local preview. Local authentication is not proof of hosted identity security. Never expose a direct Worker origin that bypasses Sites dispatch. Local environment files are ignored; `.env.example` contains names only.

## Site setup

Preserve the project ID, MCP capability and D1 binding in `.openai/hosting.json`, and the `sites()` build integration. Use the Sites source/build/version/deploy workflow. The public audience lets Slack reach its signed webhook; `/health` reveals no credentials or Slack data.

1. Import `slack-app-manifest.json` into a Slack app, install it, invite the bot to the intended public/private channels, and open a one-to-one bot DM. `assistant:write` is deliberately retained; Agent UI features are out of scope. Enable bot events `message.channels`, `message.groups`, `message.im`, `reaction_added`, and `reaction_removed`. The redundant `app_mention` event is unnecessary. Reaction events require the existing `reactions:read` scope. Group DMs and automatic joining are unsupported.
2. Set `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` as Sites runtime secrets. Set `SLACK_TEAM_ID`, `SLACK_BOT_USER_ID`, `SLACK_BOT_ID` and `SLACK_APP_ID` from trusted Slack configuration. SlackDot checks the token's team/user/bot identity before accessing Slack.
3. Sign into `/setup` as the Site owner and use the displayed Site identity for `OWNER_USER_ID`. Prove the hosted identity boundary before setting `SITES_IDENTITY_VERIFIED=true`: anonymous/forged requests must fail, and an authenticated owner call must succeed. `tests/compatibility/hosted-check.mjs` runs the public probes using `SLACKDOT_SITE_URL`. A signed-in non-owner cannot access configuration or Slack state. `/setup` has no configuration editor.
4. Generate 32 random bytes encoded as base64 for `SUBSCRIPTION_ENCRYPTION_KEY` and store it as a secret. Keep it stable across deployments; changing it without re-encrypting subscriptions invalidates their callback secrets.
5. Set `CALLBACK_ALLOWED_ORIGINS` to the exact verified HTTPS origins used by the native integration. The currently verified OpenAI origin is `https://connectors.api.openai.com`. No wildcard, suffix match or arbitrary destination is accepted; callback verification and delivery reject redirects.
6. Deploy after changing runtime settings. Configure Slack's Events API URL as the Site origin plus `/slack/events`, and complete the signed challenge. Connect the existing Site-native plugin. Instruct Dot to subscribe to the desired conversations and explicitly specify when/how it should respond; installation alone does not make it answer messages.

## Operation and privacy

D1 stores current subscriptions and their encrypted callback credentials only. Unsubscribe and observed revocation delete a row. Ordinary subscription/event activity deletes up to 100 expired/inactive rows; expiry is enforced on every delivery even when physical cleanup has not run. There is no operational payload, receipt, delivery, notice or write-result storage, global message cache, replay, outbox, scheduler or manual delivery endpoint. Slack/API data is processed in invocation memory and is not logged by application code. Platform-managed logs/backups have their own lifecycle; a table drop is not a claim of secure erasure from those systems.

The MCP server uses SDK-owned MCP 2026-07-28 HTTP envelopes. Native `events/subscribe` grants 72 hours by default and at most 72 hours, honoring shorter requests. ChatGPT renews automatically before `refreshBefore`; existing subscriptions retain their granted expiry until renewal. Responses return `cursor:null`. Callbacks use Standard Webhooks and stable event IDs. Verified signing-key rotation keeps the prior encrypted key within the active subscription for at most 60 seconds and sends both signatures during that overlap. Same-key renewal does not extend the overlap; normal activity clears expired prior keys. There is no replay cursor.

Slack events are validated and normalized in memory, then acknowledged while `waitUntil()` runs delivery. Each invocation permits up to three attempts per matching subscription within a shared 20-second budget, one-/two-second backoff, four-second callback timeouts and at most four concurrent destinations. Retry-After is honored, including stopping when another attempt cannot fit. Up to five additional seconds allow one best-effort notice in a known source thread when no callback succeeded. A callback's acceptance is success; Dot's eventual reply is separate. Bot-authored self activity and redundant `app_mention` notifications are ignored.

Separate Slack retries may cause repeated callbacks or notices. Process interruption may prevent both delivery and feedback, with no saved work to resume. These are accepted deployment/simplicity tradeoffs.

`slack_send_message` makes one mutation attempt. Optional legacy `request_id` is transient and provides no replay/deduplication guarantee; repeated calls may create duplicate messages. Confirmed Slack rejections return an error category. An uncertain result returns `ambiguous_write` without retry. Dot can inspect Slack using normal read tools before deciding what to do next; absence from a partial read does not prove a write failed.

`slack_get_thread` reads Slack directly and reports pagination/completeness. Follow `next_cursor` until null and deduplicate combined pages by `message_ts`; a parent may recur. The installed bot token's permissions determine support. No cached context is substituted for a failed read.

## Tools and events

| Capability | Tools |
| --- | --- |
| Connection and conversations | `slack_get_connection_info`, `slack_list_conversations`, `slack_get_conversation` |
| Users and DMs | `slack_list_users`, `slack_get_user`, `slack_open_dm` |
| Messages | `slack_get_messages`, `slack_get_thread`, `slack_send_message` |
| Bot message changes | `slack_update_message`, `slack_delete_message` |
| Reactions | `slack_get_reactions`, `slack_add_reaction`, `slack_remove_reaction` |

List tools return one bounded page; filtering may leave an empty page with a nonempty cursor. User profiles exclude email. Update/delete confirm bot authorship by reading the exact Slack message, including thread replies. Reaction writes affect only this bot's reaction, report already-present/absent accurately, and are not automatically retried.

Native events are `slack.message.created`, `slack.message.updated`, `slack.message.deleted`, `slack.reaction.added` and `slack.reaction.removed`. Every subscription requires `conversation_id`; optional `thread_ts` selects a thread including its root. Message filters support `sender_user_ids` and `include_bot_messages`; created/updated additionally support `mentions_only`. Reaction filters support `actor_user_ids` and `emoji_name`. Other bots are excluded by default; this bot's own activity is always excluded. A human reaction to this bot's message is eligible.

Edits/deletions with unidentifiable bot status are suppressed even with bot opt-in, because self exclusion cannot otherwise be enforced. Missing author/thread metadata stays null and cannot satisfy corresponding filters. For an edit/reaction that needs a thread filter, delivery may make one bounded live lookup of the exact Slack message; the result exists only for that invocation. Deleted targets are not looked up for feedback. No notice is posted to an unknown or deleted source. Repeated edits/reactions receive occurrence-specific IDs; the same occurrence retains its ID across delivery retries.

## Migration and verification

For the subscriptions-only upgrade, publish the table-independent Worker first, then the forward migration dropping `receipts`, `events`, `deliveries`, `delivery_notices` and `writes`. Sites applies migrations before Worker upload. Preserve subscription rows and encrypted credentials; do not export operational data. After table removal, never redeploy a historical version that depends on those tables.

The [prototype results](plans/compatibility-prototype-results.md) retain historical evidence. The [implementation plan](plans/implementation-plan.md) records current verification and remaining acceptance. Verify live replies directly in Slack; do not restore diagnostic storage for testing.
