---
name: use-slackdot
description: Reference for SlackDot MCP tools, event types, subscription filters, and conversation wildcards.
---

# SlackDot MCP reference

Each SlackDot connection serves one bot in one workspace. Supported conversations are joined public/private channels and bot one-to-one DMs. Group DMs and archived or inaccessible conversations are excluded.

## Tools

Names below are the base tool names; the host may add a plugin prefix. Arguments in parentheses are optional. Conversation IDs in tools are always concrete IDs. Slack timestamps are strings.

| Tool | Arguments | Behavior |
| --- | --- | --- |
| `slack_get_connection_info` | None | Returns workspace/bot IDs and supported event types. |
| `slack_list_conversations` | (`types`, `cursor`, `limit`) | Lists accessible conversations. Types: `public_channel`, `private_channel`, `im`. |
| `slack_get_conversation` | `conversation_id` | Returns conversation metadata. |
| `slack_list_users` | (`name_filter`, `cursor`, `limit`) | Lists users; the name filter applies to the current page only. |
| `slack_get_user` | `user_id` | Returns profile information, excluding email. |
| `slack_open_dm` | `user_id` | Opens or retrieves a bot DM and returns its conversation ID; sends no message. |
| `slack_get_messages` | `conversation_id`, (`oldest`, `latest`, `inclusive`, `cursor`, `limit`) | Returns conversation history. Time bounds are exclusive unless `inclusive` is true. |
| `slack_get_thread` | `conversation_id`, `thread_ts`, (`cursor`, `limit`) | Returns a page of the specified thread, subject to token access. |
| `slack_send_message` | `conversation_id`, `text`, (`thread_ts`, `request_id`) | Posts as the bot. `thread_ts` selects a thread; omission creates a top-level post. `request_id` does not deduplicate writes. |
| `slack_update_message` | `conversation_id`, `message_ts`, `text` | Replaces the text of a message authored by this bot. |
| `slack_delete_message` | `conversation_id`, `message_ts` | Deletes a message authored by this bot. |
| `slack_get_reactions` | `conversation_id`, `message_ts` | Returns reactions; `bot_reacted` refers to this bot. |
| `slack_add_reaction` | `conversation_id`, `message_ts`, `emoji_name` | Adds this bot's reaction. Already present returns `changed: false`. |
| `slack_remove_reaction` | `conversation_id`, `message_ts`, `emoji_name` | Removes this bot's reaction only. Already absent returns `changed: false`. |

Paginated tools accept `limit` from 1 to 100. Results expose `next_cursor` and `complete`; filtered pages can be empty while a continuation exists. Message text may be truncated. Reaction participants can be incomplete even when counts are known (`users_complete`). Emoji names omit surrounding colons, for example `eyes`.

Tool failures return `isError` and an error category, sometimes with `retry_after`. `ambiguous_write` means the write's outcome is uncertain; it does not establish failure.

## Events and filters

The MCP event methods are `events/list` (catalog and schemas), `events/subscribe` (create or refresh a webhook subscription), and `events/unsubscribe` (remove a subscription). These are separate from the `slack_*` tools.

Every event requires `conversation_id`, accepting either a concrete ID or literal `"*"`.

| Event | Meaning | Optional filters |
| --- | --- | --- |
| `slack.message.created` | New message | `thread_ts`, `sender_user_ids`, `mentions_only`, `include_bot_messages` |
| `slack.message.updated` | Message edit | `thread_ts`, `sender_user_ids`, `mentions_only`, `include_bot_messages` |
| `slack.message.deleted` | Message deletion | `thread_ts`, `sender_user_ids`, `include_bot_messages` |
| `slack.reaction.added` | Reaction added | `thread_ts`, `actor_user_ids`, `emoji_name` |
| `slack.reaction.removed` | Reaction removed | `thread_ts`, `actor_user_ids`, `emoji_name` |

Filters combine with AND; user-ID arrays match any listed ID. `sender_user_ids` matches the message author, while `actor_user_ids` matches the reacting user. `thread_ts` selects a thread within a concrete conversation. Missing metadata cannot satisfy a filter that requires it.

`mentions_only: true` matches explicit mentions of the configured bot in message text. For edits, it tests the resulting text, not whether the mention was newly added. Other bots' messages are excluded unless `include_bot_messages` is true. This bot's messages and reactions remain excluded; human reactions to its messages are eligible.

Delivered envelopes contain `eventId`, `name`, occurrence `timestamp`, `data`, and `cursor: null`. Data includes the actual `conversation_id` and `message_ts`. Created messages include a known root `thread_ts`; other event types may have null thread or author metadata. Subscription lifetimes default to and are capped at 72 hours, with expiration returned as `refreshBefore`. Replay is unsupported.

## Conversation wildcard

`conversation_id: "*"` matches all supported, currently accessible conversations in this installation, including channels joined later and bot DMs. It cannot be combined with `thread_ts`. Partial globs such as `C*`, arrays, and omitted conversation IDs are invalid. Tools and event payloads never use wildcard IDs.

Example event name and arguments for bot mentions across conversations (webhook delivery configuration omitted):

```json
{
  "name": "slack.message.created",
  "arguments": {
    "conversation_id": "*",
    "mentions_only": true
  }
}
```

Each matching message must contain a mention, including DMs and subsequent thread replies. Other filters retain their normal meaning. An exact-conversation subscription and a wildcard subscription can both receive the same event; duplicate suppression operates separately for each subscription. Losing access to one conversation preserves the wildcard subscription for others.
