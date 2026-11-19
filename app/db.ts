import Dexie, { type Table } from "dexie";
export type Track = {
  id: string;
  title: string;
  artist: string;
  duration: number;
  thumbnail?: string;
  art?: Blob;
  url?: string;
  /** Whole audio file. Absent for long tracks stored as `parts`. */
  audio?: Blob;
  /** Number of chunks in the parts table (long tracks only). */
  parts?: number;
  /** Total audio bytes for chunked tracks. */
  size?: number;
  added: number;
};
export type Part = { track: string; index: number; blob: Blob };
export type Playlist = { id: string; name: string; tracks: string[] };
class MusicDB extends Dexie {
  tracks!: Table<Track, string>;
  playlists!: Table<Playlist, string>;
  settings!: Table<{ key: string; value: unknown }, string>;
  parts!: Table<Part, [string, number]>;
  constructor() {
    // Keep the existing local database name to preserve previously saved music.
    super("soriham");
    this.version(1).stores({
      tracks: "id,title,artist,added",
      playlists: "id,name",
      settings: "key",
    });
    this.version(2).stores({ parts: "[track+index], track" });
  }
}
export const db = new MusicDB();
export async function setting<T>(key: string, fallback: T): Promise<T> {
  return ((await db.settings.get(key))?.value as T) ?? fallback;
}
export async function setSetting(key: string, value: unknown) {
  await db.settings.put({ key, value });
}
export const trackSize = (t: Track) => t.audio?.size ?? t.size ?? 0;
/** Playable audio. Chunked tracks are joined lazily; the parts stay file-backed. */
export async function trackAudio(t: Track): Promise<Blob> {
  if (t.audio) return t.audio;
  const parts = await db.parts.where("track").equals(t.id).sortBy("index");
  if (!parts.length || parts.length !== t.parts)
    throw new Error("음원 조각이 일부 없습니다. 다시 저장해 주세요.");
  return new Blob(
    parts.map((p) => p.blob),
    { type: "audio/mp4" },
  );
}
export async function removeTracks(ids: string[]) {
  await db.transaction("rw", db.tracks, db.playlists, db.parts, async () => {
    await db.tracks.bulkDelete(ids);
    await db.parts.where("track").anyOf(ids).delete();
    await db.playlists.toCollection().modify((p) => {
      p.tracks = p.tracks.filter((id) => !ids.includes(id));
    });
  });
}
