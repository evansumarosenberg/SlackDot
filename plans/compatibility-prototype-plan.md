# SlackDot compatibility prototype plan

Status: ready for implementation; no steps executed  
Last updated: 2026-11-02  
Target specification: [SlackDot specification](specification.md)

## 1. Objective

Determine whether the intended single-dot, single-bot Slack integration can run through ChatGPT Sites, including native MCP Events and reliable delivery after an HTTP request has ended.

Prove one complete path:

> A person posts in an explicitly selected Slack conversation; a public Site accepts the signed event; a subscribed dot receives an MCP event; the dot sends a threaded reply through Bolt.

Also prove recovery from an outbound delivery failure without another Slack event, an open browser, or a still-running original request.

The prototype is an implementation experiment, not the full application. A documented limitation is an acceptable research result; silently weakening delivery guarantees is not.

## 2. Boundaries

### Implement only what the proof requires

- One Slack workspace, one bot, one controlling dot, and one configured owner.
- A public Site with a minimal non-sensitive landing/health response.
- A custom Bolt receiver and Slack Web API calls in the hosted runtime.
- An authenticated MCP 2.0 HTTP endpoint through the Site-created plugin.
- Three tools: `slack_get_connection_info`, `slack_get_thread`, and `slack_send_message`.
- One event type: `slack.message.created`, requiring `conversation_id` and optionally `thread_ts`.
- Subscription creation, refresh, expiration, and unsubscribe using the OpenAI webhook profile.
- D1 persistence for subscriptions, ingress deduplication, and a minimal delivery outbox.
- Signed callback verification, signed delivery, and a demonstrated durable retry path.
- Public/private channel and DM smoke checks using manually supplied conversation IDs.

### Defer

- User/channel discovery tools and a full message history interface.
- Reactions, message edits/deletions, advanced filters, and broad catalog coverage.
- A dashboard, Slack Agent View, file handling, group DMs, and search.
- Protocol replay, multiple transports, and general webhook interoperability.
- Multi-dot ownership or routing, even in the prototype.
- Comprehensive performance/load tests and abstractions for hypothetical future hosting providers.

## 3. Preconditions and inputs

Before live integration testing, obtain or configure:

1. A Slack development app installed in the intended test workspace, with the scopes and event configuration in the specification.
2. The bot token and signing secret through secure runtime-secret configuration. Never request that credentials be committed or copied into planning documents.
3. Verified workspace ID, bot user ID, and app/bot identity returned by Slack/setup.
4. A dedicated public test channel, a private test channel with the bot invited, and a bot DM with a designated tester.
5. A trusted owner identity for application authorization. Do not bootstrap ownership from an arbitrary public request.
6. A Sites project that can be published publicly, with D1 and the native MCP capability enabled.
7. An OpenAI dot able to install/connect the Site-created plugin and subscribe to events.

No actual Site, Slack app, token, callback URL, or test conversation has been provisioned or supplied by this plan. Missing live credentials do not block local implementation or mock verification; they block the corresponding live acceptance check.

The public audience is an accepted design decision. The implementation must use the native Sites workflow to configure it explicitly; it must not accidentally leave the MCP data operations publicly callable.

## 4. Evidence to collect

Create `plans/compatibility-prototype-results.md` during execution. Record:

- Dependency versions, build/runtime configuration, and protocol version.
- Site/version/deployment identifiers and the Site-created plugin identifier.
- Each hypothesis as passed, failed, or not tested, with the date and observed behavior.
- Redacted MCP request/response fixtures and HTTP status results.
- Slack ingress acknowledgment timing and deduplication evidence.
- D1 readback showing subscriptions and pending work survive a new invocation/deployment.
- Retry timings showing execution after the original request ended.
- The chosen deployment topology and every external dependency, if any.
- Unresolved questions and precise implementation consequences.

Do not store bot tokens, signing secrets, callback secrets, callback URLs containing credentials, or real message content in that report. Use synthetic test text and redacted identifiers where practical.

## 5. Work packages

### Step 1: Establish a minimal Sites runtime

1. Recheck the relevant Sites hosting instructions and the current OpenAI MCP Events profile.
2. Initialize the supported server starter in the repository, preserving its Sites build integration.
3. Add the MCP and D1 declarations through the supported manifest workflow.
4. Pin compatible TypeScript, Bolt, MCP SDK, schema-validation, and Standard Webhooks dependencies.
5. Implement a public non-sensitive `/health` response and fail clearly when required runtime secrets are absent.
6. Build locally under the Workers-compatible environment; publish through Sites when the minimal hosted proof is ready.

Exit evidence: a successful Sites build/deployment and an actual hosted request exercising the relevant imported dependencies. A local Node.js success alone does not pass this step.

### Step 2: Prove public ingress and protected MCP access

1. Publish the Site with the accepted public audience.
2. Add `/mcp` discovery, tool listing, and the read-only `slack_get_connection_info` tool.
3. Use Sites' trusted identity mechanism to authorize the configured owner for protected methods.
4. Connect the plugin created by Sites; do not create a second plugin as a workaround before testing the native path.
5. Verify a real owner call reaches the handler with usable identity.
6. Verify anonymous calls and externally supplied identity-header impersonation cannot invoke tools or subscription methods.
7. Test a signed-in non-owner when a second test identity is available; otherwise mark that check untested rather than passed.
8. Determine whether plugin metadata discovery requires an explicitly permitted non-sensitive public catalog response. Document that exception if needed.

Exit evidence: the owner can invoke a read-only tool through the native plugin; the public URL does not confer Slack access. Failure to establish a trustworthy owner identity is an architecture blocker, not a reason to disable authorization.

### Step 3: Prove Bolt reception and Slack writes

1. Implement the Fetch-compatible Bolt receiver, preserving the raw body and explicitly managing acknowledgment timing.
2. Verify signatures and request freshness; support Slack's URL challenge.
3. Use D1 migrations to create ingress and minimal outbox storage.
4. Persist incoming test events before acknowledging them. Keep network calls to OpenAI outside the Slack acknowledgment path.
5. Establish the fixed Slack workspace/bot identity with `auth.test` in a supported setup/request path.
6. Configure Slack's Events API URL and relevant bot subscriptions.
7. Implement `slack_send_message`, including an application request ID and persisted successful result.
8. Receive a real message and post one explicitly authorized test reply through the plugin/tool path.
9. Repeat the write with the same request ID to verify a completed operation is not duplicated. Record the remaining ambiguous-network-outcome limitation.

Exit evidence: the hosted Bolt receiver accepts a genuine Slack event, rejects an invalid signature, acknowledges successful durable acceptance within three seconds, and the bot can post through the hosted MCP tool.

### Step 4: Implement and verify the minimum event lifecycle

1. Advertise `events` and implement `events/list` for `slack.message.created` on `/mcp`.
2. Define the minimal `conversation_id`/optional `thread_ts` filter schema and bounded payload schema.
3. Implement authorized `events/subscribe` with deterministic identity and canonical argument handling.
4. Validate callback URLs and signing secrets; prove the selected callback-destination restrictions work in Workers. Reject redirects and prohibited destinations before releasing data.
5. Complete signed callback challenge verification and persist the subscription with an encrypted signing secret and finite expiration.
6. Implement idempotent refresh and unsubscribe. Use `cursor: null` and do not claim replay.
7. Implement signed outbound delivery with stable event ID and a fresh timestamp/signature per attempt.
8. Register/refresh the Site plugin's catalog using the supported workflow and confirm the dot can discover the event.
9. Ask the controlling dot to monitor the test conversation with a concrete test response instruction.

Exit evidence: the actual native Site plugin forwards event discovery and subscription operations, callback verification succeeds, and a durable subscription is stored. Merely invoking the methods from a hand-built HTTP client does not prove Dot compatibility.

If the native plugin supports tools but not events, record the exact observed failure and supported alternatives. Do not silently substitute an unrelated plugin or a polling loop.

### Step 5: Prove the end-to-end conversation

1. Post synthetic text in the subscribed public test channel.
2. Confirm the ingress event is normalized and one delivery record is created.
3. Confirm OpenAI accepts the signed event and the dot receives its expected payload.
4. Have the dot call `slack_get_thread` if context is needed, then `slack_send_message` with the source message's thread timestamp.
5. Confirm the reply appears in the correct thread as the bot.
6. Confirm the bot's own message does not trigger another automatic delivery/reply.
7. Repeat a narrow smoke check in the private test channel and bot DM, using separately configured subscriptions and known IDs.
8. Exercise `conversations.replies` for public-channel, private-channel, and DM threads. Record actual token behavior and pagination; do not infer results from the conflicting documentation.

Exit evidence: at least one actual Slack -> Sites -> MCP Events -> dot -> MCP tool -> Slack round trip, plus explicit results for each tested conversation type.

### Step 6: Resolve durable execution and delayed retries

This step is a required feasibility test, not optional production hardening.

1. Inspect the supported Sites deployment capabilities for native queue consumers, scheduled triggers, or other durable wake-up mechanisms. Distinguish generic Cloudflare features from features actually configurable through Sites.
2. If a native mechanism is supported, provision a minimal instance through the supported workflow and connect it to the D1 outbox.
3. Claim work atomically, check subscription validity before sending, and persist retry/outcome state.
4. Inject a controlled transient failure before a delivery succeeds. Do not fabricate a production OpenAI callback response; use a bounded test seam or an authenticated test receiver.
5. Schedule the successful retry at least 60 seconds later, after Slack's original request and its `waitUntil()` window have ended.
6. Close the browser and send no further Slack messages. Confirm the retry occurs solely through the durable trigger.
7. Repeat with pending work across a deployment or simulated interruption. Verify recovery of work saved before its execution trigger was established.
8. Separately verify that an event delivered after recovery is accepted by the real OpenAI callback.
9. If native execution is unavailable, document a concrete minimal external queue/scheduler design and its authentication, failure, and deployment implications. Record Sites-only reliability as unproven/unsupported by the inspected interface. Do not provision new external services or silently claim a Sites-only result.

Exit evidence: either demonstrated durable recovery under the chosen topology, or a precise blocker identifying the additional service needed. Persisting a pending row without an autonomous recovery path is a failed reliability test.

### Step 7: Run the focused lifecycle and failure checks

Use the following matrix. Prefer deterministic local tests for transformations and authorization, then exercise the boundaries that require real Sites, Slack, and OpenAI behavior.

| Check | Expected result |
| --- | --- |
| Anonymous protected MCP call | Rejected without reading Slack or modifying data. |
| Forged owner header on public ingress | Rejected or stripped by the trusted platform boundary; cannot impersonate owner. |
| Invalid/stale Slack signature | Rejected without creating application work. |
| Slack URL challenge | Correct response, no message delivery. |
| Slow/failed durable acceptance | No successful acknowledgment of unpersisted work. |
| Repeated Slack event ID | One logical ingress occurrence and one delivery per matching subscription. |
| Message plus mention notification | No duplicate logical delivery. |
| Bot's own reply | No event-driven response loop. |
| Nonmatching conversation/thread | No delivery. |
| Repeated subscribe with reordered argument keys | Same logical subscription, updated expiration. |
| Callback verification failure | No active delivery subscription; compatible protocol error. |
| Private/local callback or redirect | Rejected by the validated callback policy. |
| New request/deployment | Existing subscription and accepted pending work remain usable. |
| Transient delivery failure | Stable event ID; fresh signature; delayed retry occurs autonomously. |
| Non-retryable delivery response | Delivery becomes terminal according to the client profile. |
| Unsubscribe or expiration with a pending job | No subsequent send once the handler observes inactive/expired state. |
| Revoked bot access | No further Slack data delivery; clear diagnostic state. |
| Repeated completed write request | Returns stored result without a second Slack post. |
| Public/private/DM thread retrieval | Actual support recorded; partial or unsupported behavior reported honestly. |

Do not build an exhaustive SDK test suite. Test the application's failure boundaries and the compatibility claims this prototype exists to establish.

### Step 8: Record the decision and handoff

Complete the results document with one of these outcomes:

1. **Sites-only feasible:** Bolt, authenticated MCP tools, native plugin events, D1 persistence, and autonomous retries have all been demonstrated through Sites-supported deployment capabilities.
2. **Sites with an auxiliary delivery service feasible:** The core application works in Sites, but reliable background execution needs an external queue/scheduler. Identify the dependency and the remaining implementation/validation work.
3. **Material compatibility blocker:** A core boundary fails, such as Bolt runtime support, trusted owner authorization, event methods through the native plugin, or safe callback delivery. Describe the smallest viable alternative and which accepted requirement it would change.

Update the main specification only with confirmed findings and clearly identified proposed changes. Do not declare the full product implemented when only the prototype passes.

## 6. Completion criteria

The prototype work is complete when the compatibility questions have concrete evidence and the results document explains the viable topology or blocker. Passing the full feasibility gate requires:

- Successful hosted Bolt execution and Slack signature verification.
- Public webhook reachability with protected owner-only MCP operations.
- A working subscription through the native Site-created plugin and the intended dot.
- One verified end-to-end message/reply cycle without a self-trigger loop.
- Persisted subscription/outbox state across invocations and deployment.
- A demonstrated retry after the original request lifetime, independent of new traffic.
- Explicit public-channel, private-channel, and DM thread-read results.
- No secrets exposed in source, logs, documentation, browser responses, or test artifacts.

If a live input is unavailable, mark the corresponding check not tested. If a platform feature fails, record the failure and its consequence. Neither case counts as a passed feasibility gate.

## 7. Expected deliverables

- Minimal TypeScript application using the supported Sites build/deployment structure.
- Slack app manifest, `.env.example` with key names only, and concise setup instructions.
- D1 schema/migrations for the prototype's actual state needs.
- Focused tests and redacted protocol fixtures.
- A public deployed Site and its native plugin connection, if deployment prerequisites are available.
- `plans/compatibility-prototype-results.md` with the evidence and final topology decision.

This plan does not authorize building deferred product features as part of the prototype. Preserve the single-dot constraint and keep the experiment focused on the integration boundaries.
