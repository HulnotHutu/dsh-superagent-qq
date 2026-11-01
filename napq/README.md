# napq

`napq` is a standalone, dependency-free Python 3 CLI that speaks the CLI contract of the
[QQ Source](../docs/009-qq-source.md) through a local OneBot v11 HTTP API (for example
[NapCat](https://napneko.github.io/)). It is the third transport alongside `gh` (GitHub) and
`lark-cli` (Feishu); the Source never talks HTTP itself.

## Install

```sh
install -m 0755 napq/napq ~/.local/bin/napq   # a directory on the service PATH
```

Requires Python 3.9+ and nothing else.

## Configure

Create `~/.config/napq/config.json`:

```json
{ "baseUrl": "<host:port>", "accessToken": "<token>" }
```

- `baseUrl` — the OneBot v11 HTTP endpoint of your QQ client implementation, without a trailing slash.
- `accessToken` — the shared token of that endpoint. It stays in this file and is never printed.

Replies keep their idempotency keys in `~/.config/napq/replied.json`, so a retried reply never posts twice.

## Commands

| Command | Purpose |
| --- | --- |
| `napq pull --groups <id,id> --after '<json map>' --json` | Fetch each group's recent messages; prints `{me, items, next}` where `next` is the cursor map to pass back as `--after`. The bot's own messages are dropped. |
| `napq reply --conversation <group> --to <message_id> --key <key> --text <text>` | Post one group message quoting the original; exits 0 and posts nothing if `key` was already sent. |
| `napq thread --conversation <group> --root <message_id> --json` | Print a page of a group's recent messages for assessment context. |

Errors print one JSON line, `{"error": {"code", "message"}}`, on stderr and exit non-zero; a deleted
conversation surfaces as code `410`, which the Source settles as `gone`.

You do not call `napq` yourself — the QQ Source polls it every cycle and calls it to reply.
