# Compatibility prototype results

Evaluation date: 2026-11-02. Status: local implementation validated; hosted evaluation in progress. This is not a production-readiness claim.

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
| Hosted Slack signature/ack latency | Not tested | Requires configured Slack secrets and genuine event |
| Native plugin owner call/events | Not tested | Requires publication, verified identity and dot connection |
| Public header impersonation | Passed initial hosted probe | Anonymous/forged MCP requests both 401 at Sites ingress; forged setup headers redirect to sign-in, without reflecting forged ID. Signed-in owner setup shows a distinct Site-scoped ID |
| Signed-in non-owner | Not tested | Requires second identity |
| Hosted persistence across deployment | Not tested | Local D1 readback does not establish hosted persistence |
| Autonomous delayed retry | Not tested / Sites-only unsupported by inspected contract | No native trigger declared; no external service provisioned |
| Public/private/DM thread reads | Not tested | Mock results do not resolve real bot-token behavior |
| End-to-end Slack → dot → Slack | Not tested | Requires supplied test IDs, secrets, connected dot and callback origin evidence |

Initial direct loopback HTTP preview requests timed out despite Wrangler startup. The in-process Miniflare/workerd smoke test succeeded; no browser-rendering claim is made.

## Deployment record

Site project: `appgprj_6ae8ea0e10708191b688ea6b34e404d7`. Public audience explicitly configured. Published origin: `https://slackdot-compatibility.paryllax.chatgpt.site`.

Initial hosted source commit: `3ee5b7647ca0b2749e5ac49b6853c03e3ed81511`. Site version 1: `appgprj_6ae8ea0e10708191b688ea6b34e404d7~appgver_cce2f7390cfc81918c1b2e31dca452ae`; successful deployment `appgdep_6ae8ed8d2cd88191bd3a9d44d28a0839` at 20:07:54 UTC. Native plugin: `plugin_asdk_app_sites_3783386e839c819182ddea6454d0e5f6`; plugin management reports already installed, but its tools are not yet available to this chat. Installation is not a passed tool/event invocation check.

Owner identity was obtained by an actual Sites sign-in, not inferred from the account ID. Runtime identity trust was enabled only after the hosted public-header probe. Slack secrets were supplied by the user in Sites; encryption and service-trigger secrets were generated directly into secret runtime configuration. No secret values were written to repository files.

The evaluated tag and subsequent deployment evidence will be added after evaluation. No Slack secrets, callback URLs or real message content belong here.

## Topology decision and transition checkpoint

**Full feasibility gate remains blocked on live evidence.** The candidate is Sites with an auxiliary scheduler; neither that topology nor Sites-only reliability is yet proven. Minimal auxiliary design: a separately operated durable scheduler invokes POST `/internal/deliver` once per minute over HTTPS with a 32-byte random bearer secret, retries failed invocations, and alerts on repeated failures. Each invocation scans due D1 rows, recovering the persist-before-schedule gap even after deployment. Store the bearer only in the scheduler's secret store and Sites runtime settings. The scheduler must keep running without a browser or Slack traffic. Provisioning it requires a separate explicit service choice; it has not been provisioned.

Retain the application modules, D1 schema, SDK adapter and focused regression tests. Before full implementation, demonstrate the real callback allowlist, owner identity boundary, native event forwarding, Slack thread support, hosted acknowledgment timing and durable wake-up. Replace the external-trigger dependency with a Sites-native trigger only if actual supported provisioning is established. Retain conservative ambiguous-write behavior until reconciliation is implemented. Add production retention monitoring and operational diagnostics; cleanup runs only when the delivery trigger runs. The full tool catalog, edits/reactions, discovery and broader product work remain deferred.

## Sources checked

- [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events)
- [MCP TypeScript v2 SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/packages/server)
- [Slack custom receivers](https://docs.slack.dev/tools/bolt-js/concepts/receiver/)
- [Workers Request / resolveOverride](https://developers.cloudflare.com/workers/runtime-apis/request/)
- Installed Sites 1.1.2 skill: MCP server, identity/secrets, storage and publishing references.
