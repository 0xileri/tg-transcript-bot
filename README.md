# tg-transcript-bot

Send the bot an X or YouTube link in Telegram, get the video's transcript back.

It reads caption tracks the video already carries. It does **not** transcribe audio, so a
video with no captions produces no transcript — the bot says so and stops.

## What you need

- Node 20+ (uses built-in `fetch` and `--env-file`; there are no npm dependencies)
- Python with `yt-dlp`: `pip install -U yt-dlp`
- A bot token from [@BotFather](https://t.me/botfather) → `/newbot`

## Setup

```
cp .env.example .env      # then paste your token in
npm run check             # verifies the token and that yt-dlp runs
npm start
```

Message the bot a link. `/help` lists the commands.

| Command | Result |
| --- | --- |
| *(bare link)* | Transcript as flowing text |
| `/ts <link>` | Transcript with `[mm:ss]` markers |
| `/srt <link>` | Subtitle file, for re-cutting video |
| `/whoami` | Your chat id, for the allowlist |

Transcripts over ~3500 characters arrive as a `.txt` file, since that is Telegram's
message ceiling.

## Lock it down

A bot token is effectively public once the bot has a username — anyone who finds it can
make your machine run extraction jobs. Set `ALLOWED_CHAT_IDS` in `.env` to your own chat
id (send `/whoami` to get it) and everyone else gets turned away.

## Why polling, and why local

The bot long-polls instead of running a webhook. No public URL, no tunnel, no TLS
certificate — it runs on a laptop unchanged.

Running it locally is also better for YouTube specifically. YouTube challenges datacenter
IPs far more aggressively than residential ones, so the same code that works from your
machine may start failing bot checks on a VPS. If you do move it to a server, expect to
add cookies or a proxy for YouTube; X is unaffected.

## Caption availability, which is the real constraint

- **YouTube** almost always has captions, usually auto-generated, often alongside a large
  set of machine translations. The bot prefers a human-written track over a machine one,
  even across languages, and prefers the original machine transcript over a translation
  of it.
- **X** only serves captions when the uploader supplied them. Most X videos have none.
  This is the single most common reason the bot comes back empty-handed, and no amount of
  code fixes it — the text genuinely is not there.

## Layout

| File | Role |
| --- | --- |
| `src/bot.js` | Poll loop, command routing, reply shaping |
| `src/telegram.js` | Bot API client over `fetch` |
| `src/extract.js` | yt-dlp wrapper: probe, track selection, download |
| `src/vtt.js` | WebVTT parsing and output formats |

### One parsing note worth knowing

X wraps every cue in a custom `<X-word-ms ms=… index=… character_ranges=…>` element
carrying per-word millisecond offsets. Read the VTT raw and it is unreadable. `vtt.js`
strips it. That per-word timing is genuinely useful if you ever want karaoke-style
caption rendering — it is discarded here only because this bot wants prose.
