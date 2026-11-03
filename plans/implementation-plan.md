# SlackDot implementation plan

Status: revised for the user's subscriptions-only and YAGNI requirements; runtime simplification is not yet implemented.
Target: [specification](specification.md)
Historical evidence: [compatibility results](compatibility-prototype-results.md)

## 1. Goal and current gap

Build a lightweight Slack-to-Dot bridge on the existing ChatGPT Site. Keep one workspace, one bot, one controlling dot, the native plugin and the existing authorization/security boundaries. Configure through Sites environment variables and secrets. The only application data in D1 is current subscription information.

Deployed version 10 (`e9f7587`) has a 72-hour subscription default but still stores operational events, receipts, deliveries, notices and write results. The previous prototype proved the integration with that implementation; it did not prove the subscriptions-only replacement. Removing those tables and their writers is the first task, before adding product features. No additional retention or diagnostics system is authorized.

## 2. Implementation sequence

| Step | Result | Verification |
| --- | --- | --- |
| 1. Remove operational persistence | Request-scoped delivery/tools; subscriptions-only D1; minimal setup | Storage-access assertions, forward migration, bounded Worker tests and hosted round trip |
| 2. Add missing read and action tools | Conversation/user discovery, DM/history, bot message edits/deletion, reactions | Relevant contract tests and synthetic native smoke checks |
| 3. Complete event filters and types | Message filters plus edit/delete/reaction events | Normalization/matching tests, old subscription compatibility, native event checks |
| 4. Finish deployment documentation and acceptance | Simple environment-based setup and evidence for the agreed functionality | Privacy/security review and focused full-flow regression |

Keep changes in the same application tree and Site project. Do not create another service, plugin, queue, scheduler, operational database, configuration GUI or diagnostics dashboard.

## 3. Step 1 — Remove operational persistence

### Runtime changes

- Change `lib/slack/receiver.ts` to validate/normalize the event in memory, register delivery through `ctx.waitUntil()` and acknowledge Slack promptly. No receipt/event/outbox insertion.
- Change `lib/events/delivery.ts` to accept the event object and invocation deadline directly. Read active subscriptions, match filters and recheck access/activity/expiry before sending. Keep at most three attempts per subscription in the shared 20-second delivery budget, short backoff and cancellation, then up to five seconds for one best-effort notice. Remove D1 claims, leases, attempt/outcome updates and drain/recovery behavior.
- Keep only invocation-local fanout/results. One successful matching callback suppresses the generic notice for that invocation. Failed/ambiguous notices are not retried or stored. Separate Slack retries may create duplicate deliveries/notices; do not introduce another persistence mechanism to conceal this limit.
- Remove the write ledger from `lib/slack/service.ts`. A mutation makes one Slack call and returns its confirmed result or normalized failure/uncertainty. No automatic retry of ambiguous writes. Keep old `request_id` accepted as an optional transient compatibility input if needed by existing saved instructions; remove stored-result replay claims and the send tool's idempotent annotation.
- Use canonical message events for new-message fanout; ignore redundant `app_mention` notifications and derive mention flags from explicit bot mentions. Keep stable event IDs for recipient duplicate recognition, without claiming persistent duplicate suppression. Do not silently discard every Slack retry header: the original invocation may never have run.
- Remove `/internal/deliver`, `drain()`, the one-shot operator script, `DELIVERY_TRIGGER_SECRET`, and the no-longer-needed deployed-fixture/operator plumbing. No replacement maintenance endpoint or credential.
- Remove application per-event audit logging and ensure request/event content does not reach logs, artifacts or global caches. Keep only minimal content-free error categories where needed.

### Subscription schema and deletion

- Reduce `db/schema.ts` and storage code to necessary subscription fields/indexes. Apply a new forward migration that drops `receipts`, `events`, `deliveries`, `delivery_notices`, and `writes` and their contents. Do not export/archive them. Preserve active subscription identities, filters, expiration and encrypted secrets.
- Make unsubscribe/revocation delete the subscription row, with an idempotent empty response for an already-absent subscription. Remove expired rows during ordinary subscription/event activity using simple bounded deletion; no maintenance table, lease, metrics or recurring task. Expiry is enforced on reads regardless of physical deletion.
- Preserve the 72-hour default/maximum, shorter requested lifetimes and documented automatic ChatGPT renewal. Add no lifetime setting without an actual need. Do not run a separate live renewal experiment.
- Preserve encrypted callback secrets and any protocol-required, bounded active-key rotation overlap within the subscription. Do not retain expired subscription history or tombstones.
- Coordinate code and migration so the deployed handler no longer needs removed tables. Confirm the supported Sites deployment ordering before applying the destructive migration; if separate publication is needed, deploy the code without writers first, then drop tables. Never roll back to a table-dependent version after removal.
- Verify removal through schema/table existence and bounded subscription counts, without copying the rejected data into the conversation or a report. Platform-managed backup/log lifecycle is separate; do not claim secure erasure of those copies without evidence.

### Setup

Keep `/setup` small and owner-authorized: configuration presence, connection identity and minimal current subscription state if useful. No secret values, editing forms, delivery history, metrics or separate diagnostics view. Environment variables/secrets remain the configuration interface. Any unauthenticated identity-bootstrap explanation must reveal no configuration or Slack state.

### Focused acceptance

1. Instrument database access in tests: only subscription queries/mutations occur during webhook handling, retries, failure notices and tool calls. Verify obsolete tables are absent after migration, including seeded historical rows.
2. Test valid/invalid signatures, acknowledgment timing, success, transient retry, permanent failure, long Retry-After, timeouts, fanout and notice failure in the built Worker. Assert bounded execution and no operational storage; remove tests that require retained event/outbox state.
3. Test process interruption honestly: no stored work resumes, subscriptions survive, and no guaranteed failure notice is claimed. Test separate redeliveries as possible repeats with stable IDs, not as an exactly-once success case.
4. Verify subscription refresh, expiry, unsubscribe and access revocation with local tests. Test owner-only setup/MCP access and redacted outputs.
5. Publish the replacement and verify the public/private/DM automatic flow with explicit native instructions and synthetic markers when ready. Read replies directly from Slack; do not recreate a diagnostic database for test evidence. Confirm no self-loop and no extra plugin/subscriptions.

## 4. Step 2 — Complete the tool catalog

Keep `slack_get_connection_info`, `slack_get_thread`, and `slack_send_message`. Add the already-specified functionality:

| Tools | Implementation boundary |
| --- | --- |
| `slack_list_conversations`, `slack_get_conversation` | Joined public/private channels and bot one-to-one DMs; access checks; no auto-joining or group DMs |
| `slack_list_users`, `slack_get_user` | Available profiles and per-page name filtering; no email lookup or profile cache |
| `slack_open_dm` | Open/retrieve the specified user's one-to-one DM; no unsolicited greeting |
| `slack_get_messages` | Direct Slack history with string timestamps, bounded time filters, truncation and continuation |
| `slack_update_message`, `slack_delete_message` | Confirm bot authorship from Slack and rely on bot-token enforcement; no local authorship ledger |
| `slack_get_reactions`, `slack_add_reaction`, `slack_remove_reaction` | Actual Slack reaction state; distinguish actor/item author; handle already-present/absent responses accurately |

Use small typed service functions and strict schemas. Split files only when useful; no generic operation framework or configurable provider abstraction. Preserve cursors even when a filtered page is empty; do not fetch the entire workspace implicitly. Return actual IDs/results and bounded errors, honor rate limits, and label partial/unsupported reads honestly.

Do not implement a reconciliation tool, persisted write IDs or automatic ambiguous-write retries. Normal read tools are sufficient for the dot to inspect Slack before deciding how to proceed. Similar text or a failed lookup is not conclusive evidence of a previous write's outcome.

Tests cover access failures, pagination, filtering, missing scopes, rate limits, target authorship, uncertain writes and actual reaction semantics. Hosted edit/delete tests target newly created synthetic bot messages only; do not delete human marker threads as test cleanup.

## 5. Step 3 — Complete event filters and types

- Extend `slack.message.created` with sender, mention and other-bot filters; retain required conversation and optional thread. The app's own bot always remains excluded.
- Add `slack.message.updated`, `slack.message.deleted`, `slack.reaction.added`, and `slack.reaction.removed` with a small explicit schema/matching dispatch. No extensible plugin registry or new storage tables are needed.
- Preserve existing subscription identities/secret associations when introducing filter defaults. Match event names as well as filters. Canonical unsubscribe must still find older subscriptions.
- Normalize payloads entirely in memory. Use occurrence-specific stable IDs for repeated edits and reaction changes. Unknown author/thread values remain unknown and do not satisfy those filters. Perform a bounded live Slack read only if required; no cross-notification enrichment or history cache.
- Feedback requires a known, valid source thread. If it cannot be determined or the target is unavailable/deleted, skip the notice; do not create a suppression record or post to a guessed destination.
- Add the two reaction event subscriptions to the Slack manifest/setup guide when implementing them. Remove redundant `app_mention` subscription configuration if unnecessary; the handler must remain safe if the existing app still sends it. Check actual Slack configuration/grants before live testing.

Tests cover filter combinations, legacy subscriptions, missing metadata, multiple edits/reactions, self activity, unsupported items and fanout. Native tests use explicit saved instructions and known synthetic targets; a manually requested reply is not evidence that an event-triggered instruction ran.

## 6. Step 4 — Documentation and acceptance

Provide one concise environment-based setup guide, not an administration product. Document the native plugin, required scopes/events, owner configuration, secrets, 72-hour renewal contract, no payload storage, no replay and best-effort execution. State duplicate/ambiguous-write limits in tool descriptions and user-facing guidance.

Run relevant type checks, behavioral tests and the supported Sites build for each change. Verify new native tools/events through discovery before using them. Keep tests synthetic and avoid live payload captures. Check bounded fanout and privacy/security behavior at realistic bridge scale; do not introduce a monitoring project or benchmark platform.

Map final results to specification section 14. A hosted second-identity check can be performed when that identity is available; preserve the proven owner/anonymous checks and local non-owner tests in the meantime. Do not invent a new manual renewal test or external infrastructure requirement. Keep implementation status distinct from historical prototype results.

Use short-lived `codex-` branches based on `master` and the supported Sites source/version/publication workflow. Preserve historical tags, but never redeploy a storage-dependent historical build after dropping its tables. A documentation correction alone does not mean the deployed data has been removed.

## 7. YAGNI decisions

Removed from the prior plan: seven-day operational retention, delivery/notice dashboards, stored-result replay, ambiguous-write ledgers and reconciliation endpoints, maintenance claims/cooldowns/tables, manual outbox runners and their secret, cached profile/thread fallbacks, cross-notification enrichment, configurable lifetime/retry knobs and a configuration GUI.

Retained because they implement the requested bridge: active subscriptions, secure callback material, owner authorization, Slack signatures/access checks, bounded retries, best-effort threaded feedback, and the already-agreed Slack tool/event capabilities. The expanded discovery/edit/reaction features are existing product scope, not prerequisites for the storage-removal fix; they can be deferred without holding up that fix.

`assistant:write` is an existing requested scope, but the initial bridge has no Agent UI feature requiring it. It is a candidate to remove from the requested scope set; no change to the user's installed grants is implied by this plan. Do not add more scopes or UI features to justify retaining it.

## Sources for execution limits

- [Slack event acknowledgment and retries](https://docs.slack.dev/apis/events-api/#responding-to-events): acknowledgment is required within three seconds; retries can occur in later requests.
- [Workers execution context](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil): background tasks share a bounded post-response window and unfinished work can be cancelled.
