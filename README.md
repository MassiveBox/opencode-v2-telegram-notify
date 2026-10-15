# opencode-v2-telegram-notify

OpenCode v2 server plugin that sends a Telegram message when OpenCode needs
you, and when a turn finishes.

* User interaction required: `permission.asked`, `form.created`
* Notable events (default): `session.execution.succeeded`,
  `session.execution.failed`, `session.execution.interrupted`.
* Opt-in: `session.status` (idle), `session.idle`, `session.step.failed`,
  `session.compaction.ended`, or any `prefix.*` wildcard.

It uses `ctx.event.subscribe()` (the `/api/event` stream across all server
locations) and calls the Telegram Bot API with `fetch`. No extra runtime
dependencies.

## 1. Create the Telegram bot

1. Talk to `@BotFather` -> `/newbot` -> copy the token.
2. Start a chat with your bot (send any message).
3. Get your chat id:
   `curl 'https://api.telegram.org/bot<TOKEN>/getUpdates'` and read
   `message.chat.id` (a negative id is a group).
4. Send one message to the bot first, otherwise `sendMessage` returns 403.

## 2. Install

Requires OpenCode v2.

### Option A: local path

Copy this directory somewhere permanent, then add it to your global or
project config (`~/.config/opencode/opencode.jsonc` or `./opencode.jsonc`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/path/to/opencode-v2-telegram-notify",
      "options": {
        "botToken": "123456:ABC-DEF...",
        "chatId": "123456789",
        "prefix": "🖥 homelab"
      }
    }
  ]
}
```

See `opencode.example.jsonc` for all options.

### Option B: from git

```jsonc
{
  "plugins": [
    {
      "package": "git+https://git.boxo.cc/massivebox/opencode-v2-telegram-notify.git",
      "options": { "botToken": "123456:ABC-DEF...", "chatId": "123456789" }
    }
  ]
}
```

### Environment-variable alternative

Instead of writing secrets into config, export them:

```sh
export TELEGRAM_BOT_TOKEN="123456:ABC-DEF..."
export TELEGRAM_CHAT_ID="123456789" # comma-separated for several chats
```

`ctx.options` wins over the environment. Multiple chats are also possible
with `"chatIds": ["111", "222"]`.

## 3. Restart and verify

```sh
opencode service restart
opencode service status
```

Watch the server log for the plugin line:

```sh
tail -f ~/.local/share/opencode/log/opencode.log | grep opencode-v2-telegram-notify
# [opencode-v2-telegram-notify] listening for permission.asked, form.created, ...
```

Trigger each case:

* Question: ask the agent to use the `question` tool.
* Permission: run something that hits an `ask` rule.
* Turn end: run any prompt and wait for it to finish.

## Configuration

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `botToken` (`token`) | string | `TELEGRAM_BOT_TOKEN` | BotFather token. |
| `chatId` (`chatID`) / `chatIds` | string/number/array | `TELEGRAM_CHAT_ID` | Target chat(s); comma-separated env supported. |
| `notifyOn` | string[] | permission + form + execution events | Exact event types plus `prefix.*` wildcards. |
| `prefix` | string | `TELEGRAM_PREFIX` or `""` | First line of every message (e.g. host name). |
| `includeSessionTitle` | boolean | `true` | Look up `ctx.session.get()` to append the title. |
| `telegramApiBase` | string | `https://api.telegram.org` | Override for tests/proxies. |

Minimal “everything finished or failed” setup:

```jsonc
{ "package": "...", "options": {
  "botToken": "...", "chatId": "...",
  "notifyOn": ["session.execution.succeeded", "session.execution.failed"]
} }
```

Quiet-hours-friendly “only when I must act” setup:

```jsonc
{ "package": "...", "options": {
  "botToken": "...", "chatId": "...",
  "notifyOn": ["permission.asked", "form.created"]
} }
```

## Troubleshooting

* `missing bot token or chat id` — options and env are both empty.
* `Telegram sendMessage failed (401)` — bad token.
* `... (403) ... bot was blocked / chat not found` — you never started the bot, or the chat id is wrong.
* No messages, no log line — plugin not loaded: check the `plugins` path and run `opencode service restart`. Compare with `opencode --standalone`.
* Events are volatile: a slow consumer or a disconnected stream misses events (`SubscriberOverflowError` server-side). This plugin is a notifier, not an audit log.