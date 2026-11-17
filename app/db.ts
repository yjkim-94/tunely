import Dexie, { type Table } from "dexie";
export type Track = {
  id: string;
  title: string;
  artist: string;
  duration: number;
  thumbnail?: string;
  art?: Blob;
  url?: string;
  audio: Blob;
  added: number;
};
export type Playlist = { id: string; name: string; tracks: string[] };
class MusicDB extends Dexie {
  tracks!: Table<Track, string>;
  playlists!: Table<Playlist, string>;
  settings!: Table<{ key: string; value: unknown }, string>;
  constructor() {
    // Keep the existing local database name to preserve previously saved music.
    super("soriham");
    this.version(1).stores({
      tracks: "id,title,artist,added",
      playlists: "id,name",
      settings: "key",
    });
  }
}
export const db = new MusicDB();
export async function setting<T>(key: string, fallback: T): Promise<T> {
  return ((await db.settings.get(key))?.value as T) ?? fallback;
}
export async function setSetting(key: string, value: unknown) {
  await db.settings.put({ key, value });
}
export async function removeTracks(ids: string[]) {
  await db.transaction("rw", db.tracks, db.playlists, async () => {
    await db.tracks.bulkDelete(ids);
    await db.playlists.toCollection().modify((p) => {
      p.tracks = p.tracks.filter((id) => !ids.includes(id));
    });
  });
}
