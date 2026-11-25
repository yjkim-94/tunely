/**
 * Temporary playback diagnostics: why the next track sometimes does not start.
 * Events go into a small localStorage ring buffer and are sent to /api/debug/playback
 * when the app is visible and online. No audio or personal data beyond track ids/titles.
 */
const KEY = "tunely-playlog";
const MAX = 400;
type Entry = { t: number; e: string; h: 0 | 1; [k: string]: unknown };

let poster: ((events: Entry[]) => Promise<unknown>) | undefined;
let sending = false;

function load(): { list: Entry[]; sent: number } {
  try {
    const d = JSON.parse(localStorage.getItem(KEY) || "");
    if (Array.isArray(d.list)) return d;
  } catch {}
  return { list: [], sent: 0 };
}
function save(d: { list: Entry[]; sent: number }) {
  try {
    localStorage.setItem(KEY, JSON.stringify(d));
  } catch {}
}

/** Record one event; `h` = page hidden (screen locked or app in background). */
export function plog(e: string, data: Record<string, unknown> = {}) {
  const d = load();
  d.list.push({ t: Date.now(), e, h: document.hidden ? 1 : 0, ...data });
  if (d.list.length > MAX) {
    const drop = d.list.length - MAX;
    d.list = d.list.slice(drop);
    d.sent = Math.max(0, d.sent - drop);
  }
  save(d);
}

export function setPlaylogPoster(fn: (events: Entry[]) => Promise<unknown>) {
  poster = fn;
}

export async function flushPlaylog() {
  if (sending || !poster || !navigator.onLine || document.hidden) return;
  const d = load();
  const batch = d.list.slice(d.sent, d.sent + 300);
  if (!batch.length) return;
  sending = true;
  try {
    await poster(batch);
    const now = load();
    now.sent = Math.min(now.list.length, now.sent + batch.length);
    save(now);
  } catch {
    // retried on the next flush
  } finally {
    sending = false;
  }
}
