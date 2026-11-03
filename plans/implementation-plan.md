# SlackDot implementation plan

Status: Steps 1–3 are implemented and deployed on version 13. Step 1 hosted acceptance passed. The expanded catalog is locally verified; live checks of the new tools/events remain in progress. Step 4 documentation is updated; final acceptance awaits those checks.
Target: [specification](specification.md)
Historical evidence: [compatibility results](compatibility-prototype-results.md)

## 1. Goal and current gap

Build a lightweight Slack-to-Dot bridge on the existing ChatGPT Site. Keep one workspace, one bot, one controlling dot, the native plugin and the existing authorization/security boundaries. Configure through Sites environment variables and secrets. The only application data in D1 is current subscription information.

The user explicitly accepts possible cross-request duplicate deliveries/notices/writes and interruption that prevents both delivery and feedback. These are accepted simplicity and deployment tradeoffs, not gaps to solve with additional storage or infrastructure.

Version 11 (`05e487b`) deployed the table-independent Worker with environment revision 12, removing the obsolete delivery secret. Version 12 (`599e2f6`) then applied the forward migration. Live schema inspection confirms that `subscriptions` is the only application table and all five pre-migration subscription identities survived. No operational payloads were exported. Local Step 1 verification passed 69 tests, TypeScript checks, Sites build and ten built-Worker scenarios. The user authoritatively verified all three native public/private/DM MEMORY replies in Slack; this hosted round-trip acceptance is passed. Dot separately confirmed receipt of all three native events. No additional read-back is required to accept the user's verification.

## Current catalog verification

The expanded implementation passes 165 unit/protocol tests, TypeScript checking and the Sites build. The built catalog smoke exercises all 14 tools and five event types with synthetic outbound services and only the subscriptions table. All ten bounded-delivery Worker scenarios passed: success, transient retry, exhaustion, permanent failure, long Retry-After, failed notice, timeout, interruption, fanout and duplicate ingress. Final local acknowledgments were 6–9 ms; timeout exhaustion completed in about 15.5 seconds. These are synthetic local timings, not hosted latency measurements. Review fixes cover subscription recreation races, malformed Slack responses, root-edit/reaction thread resolution, self exclusion with unknown authorship, and the protocol-required 60-second signing-key overlap. The additive key fields remain part of active subscriptions, not operational history. No live renewal experiment was added. The user confirmed Slack's reaction bot-event settings are saved.

Version 13 deployed source `0356845bc09dd62a843af8ef6894db511cb3cce5` via deployment `appgdep_6ae94a412fc88191aaa02e18edd9eec2` (environment revision 12), succeeded 2026-11-03 02:43:23 UTC. Native owner identity/capability calls report all five event types. Live schema inspection still shows only `subscriptions`. Anonymous/forged MCP probes return 401 and forged setup identity is not reflected. The current chat's connector catalog still exposes the original three tools, so the new-tool native smoke is delegated to Dot through the user. No extra plugin was created.

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

Retain `assistant:write` by explicit user choice. Simple Agent UI features may be investigated in the future, but remain outside this implementation task. Do not remove the scope or add UI features as part of this work.

## Sources for execution limits

- [Slack event acknowledgment and retries](https://docs.slack.dev/apis/events-api/#responding-to-events): acknowledgment is required within three seconds; retries can occur in later requests.
- [Workers execution context](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil): background tasks share a bounded post-response window and unfinished work can be cancelled.
