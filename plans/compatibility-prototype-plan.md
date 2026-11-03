# SlackDot compatibility prototype plan

Status: Steps 6–8 complete. Sites-only bounded-delivery feasibility passed on clean version 9, including automatic public/private/DM round trips and controlled hosted failure feedback. The decision, evidence, accepted limitations, and transition checkpoint are recorded in [results](compatibility-prototype-results.md). External schedulers/services remain explicitly disallowed; full-product work is subsequent scope.

**Superseded storage design:** this completed prototype used operational persistence. The current [specification](specification.md) permits subscriptions only. Its old outbox, receipt, write-ledger and notice-state requirements below are historical, not instructions for further implementation; use [the revised implementation plan](implementation-plan.md).
Last updated: 2026-11-02  
Target specification: [SlackDot specification](specification.md)

## 1. Objective

Determine whether the intended single-dot, single-bot Slack integration can run entirely through ChatGPT Sites, including native MCP Events, automatic delivery after Slack acknowledgment, bounded background retries, and best-effort threaded failure feedback.

Prove one complete path:

> A person posts in an explicitly selected Slack conversation; a public Site accepts the signed event; a subscribed dot receives an MCP event; the dot sends a threaded reply through Bolt.

Also prove a short transient-failure retry inside the originating request's `waitUntil()` window, without another Slack event, an open browser, a manual trigger, or an external scheduler. On exhausted or permanent failure, verify terminal state and one best-effort threaded notice. The accepted policy is up to three total attempts within a 20-second aggregate delivery budget, five additional seconds reserved for terminal-state persistence/feedback, and safety margin before the 30-second platform limit.

This accepted tradeoff supersedes the previous requirement for a retry at least 60 seconds later and guaranteed autonomous recovery after interruption. Durable records remain required; eventual delivery, resumed execution after a crash/deployment, and guaranteed failure notification are not promised. Existing manual-trigger and long-delay experiments remain historical evidence and do not pass the revised automatic path.

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
- Signed callback verification, automatic signed delivery, short budgeted retries, and persisted terminal/notice outcomes.
- One best-effort Slack failure notice per eligible source message, with idempotency, uncertainty handling, and bot-loop suppression.
- Public/private channel and DM smoke checks using manually supplied conversation IDs.

### Defer

- User/channel discovery tools and a full message history interface.
- Reactions, message edits/deletions, advanced filters, and broad catalog coverage.
- A dashboard, Slack Agent View, file handling, group DMs, and search.
- Protocol replay, multiple transports, and general webhook interoperability.
- Multi-dot ownership or routing, even in the prototype.
- Comprehensive performance/load tests and abstractions for hypothetical future hosting providers.

## 3. Repository organization and implementation lifecycle

Build one application, with the compatibility prototype as its first implementation milestone. Code that proves viable becomes the foundation of the full application. Keep disposable experiments and test infrastructure separate; do not maintain parallel prototype and production application trees.

### Proposed layout

```text
SlackDot/
├── plans/
│   ├── specification.md
│   ├── compatibility-prototype-plan.md
│   └── compatibility-prototype-results.md
├── app/                    # HTTP routes and minimal Site page
├── worker/                 # Sites Worker entry point
├── lib/
│   ├── slack/              # Bolt receiver, Slack operations, normalization
│   ├── mcp/                # Protocol handlers, tools, event definitions
│   ├── events/             # Subscriptions, signing, delivery
│   └── runtime/            # Environment, identity, execution integration
├── db/                     # D1 schema and migrations
├── tests/
│   ├── unit/
│   ├── compatibility/      # Hosted integration checks and test harnesses
│   └── fixtures/           # Synthetic Slack events, redacted MCP exchanges
├── experiments/            # Disposable probes, only when needed
├── scripts/                # Sites helpers and operational scripts
├── .openai/
│   └── hosting.json
├── slack-app-manifest.json
├── .env.example
└── package.json
```

Preserve the Sites starter's actual conventions when initializing the application. The tree describes responsibility boundaries, not a requirement to move generated files or create empty directories. Create directories and modules when the prototype needs them.

### Code and test boundaries

- Implement the receiver, owner authorization, three prototype tools, subscription lifecycle, and D1 persistence in the normal application modules. The full application expands these same modules with additional tools and event types.
- Keep HTTP routes thin. Put Slack operations, event processing, and protocol behavior in modules that can be exercised independently of route wiring.
- Put hosted compatibility checks, controlled callback fixtures, and bounded-delivery harnesses in `tests/compatibility`. They must exercise the same application code deployed to Sites; test fixtures are not operational dependencies.
- Put synthetic payloads and redacted protocol fixtures in `tests/fixtures`; do not capture credentials or real private conversation content.
- Use `experiments` only for isolated, disposable questions such as Bolt bundling or a runtime API probe. Keep experiments outside the deployed import graph, move validated findings into application code, and remove obsolete probes.
- Keep fault injection in test infrastructure or a narrowly injected test transport. Do not ship public debugging endpoints or a broad `PROTOTYPE_MODE` that weakens authentication or changes delivery guarantees.
- Start with one package, one dependency graph, and one lockfile. The entire application must deploy through Sites. Do not introduce an external scheduler or separately hosted delivery service.
- Do not prebuild generalized hosting adapters, plugin frameworks, or abstractions for deferred product features.

### Git milestones

- Use a short-lived implementation branch such as `codex-compatibility-prototype`, preserving the required Sites source synchronization workflow.
- Make small commits corresponding to the proof steps so a failed experiment can be understood and revised independently.
- Record the exact tested commit and associated Site version/deployment in the results document.
- At evaluation, preserve the tested prototype with a tag such as `compatibility-prototype-v1`, recording whether the feasibility checks passed or remain blocked. A tag is a reproducibility marker, not a production-readiness claim.
- Integrate the validated application foundation into the main development line. Git history and the tag preserve the prototype; do not retain a second permanent application directory or long-lived prototype branch.

### Transition to the full application

Only after implementing and verifying the accepted bounded-delivery design in Steps 6–7, perform the Step 8 transition checkpoint. Earlier tags preserve historical evidence and do not close this work:

1. Review the compatibility evidence and resolve or document each deployment dependency and blocker.
2. Identify which implementation choices are retained, replaced, or removed. Passing a compatibility check does not automatically make its implementation production-ready.
3. Remove obsolete experiments and test-only deployment behavior. Retain useful automated compatibility checks and fixtures as regression coverage.
4. Update the specification with confirmed findings and any explicitly accepted changes.
5. Plan the remaining product work against the full specification's acceptance criteria, then expand the same application incrementally.

This checkpoint does not expand the prototype's scope. Deferred product features remain subsequent work, and the full specification determines production readiness.

## 4. Preconditions and inputs

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

## 5. Evidence to collect

Create `plans/compatibility-prototype-results.md` during execution. Record:

- Dependency versions, build/runtime configuration, and protocol version.
- The exact tested Git commit and prototype tag, when created.
- Site/version/deployment identifiers and the Site-created plugin identifier.
- Each hypothesis as passed, failed, or not tested, with the date and observed behavior.
- Redacted MCP request/response fixtures and HTTP status results.
- Slack ingress acknowledgment timing and deduplication evidence.
- D1 readback showing subscriptions and pending work survive a new invocation/deployment.
- Timelines showing Slack acknowledgment before callback completion, attempts/backoff within the aggregate budget, and notice completion or recorded failure before the deadline.
- Terminal state, stable event IDs, notice idempotency, and interruption evidence; distinguish retained state from resumed execution.
- Sites-only deployment and confirmation that normal delivery needs no manual trigger, browser, schedule, or external execution service.
- Unresolved questions and precise implementation consequences.

Do not store bot tokens, signing secrets, callback secrets, callback URLs containing credentials, or real message content in that report. Use synthetic test text and redacted identifiers where practical.

## 6. Work packages

### Step 1: Establish a minimal Sites runtime

1. Recheck the relevant Sites hosting instructions and the current OpenAI MCP Events profile.
2. Initialize the supported server starter in the repository on the prototype implementation branch, preserving its Sites build integration and following the repository organization above. Implement the prototype in the normal application modules.
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
3. Confirm OpenAI accepts the signed event and the dot receives its expected payload. Rerun this check after Step 6 without invoking `/internal/deliver`; previous manual-trigger passes are the integration baseline only.
4. Have the dot call `slack_get_thread` if context is needed, then `slack_send_message` with the source message's thread timestamp.
5. Confirm the reply appears in the correct thread as the bot.
6. Confirm the bot's own message does not trigger another automatic delivery/reply.
7. Repeat a narrow smoke check in the private test channel and bot DM, using separately configured subscriptions and known IDs.
8. Exercise `conversations.replies` for public-channel, private-channel, and DM threads. Record actual token behavior and pagination; do not infer results from the conflicting documentation.

Exit evidence: at least one actual Slack -> Sites -> MCP Events -> dot -> MCP tool -> Slack round trip, plus explicit results for each tested conversation type.

### Step 6: Implement and verify bounded Sites-only delivery

This is required implementation and verification within the compatibility prototype, before decision and handoff. Use specification sections 6 and 10 as the behavioral contract. Do not provision or propose external execution infrastructure.

1. Pass the Sites execution context into ingress orchestration. After successful durable acceptance, register direct delivery work with `ctx.waitUntil()` and return Slack's response promptly. Do not await callback completion on the acknowledgment path or call the Site over HTTP to start its own delivery.
2. Persist original deadlines and attempt/claim state. Use up to three total attempts per event/subscription within one request-wide 20-second delivery budget, with short exponential backoff (initial target one second, then two seconds). Reserve the next five seconds for terminal-state persistence and feedback, leaving safety margin. Bound and cancel all network calls, including Slack authorization checks, against remaining time; verify fanout cannot multiply the shared budget.
3. Preserve callback identity/body across retries and generate fresh signatures. Honor Retry-After, stop early when another attempt cannot fit, and handle permanent responses without retry. Recheck owner/subscription/access validity and retain atomic claims. Duplicate ingress and later invocations must not restart budgets or revive terminal/expired jobs.
4. Treat callback `2xx` as delivery success without waiting for Dot's task/reply. On exhausted or permanent failure, persist terminal state and retain diagnostic records. On cancellation/revoked access, stop safely. Classify interrupted expired records when later observed, without promising another execution source.
5. Implement one best-effort notice per source message in its correct Slack thread, using persisted notice/write idempotency and the specification's uncertainty-aware wording. Suppress generic failure notices if any matching delivery was accepted, or for unmatched/intentionally cancelled events. Record notice sent/failed/ambiguous state; do not blindly resend uncertain Slack writes. Filter notice-generated bot events from delivery.
6. Add deterministic deadline/backoff/state tests and built-Worker tests that exercise actual background execution, not just a directly invoked drain. Hold a synthetic callback open to prove Slack acknowledgment precedes delivery completion. Inject one transient failure followed by success, repeated failures, permanent rejection, long Retry-After, cancellation, and notice failure. Assert attempt and total-time limits, terminalization, deduplication, and no self-loop.
7. Test interruption before background registration, during a callback, and during a notice. Verify persisted state survives a new invocation/deployment and original deadlines still apply. Record that automatic recovery and a failure notice are not guaranteed; do not mislabel surviving records or a manually resumed job as autonomous success.
8. Publish through the existing Sites workflow and rerun the live public/private/DM marker round trips using explicit Dot reply instructions, without a manual delivery invocation, browser keepalive, further Slack traffic, or scheduler. Verify real callback acceptance, thread placement, and no bot loops. Existing subscriptions and authorized test conversations should be reused where appropriate.
9. Verify the exhaustion-to-Slack-notice path with a controlled synthetic failure fixture and real authorized Slack test thread in the hosted runtime. Use narrowly scoped, authenticated test infrastructure or an injected test transport; never fabricate a real OpenAI response, broaden the production callback allowlist, add public debug endpoints, or deliberately break real subscriptions. Keep any test-only deployment behavior isolated and remove it before final handoff. If hosted failure-path verification cannot safely be performed, record it as incomplete rather than substituting a local-only pass.
10. Record tested source/deployment, acknowledgment and background timings, attempt counts, persisted outcomes, and the notice or its accurately recorded failure. Update setup/capability descriptions to remove the obsolete external-scheduler requirement; keep any manual endpoint explicitly diagnostic. Preserve useful regression coverage and identify older long-delay experiments as superseded evidence.

Exit evidence: automatic hosted delivery and live replies without manual triggering; bounded transient retry and exhausted/permanent failure with terminal state and verified best-effort feedback; honest interruption/notification-failure outcomes. All required checks must pass or have an explicit unresolved blocker before Step 8 records an outcome. This design does not require or claim a retry beyond the originating background window.

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
| Automatic post-acceptance delivery | Hosted callback begins without a manual trigger; Slack acknowledgment is not delayed by callback latency. |
| New request/deployment/interruption | Persisted subscription/delivery/notice state survives; expired work does not restart. No guaranteed resumed execution is claimed. |
| Transient delivery failure | Same ID/body, fresh signature, short backoff, at most three total attempts within the shared delivery budget. |
| Non-retryable delivery response | Terminal state without retry; best-effort failure feedback where appropriate. |
| Attempts exhausted or deadline reached | No further callback attempt; retained terminal record and bounded notice attempt. |
| Retry-After exceeds remaining budget | No premature retry; terminal reason and best-effort feedback. |
| Slow authorization/callback/database | Aggregate deadline governs all work; no new attempt consumes the notice reserve; uncertainty is recorded if persistence fails. |
| Callback accepted, Dot reply delayed | Delivery remains successful; no failure notice for asynchronous task latency. |
| Duplicate/overlapping subscriptions and ingress | Shared budget, per-delivery claims, no reset deadlines, and one logical notice; suppress generic failure if any delivery succeeded. |
| Slack notice rate-limit/error/ambiguous write | Record actual notice outcome without blind resend, duplicate, or false notification claim. |
| Failure-notice bot event | No delivery or notice loop. |
| Unsubscribe or expiration with a pending job | No subsequent send once the handler observes inactive/expired state. |
| Revoked bot access | No further Slack data delivery; clear diagnostic state. |
| Repeated completed write request | Returns stored result without a second Slack post. |
| Public/private/DM thread retrieval | Actual support recorded; partial or unsupported behavior reported honestly. |

Do not build an exhaustive SDK test suite. Test the application's failure boundaries and the compatibility claims this prototype exists to establish.

### Step 8: Record the decision and handoff

Do not advance to final decision/handoff until the Step 6 implementation and Step 7 verification have been completed and assessed. Existing core-integration results and historical tags are not acceptance of the new design. Then complete the results document with one of these outcomes:

1. **Sites-only feasible under the accepted bounded contract:** Bolt, protected MCP, native events, automatic post-acceptance delivery, short retries, terminal state, and best-effort threaded failure feedback are verified. State clearly that interruption can prevent delivery and feedback.
2. **Core integration verified; bounded delivery/feedback incomplete:** Identify the specific implementation or verification gap and keep the prototype open. Do not substitute external infrastructure or declare handoff complete.
3. **Material compatibility blocker:** A core boundary fails, such as Bolt runtime support, trusted owner authorization, event methods through the native plugin, or safe callback delivery. Describe the smallest viable alternative and which accepted requirement it would change.

Update the main specification only with confirmed findings and clearly identified proposed changes. Do not declare the full product implemented when only the prototype passes.

Record the tested commit/deployment and preserve the evaluated prototype with the Git milestone described above. Complete the transition checkpoint, documenting retained code and required replacements before planning the remaining application features.

## 7. Completion criteria

The prototype work is complete only after implementing and verifying the accepted Sites-only bounded-delivery design and recording its outcome or a concrete blocker. Passing the revised feasibility gate requires:

- Successful hosted Bolt execution and Slack signature verification.
- Public webhook reachability with protected owner-only MCP operations.
- A working subscription through the native Site-created plugin and the intended dot.
- Verified hosted public/private/DM message/reply smoke checks with automatic post-acceptance delivery and no manual trigger or self-loop.
- Persisted subscription/outbox/notice state across invocations and deployment, with unchanged deadlines and honest interruption handling.
- A demonstrated short retry after Slack acknowledgment within the background window, independent of new traffic, with attempt/time limits and Retry-After honored.
- Exhausted/permanent delivery failure becomes terminal; one correctly threaded best-effort notice is verified, and failed/ambiguous notice attempts are reported honestly.
- Success, duplication, cancellation, fanout, and interruption tests establish that the notice cannot create a loop or reset delivery budgets.
- Explicit public-channel, private-channel, and DM thread-read results.
- No secrets exposed in source, logs, documentation, browser responses, or test artifacts.

If a live input is unavailable, mark the corresponding check not tested. If a platform feature fails, record the failure and its consequence. Neither case counts as a passed feasibility gate.

## 8. Expected deliverables

- Minimal TypeScript application using the supported Sites build/deployment structure, in the same application tree that will grow into the full product.
- Slack app manifest, `.env.example` with key names only, and concise setup instructions.
- D1 schema/migrations for the prototype's actual state needs.
- Automatic `waitUntil()` delivery, shared deadline handling, bounded retry policy, and persisted terminal/failure-notice state implemented in the application modules.
- Focused tests and redacted protocol fixtures.
- A public deployed Site and its native plugin connection, if deployment prerequisites are available.
- `plans/compatibility-prototype-results.md` with the evidence and final topology decision.
- A recorded tested Git commit/prototype tag and transition notes identifying retained code, temporary choices to replace, and the remaining full-application work.

This plan does not authorize building deferred product features as part of the prototype. Preserve the single-dot constraint and keep the experiment focused on the integration boundaries.
