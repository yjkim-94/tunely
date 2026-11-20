/**
 * Text-only library backup to the server (titles, artists, playlists; never audio).
 *
 * Dexie hooks record which tracks/playlists changed in a small "dirty" list kept in
 * localStorage, so edits made offline or right before the app is closed are not lost.
 * `flushLibrary()` sends the current state of those items and clears them on success.
 */
import { db } from "./db";

type Op = "up" | "del";
type Dirty = { t: Record<string, Op>; p: Record<string, Op> };
export type SyncBody = {
  tracks: {
    video_id: string;
    title: string;
    artist: string;
    duration: number;
    codec: string | null;
    trim_start: number | null;
    trim_end: number | null;
  }[];
  delete_tracks: string[];
  playlists: { id: string; name: string; tracks: string[] }[];
  delete_playlists: string[];
};

const DIRTY = "tunely-sync-dirty";
const INIT = "tunely-sync-init-v1";
const LAST = "tunely-sync-at";
// Only YouTube tracks can be restored; files imported in older versions are skipped.
const VIDEO = /^[A-Za-z0-9_-]{11}$/;

function load(): Dirty {
  try {
    const d = JSON.parse(localStorage.getItem(DIRTY) || "");
    if (d && d.t && d.p) return d;
  } catch {}
  return { t: {}, p: {} };
}
function save(d: Dirty) {
  try {
    localStorage.setItem(DIRTY, JSON.stringify(d));
  } catch {}
}

let poster: ((body: SyncBody) => Promise<unknown>) | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let flushing = false;
const listeners = new Set<() => void>();

function changed() {
  listeners.forEach((fn) => fn());
  clearTimeout(timer);
  timer = setTimeout(() => void flushLibrary(), 1500);
}
function mark(kind: "t" | "p", id: string, op: Op) {
  if (kind === "t" && !VIDEO.test(id)) return;
  const d = load();
  d[kind][id] = op;
  save(d);
  changed();
}

let hooked = false;
export function installSyncHooks() {
  if (hooked) return;
  hooked = true;
  db.tracks.hook("creating", (_pk, obj) => mark("t", obj.id, "up"));
  db.tracks.hook("updating", (_mods, pk) => mark("t", String(pk), "up"));
  db.tracks.hook("deleting", (pk) => mark("t", String(pk), "del"));
  db.playlists.hook("creating", (_pk, obj) => mark("p", obj.id, "up"));
  db.playlists.hook("updating", (_mods, pk) => mark("p", String(pk), "up"));
  db.playlists.hook("deleting", (pk) => mark("p", String(pk), "del"));
}

export function setSyncPoster(fn: (body: SyncBody) => Promise<unknown>) {
  poster = fn;
}
export function onSyncChange(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
export function syncStatus() {
  const d = load();
  let at = 0;
  try {
    at = Number(localStorage.getItem(LAST) || 0);
  } catch {}
  return {
    pending: Object.keys(d.t).length + Object.keys(d.p).length,
    lastSync: at,
  };
}

/** First run after this feature ships: back up everything already on the phone. */
export async function initialBackup() {
  try {
    if (localStorage.getItem(INIT)) return;
  } catch {
    return;
  }
  const d = load();
  for (const t of await db.tracks.toCollection().primaryKeys())
    if (VIDEO.test(String(t))) d.t[String(t)] = "up";
  for (const p of await db.playlists.toCollection().primaryKeys())
    d.p[String(p)] = "up";
  save(d);
  try {
    localStorage.setItem(INIT, "1");
  } catch {}
  changed();
}

export async function flushLibrary() {
  if (flushing || !poster || !navigator.onLine) return;
  const snapshot = load();
  const tIds = Object.keys(snapshot.t);
  const pIds = Object.keys(snapshot.p);
  if (!tIds.length && !pIds.length) return;
  flushing = true;
  try {
    const body: SyncBody = {
      tracks: [],
      delete_tracks: [],
      playlists: [],
      delete_playlists: [],
    };
    for (const id of tIds) {
      if (snapshot.t[id] === "del") {
        body.delete_tracks.push(id);
        continue;
      }
      const t = await db.tracks.get(id);
      if (t)
        body.tracks.push({
          video_id: id,
          title: t.title.slice(0, 300),
          artist: t.artist.slice(0, 200),
          duration: Math.max(0, Math.min(86400, Math.round(t.duration || 0))),
          codec: t.codec?.slice(0, 20) ?? null,
          trim_start: t.trim ? Math.round(t.trim.start * 10) / 10 : null,
          trim_end: t.trim ? Math.round(t.trim.end * 10) / 10 : null,
        });
    }
    for (const id of pIds) {
      if (snapshot.p[id] === "del") {
        body.delete_playlists.push(id);
        continue;
      }
      const p = await db.playlists.get(id);
      if (p)
        body.playlists.push({ id, name: p.name.slice(0, 100), tracks: p.tracks });
    }
    await poster(body);
    // Keep anything that changed again while the request was in flight.
    const now = load();
    for (const id of tIds) if (now.t[id] === snapshot.t[id]) delete now.t[id];
    for (const id of pIds) if (now.p[id] === snapshot.p[id]) delete now.p[id];
    save(now);
    try {
      localStorage.setItem(LAST, String(Date.now()));
    } catch {}
  } catch {
    // Offline or server error: the dirty list stays and is retried later.
  } finally {
    flushing = false;
    listeners.forEach((fn) => fn());
  }
}
