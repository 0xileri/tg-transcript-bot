// WebVTT -> usable text.
//
// The tag stripping is not cosmetic. X ships every cue wrapped in a custom
// <X-word-ms ms=... index=... character_ranges=...> element carrying per-word
// millisecond offsets. Read the file raw and the transcript is unreadable, so
// anything that is not cue text gets removed before it reaches a user.

const CUE_TIME = /(\d{2}:\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[.,]\d{3})/;

/** Parse a VTT document into [{ start, end, text }], in file order. */
export function parseVtt(raw) {
  const cues = [];

  for (const block of raw.split(/\r?\n\s*\r?\n/)) {
    const m = block.match(CUE_TIME);
    if (!m) continue; // header, NOTE/STYLE blocks, stray ids

    const text = block
      .slice(m.index + m[0].length)
      .replace(/<[^>]*>/g, "") // X-word-ms, <c>, <i>, karaoke timestamps
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, " ")
      .trim();

    if (text) cues.push({ start: m[1], end: m[2], text });
  }

  return dedupe(cues);
}

/**
 * Collapse consecutive cues carrying identical text into one span.
 *
 * YouTube's auto-captions are the reason this exists: they roll, republishing the
 * same line across several cues as words are appended. Without this the transcript
 * repeats nearly every phrase.
 */
function dedupe(cues) {
  const out = [];
  for (const cue of cues) {
    const prev = out[out.length - 1];
    if (prev && prev.text === cue.text) prev.end = cue.end;
    else out.push({ ...cue });
  }
  return out;
}

/**
 * Drop a cue whose text is fully contained in the one before it.
 *
 * Also a rolling-caption artifact, but the partial-line form: "so I thought" then
 * "so I thought I'd make". Only applied to auto-generated tracks, because in a
 * hand-authored file a short repeated line is usually deliberate.
 */
export function collapseRolling(cues) {
  const out = [];
  for (const cue of cues) {
    const prev = out[out.length - 1];
    if (prev && cue.text.startsWith(prev.text)) {
      prev.text = cue.text;
      prev.end = cue.end;
    } else {
      out.push({ ...cue });
    }
  }
  return out;
}

/** Flowing prose, no timings. What most people actually want to read. */
export function toPlainText(cues) {
  const flow = cues.map((c) => c.text).join(" ").replace(/\s+/g, " ").trim();

  // Paragraph roughly every four sentences. Cue boundaries follow speech pauses
  // rather than sentences, so this is a readability aid, not real structure.
  const sentences = flow.split(/(?<=[.!?])\s+/);
  const paras = [];
  for (let i = 0; i < sentences.length; i += 4) {
    paras.push(sentences.slice(i, i + 4).join(" "));
  }
  return paras.join("\n\n");
}

/** One line per cue, [mm:ss] prefixed, for finding a moment in the video. */
export function toTimestamped(cues) {
  return cues.map((c) => `[${c.start.slice(3, 8)}] ${c.text}`).join("\n");
}

/** Standard SRT, for re-cutting the video elsewhere. */
export function toSrt(cues) {
  return cues
    .map((c, i) =>
      `${i + 1}\n${c.start.replace(".", ",")} --> ${c.end.replace(".", ",")}\n${c.text}\n`)
    .join("\n");
}

export function wordCount(cues) {
  return cues.reduce((n, c) => n + c.text.split(/\s+/).filter(Boolean).length, 0);
}
