# SlackDot implementation plan

Status: ready to execute; implementation has not started.  
Last updated: 2026-11-02  
Target: [specification](specification.md)  
Starting evidence: [compatibility results and handoff](compatibility-prototype-results.md#transition-checkpoint-and-remaining-product-work-current)

## 1. Objective and baseline

Expand the verified compatibility prototype into the full application described by the specification, in the same application tree and Sites project. Start from the integrated `master` checkpoint `9d4f4ef`; the tested application is Site version 9 at `d239f07`, preserved by `compatibility-prototype-v3`.

Preserve one workspace, one bot, one controlling dot, owner-only protected operations, the native Site-created plugin, exact callback-origin restrictions, and no protocol replay. Keep the existing automatic delivery contract: at most three attempts inside the original 20-second delivery budget, up to five seconds for best-effort failure feedback, no external scheduler, and no promise of recovery after interruption. Dot task completion is separate from callback delivery success.

This plan covers the remaining specification, not another compatibility experiment. Implement and verify one slice at a time. Do not reopen the completed feasibility gate because a later production check needs a second identity or an observation period.

## 2. Delivery sequence

| Slice | User-visible outcome | Depends on | Completion evidence |
| --- | --- | --- | --- |
| 1. Setup and operations | Owner can understand configuration, subscription expiry, and delivery/notice status; expired data has a documented cleanup path | Verified baseline | Authorization, redaction, retention and deadline tests; hosted owner readback |
| 2. Discovery and reading | Dot can find accessible conversations/users, open a DM, and read paginated history | 1 | Contract tests and native public/private/DM discovery/read smoke checks |
| 3. Message and reaction actions | Dot can edit/delete its own messages and inspect/manage its reactions safely | 2 | Mutation/idempotency tests and read-back verification on synthetic messages |
| 4. Message filters | Dot can select message authors, mentions, threads, and other-bot messages | 1; regression coverage from 2–3 | Matching matrix, legacy subscription compatibility, native filtered runs |
| 5. Edits, deletions and reaction events | Dot receives correctly typed changes without duplicates or self-loops | 3–4 | Event fixtures, migration checks, native controlled event runs |
| 6. Reconciliation and release review | Uncertain outcomes are inspectable; full specification has an evidence-backed acceptance record | 1–5 | Security/retention/load checks, setup guide, final Sites/native regression matrix |

The immediate implementation task is Slice 1. Existing public/private/DM subscriptions and the paused temporary thread automation remain unchanged unless a later scoped test requires a change. No new polling automation or external infrastructure is part of any slice.

## 3. Slice 1 — Setup, diagnostics and retention

### Deliverables

- Expand the existing `/setup` owner view and setup guide, without adding a rich dashboard or a form that accepts secrets. Show configuration presence, verified workspace/bot identity, supported capabilities, and bounded-delivery limitations. Keep non-owner output limited to that visitor's own setup identity and access explanation.
- Add an owner-authorized, paginated diagnostics view behind the same authorization boundary. Return subscription IDs, event names/filters, active/expired status and expiry times; delivery/notice counts and bounded failure categories; and unresolved/expired work. Never return callback URLs, signing secrets, token values, event bodies, or raw Slack errors. Do not expose a new MCP tool merely to make this view work.
- Compute effective expiration at read time. A stored active flag is insufficient after `expires_at`. Make configurable subscription lifetime a validated server setting, retaining the current 24-hour default and current behavior when unset. Diagnostics report expiration; they do not claim to renew ChatGPT automations.
- Separate maintenance from `drain()`. Add bounded, idempotent cleanup batches with a D1 maintenance claim/cooldown so concurrent invocations do not scan the whole database. Add required indexes through a new migration.
- Run opportunistic maintenance on authorized application activity where a bounded execution allowance is available. Slack ingress must acknowledge promptly; delivery and its notice reserve take priority. Do not start cleanup concurrently with delivery as if it had a separate platform window. An explicit authenticated maintenance operation remains available when the application is idle; it cannot send callbacks or Slack messages.
- Classify expired unresolved delivery rows without resending, resetting deadlines, or stealing unexpired claims. Remove expired subscription secrets when maintenance executes. Retain seven days of operational payloads/completed records, preserving live jobs and required deduplication associations. Preserve minimal unresolved write/notice evidence rather than retaining message bodies indefinitely. Document precisely which metadata survives and how an operator resolves it.

### Implementation locations

`app/setup/page.tsx`, a small owner-only diagnostics route/view, `lib/runtime/config.ts`, `lib/runtime/router.ts`, `lib/storage.ts` (or a focused `lib/storage/maintenance.ts`), `lib/events/subscriptions.ts`, `db/schema.ts`, a new `drizzle/` migration, `.env.example`, and `README.md`/setup documentation. Reuse `owner()`; do not create a second authorization mechanism. Keep `slack_get_connection_info` backward compatible if adding non-secret capability/limit fields.

### Acceptance

1. Anonymous and signed-in non-owner requests cannot read diagnostics or run maintenance. Local non-owner tests run now; an actual second-identity hosted test remains explicitly untested until that input exists.
2. Missing configuration reports key names/status only. Public health and non-owner setup responses contain no workspace data, event text, subscriber data or credentials.
3. A paginated diagnostics request performs bounded reads. Expired and ambiguous rows are distinguished from retryable work; viewing them performs no delivery or Slack write.
4. Cleanup preserves an active delivery/notice claim, removes eligible old payloads and expired secrets, survives overlapping invocations, and reports partial progress. Zero traffic means zero guaranteed cleanup executions; seven days is an eligibility policy, not a wall-clock deletion guarantee.
5. A Worker test proves maintenance does not delay acknowledgment, reduce the delivery/notice allowance, or extend the shared request lifetime. An interrupted maintenance batch is safe to resume on a later authorized invocation.
6. Deploy with the existing environment defaults and subscriptions preserved. Read back owner setup/diagnostics and confirm the existing three-tool/event catalog still works.

## 4. Slice 2 — Conversation/user discovery and history

Implement the specification's `slack_list_conversations`, `slack_get_conversation`, `slack_list_users`, `slack_get_user`, `slack_open_dm`, and `slack_get_messages`. Preserve `slack_get_thread` and `slack_send_message` contracts.

- Use typed service methods with strict input/output schemas, explicit MCP annotations, bounded responses, and normalized errors. Split `lib/slack/service.ts` and tool registration by responsibility only as these additions justify it.
- List joined public/private channels and existing one-to-one bot DMs; exclude group DMs and inaccessible/nonmember channels. Recheck access on individual reads/writes. Never auto-join a channel.
- Return the upstream continuation cursor even when membership or name filtering produces an empty page. User-name filtering applies to the returned page, with that coverage explicit; do not silently fetch the whole workspace or claim a complete search. Do not request email fields/scopes.
- Keep timestamps as strings and validate time bounds. Normalize history/thread results through shared bounded message schemas with source, completeness, truncation and continuation fields.
- Opening a one-to-one DM uses the specified user ID and returns the actual conversation ID; it sends no greeting. Verify repeated calls return the existing conversation and do not implement group-DM behavior.
- Preserve `Retry-After` in errors and avoid automatic hidden pagination/retries that exceed the MCP request allowance.

Tests cover empty filtered pages with cursors, missing/deleted users, inaccessible channels, wrong installation, unsupported group DMs, history bounds, missing scopes, rate limits, partial responses and stable DM identity. Hosted tests use the authorized test conversations and a designated tester, with no unsolicited messages to discovered users.

## 5. Slice 3 — Message modifications and reactions

Implement `slack_update_message`, `slack_delete_message`, `slack_get_reactions`, `slack_add_reaction`, and `slack_remove_reaction`.

- Extract the existing durable write-request discipline into a shared operation helper. Preserve legacy send request hashes/replay behavior; operation names prevent cross-operation reuse of a request ID. Identical completed requests return their saved result, conflicting arguments fail, and uncertain writes are not blindly retried.
- Distinguish definite Slack rejections from transport/commit ambiguity. Keep the actual normalized failure category and any retry delay, without treating every error as proof of success or as permission to resend.
- Verify target message authorship before edit/delete using trustworthy Slack data or sufficient retained write evidence; reject unknown authorship conservatively. Slack's bot-token enforcement remains the final boundary. Do not infer ownership from caller-supplied IDs.
- Treat known already-present/already-absent bot reaction outcomes as the requested final state where the API supports that conclusion. A user's reaction does not establish that the bot reacted. Reconcile returned metadata without claiming the reaction-user list is exhaustive.
- Return Slack identifiers and operation outcomes; never report a deletion solely because a later read lacks permission or cannot find the conversation.

Tests cover cross-operation request-ID collisions, concurrent claims, non-bot targets, completed replay, definitive rejection, lost-response ambiguity, reaction state and access revocation. Live tests create dedicated synthetic bot messages, edit and read them back, add/remove and read reactions, then delete only those messages. Existing human marker threads remain evidence, not deletion targets.

## 6. Slice 4 — Message matching and subscription compatibility

Expand `slack.message.created` with `sender_user_ids`, `mentions_only`, and `include_bot_messages`, retaining the required conversation and optional root/thread filter.

- Introduce one typed event/filter registry used by discovery, validation, normalization and matching. Validate event names and filters before persistence. Move matching beyond the prototype's conversation/thread-only SQL; include the event name explicitly.
- Preserve existing subscription IDs, encrypted-secret association, canonical unsubscribe, expiration and active state across deployment. Adding schema defaults must not silently change the hash of old arguments. Test old saved arguments and new explicit defaults; document canonical equivalence and prevent duplicate identities for equivalent filters without rebinding secrets incorrectly.
- Other bots are excluded by default; the app's own bot is always excluded. Apply this consistently to webhook payload variants. Sender filters match authors, not a webhook actor inferred from another field.
- Keep created-event IDs stable across message/app-mention overlap. If the later notification supplies mention metadata missing from the first, enrich matching safely while keeping one immutable serialized body per delivery and one original deadline per logical occurrence. Do not replay to subscriptions created after the event.
- If more subscriptions match than can run within the shared budget, persist the bounded outcome; do not create additional execution windows.

Tests cover all filter combinations, root inclusion, unknown author, explicit mention versus plain display-name text, other/self bot behavior, either order of mention/message notifications, late duplicates, concurrent acceptance, old subscription refresh/unsubscribe and deadline preservation. Native tests reuse or create narrowly scoped temporary automations and pause them after their test; never duplicate the existing production test subscriptions accidentally.

## 7. Slice 5 — Additional event types

Implement `slack.message.updated`, `slack.message.deleted`, `slack.reaction.added`, and `slack.reaction.removed` with per-event filter/payload schemas.

- Normalize edits/deletions as changes, never as new messages. Keep missing author, text and root-thread metadata explicitly unknown. For reactions, distinguish actor from the author of the reacted-to message and support message items only.
- Use occurrence-specific stable IDs for edits/reactions/deletions, incorporating the verified Slack occurrence identity and event type; reusing the creation key `(workspace, conversation, message_ts)` would collapse repeated edits or reaction changes. Retries of the same occurrence still deduplicate.
- Add nullable thread support through a migration that preserves existing events and pending deliveries. Unknown thread/author values cannot satisfy a corresponding filter. If authoritative enrichment is necessary, bound it within the original budget and retain uncertainty on failure; no speculative root assignment or unbounded pre-acknowledgment Slack calls.
- Exclude self-authored changes and the bot's own reaction actions while allowing another person's reaction to a bot message. If self-origin cannot be determined safely, do not claim the self-loop check passed; record/resolve that case explicitly.
- Generalize delivery payload types while retaining the tested signed bytes, claims, timeouts and notice deduplication. Attempt feedback only when a valid source thread is known and usable. A deleted/unavailable source or unresolved root produces a persisted notice-suppression reason, not a message in a guessed channel/thread. Successful fanout continues to suppress generic failure notices.
- Add `reaction_added`/`reaction_removed` to the manifest and setup guide. Existing message subscriptions carry edit/delete subtypes; do not invent separate Slack event names for them. Verify actual installed scopes and event selections before live tests; manifest contents alone do not prove grant/configuration state.

Tests cover repeated edits, distinct add/remove occurrences, duplicate webhook deliveries, missing previous-message metadata, unsupported reaction items, actor/author filters, self changes, unknown threads, and notice suppression. Live native tests use synthetic targets, explicit saved event instructions and readback, including one negative filter case; do not ask Dot to send a manual response to simulate a successful event run.

## 8. Slice 6 — Reconciliation and production acceptance

- Provide bounded owner inspection of uncertain writes/notices. Where an authoritative Slack result and stored request identity prove the outcome, record that evidence atomically. Similar text alone is not proof that an ambiguous send succeeded. A failed lookup or absent history entry is not proof that it failed. Keep unresolved outcomes explicit and never turn inspection into an automatic resend.
- Finish the setup/operations guide: required scopes and events, secure configuration, public URL verification, Site plugin connection, explicit Dot response instructions, finite subscription lifetime, no replay, maintenance, ambiguity and bounded feedback limits.
- Exercise representative concurrency, fanout and payload limits in the built Worker. Check migration preservation and cleanup query bounds. Keep protocol dependencies pinned; update only with a targeted reason and the relevant regression checks.
- Observe native renewal/expiry when available and perform the signed-in non-owner hosted check with a second identity. Neither justifies an external scheduler or a multi-owner system. Record unavailable live inputs separately from failed checks.
- Create a full-product acceptance record mapping every specification section 14 criterion to local tests and hosted evidence, or an explicit remaining gap. Do not label the product production-ready while a required security/behavior check is unverified.

## 9. Verification and publication rules

For each slice, run type checking and the relevant behavioral tests, then the supported Sites build and affected built-Worker scenarios. Do not rerun the historical long-delay test as an acceptance requirement. Do not add tests that merely duplicate implementation structure.

Use migrations that preserve deployed data; do not reset D1 or recreate the plugin. Publish through the Sites source/build/version workflow and record the exact source SHA/version/deployment with the new evidence. A plugin catalog change needs native discovery verification before relying on the new tools/events. Existing compatible subscriptions should survive without recreation.

Read-only checks and local work proceed independently of live-input requests. Ask for manual Slack configuration or human markers only when that specific test is ready, with exact instructions. Reconcile an ambiguous native action before another attempt. Keep temporary fixture hooks outside the final production import graph. Runtime secrets never enter source, logs, fixtures, tool output or documents.

Maintain the implementation on short-lived `codex-` branches based on `master`, preserving the Sites workflow. Integrate completed slices and keep one application tree. Preserve `compatibility-prototype-v3`; later milestones describe their own tested scope.

## 10. Planning references

The repository specification and verified prototype determine scope and accepted guarantees. These Slack primary references were checked while preparing this plan on 2026-11-02; recheck the relevant method contract during its implementation:

- [conversations.list](https://docs.slack.dev/reference/methods/conversations.list/): cursor pagination and filtering can yield fewer entries than the requested limit without completing the list.
- [chat.update](https://docs.slack.dev/reference/methods/chat.update/): modifications are restricted to messages authored by the authenticated identity, including its bot messages.
- [message_deleted](https://docs.slack.dev/reference/events/message/message_deleted/): deletion is a message subtype; do not assume complete original-message metadata.
- [reaction_added](https://docs.slack.dev/reference/events/reaction_added/): the reacting actor and original item author are different fields, and the item author can be absent.
