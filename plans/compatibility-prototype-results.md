# Compatibility prototype results

Evaluation date: 2026-11-02. Status: implementation and local validation complete; hosted feasibility gate incomplete. This is not a production-readiness claim.

## Review findings and decisions

The specification and prototype plan agree on three tools, one message event, one owner/workspace/bot, no protocol replay, and durable acceptance before acknowledgment. No deferred tool catalog has been implemented.

- The current MCP v2 server SDK supports protocol 2026-07-28. Use `@modelcontextprotocol/server`, not the older monolithic v1 SDK. SDK-owned HTTP validation requires `MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name` for tool calls, plus the per-request metadata envelope. The OpenAI Events extension is registered separately using SDK custom methods. Discovery retains the extension capability.
- The inspected Sites 1.1.2 manifest supports D1/R2 and MCP but provides no documented queue/cron consumer provisioning. A D1 row cannot wake a Worker. A service-authenticated `/internal/deliver` endpoint and leased outbox are implemented; an autonomous scheduler is not provisioned or claimed.
- Workers callback DNS pinning is not established. The implementation uses the specification's permitted exact trusted-origin restriction. `CALLBACK_ALLOWED_ORIGINS` must contain only independently verified OpenAI callback origins, never user-supplied arbitrary hosts. Empty configuration rejects subscriptions. No production origins have been guessed. Redirects, credentials, IP literals, fragments, non-HTTPS and nonstandard ports are rejected. Actual origins and hosted behavior remain unverified.
- Owner authorization is a configured Site-scoped ID. `SITES_IDENTITY_VERIFIED=true` is required before protected MCP operations work. It must be set only after public ingress stripping and a real signed-in owner identity are verified. `/setup` shows only the current signed-in visitor's own Site ID, with no Slack data or ability to change ownership.
- Hosted `auth.test` on version 2 failed. A workerd outbound-service fixture reproduced the cause: this runtime rejects fetch `redirect: "error"`, which Slack Web API 8.3.0 uses. The transport now forces `manual` and explicitly rejects every 3xx response before any follow-up request. Callback verification/delivery use the same policy. The built-Worker regression now exercises an actual SDK HTTP call through a synthetic outbound service, as well as signed Bolt ingress and modern MCP discovery. No raw diagnostic logging remains in application code.

## Implementation and dependency baseline

One application tree on `codex-compatibility-prototype`, based on the supported Vinext starter and its unchanged `sites()` build integration. Worker compatibility date `2026-05-15`, `nodejs_compat`; runtime credentials are absent from source. Exact prototype dependencies: Bolt 5.1.0 (Web API 8.3.0 in lockfile), MCP server 2.4.0, Standard Webhooks 1.1.1, Zod 4.6.7, TypeScript 5.9.3, Vitest 5.1.0. Framework baseline: Vinext 1.0.0-beta.5, Vite 8.0.13, Wrangler 4.92.0, local workerd 1.20260515.1. `package-lock.json` pins the full graph.

D1 migration: `drizzle/0000_broken_white_queen.sql` and generated Drizzle metadata. Tables: subscriptions, receipts, normalized events, delivery outbox, and write requests. Acceptance and fanout use one atomic batch; delivery claims use atomic UPDATE RETURNING with expiring leases. Encryption is AES-256-GCM with subscription ID as associated data. Subscription lifetime is 24 hours; verification cache is five minutes, invalidated on secret rotation/reactivation. Delivery is bounded to eight attempts and 24 hours, starting at a 60-second retry delay. One run processes at most ten rows/20 seconds before starting another job.

## Evidence

| Check | Result | Evidence / limitation |
|---|---|---|
| TypeScript | Passed locally | `npm run typecheck` |
| Focused application tests | Passed locally | 33 tests, `npm test`; real SQLite transaction adapter executes application D1 SQL |
| Sites build | Passed locally | Supported `build-site.mjs`; framework builds all environments |
| Worker runtime imports and health | Passed locally and hosted | `worker-smoke.mjs` executes Bolt ingress and SDK discovery in the built bundle; hosted health 200 |
| D1 migrations and readback | Passed locally | Same worker smoke harness against Miniflare D1 |
| Bolt receiver | Passed locally | Actual Bolt processEvent, signed synthetic request, challenge, invalid/stale signatures, wrong workspace, failed persistence |
| Core SDK and Events wire contract | Passed locally | Modern discovery, three tools, strict event schema, protected methods, sanitized errors |
| Deduplication and filtering | Passed locally | Slack retry and message/mention overlap yield one delivery; self, edit/delete, conversation/thread exclusions |
| Subscription lifecycle | Passed locally | Canonical identity, refresh, encrypted secret rotation, verification failure, owner-scoped idempotent unsubscribe |
| Retry and claim recovery | Passed with simulated time | Stable event ID/body, fresh signature, 60-second minimum delay, abandoned lease recovery, concurrent claims |
| Cancellation/revocation | Passed locally | Expiration, unsubscribe and revoked-access delivery checks |
| Write idempotency | Passed locally | Success replay, conflicting request ID, concurrent claim, uncertain response never resent |
| Hosted Bolt/Web API execution | Passed for auth.test | Version 3 owner setup returned the configured workspace/bot user and a bot ID from Slack after the manual-redirect fix |
| Hosted Slack signature/ack latency | Passed for bot callbacks and one human marker | Human marker accepted with ack_ms=184, Worker wall time 208 ms, HTTP 200; earlier filtered bot callbacks took 6–9 ms |
| Native catalog forwarding and UI | Passed on version 5 | Native requests received JSON-RPC results (not just HTTP 200): complete discovery, three tools, one event. ChatGPT app details visibly list all four capabilities; desktop status is Connected |
| Native plugin owner tool invocation | Passed on version 5 | New local chat loaded all three tools; connection info matched expected workspace/bot; DM send, replay and thread read succeeded with owner_match=true in hosted logs |
| Native event lifecycle | Subscription, callback verification, and one event receipt passed on version 7 | Dot confirmed enabled automation and receipt of the exact human marker after one manual delivery invocation. Refresh and active unsubscribe remain untested; subscription retained |
| Public header impersonation | Passed initial hosted probe | Anonymous/forged MCP requests both 401 at Sites ingress; forged setup headers redirect to sign-in, without reflecting forged ID. Signed-in owner setup shows a distinct Site-scoped ID |
| Signed-in non-owner | Not tested | Requires second identity |
| Hosted persistence across deployment | Passed for active subscription | Subscription created before environment revision 11 redeployment delivered a subsequent marker. Pending outbox persistence across deployment remains untested |
| Autonomous delayed retry | Not tested / Sites-only unsupported by inspected contract | No native trigger declared; no external service provisioned |
| Public/private/DM thread reads | Passed in all three | Each test thread returned its exact parent and reply from slack.conversations.replies, complete=true, next_cursor=null |
| Native Slack writes and replay | Passed in all three | Each parent and reply replayed to its original timestamp; each complete thread contained exactly two messages |
| Live Slack Events configuration | Corrected and verified | User updated configuration; Sites receiver URL is Verified and Socket Mode is false; signed callbacks now reach Sites |
| Slack → native ChatGPT event delivery | Passed with manual runner | Dot reported native receipt and exact-marker verification through the prototype thread-read tool, then notified its private ChatGPT chat as configured |
| End-to-end Slack → dot → Slack | Passed with manual delivery trigger and manually requested reply | Native event receipt and private ChatGPT notification passed; Dot subsequently reported one verified threaded bot reply at `1793655609.123899`, also visually confirmed by the user in Slack. Automatic Slack reply behavior remains untested |

Initial direct loopback HTTP preview requests timed out despite Wrangler startup. The in-process Miniflare/workerd smoke test succeeded; no browser-rendering claim is made.

## Deployment record

Site project: `appgprj_6ae8ea0e10708191b688ea6b34e404d7`. Public audience explicitly configured. Published origin: `https://slackdot-compatibility.paryllax.chatgpt.site`.

Initial hosted source commit: `3ee5b7647ca0b2749e5ac49b6853c03e3ed81511`. Site version 1: `appgprj_6ae8ea0e10708191b688ea6b34e404d7~appgver_cce2f7390cfc81918c1b2e31dca452ae`; successful deployment `appgdep_6ae8ed8d2cd88191bd3a9d44d28a0839` at 20:07:54 UTC. Native plugin: `plugin_asdk_app_sites_3783386e839c819182ddea6454d0e5f6`; plugin management reports already installed, but its tools are not yet available to this chat. Installation is not a passed tool/event invocation check.

Owner identity was obtained by an actual Sites sign-in, not inferred from the account ID. Runtime identity trust was enabled only after the hosted public-header probe. Slack secrets were supplied by the user in Sites; encryption and service-trigger secrets were generated directly into secret runtime configuration. No secret values were written to repository files.

Evaluated application commit: `bbaa39b4167e753d4c7be44f2406862c1d4807f3`, preserved as `compatibility-prototype-v1`. The report is updated in a subsequent documentation commit; the tag marks evaluated application code, not a full feasibility pass. No Slack secrets, callback URLs or real message content belong here.

Version 3 source `e6401b6b39b81004824b44e503fe17e508110c24`, saved version `appgprj_6ae8ea0e10708191b688ea6b34e404d7~appgver_bd6e3373196081919f0d2c8764751006`, deployment `appgdep_6ae8ef4ce3208191898071b41fe75d72` succeeded at 20:15:19 UTC. The owner setup page then completed live Slack auth.test. A later environment-only redeployment (`appgdep_6ae8ef78e70c8191af325fa2413bb750`) failed with "Project lifecycle changed while publishing." Health subsequently returned 503 while the project still reported active/public.

Recovery succeeded with version 4 (`appgprj_6ae8ea0e10708191b688ea6b34e404d7~appgver_49a2bb756f4c8191819a1cc06e4ab485`), deployment `appgdep_6ae8f02c0c688191b45f875fcf6a9794`, runtime environment revision 9, at 20:19:01 UTC. The post-deployment probe passes: health 200, anonymous and forged MCP 401, forged setup headers 307 to sign-in. Hosted logs show native modern catalog requests returning 200 on this deployment as well. No authentication bypass or public catalog exception was added.

The initial missing-tools report was investigated on November 2. The native plugin was installed but its contained app still showed Connect. Completing the existing ChatGPT sign-in flow connected the app; no separate Slack user sign-in was involved. The tools and event are displayed inside the plugin's Apps row, which opens a capability detail dialog. Both the web dialog and desktop Connected status were verified, and the desktop catalog Refresh action completed. A subsequent user turn in the same chat still lacked the newly connected tools. The official connect-and-test workflow calls for a new conversation with the plugin enabled; another message in this chat was insufficient. No synthetic Slack messages have been sent. Test posts/replies in the dedicated conversations remain authorized.

Version 5 adds catalog-only diagnostics: numeric error codes, fixed format/outcome labels, request metadata presence, and tool/event counts. It never logs arbitrary response messages, bodies, identities, callbacks, or tool-call results. Source `638df63d2300194f33e4625b3905763d2efd6e82`; saved version `appgprj_6ae8ea0e10708191b688ea6b34e404d7~appgver_ec49a14c6f308191bc945458f0382342`; deployment `appgdep_6ae8f27f139c8191886bc5504f2898bc` succeeded at 20:28:56 UTC with environment revision 9. The native scan at 20:29:03–04 UTC returned complete JSON results for server/discover, tools/list (3), and events/list (1). Typecheck, 33 tests, build, built-Worker smoke, and hosted unauthorized/forged-header probes passed again. Local screenshot evidence: `outputs/slackdot-native-catalog.png` (ignored artifact).

Version 6 publishes the subscription compatibility fixes and bounded event diagnostics after explicit user approval. Source `5e9d28f58138a9cdab24e3bb514a87b103e80318`; saved version `appgprj_6ae8ea0e10708191b688ea6b34e404d7~appgver_f78598635c888191a72006638ff380c3`; deployment `appgdep_6ae8fa0c4d048191a2810830a48c0551` succeeded at 21:01:13 UTC (3:01:13 p.m. America/Chicago) with unchanged environment revision 9. Post-deployment native connection info matched the workspace/bot; public health passed, anonymous and forged MCP probes returned 401, and forged setup headers redirected to sign-in without reflecting identity. The branch remains `codex-compatibility-prototype`; the original Site/plugin and public audience are preserved. A native subscription retry against version 6 is still required; no live callback origin or successful native subscription is claimed.

## Topology decision and transition checkpoint

**Outcome 3: incomplete autonomous-delivery evidence.** Native catalog discovery, owner tool invocation, public/private/DM writes, replay, thread reads, callback verification, and Slack-to-native-ChatGPT event delivery are verified. The human marker was durably accepted and delivered after one manual runner invocation. The active subscription survived redeployment. The configured private ChatGPT notification succeeded; a Slack reply was not specified in that automation. The candidate remains Sites with an auxiliary scheduler; unattended delivery and delayed retry are not yet proven. No duplicate plugin or alternative host was created.

### Native live test, 2026-11-02

Tested the existing version 5 deployment and source `638df63d2300194f33e4625b3905763d2efd6e82` from a new local chat. No application code, deployment, secrets, audience, plugin, or Slack configuration was changed during this test. The native account with the signed-in `suma@umn.edu` profile was selected; the other unprofiled link was not used. All three native tools were available, resolving the previous chat's stale tool catalog.

`slack_get_connection_info` returned workspace `T6BL7UHQF`, bot user `U0CF1MF96D6`, bot ID `B0CF1MF7L4Q`, event `slack.message.created`, `replay=false`, `durable_trigger=external_scheduler_required`, and `thread_support=requires_live_verification`. The tool does not return an app ID; the Slack settings page independently identifies app `A0CDRUNRFK9` in this workspace. The general Slack connector was not used.

All posted text was synthetic and clearly labeled with run ID `slackdot-native-20261102-01`. Request IDs below must retain their original exact arguments if reused; choose a new run ID for another test.

| Conversation | Request ID suffix (after `slackdot-native-20261102-01-`) | Actual result |
|---|---|---|
| Public `C0CE0REVDU1` | `public-parent` | `isError=true`, text error `missing_scope`; wrapper structured error `INVALID_ARGUMENT`. No post occurred: `SlackService.send` calls `access` before claiming a write or posting. |
| Private `C0CF32HS0TS` | `private-parent` | Same `missing_scope` access failure; no parent/reply created. |
| DM `D0CE751HZMY` | `dm-parent` | Posted at `1793651779.045399`; identical replay returned this same timestamp and `thread_ts=null`. |
| DM `D0CE751HZMY` | `dm-reply` | Posted at `1793651810.307849`, threaded under `1793651779.045399`; identical replay returned the same identifiers. |

`slack_get_thread` for that DM parent returned `source=slack.conversations.replies`, `complete=true`, `next_cursor=null`, and exactly two messages with the above timestamps and author `U0CF1MF96D6`; neither text was truncated. This verifies successful native writes, thread placement, and completed-write idempotency across separate hosted invocations. It does not prove ambiguous-outcome reconciliation or persistence across a deployment. A separate request with `limit=1` still returned both messages with no cursor; pagination continuation therefore remains untested. Channel thread support remains unresolved because access validation prevented creating test parents; a scope failure is not evidence that `conversations.replies` rejects this bot token.

Hosted logs correlate native `tools/call` requests with `owner_match=true`. Representative request IDs: connection info `eb3e4c20eeaa0945d4aabf1e3de1c9ae`; DM parent `210e949ff6ee46aae417f1522cc01488`; parent replay `905bc6b66b1688f3a136a02554187f6a`; reply `e5d5803766234de64d7a3a99656375f5`; reply replay `2c059e1e7584672ed4ab2f98d8f39233`; thread read `0f691329ea28f206425b8bafab74157b`. The initial read/write sequence ran at 20:35:53–20:36:56 UTC (2:35:53–2:36:56 p.m. America/Chicago). Native tool bodies establish success/failure; HTTP 200 alone does not. No signed Slack ingress or event subscription was observed in the bounded log sample, and no acknowledgment-latency claim is made.

Read-only inspection of the live Slack Events page and app manifest established:

- App `A0CDRUNRFK9` is named `evan-assistant`, in workspace `T6BL7UHQF`.
- Events are enabled, but the configured Request URL is `https://ngrok-free.app/slack/events`, displayed as unverified / not responding. Socket Mode is enabled. The configured URL is not the deployed `https://slackdot-compatibility.paryllax.chatgpt.site/slack/events` endpoint.
- Bot event subscriptions include `app_home_opened`, `app_mention`, `message.channels`, `message.groups`, and `message.im`.
- The bot scope list lacks `channels:read` and `groups:read`; those scopes exist only in the user scope list. SlackDot uses the bot token. This matches the public/private access failure at `conversations.info`; DM access succeeds with `im:read`. Changing the app's requested scopes alone is insufficient: the installation must be reauthorized, and the configured runtime bot token must carry the grants.
- The live manifest includes other existing features and user scopes. Do not replace it wholesale with the repository template, remove existing permissions/features, or copy user-token permissions into the prototype. The narrow repair is to add the two specified bot metadata scopes, reauthorize, switch Events to the deployed receiver, and disable Socket Mode for HTTP delivery.

The available tools in this local chat contain the three SlackDot tools and local timer-based automation, but no native event-subscription operation. [Official MCP Events documentation](https://developers.openai.com/plugins/build/mcp-events) specifies Work chats on ChatGPT web, Work chats with Cloud selected on desktop, and dots for MCP Events. No fabricated callback or hand-built authenticated subscription was used as a substitute for that host lifecycle. `CALLBACK_ALLOWED_ORIGINS` remains intentionally unset; callback verification, refresh, unsubscribe, delivery, and end-to-end reply/self-loop checks are not tested. An autonomous scheduler is still unprovisioned; the service-authenticated `/internal/deliver` path remains unchanged.

### Retest after Slack configuration repair, 2026-11-02

After the user reported completing the requested Slack changes, native connection info still matched the configured workspace/bot. Public and private access now succeeds. Run ID `slackdot-native-20261102-02` used fresh request IDs ending in `public-parent`, `public-reply`, `private-parent`, and `private-reply` with clearly labeled synthetic text.

| Conversation | Parent timestamp | Reply timestamp | Result |
|---|---|---|---|
| Public `C0CE0REVDU1` | `1793652278.986149` | `1793652292.627579` | Both writes succeeded; each identical replay returned the original result; complete thread read contained exactly these two messages |
| Private `C0CF32HS0TS` | `1793652282.039119` | `1793652301.277249` | Both writes succeeded; each identical replay returned the original result; complete thread read contained exactly these two messages |

Both reads returned `source=slack.conversations.replies`, `complete=true`, `next_cursor=null`, author `U0CF1MF96D6`, and no truncation. Replies have the correct parent `thread_ts`. Together with the earlier DM run, actual bot-token thread retrieval and successful-write idempotency now pass in all three conversation types. Pagination across multiple pages, ambiguous writes, and persistence across deployment remain untested.

Read-only Slack UI verification showed the Request URL `https://slackdot-compatibility.paryllax.chatgpt.site/slack/events` marked **Verified** and the Socket Mode switch `aria-checked=false`. No Slack configuration or runtime secrets were changed by the agent. Successful channel access demonstrates the installed runtime token now has the needed access; no token value was retrieved.

Hosted logs show real `/slack/events` requests with `slack_ingress` outcome `accepted` and HTTP 200: request `2745d1800ed214ae83b0ddfb476f9005` at 20:44:39.717 UTC (9 ms Worker wall time), `192c1149ae8e209a42821eb3ebb9d8fe` at 20:44:42.631 UTC (9 ms), and `ea9a4bb1b97109c40340f09ce25dc350` at 20:44:53.260 UTC (6 ms). Application `ack_ms` was 0 at the runtime clock's resolution. These callbacks passed signature, freshness, workspace, and app checks and occurred alongside synthetic bot posts. They prove hosted Slack ingress and prompt acknowledgment for filtered bot events, not durable acceptance/fanout of a human message. No message bodies or signing headers were logged in this report, and callback-to-message correlation is temporal rather than payload-based.

Native MCP thread-read request IDs are `d1434e9cb0ca5c41c4dba2d87d3300c5` (public) and `d7da1aa49b0dff845c8d90c9912edb9c` (private). Native calls continued to show owner authorization. The application and existing version 5 deployment remain unchanged. Callback allowlist, native subscription lifecycle, human-message durable acceptance, event-driven replies, and autonomous retry remain the next feasibility checks.

### Native dot subscription attempt and version 6 repair, 2026-11-02

The user relayed a dot test: identity and event discovery passed; actual native subscription returned status ERROR with an unexpected-task-service error and user-facing "Unable to complete task request. Try again." The dot's read-only reconciliation found no saved test automation. It did not retry, receive an event, post a reply, or claim unsubscribe succeeded. No callback origin or underlying protocol error was exposed to the dot.

Hosted logs independently confirm an owner-authenticated `events/subscribe` request at 20:52:41.553 UTC (2:52:41.553 p.m. America/Chicago), request ID `39b5fdea365423a280d4f94bcf1c8f00`, followed by `events/unsubscribe` at 20:52:41.778 UTC, request ID `6459e60cce03d4c4beea9f0ad6dfc2b1`. Both used protocol `2026-07-28`, event name `slack.message.created`, and returned HTTP 200. The unsubscribe is consistent with host cleanup, but its purpose/result are not established. Version 5 logs no event-method response bodies or reasons. HTTP 200 is not evidence of a successful subscription or cleanup, and the observed failure cannot yet be attributed to the allowlist.

Inspection against the current [OpenAI MCP Events contract](https://developers.openai.com/plugins/build/mcp-events) found two independent implementation gaps: strict subscribe parsing rejects documented `ttlMs`, and unsubscribe accepts only an ID instead of the documented event/arguments/callback identity. Either is relevant to compatibility, but the actual failed request body was not captured.

The patch, now deployed as **version 6**, accepts a positive integer/null/omitted `ttlMs`, grants the shorter of a requested duration and the 24-hour server maximum (null still grants a finite lifetime), and supports canonical event/filter/callback unsubscribe while retaining owner-scoped legacy ID unsubscribe. It treats an absent callback-origin environment variable as an empty allowlist, returning `callback_policy_unconfigured` instead of a generic TypeError-derived failure. It also adds bounded event-method diagnostics: fixed response outcome/reason categories, numeric protocol error codes, sanitized validation paths, field-presence flags, and an HTTPS callback origin candidate only after owner authorization. Origin candidates are untrusted diagnostic evidence, never automatic allowlist entries. No signing secrets, callback paths/queries/fragments/credentials, raw validation messages, unknown property names, or response bodies are logged.

Validation: TypeScript, all 40 tests, Sites build, and built-Worker smoke passed locally. Regressions cover lifetime bounds, canonical unsubscribe isolation/cancellation/idempotency, callback-policy failure categorization, and diagnostic redaction. The built Worker accepts a synthetic native-format lifetime request and reports `callback_policy_unconfigured`, then accepts native-format cleanup. The production allowlist remains unset; version 6 is deployed with unchanged environment revision 9.

The user explicitly approved publication of this tested patch after automatic approval review initially rejected the escalated Site workflow. Publication succeeded through the existing Site workflow, preserving the current project, plugin, branch, audience, and runtime configuration. Next request one controlled native retry and inspect the bounded diagnostics. Independently verify any actual callback origin before configuring it. Do not post the test marker until a native subscription is confirmed successful. The deployment record above identifies the published version.

### Version 6 native retry and callback-origin evidence, 2026-11-02

The dot reported exactly one retry initiated at 21:02:57.627 UTC (3:02:57.627 p.m. America/Chicago), with no saved test automation before or after the task-service ERROR. Version 6 logs resolve the previously hidden application result:

- `events/subscribe`, request `d2c09dc709af6ace6c74aa91930a9c24`, received at 21:02:58.596 UTC with `owner_match=true`, expected event name, arguments/delivery/signing-secret present, and `ttl_ms_state=absent`. It returned JSON-RPC error `-32015`, reason `callback_policy_unconfigured`, over HTTP 200 at 21:02:58.640 UTC.
- The callback origin candidate supplied by this actual authenticated native request is `https://connectors.api.openai.com`. No full callback URL or signing secret was exposed.
- Native `events/unsubscribe`, request `c66e23cdda2f5425053801a941f01ef4`, received at 21:02:58.814 UTC with the same origin and expected identity fields, returned a JSON-RPC result at 21:02:58.929 UTC. This proves native canonical cleanup compatibility, not that an active subscription ever existed.

Independent host checks resolved the exact hostname to public addresses `104.18.38.184` and `172.64.149.72`. A TLS connection with normal certificate and hostname verification succeeded; the certificate covers `*.api.openai.com` / `api.openai.com`, issued by Let's Encrypt YE2, valid November 2, 2026 through January 31, 2027. A credential-free HEAD to the origin root returned 404 with no redirect. These independently establish public routing and a valid certificate for the OpenAI hostname; its callback role is evidenced by the authenticated native subscription request. They do not prove the callback challenge or event delivery. No official documentation search result independently listed the exact hostname.

`CALLBACK_ALLOWED_ORIGINS=https://connectors.api.openai.com` was saved as the sole exact allowed origin in Sites environment revision **10**. Automatic approval review initially rejected activation without explicit approval of that exact persistent destination; no alternate deployment path was used. The user subsequently explicitly approved activation. Redeployment `appgdep_6ae8fb3b86ec819182013ef99445ca7e` succeeded at 21:06:11 UTC (3:06:11 p.m. America/Chicago), activating revision **10** on the existing saved **version 6** (`appgprj_6ae8ea0e10708191b688ea6b34e404d7~appgver_f78598635c888191a72006638ff380c3`). Source, plugin, Site, and public audience are unchanged. Callback challenge verification and native subscription success require a fresh controlled native attempt; event delivery and autonomous scheduling remain unproven/unprovisioned.

### Callback transport failure and local repair, 2026-11-02

The dot retried once at 21:07:40.498 UTC (3:07:40.498 p.m. America/Chicago), again reporting the generic task-service error and no saved automation. Hosted `events/subscribe` request `142e5191428855bfc5b44c3cda84e028` reached the owner-authorized handler at 21:07:41.772 UTC, with the expected origin and absent `ttlMs`. At 21:07:42.004 UTC it returned JSON-RPC `-32015`, reason `callback_transport_failed`, over HTTP 200. Follow-up canonical unsubscribe `8cfb38947625a0f5660e32020b899c4b` returned a result at 21:07:42.334 UTC. The allowlist rejection is resolved; the failure is now in the signed callback transport path. The sanitized error alone does not expose the underlying production exception.

The built-Worker smoke test was extended to actually call an allowed synthetic callback receiver using the default production transport. Against the version 6 bundle it reproduced `callback_transport_failed`. The callback client stored global `fetch` directly and invoked it as `this.transport(...)`, supplying the callback client as the runtime function's receiver. A **local, not deployed** one-line fix wraps it as `(url,init)=>globalThis.fetch(url,init)`. Rebuilding with only that application change made signed challenge verification and subscription creation pass. The default transport's binding bug is therefore reproduced locally; a real native retry after deployment remains necessary to confirm the hosted failure is resolved.

Validation passes: TypeScript, all 40 tests, Sites build, and enhanced built-Worker smoke. The smoke fixture verifies actual Standard Webhooks signatures, echoes the challenge, checks active subscription persistence, accepts another signed synthetic Slack event, invokes the service-authenticated `/internal/deliver`, verifies the event signature and event ID, checks the outbox row reaches `delivered`, and verifies canonical unsubscribe. This uses an isolated synthetic receiver and does not claim an OpenAI callback pass, autonomous scheduling, or real dot event receipt.

The user explicitly approved publication of this specific fetch-binding patch after automatic approval review initially rejected it as beyond the previous version/configuration approval. No alternate publication path was attempted. The existing Site workflow will publish the tested application change with the user-approved exact origin and environment revision 10 unchanged. Await confirmed deployment before requesting another native retry; do not post the test marker until subscription readiness is established.

### Version 7 deployment, 2026-11-02

After explicit user approval, the callback fetch-binding fix and enhanced Worker regression were published through the existing Site workflow. Source `2753147f2f291e0ab8f111498693f588ccbae2ef`; saved version `appgprj_6ae8ea0e10708191b688ea6b34e404d7~appgver_5d760e8d1b088191a14fe6b37f570a48`; deployment `appgdep_6ae8fcd435588191b6ec6df87ddc963b` succeeded at 21:13:04 UTC (3:13:04 p.m. America/Chicago), with unchanged environment revision **10** and the approved exact OpenAI callback origin. The original Site/plugin, public audience, and `codex-compatibility-prototype` branch are preserved. Native connection identity and hosted public-boundary probes pass after deployment. Native subscription/callback verification now needs one controlled retry; no real OpenAI callback success or event receipt is claimed by the synthetic Worker regression. The autonomous scheduler is still unprovisioned.

### Native subscription success, 2026-11-02

The user relayed the dot's successful single attempt, initiated at 21:14:04.140 UTC (3:14:04.140 p.m. America/Chicago): ChatGPT returned "Automation created" and enabled a native `slack.message.created` subscription for `{"conversation_id":"C0CE0REVDU1"}`. The dot retained it without a polling schedule and sent no Slack messages.

Hosted version 7 logs independently confirm request `cb75933b70598f562dfe9f7a0bb36329`: owner-authorized `events/subscribe` at 21:14:05.116 UTC, expected event/filter/delivery fields, no `ttlMs`, and callback origin `https://connectors.api.openai.com`. The handler returned a JSON-RPC result at 21:14:05.612 UTC (HTTP 200, Worker wall time 520 ms). In the deployed code, a fresh subscription cannot return this result before successful signed challenge verification and D1 persistence. Combined with the dot's enabled automation, this passes native subscription forwarding, callback verification, and initial durable subscription creation. No callback secret, full URL, or raw response was captured. Default granted lifetime is 24 hours; native refresh is not yet tested.

This does not prove delivery of an application event. No post-subscription synthetic human message or event-driven reply has been tested. The receiver persists matching work but does not invoke the outbox runner; `/internal/deliver` requires service authentication. No autonomous scheduler is provisioned. The next phase needs an authenticated one-shot runner or an explicitly selected external scheduler, then a synthetic human marker and observed native event receipt/reply. Do not rely on Slack traffic or the open browser to run the outbox, and do not interpret an idle subscription as a delivery failure while no runner exists.

### One-shot delivery test preparation, 2026-11-02

The user selected a manually triggered one-time test before provisioning a scheduler. The existing `DELIVERY_TRIGGER_SECRET` was configured as a non-readable Sites secret; it could not be recovered for a manual request. A fresh 32-byte cryptographically random credential was generated into session memory and saved directly as a Sites secret, without printing it or writing it to disk. Only this key changed, creating environment revision **11**. The existing saved version **7** was redeployed without application/source changes; deployment `appgdep_6ae8fec09c9481919e3a1e5f9660b23a` succeeded at 21:21:14 UTC (3:21:14 p.m. America/Chicago). Native connection identity still passes. The approved callback origin, subscription storage, Site/plugin, and audience are unchanged.

Local operator script `scripts/run-delivery-once.mjs` is prepared and syntax-checked. It accepts the service credential through hidden stdin, sends one POST to the fixed existing `/internal/deliver` endpoint with redirects disabled and a bounded timeout, and reports only timestamps, HTTP status, and the bounded processed count. It does not retry ambiguous outcomes, expose response bodies/credentials, create a schedule, or add a production route. No authenticated delivery call has been made yet.

The preparation called for a human marker and one authenticated trigger invocation. Its earlier expectation of a threaded Slack reply was incorrect: the actual automation specified a private ChatGPT notification. The deployed runner scans due jobs (up to ten); its processed count alone does not prove successful callback receipt. The following result supersedes the preparation status above.

### Manual native event delivery passed, 2026-11-02

The user posted synthetic marker `SLACKDOT-E2E-20261102` in public channel `C0CE0REVDU1`, parent timestamp `1793654948.939839`. Native prototype thread reads independently confirmed the exact human-authored marker. Hosted ingress request `5da5525a238f5cff185adbf531b8c06e` at 21:29:10.826 UTC returned HTTP 200 with accepted outcome, `ack_ms=184`, and Worker wall time 208 ms. Unlike the earlier filtered bot callbacks, this test exercises durable human-message acceptance and fanout.

One authenticated delivery invocation completed at 21:33:08.160–21:33:11.794 UTC with HTTP 200 and `processed=1`. Hosted `/internal/deliver` request `a4d93340aeda2b083efec82a60ce95f4` was recorded at 21:33:09.703 UTC. An earlier local stdin failure was reconciled against hosted logs before the successful invocation; it produced no observed delivery request. No automatic retry or scheduler was introduced, and no further delivery invocation was made.

The user relayed the dot's successful native event-run result: event `slack.message.created`, event ID `evt_5de5accc1c7a9dc322da241c0f0421e9f462e4e1f981cc8fe5618a6944773491`, occurrence 21:29:08 UTC (3:29:08 p.m. CST). The dot reported native receipt and exact-marker verification using the prototype's thread-read tool. It notified its private ChatGPT chat as its automation instructed. This passes Slack-to-native-ChatGPT delivery with a manually invoked outbox runner; it does not rely solely on the runner's processed count.

The native subscription remains enabled. Because it was created before the environment revision 11 redeployment and delivered this later event, hosted active-subscription persistence across deployment also passes. No Slack reply was sent or expected by the saved automation during this phase. Unattended triggering, hosted delayed retry, native refresh, active unsubscribe, and pending-outbox persistence across deployment remain untested.

### Manually requested threaded reply passed, 2026-11-02

After native event receipt, the user separately requested the Slack reply phase. The supplied prompt instructed Dot to use only the SlackDot prototype, check for an existing identical reply, post once under parent `1793654948.939839` in `C0CE0REVDU1`, verify by reading the thread, and retain the subscription.

The user relayed Dot's result: it sent “SlackDot threaded reply test passed.” once as the SlackDot bot and verified it in the thread, with reply timestamp `1793655609.123899`. The user also independently confirmed that the original message and threaded reply are visible in Slack. This passes the manually requested reply phase based on Dot's reported verification and the user's visual confirmation. Combined with the earlier native event receipt, the manually operated Slack-to-Dot-to-Slack test is complete. It does not establish automatic Slack reply behavior, because the saved automation specified a private ChatGPT notification and this reply was requested separately. The subscription remains enabled; no unsubscribe was requested or performed as part of this phase.

### Live-test handoff

Use the existing checkout and native plugin above. Start with `slack_get_connection_info`; verify workspace `T6BL7UHQF`, app `A0CDRUNRFK9`, bot user `U0CF1MF96D6`, and bot ID `B0CF1MF7L4Q` (obtained from hosted auth.test). The user explicitly authorized synthetic messages and threaded replies in public channel `C0CE0REVDU1`, private channel `C0CF32HS0TS`, and bot DM `D0CE751HZMY`. The user configured `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` as Sites secrets; never retrieve or print their values.

Public/private/DM posting, replay, and thread reads are complete. Slack HTTP configuration, human-message durable acceptance, native callback verification, and native event receipt with one manual runner invocation pass. The intended dot retains an enabled native public-channel subscription; reuse/reconcile it rather than creating a duplicate. The exact observed and independently checked origin `https://connectors.api.openai.com` is active in `CALLBACK_ALLOWED_ORIGINS`. Do not substitute the unrelated general Slack connector, which cannot access these IDs. The configured private ChatGPT notification and a subsequently requested threaded Slack reply both succeeded. The external delivery scheduler has not been provisioned, and automatic Slack reply behavior has not been tested; do not claim unattended delivery or replies. Preserve the current plugin, Site, audience, and owner checks.

Minimal auxiliary design: a separately operated durable scheduler invokes POST `/internal/deliver` once per minute over HTTPS with a 32-byte random bearer secret, retries failed invocations, and alerts on repeated failures. Each invocation scans due D1 rows, recovering the persist-before-schedule gap even after deployment. Store the bearer only in the scheduler's secret store and Sites runtime settings. The scheduler must keep running without a browser or Slack traffic. Provisioning it requires a separate explicit service choice; it has not been provisioned.

Retain the application modules, D1 schema, SDK adapter and focused regression tests. Before full implementation, demonstrate the real callback allowlist, native owner tool invocation/event forwarding, Slack thread support, hosted acknowledgment timing and durable wake-up. Replace the external-trigger dependency with a Sites-native trigger only if actual supported provisioning is established. Retain conservative ambiguous-write behavior until reconciliation is implemented. Add production retention monitoring and operational diagnostics; cleanup runs only when the delivery trigger runs. The full tool catalog, edits/reactions, discovery and broader product work remain deferred. Keep the implementation branch while the feasibility gate is open; integration into main is deferred until the remaining boundary evidence is resolved.

## Sources checked

- [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events)
- [Connect and test your plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt) (new conversation after installation/refresh)
- [MCP TypeScript v2 SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/packages/server)
- [Slack custom receivers](https://docs.slack.dev/tools/bolt-js/concepts/receiver/)
- [Workers Request / resolveOverride](https://developers.cloudflare.com/workers/runtime-apis/request/)
- Installed Sites 1.1.2 skill: MCP server, identity/secrets, storage and publishing references.
