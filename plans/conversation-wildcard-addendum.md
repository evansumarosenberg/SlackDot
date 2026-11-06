# Conversation wildcard subscription addendum

Date: 2026-11-05

Status: implemented, independently reviewed and deployed as SlackDot version 9 on 2026-11-05. Local validation and hosted health/connection checks pass; native wildcard automation verification remains pending.

This addendum extends the [SlackDot specification](specification.md), especially section 9's subscription filters and lifecycle and section 10's matching behavior. It supersedes the requirement that every subscription identify one concrete conversation, while keeping `conversation_id` required. Other requirements in the specification and [agent instructions](../AGENTS.md) remain in force. Historical acceptance in the [implementation plan](implementation-plan.md) does not establish wildcard support.

## 1. Intended behavior

Allow the controlling Dot to subscribe once to an event across all supported conversations accessible to this installation's bot. The motivating example is receiving explicit bot mentions in every joined channel, including channels joined after subscription creation.

The following is an event name and arguments fragment; an actual `events/subscribe` request also includes the existing client-supplied webhook delivery configuration:

```json
{
  "name": "slack.message.created",
  "arguments": {
    "conversation_id": "*",
    "mentions_only": true
  }
}
```

The wildcard removes only the exact-conversation restriction. Existing event-specific filters and bot/self suppression still apply. For example, the fragment above excludes messages without an explicit mention and excludes other bots by default; this bot's own messages are always excluded.

## 2. Public contract

All five event types accept the literal `"*"` as `arguments.conversation_id`:

| Event | Other permitted filters |
| --- | --- |
| `slack.message.created` | `sender_user_ids`, `mentions_only`, `include_bot_messages` |
| `slack.message.updated` | `sender_user_ids`, `mentions_only`, `include_bot_messages` |
| `slack.message.deleted` | `sender_user_ids`, `include_bot_messages` |
| `slack.reaction.added` | `actor_user_ids`, `emoji_name` |
| `slack.reaction.removed` | `actor_user_ids`, `emoji_name` |

These are the other filters permitted with a wildcard. Concrete-conversation subscriptions also retain their existing optional `thread_ts` filter.

- Keep `conversation_id` required. Omission, `null`, empty strings, partial globs such as `C*`, arrays and other wildcard spellings are invalid. Do not trim or coerce them into `"*"`.
- Accept either an existing valid concrete conversation ID or exactly `"*"` in subscription filters only. Preserve strict rejection of unknown fields and filters unsupported by the chosen event.
- Reject `conversation_id: "*"` together with `thread_ts` for every event type. A thread is identified by a conversation and a timestamp together. Apply the same argument contract to subscribe and canonical unsubscribe; unsubscribe by ID remains available.
- Publish the new contract through `events/list`, including the wildcard meaning and incompatible thread filter. Ensure the advertised JSON Schema and runtime validation agree, including the invalid combination; a runtime-only refinement is insufficient.
- Preserve actual conversation IDs in delivered payloads. Ordinary read/write tool inputs and normalized payload schemas never accept `"*"`.
- Preserve existing `mentions_only` semantics: explicit `<@BOT_USER_ID>` text mentions, computed before preview truncation, for created and updated messages only. An update qualifies whenever its resulting known text contains the mention; this does not introduce a special transition from unmentioned to mentioned.
- Missing edit/delete/reaction metadata continues to fail filters that require that metadata. A wildcard does not relax unknown-bot suppression or create metadata.

## 3. Scope and access

`"*"` means all currently accessible conversations supported by this single workspace installation: joined public channels, joined private channels and bot one-to-one DMs. Preserve the existing exclusions for group DMs, archived/unavailable conversations and the existing workspace-context check. No cross-workspace aggregation or channel-only filter is introduced.

Explicit mentions in bot DMs can therefore match the example above. A normal DM without an explicit mention does not match `mentions_only: true`. A separate existing DM subscription may continue handling those messages, subject to the overlap behavior below.

Membership is evaluated at delivery time using the existing Slack access checks. Do not enumerate or snapshot channels when subscribing, store a membership list, automatically join channels, or create one subscription per channel. A wildcard can be created when no channels are joined. Subsequent eligible events from newly joined channels are covered while the subscription is active. Leaving a channel blocks delivery from that channel; rejoining can allow subsequent events again. There is no historical replay or guaranteed recovery of events from a period of lost access.

Keep the current Slack manifest, scopes (including `assistant:write`) and canonical `message.channels`, `message.groups`, `message.im`, `reaction_added` and `reaction_removed` sources. Continue ignoring separate `app_mention` notifications for new-message fanout. This extension filters events Slack actually sends; it does not broaden Slack's visibility or guarantee delivery of an invitation-causing mention before the bot has joined.

## 4. Subscription lifecycle

Keep the Sites owner and configuration checks before subscription operations. For a concrete conversation, retain the current live conversation-access validation on subscribe/refresh. For `"*"`, validate the configured bot/workspace identity through `SlackService.identity()` on subscribe/refresh instead. Never pass `"*"` to `SlackService.access()` or a Slack API method. This configured-runtime check does not change the installation guide's direct `auth.test` procedure.

Retain callback allowlisting, signed challenge verification, encrypted signing material, deterministic subscription identity, refresh/upsert, signing-key rotation, expiration and owner-scoped deletion. The current default and maximum lifetime remain 72 hours, honoring shorter requests. Wildcard subscriptions require the same native renewal as concrete subscriptions; no new renewal mechanism is introduced.

Canonical unsubscribe with wildcard arguments must work without a Slack access/identity call, including after channel access or installation credentials have been lost. Preserve the existing unsubscribe-by-ID form.

## 5. Event selection and delivery

For each verified, normalized event:

1. Select active subscriptions belonging to the configured owner, for the exact event name, with `created_at <= acceptedAt` and an unexpired lifetime. Select both `conversation = event.data.conversation_id` and `conversation = '*'` while preserving deterministic ordering and returning each subscription once.
2. Revalidate stored arguments and apply all applicable filters. Conversation matching succeeds for either the exact incoming ID or `"*"`. Invalid persisted arguments fail closed, including a wildcard/thread combination.
3. Preserve event/subscription deduplication claims and the existing bounded execution and retry rules.
4. Before each callback attempt, validate access to `event.data.conversation_id`, never the wildcard stored in the subscription. Preserve the current installation identity and membership checks inside that access operation.
5. Preserve subscription re-reads and filter checks around access, plus claim ownership and deadline checks before sending. Unsubscribe, expiry, recreation and concurrent changes must retain their current cancellation behavior.
6. Deliver the unchanged event envelope with its actual source conversation and available thread metadata. Replies, indicators and any eligible failure notice use that source conversation and the existing thread rules.

A wildcard alone must not trigger an exact-message lookup to resolve thread metadata, because it cannot carry a thread filter. An overlapping concrete subscription with a thread filter may still trigger the existing shared bounded lookup. Preserve existing payload normalization and enrichment behavior in that case.

## 6. Failure handling

Distinguish a conversation becoming unavailable from the installation being unusable. The following rules apply to failures of the delivery access check:

| Failure category | Concrete subscription | Wildcard subscription |
| --- | --- | --- |
| `conversation_unavailable`, `not_found`, `not_in_conversation` | Preserve current deletion/cancellation | Cancel this event's delivery to this subscription; retain the subscription for other conversations |
| `installation_revoked`, `installation_mismatch`, `missing_scope` | Preserve current deletion/cancellation | Delete/cancel the affected subscription as today; a wildcard does not bypass installation or scope failures |
| Transient failure, including `rate_limited` | Existing bounded retry behavior; retain subscription | Same behavior |

Treat a skipped conversation as cancellation, not a callback failure: it produces no callback, activity indicator or failure notice for that cancelled destination, and does not consume further retry attempts for it. Preserve the existing finalization of any claimed opaque deduplication record for an unsuccessful delivery; do not add permanent per-channel denial records or mark cancellation as confirmed delivery. A later Slack redelivery remains subject to existing claim/expiry rules and a fresh access check.

Installation-wide failures must still fail closed for every attempted delivery. Preserve deletion of the affected subscription; this addendum does not introduce bulk subscription deletion. Missing scopes retain their current permanent-failure treatment rather than being mistaken for one channel's membership loss.

Callback HTTP failures, destination-policy failures, uncertain acceptance and best-effort feedback retain existing behavior. An error from a callback or an optional thread lookup must not be reinterpreted as proof that a channel membership or the whole installation was revoked.

## 7. Overlap, compatibility and storage

A wildcard subscription and a concrete-conversation subscription are distinct subscriptions even when they share a callback URL. If both match, both receive a callback. Deduplication remains keyed by the event/subscription pair; it does not collapse separate automations. Explain this when configuring automations so overlapping subscriptions do not unintentionally produce two replies.

Keep the current activity-indicator rule: the first confirmed created-message delivery starts at most one processing/eyes attempt per invocation. Do not add an indicator per matching subscription. Preserve the current notice-suppression rules when another destination was delivered or suppressed. Threaded tool replies retain their existing indicator cleanup behavior.

Existing concrete subscriptions must retain their canonical arguments, deterministic IDs and encrypted-secret association. Do not insert implicit defaults or rewrite stored subscriptions during rollout. A wildcard is a new explicit argument value, not a conversion of existing subscriptions.

The existing `subscriptions.conversation` text column can store `"*"`; `args` retains the canonical wildcard arguments and `thread` is null. No migration, new table, additional configuration variable or membership cache is required. Keep the existing opaque event/subscription records with three-hour fixed expiry, 45-second claims and request-driven cleanup. Store no message payloads, raw dedup identifiers, attempt histories or Slack write results.

Retain the Sites-only architecture and bounded request execution. More matching events can cause more callbacks and access checks; this change does not add a queue, scheduler, replay service or stronger delivery guarantee.

## 8. Implementation boundaries

| Existing module | Expected change |
| --- | --- |
| [Filter schemas and normalization](../lib/slack/normalize.ts) | Introduce a subscription-only conversation selector, express the thread incompatibility in discovery and validation, document wildcard behavior, and update matching |
| [Subscription lifecycle](../lib/events/subscriptions.ts) | Choose concrete access or installation identity verification; accept the same arguments for canonical unsubscribe |
| [MCP handlers](../lib/mcp/server.ts) | Supply the required validation operations while preserving owner authorization and protocol errors |
| [Event delivery](../lib/events/delivery.ts) | Select exact and wildcard subscriptions, authorize actual event conversations, and distinguish conversation cancellation from subscription deletion |
| [Slack service](../lib/slack/service.ts) | Reuse identity and concrete-conversation access boundaries; keep wildcard values out of ordinary tools and Slack requests |

Update the specification's filter/lifecycle text and user-facing subscription guidance when implementing the feature. Do not rewrite historical acceptance records as evidence for new behavior. No installation, live Site change, subscription creation, commit or upstream push is authorized by this documentation task.

## 9. Acceptance criteria

The implementation must demonstrate:

1. All five event contracts accept exact IDs and literal `"*"`, reject malformed selectors and unknown/unsupported filters, and reject wildcard plus `thread_ts`. Exercise both runtime validation and the actual advertised JSON Schema. Payloads and ordinary tools still reject `"*"`.
2. Wildcard subscribe/refresh checks installation identity without channel enumeration or a wildcard Slack request. Concrete subscribe retains access validation. Owner rejection, callback verification, expiration, rotation, canonical unsubscribe and unsubscribe by ID retain their behavior.
3. Wildcard matching works across at least two conversation IDs for every event type, with event-specific sender/actor/emoji/mention filters, unknown metadata, and self/other-bot handling preserved. Explicit DM mentions match; unmentioned DMs do not satisfy `mentions_only`.
4. Synthetic access checks prove joined public/private channels and supported bot DMs are eligible, unavailable/group/archived conversations remain excluded, and newly accessible channels require no subscription refresh. Losing access in one channel preserves wildcard delivery in another. Installation failures and missing scopes still cancel/delete the affected subscription.
5. No callback or indicator is emitted for an inaccessible event, and conversation cancellation does not create a failure notice for that destination. Ordinary callback failures and mixed fanout retain existing notice behavior.
6. Exact and wildcard subscriptions both receive a matching event, with independent deduplication across Slack retries and at most one activity-indicator attempt per invocation. Existing unsubscribe/expiry/recreation races and delivery deadlines remain covered.
7. Concrete subscription canonical IDs and encrypted associations are unchanged. Wildcard refresh/unsubscribe are stable. Only the existing permitted subscription and opaque deduplication storage is used.

Run relevant unit/protocol tests, type checks and the supported Sites build before any separately authorized deployment. Extend the existing built-Worker integration coverage for wildcard selection, concrete access calls, cancellation and overlapping fanout; do not rely solely on mocked matching tests.

After an authorized deployment, perform a focused check in the intended Dot's ChatGPT context: confirm updated discovery, create one wildcard mention subscription, and observe native delivery from human mentions in two joined channels (including a private channel when available), with a non-mention as a negative control. A channel joined after subscription creation should be covered without resubscribing. Exercise unsubscribe through native controls and reconcile any temporary automation with the owner-requested final state. Report observed results separately from synthetic validation; previously accepted unrelated live tests need not be repeated. If native controls cannot express the wildcard, report that concrete limitation without substituting polling or manually sent Slack replies.

## 10. Independent review and adjudication

An independent subagent completed a read-only review on 2026-11-05 against the current implementation, project instructions and approved design. It found no blocking design or correctness issues. The review checked discovery/runtime schema agreement, wildcard isolation from tools and payloads, subscribe/refresh authorization, access-free unsubscribe, access-failure classification, overlapping deliveries, subscription identity compatibility, bounded storage and acceptance scope.

| Finding | Adjudication | Resolution |
| --- | --- | --- |
| P3: The main specification should link to the addendum so implementers do not miss the approved extension | Accepted. The baseline specification is the natural entry point; the extension must be discoverable there | Added a link near the main specification's status and companion documents, explicitly labeling this design approved and implementation pending. The link was added while review was underway and satisfies the finding |

No findings were rejected or deferred, and no design decisions remain open from this review. Documentation validation checks local links, the JSON example and whitespace; runtime tests and live verification remain implementation acceptance work, not evidence claimed by this addendum.

## 11. Implementation validation

The owner subsequently requested implementation, tests and an independent code review. The local implementation now accepts subscription-only wildcard selectors, advertises the wildcard/thread exclusion, verifies installation identity on wildcard subscribe/refresh, checks actual event conversation access before callbacks, and retains wildcard subscriptions after conversation-specific access loss. Existing storage and concrete subscription identities are preserved.

Validation completed on 2026-11-05:

- All 259 unit/protocol tests pass, including 36 new wildcard tests in [wildcard.test.ts](../tests/unit/wildcard.test.ts).
- TypeScript checks and the supported Sites build pass.
- The new [built-Worker wildcard check](../tests/compatibility/wildcard-smoke.mjs) passes all five event types, producing 14 signed callbacks with zero wildcard Slack access calls. It covers identity-only creation, multiple conversations, overlapping subscriptions and duplicate suppression, membership/access loss, missing scopes, a newly accessible channel, explicit DM mentions and unsubscribe.
- The existing built-Worker catalog check passes all 14 tools and five event types. Existing retry, permanent-failure, fanout and duplicate-ingress Worker scenarios also pass.
- Documentation links, the JSON example and `git diff --check` pass.

A separate subagent independently reviewed the implementation and tests against this addendum and the project instructions. It reported no actionable findings; no fixes or deferred findings arose from that code review. The reviewer did not rerun the primary agent's checks. The results above are local synthetic validation, not native hosted acceptance. No deployment, live subscription change, commit or push was performed as part of this implementation task.

## 12. Authorized deployment

The owner subsequently requested deployment to the existing SlackDot Site. The Sites workflow reused the existing deployment checkout, rebuilt the application and reran the wildcard Worker check successfully, then synchronized only the Site-managed source repository. The upstream SlackDot repository was not committed or pushed.

| Item | Recorded value |
| --- | --- |
| Site | `appgprj_6ae96bf305348191b643a34ca36eb892` |
| URL | [SlackDot](https://slackdot.paryllax.chatgpt.site) |
| Saved version | 9: `appgprj_6ae96bf305348191b643a34ca36eb892~appgver_2d3403d8675c81918615da61457b1e0a` |
| Managed source commit | `518a9f2aa31643b9acd4d6c404df3f9073adbd23` |
| Deployment | `appgdep_6aed3d2d76488191847ad3bb54d40d2e` |
| Result | Succeeded at 2026-11-05 20:36:38 America/Chicago (2026-11-06 02:36:38 UTC), MCP enabled |
| Environment revision | 18; no environment settings changed |
| Existing plugin | `plugin_asdk_app_sites_e91d3007f878819186ee330fdc8bf4e6` |

Hosted `/health` returned HTTP 200 with `service: SlackDot` and `status: ok`; anonymous `POST /mcp` returned 401. The connected plugin's read-only connection check succeeded for workspace `T6BL7UHQF`, bot user `U0CEA5NGMV4`, bot `B0CEE1GE9B3`, and all five event types. The existing public audience, plugin and database were retained. No live subscription was created or changed and no Slack message was sent. These checks confirm deployment and the connection, not the native wildcard automation acceptance in section 9.
