# SlackDot

**One Dot, Many Slacks.**

SlackDot lets a single Dot send and receive messages in multiple Slack workspaces. Each workspace gets its own Slack bot, each connected to the Dot through an MCP server that is automatically deployed on ChatGPT Sites. MCP 2.0 event subscriptions are fully supported, so the Dot can create event-triggered automations.

Start with a private conversation: DM your SlackDot bot, and your Dot replies in Slack. You can also invite the bot to channels and ask your Dot to follow specific conversations.

## Install with Codex

Use a **Codex session** with the Sites and Plugin Creator plugins available to build, deploy and configure SlackDot. You need permission to install a Slack app in your workspace. Once installation is ready, your **Dot in ChatGPT** will connect the plugin and create the event-triggered automation.

Give Codex this prompt:

```text
Read https://github.com/evansumarosenberg/SlackDot/blob/master/README.md and follow its installation instructions to set up SlackDot for me.
```

**Codex: read [AGENTS.md](AGENTS.md), then follow [docs/install.md](docs/install.md) in order.** The installation guide is the canonical procedure, including manual handoffs, configuration, verification and the prompt to give the Dot. Do not assume that following a README link automatically loads the other files.

You will create/install the Slack app and enter only these four Site environment values when prompted:

```dotenv
SLACK_APP_ID=
SLACK_SIGNING_SECRET=
SLACK_BOT_TOKEN=
SLACK_BOT_USER_ID=
```

Codex configures the remaining values. You may also need to sign in, approve the plugin connection, identify your own Slack member account and send a test DM. Keep secrets out of chat.

To connect another workspace, repeat the setup with a separate Slack app, Site and plugin. Give each installation a recognizable workspace label so your Dot uses the right connection.

## Privacy and delivery

SlackDot stores only the subscriptions needed to deliver events. It does not retain message content or delivery history in its database. Delivery retries are brief and best effort; interruptions can lose events, and duplicate delivery is possible. Slack and ChatGPT retain data according to their own settings.
