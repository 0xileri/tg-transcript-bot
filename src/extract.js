// yt-dlp wrapper. Everything that knows about X or YouTube specifics lives here.

import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseVtt, collapseRolling } from "./vtt.js";

const YTDLP_CMD = process.env.YTDLP_CMD ?? "python -m yt_dlp";
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_SECONDS ?? 180) * 1000;

const URL_PATTERNS = [
  { platform: "x", re: /https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[^\s]+\/status\/\d+/i },
  { platform: "youtube", re: /https?:\/\/(?:www\.|m\.)?youtube\.com\/(?:watch\?[^\s]*v=|shorts\/|live\/)[\w-]+[^\s]*/i },
  { platform: "youtube", re: /https?:\/\/youtu\.be\/[\w-]+[^\s]*/i },
];

/** First supported link in a message, or null. Ignores any other URLs present. */
export function findLink(text = "") {
  for (const { platform, re } of URL_PATTERNS) {
    const m = text.match(re);
    if (m) return { platform, url: m[0] };
  }
  return null;
}

/** Run yt-dlp, resolving with stdout. Rejects with a message already fit to show a user. */
function runYtdlp(args, { timeoutMs = JOB_TIMEOUT_MS } = {}) {
  const [cmd, ...base] = YTDLP_CMD.split(/\s+/);

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...base, ...args], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`Could not run yt-dlp (${e.message}). Check YTDLP_CMD in .env.`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`Gave up after ${timeoutMs / 1000}s.`));
      if (code !== 0) {
        // Always keep the raw output on the console. The message sent to the user is
        // deliberately short, and without this the operator has no way to see what
        // yt-dlp actually said.
        const tail = stderr.trim().split(/\r?\n/).filter(Boolean).slice(-6);
        console.error(`yt-dlp exit ${code}:`);
        for (const l of tail) console.error(`  ${l}`);
        return reject(new Error(friendlyError(stderr, code)));
      }
      resolve(stdout);
    });
  });
}

/** Map yt-dlp's stderr onto something a person can act on. */
function friendlyError(stderr, code) {
  const s = stderr.toLowerCase();
  if (s.includes("no video could be found") || s.includes("no media found"))
    return "That post doesn't contain a video.";
  if (s.includes("private video") || s.includes("protected") || s.includes("not authorized"))
    return "That video is private, so I can't reach it.";
  if (s.includes("video unavailable") || s.includes("has been removed") || s.includes("does not exist"))
    return "That video is unavailable or has been removed.";
  if (s.includes("sign in to confirm") || s.includes("bot"))
    return "YouTube is challenging this request as automated traffic. Trying again shortly usually clears it.";
  if (s.includes("age") && s.includes("restrict"))
    return "That video is age-restricted, which needs a signed-in session I don't have.";
  if (s.includes("unsupported url"))
    return "I don't know how to read that link.";

  const line = stderr.split(/\r?\n/).filter((l) => l.trim().startsWith("ERROR")).pop();
  if (line) return line.replace(/^ERROR:\s*/, "").trim();

  // No ERROR line to quote. A bare "Extraction failed" here threw away the only
  // evidence of what went wrong, leaving nothing to act on. Pass along whatever
  // yt-dlp did say instead.
  const tail = stderr.trim().split(/\r?\n/).filter((l) => l.trim()).slice(-2).join(" ").trim();
  return tail
    ? `Extraction failed (exit ${code}): ${tail}`.slice(0, 400)
    : `Extraction failed with exit code ${code} and no output at all.`;
}

/** Metadata plus the list of caption tracks, without downloading anything. */
export async function probe(url) {
  const raw = await runYtdlp(["-J", "--no-warnings", "--no-playlist", url], { timeoutMs: 90_000 });
  const info = JSON.parse(raw);
  return {
    id: info.id,
    title: info.title ?? "(untitled)",
    uploader: info.uploader ?? info.uploader_id ?? null,
    duration: info.duration ?? null,
    manual: Object.keys(info.subtitles ?? {}),
    auto: Object.keys(info.automatic_captions ?? {}),
  };
}

/**
 * Choose a caption track.
 *
 * Human-written wins over machine-generated even across languages: a hand-authored
 * Spanish track beats an auto-generated English one, because the auto English is a
 * machine translation of a machine transcription and the errors compound.
 */
export function pickTrack({ manual, auto }) {
  const english = (list) =>
    list.find((l) => l === "en") ?? list.find((l) => /^en[-_]/i.test(l));

  const manualEn = english(manual);
  if (manualEn) return { lang: manualEn, auto: false };
  if (manual.length) return { lang: manual[0], auto: false };

  // YouTube lists one real machine transcript alongside dozens of machine TRANSLATIONS of
  // it. Translations are tagged with a source suffix, so preferring a bare code keeps the
  // track that was actually generated from the audio.
  const native = auto.filter((l) => /^[a-z]{2,3}(-orig)?$/i.test(l));
  const pool = native.length ? native : auto;

  const autoEn = english(pool);
  if (autoEn) return { lang: autoEn, auto: true };
  if (pool.length) return { lang: pool[0], auto: true };

  return null;
}

/** Download one caption track and return its parsed cues. */
export async function fetchCues(url, track) {
  const dir = await mkdtemp(join(tmpdir(), "tgtranscript-"));
  try {
    await runYtdlp([
      "--skip-download",
      track.auto ? "--write-auto-subs" : "--write-subs",
      "--sub-langs", track.lang,
      "--sub-format", "vtt",
      "--no-warnings",
      "--no-playlist",
      "-o", join(dir, "%(id)s.%(ext)s"),
      url,
    ]);

    const file = (await readdir(dir)).find((f) => f.endsWith(".vtt"));
    if (!file) throw new Error("yt-dlp reported success but wrote no subtitle file.");

    const cues = parseVtt(await readFile(join(dir, file), "utf8"));
    // Rolling-line collapse only for machine tracks; see the note in vtt.js.
    return track.auto ? collapseRolling(cues) : cues;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export function formatDuration(seconds) {
  if (!seconds) return null;
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}
