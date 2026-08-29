// Telegram transcript bot: send an X or YouTube link, get the video's captions back.
//
// Long-polling rather than a webhook, deliberately. Polling needs no public URL, no
// tunnel and no TLS, so this runs on a laptop as-is. It also means YouTube sees a
// residential IP, which it challenges far less often than a datacenter one.

import { readFile, writeFile } from "node:fs/promises";
import { createScheduler } from "./scheduler.js";
import { findLink, probe, pickTrack, fetchCues, formatDuration } from "./extract.js";
import { toPlainText, toSrt, toTimestamped, wordCount } from "./vtt.js";
import {
  MESSAGE_LIMIT, getMe, getUpdates, sendMessage,
  editMessageText, sendChatAction, sendDocument,
} from "./telegram.js";

const OFFSET_FILE = new URL("../.offset", import.meta.url);

// Jobs used to run inline with the poll loop: the bot awaited each extraction before
// reading the next batch of updates, so a single 30-second video stalled everyone else
// and the bot looked dead rather than busy.
const jobs = createScheduler({
  maxConcurrent: Number(process.env.MAX_CONCURRENT_JOBS ?? 3),
  maxPerUser: Number(process.env.MAX_QUEUED_PER_USER ?? 2),
});

const ALLOWED = (process.env.ALLOWED_CHAT_IDS ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);

const HELP = [
  "Send me an X or YouTube link and I'll reply with the video's transcript.",
  "",
  "Commands:",
  "/srt <link> — get the transcript as a subtitle file instead",
  "/ts <link> — get it with [mm:ss] timestamps",
  "/whoami — show your chat id, for the allowlist",
  "",
  "I read captions the video already carries; I don't transcribe audio.",
  "Most YouTube videos have auto-captions. Many X videos have none at all.",
].join("\n");

// ---- output shaping -------------------------------------------------------

function header({ title, uploader, duration }, track, cues) {
  const bits = [
    uploader ? `${title} — ${uploader}` : title,
    [formatDuration(duration), `${wordCount(cues)} words`].filter(Boolean).join(" · "),
    track.auto ? `auto-generated captions (${track.lang})` : `captions (${track.lang})`,
  ];
  return bits.join("\n");
}

async function deliver(chatId, info, track, cues, format) {
  const head = header(info, track, cues);
  const slug = (info.title ?? "transcript").replace(/[^\w\s-]/g, "").trim()
    .replace(/\s+/g, "-").slice(0, 60) || "transcript";

  if (format === "srt") {
    return sendDocument(chatId, `${slug}.srt`, toSrt(cues), head);
  }

  const body = format === "ts" ? toTimestamped(cues) : toPlainText(cues);

  // A transcript that overflows a Telegram message goes out as a file rather than a
  // wall of split messages: it stays searchable, and it survives being forwarded.
  if (body.length > MESSAGE_LIMIT) {
    const ext = format === "ts" ? "timestamped.txt" : "txt";
    return sendDocument(chatId, `${slug}.${ext}`, body, `${head}\n\nToo long to post inline, so here it is as a file.`);
  }
  return sendMessage(chatId, `${head}\n\n${body}`);
}

// ---- job ------------------------------------------------------------------

async function handleLink(chatId, url, format) {
  await sendChatAction(chatId);
  const status = await sendMessage(chatId, "Reading that link…");
  const note = (t) => editMessageText(chatId, status.message_id, t);

  let info;
  try {
    info = await probe(url);
  } catch (e) {
    return note(e.message);
  }

  const track = pickTrack(info);
  if (!track) {
    const where = url.includes("youtu") ? "YouTube" : "X";
    return note(
      `“${info.title}” has no caption track, so there's no text to pull.\n\n` +
      `${where} only serves captions when the uploader added them or the platform ` +
      `generated them. I read captions rather than transcribing audio, so this one is a dead end.`,
    );
  }

  await note(`Found “${info.title}”. Pulling ${track.auto ? "auto-" : ""}captions (${track.lang})…`);
  await sendChatAction(chatId, format === "plain" ? "typing" : "upload_document");

  let cues;
  try {
    cues = await fetchCues(url, track);
  } catch (e) {
    return note(e.message);
  }

  if (!cues.length) return note("The caption track came back empty.");

  await deliver(chatId, info, track, cues, format);
  await note(`Done — ${wordCount(cues)} words from “${info.title}”.`);
}

async function handleMessage(msg) {
  const chatId = msg.chat?.id;
  const text = (msg.text ?? "").trim();
  if (!chatId || !text) return;

  if (/^\/whoami\b/.test(text)) {
    return sendMessage(chatId, `Your chat id is ${chatId}`);
  }
  if (ALLOWED.length && !ALLOWED.includes(String(chatId))) {
    console.log(`ignored chat ${chatId} (not in allowlist)`);
    return sendMessage(chatId, "This bot is private.");
  }
  if (/^\/(start|help)\b/.test(text)) {
    return sendMessage(chatId, HELP);
  }

  const format = /^\/srt\b/.test(text) ? "srt" : /^\/ts\b/.test(text) ? "ts" : "plain";
  const link = findLink(text);

  if (!link) {
    return sendMessage(chatId, "Send me an X or YouTube link. /help for the details.");
  }

  // Cap per person so one user cannot fill the queue. Their in-flight job counts,
  // so this is a limit on outstanding work, not on links sent over time.
  if (jobs.outstandingFor(chatId) >= jobs.maxPerUser) {
    return sendMessage(
      chatId,
      `You already have ${jobs.maxPerUser} links in progress. Let those finish and send this one again.`,
    );
  }

  const started = jobs.submit(chatId, async () => {
    const started = Date.now();
    try {
      await handleLink(chatId, link.url, format);
      console.log(`[${chatId}] done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    } catch (e) {
      console.error(`[${chatId}] job failed: ${e.message}`);
      await sendMessage(chatId, `That did not work: ${e.message}`).catch(() => {});
    }
  });

  console.log(`[${chatId}] ${format} <- ${link.url}${started ? "" : " (queued)"}`);

  // handleLink says nothing until it actually starts, so without this a genuinely
  // queued user sits in silence and assumes the bot is broken.
  if (!started) {
    await sendMessage(chatId, `Queued — ${jobs.waiting} ahead of you.`).catch(() => {});
  }
}

// ---- loop -----------------------------------------------------------------

async function main() {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.error("TELEGRAM_BOT_TOKEN is not set. Copy .env.example to .env and fill it in.");
    process.exit(1);
  }

  const me = await getMe();
  console.log(`connected as @${me.username}`);
  console.log(ALLOWED.length ? `allowlist: ${ALLOWED.join(", ")}` : "allowlist: off (anyone can use this bot)");

  if (process.argv.includes("--selftest")) {
    // "Me at the zoo": the oldest video on YouTube, carries real caption tracks, and is
    // about as unlikely to be deleted as anything on the platform. A check that fails
    // because its own fixture rotted tells you nothing about your setup.
    const url = "https://www.youtube.com/watch?v=jNQXAC9IVRw";
    try {
      const info = await probe(url);
      const track = pickTrack(info);
      console.log(`yt-dlp works — probed "${info.title}", picked ${track ? track.lang : "no track"}`);
    } catch (e) {
      console.error(`yt-dlp check failed: ${e.message}`);
      process.exitCode = 1;
    }
    return;
  }

  let offset = Number(await readFile(OFFSET_FILE, "utf8").catch(() => 0)) || 0;
  let running = true;
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => { console.log("\nstopping…"); running = false; });
  }

  console.log("polling for messages. ctrl-c to stop.");
  while (running) {
    let updates;
    try {
      updates = await getUpdates(offset);
    } catch (e) {
      // Network blips and Telegram 5xx are routine on a long poll; pause and retry.
      console.error("poll failed:", e.message);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }

    for (const update of updates) {
      offset = update.update_id + 1;
      // Persist before handling: a crash mid-job must not replay the same link forever.
      await writeFile(OFFSET_FILE, String(offset)).catch(() => {});
      if (update.message) {
        // A failure serving one person must not end the bot for everyone else. This
        // process was killed in production by `Forbidden: bot was blocked by the user`
        // -- somebody messaged the bot, blocked it before the reply landed, and the
        // send threw straight past the loop into main(). Any per-message throw now
        // stays with that message.
        try {
          await handleMessage(update.message);
        } catch (e) {
          console.error(`[${update.message.chat?.id}] dropped: ${e.message}`);
        }
      }
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
