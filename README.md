# SlackDot

> One Dot to ping them all,  
> One Dot to find them,  
> One Dot to bridge them all,  
> And in the Slackness bind them.

SlackDot lets a single Dot send and receive messages in multiple Slack workspaces. Each workspace gets its own Slack bot, each connected through a lightweight bridge deployed automatically on ChatGPT Sites. No external infrastructure needed!

MCP 2.0 event subscriptions are supported, so the Dot can create event-triggered automations.

Start with a private conversation: DM your SlackDot bot, and your Dot replies in the same thread. You can also invite the bot to channels and ask your Dot to respond to mentions or messages from specific users.

## Install with Codex or ChatGPT Work

Use **Codex or a ChatGPT Work cloud session** with the Sites and Plugin Creator plugins available to build, deploy and configure SlackDot. You need permission to install a Slack app in your workspace. Once installation is ready, your intended **Dot in ChatGPT** will connect the plugin and create the event-triggered automation.

Give your installation agent this prompt:

```text
Read https://github.com/evansumarosenberg/SlackDot/blob/master/README.md and follow its installation instructions to set up SlackDot for me.
```

**Installation agent: read [AGENTS.md](AGENTS.md), then follow [docs/install.md](docs/install.md) in order.** The installation guide is the canonical procedure, including manual handoffs, configuration, verification and the prompt to give the Dot.

You will create/install the Slack app and enter only these four Site environment values when prompted:

```dotenv
SLACK_APP_ID=
SLACK_SIGNING_SECRET=
SLACK_BOT_TOKEN=
SLACK_BOT_USER_ID=
```

The installation agent configures the remaining values. You may also need to sign in, approve the plugin connection, identify your own Slack member account, and send a test DM. Some authenticated steps may need your browser or a supported secure handoff. Keep secrets out of chat.

To connect another Slack workspace, instruct your agent to repeat the setup with a separate Slack app, Site, and plugin. Make sure to give each installation a recognizable workspace label so your Dot uses the right connection.

## Privacy

SlackDot stores event subscriptions and opaque, privacy-preserving records that suppress repeat event delivery for three hours. Expired records are removed on subsequent activity; no message content or delivery history is retained.

