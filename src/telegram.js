// Telegram Bot API over plain fetch. Node 20+ ships fetch, FormData and Blob, so
// this file is the entire client and the project needs no dependencies.

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BASE = `https://api.telegram.org/bot${TOKEN}`;

// Telegram hard-caps a message at 4096 characters. Staying under it keeps room for
// the header line the bot prepends to a transcript.
export const MESSAGE_LIMIT = 3500;

async function api(method, body, { timeoutMs = 70_000 } = {}) {
  const res = await fetch(`${BASE}/${method}`, {
    method: "POST",
    headers: body instanceof FormData ? undefined : { "content-type": "application/json" },
    body: body instanceof FormData ? body : JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const data = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
  if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description}`);
  return data.result;
}

export const getMe = () => api("getMe", {}, { timeoutMs: 15_000 });

/**
 * Long poll. Telegram holds the connection open until something arrives or `timeout`
 * elapses, so this is one cheap request per interval rather than a busy loop.
 */
export const getUpdates = (offset, timeout = 50) =>
  api("getUpdates", { offset, timeout, allowed_updates: ["message"] }, { timeoutMs: (timeout + 15) * 1000 });

export const sendMessage = (chat_id, text, extra = {}) =>
  api("sendMessage", { chat_id, text, disable_web_page_preview: true, ...extra });

export const editMessageText = (chat_id, message_id, text, extra = {}) =>
  api("editMessageText", { chat_id, message_id, text, disable_web_page_preview: true, ...extra })
    .catch(() => null); // editing is a nicety; a failed edit must not kill the job

export const sendChatAction = (chat_id, action = "typing") =>
  api("sendChatAction", { chat_id, action }).catch(() => null);

export async function sendDocument(chat_id, filename, content, caption) {
  const form = new FormData();
  form.append("chat_id", String(chat_id));
  if (caption) form.append("caption", caption);
  form.append("document", new Blob([content], { type: "text/plain" }), filename);
  return api("sendDocument", form, { timeoutMs: 120_000 });
}
