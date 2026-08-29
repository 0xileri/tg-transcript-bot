// Turns a transcript into a publish-ready social caption, via Claude.
//
// The instructions live in prompts/caption.md rather than in here on purpose: it is
// the part most likely to be tuned, and editing a prompt should not mean editing code.

import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ESM has no __dirname, and the bot may be launched from any working directory,
// so the prompt path is resolved relative to this file rather than to the cwd.
const HERE = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = join(HERE, "..", "prompts", "caption.md");

const MODEL = process.env.CAPTION_MODEL ?? "claude-opus-5";

let cachedPrompt = null;

/** The caption instructions, read once and reused. */
async function systemPrompt() {
  if (cachedPrompt === null) {
    cachedPrompt = await readFile(PROMPT_PATH, "utf8");
  }
  return cachedPrompt;
}

export function captionConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * Write a caption for one transcript.
 *
 * @param {string} transcript timestamped lines, as the bot already produces
 * @param {{title?: string, uploader?: string, url?: string}} info
 * @returns {Promise<string>} the caption text, exactly as written
 */
export async function writeCaption(transcript, info = {}) {
  if (!captionConfigured()) {
    throw new Error(
      "Captioning needs an Anthropic API key. Add ANTHROPIC_API_KEY to .env and restart.",
    );
  }

  const client = new Anthropic();
  const system = await systemPrompt();

  const context = [
    info.title ? `Video: ${info.title}` : null,
    info.uploader ? `Posted by: ${info.uploader}` : null,
    info.url ? `Source: ${info.url}` : null,
  ].filter(Boolean).join("\n");

  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    // A policy decline would otherwise just stop the request; this re-runs it on a
    // fallback model inside the same call. Captions quote people verbatim on
    // whatever subject the video covers, so declines are a live possibility.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    // The instructions are long and identical on every call, so they are worth
    // caching -- subsequent captions read the prefix at a fraction of the cost.
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    // The prompt requires verifying handles and superlatives rather than guessing
    // at them, which is not something the model can do from memory.
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 10 }],
    messages: [
      {
        role: "user",
        content: `${context}\n\nTranscript:\n\n${transcript}`,
      },
    ],
  });

  const message = await stream.finalMessage();

  if (message.stop_reason === "refusal") {
    const why = message.stop_details?.explanation ?? "no explanation given";
    throw new Error(`The model declined to caption this one (${why}).`);
  }

  const text = message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  if (!text) throw new Error("The model returned no caption text.");
  return text;
}
