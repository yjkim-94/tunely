"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import {
  Music2,
  Search,
  Library,
  ListMusic,
  Settings,
  Plus,
  ArrowDownToLine,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Shuffle,
  Repeat,
  Repeat1,
  X,
  Check,
  Trash2,
  ChevronLeft,
  ChevronUp,
  ChevronDown,
  Headphones,
  WifiOff,
  HardDrive,
  LogOut,
  Upload,
  Link as LinkIcon,
  LoaderCircle,
  MoreHorizontal,
} from "lucide-react";
import {
  db,
  removeTracks,
  setting,
  setSetting,
  type Track,
  type Playlist,
} from "./db";

type Result = Omit<Track, "audio" | "added">;
type Job = {
  key: string;
  url: string;
  title: string;
  id?: string;
  state: "waiting" | "running" | "done" | "error" | "cancelled";
  stage?: string;
  percent?: number;
  error?: string;
};
type Saved = {
  id?: string;
  position: number;
  queue: string[];
  shuffle: boolean;
  repeat: "off" | "all" | "one";
  speed: number;
};
const emptySaved: Saved = {
  position: 0,
  queue: [],
  shuffle: false,
  repeat: "off",
  speed: 1,
};
const fmt = (s: number) =>
  `${Math.floor((s || 0) / 60)}:${String(Math.floor((s || 0) % 60)).padStart(2, "0")}`;
const bytes = (n: number) =>
  n > 1024 ** 3
    ? `${(n / 1024 ** 3).toFixed(1)} GB`
    : `${(n / 1024 ** 2).toFixed(1)} MB`;
const errorText = (e: unknown) =>
  e instanceof Error ? e.message : "작업 중 오류가 발생했습니다.";
async function api(path: string, body?: unknown, signal?: AbortSignal) {
  const r = await fetch("/api/" + path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(12000),
  });
  if (!r.ok) {
    const e = await r
      .json()
      .catch(() => ({ detail: "서버에 연결할 수 없습니다." }));
    throw new Error(
      typeof e.detail === "string" ? e.detail : `요청 실패 (${r.status})`,
    );
  }
  return r;
}
function canonicalClient(raw: string) {
  const u = new URL(raw);
  let id = "";
  if (u.hostname === "youtu.be") id = u.pathname.slice(1);
  else if (
    [
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "music.youtube.com",
    ].includes(u.hostname)
  )
    id =
      u.pathname === "/watch"
        ? u.searchParams.get("v") || ""
        : u.pathname.split("/")[2];
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.port ||
    !id ||
    !/^[\w-]{11}$/.test(id)
  )
    throw new Error("올바른 YouTube 영상 URL을 입력해 주세요.");
  return { id, url: "https://www.youtube.com/watch?v=" + id };
}
function Cover({
  track,
  large = false,
}: {
  track?: Pick<Track, "id" | "art" | "thumbnail">;
  large?: boolean;
}) {
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    if (track?.art) {
      const s = URL.createObjectURL(track.art);
      setSrc(s);
      return () => URL.revokeObjectURL(s);
    }
    setSrc(track?.thumbnail);
  }, [track?.id, track?.art, track?.thumbnail]);
  return (
    <div className={"cover " + (large ? "large" : "")}>
      {src ? (
        <img src={src} alt="" onError={() => setSrc(undefined)} />
      ) : (
        <Music2 size={large ? 68 : 24} />
      )}
    </div>
  );
}
export default function Home() {
  const [initPhase, setInitPhase] = useState("저장소를 확인하고 있어요"),
    [ready, setReady] = useState(false),
    [consent, setConsent] = useState(false),
    [auth, setAuth] = useState(false),
    [expires, setExpires] = useState(0),
    [password, setPassword] = useState(""),
    [loginBusy, setLoginBusy] = useState(false);
  const [tab, setTab] = useState("library"),
    [tracks, setTracks] = useState<Track[]>([]),
    [lists, setLists] = useState<Playlist[]>([]),
    [activeList, setActiveList] = useState<string>(),
    [filter, setFilter] = useState(""),
    [sort, setSort] = useState("new");
  const [query, setQuery] = useState(""),
    [results, setResults] = useState<Result[]>([]),
    [searched, setSearched] = useState(false),
    [searching, setSearching] = useState(false),
    [picked, setPicked] = useState<string[]>([]),
    [permitted, setPermitted] = useState(false),
    [jobs, setJobs] = useState<Job[]>([]);
  const [selected, setSelected] = useState<string[]>([]),
    [selectionMode, setSelectionMode] = useState(false),
    [notice, setNotice] = useState(""),
    [offline, setOffline] = useState(false),
    [persistent, setPersistent] = useState<boolean>(),
    [storage, setStorage] = useState({ usage: 0, quota: 0 });
  const [current, setCurrent] = useState<Track>(),
    [playing, setPlaying] = useState(false),
    [position, setPosition] = useState(0),
    [duration, setDuration] = useState(0),
    [queue, setQueue] = useState<string[]>([]),
    [shuffle, setShuffle] = useState(false),
    [repeat, setRepeat] = useState<Saved["repeat"]>("off"),
    [speed, setSpeed] = useState(1),
    [expanded, setExpanded] = useState(false),
    [edit, setEdit] = useState<Track>(),
    [listName, setListName] = useState(""),
    [listDialog, setListDialog] = useState(false),
    [addToList, setAddToList] = useState<string[] | null>(null),
    [health, setHealth] = useState("");
  const audio = useRef<HTMLAudioElement>(null),
    blobUrl = useRef<string | undefined>(undefined),
    abort = useRef<AbortController | undefined>(undefined),
    searchAbort = useRef<AbortController | undefined>(undefined),
    running = useRef(false),
    savedRef = useRef<Saved>(emptySaved),
    seekRef = useRef<number | null>(null),
    fileInput = useRef<HTMLInputElement>(null),
    lastSave = useRef(0);
  const refresh = useCallback(async () => {
    setTracks(await db.tracks.toArray());
    setLists(await db.playlists.toArray());
    void navigator.storage
      ?.estimate?.()
      .then((e) => setStorage({ usage: e.usage || 0, quota: e.quota || 0 }))
      .catch(() => {});
  }, []);
  useEffect(() => {
    let alive = true;
    const network = () => setOffline(!navigator.onLine);
    network();
    window.addEventListener("online", network);
    window.addEventListener("offline", network);
    (async () => {
      try {
        await Promise.race([
          db.open(),
          new Promise((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(
                    "기기 저장소 연결 시간이 초과되었습니다. 다른 Tunely 탭을 닫고 다시 열어 주세요.",
                  ),
                ),
              10000,
            ),
          ),
        ]);
        await refresh();
        setInitPhase("설정을 불러오고 있어요");
        setConsent(await setting("consent-v1", false));
        const s = await setting<Saved>("player", emptySaved);
        savedRef.current = s;
        setQueue(s.queue);
        setShuffle(s.shuffle);
        setRepeat(s.repeat);
        setSpeed(s.speed);
        setPosition(s.position);
        if (s.id) {
          const t = await db.tracks.get(s.id);
          if (t) {
            setCurrent(t);
            seekRef.current = s.position;
          }
        }
        setInitPhase("로그인 상태를 확인하고 있어요");
        const last = await setting("session-expiry", 0);
        try {
          const res = await api("auth/session");
          const data = await res.json();
          setAuth(true);
          setExpires(data.expires);
          await setSetting("session-expiry", data.expires);
        } catch {
          if (!navigator.onLine && last > Date.now() / 1000) {
            setAuth(true);
            setExpires(last);
          }
        }
        if (navigator.storage?.persisted)
          void navigator.storage
            .persisted()
            .then(setPersistent)
            .catch(() => {});
        if (
          "serviceWorker" in navigator &&
          process.env.NODE_ENV === "production"
        )
          void navigator.serviceWorker
            .register("/sw.js")
            .catch(() =>
              setNotice(
                "오프라인 화면 준비에 실패했습니다. 연결 상태를 확인하고 다시 열어 주세요.",
              ),
            );
      } catch (e) {
        setNotice("저장소를 열지 못했습니다. " + errorText(e));
      } finally {
        if (alive) setReady(true);
      }
    })();
    return () => {
      alive = false;
      window.removeEventListener("online", network);
      window.removeEventListener("offline", network);
    };
  }, [refresh]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 6000);
    return () => clearTimeout(t);
  }, [notice]);
  useEffect(() => {
    if (!auth || !expires) return;
    const check = () => {
      if (Date.now() / 1000 >= expires) {
        setAuth(false);
        audio.current?.pause();
        abort.current?.abort();
        searchAbort.current?.abort();
        setNotice("30일이 지나 다시 로그인이 필요합니다.");
      }
    };
    check();
    const t = setInterval(check, 15000);
    return () => clearInterval(t);
  }, [auth, expires]);
  useEffect(() => {
    savedRef.current = {
      id: current?.id,
      position,
      queue,
      shuffle,
      repeat,
      speed,
    };
  }, [current, position, queue, shuffle, repeat, speed]);
  useEffect(() => {
    const save = () => {
      void setSetting("player", savedRef.current);
    };
    window.addEventListener("pagehide", save);
    document.addEventListener("visibilitychange", save);
    return () => {
      window.removeEventListener("pagehide", save);
      document.removeEventListener("visibilitychange", save);
    };
  }, []);
  useEffect(() => {
    if (!current || !audio.current) return;
    const a = audio.current;
    if (blobUrl.current) URL.revokeObjectURL(blobUrl.current);
    blobUrl.current = URL.createObjectURL(current.audio);
    a.src = blobUrl.current;
    a.playbackRate = savedRef.current.speed;
    return () => {
      a.pause();
    };
  }, [current?.id, auth, consent, ready]);
  useEffect(() => {
    if (audio.current) audio.current.playbackRate = speed;
  }, [speed]);
  const persistPlayer = () => void setSetting("player", savedRef.current);
  const playTrack = useCallback(
    async (t: Track, ids?: string[]) => {
      if (ids) setQueue(ids);
      if (current?.id === t.id) {
        try {
          await audio.current?.play();
        } catch {
          setNotice("재생 버튼을 다시 눌러 주세요.");
        }
        return;
      }
      seekRef.current = 0;
      setPosition(0);
      setCurrent(t);
    },
    [current?.id, auth, consent, ready],
  );
  const playOnLoad = useRef(false);
  const startTrack = (t: Track, ids?: string[]) => {
    playOnLoad.current = true;
    void playTrack(t, ids);
  };
  const next = useCallback(
    (delta = 1, ended = false) => {
      const ids = queue.filter((id) => tracks.some((t) => t.id === id));
      if (!ids.length) return;
      if (ended && repeat === "one") {
        if (audio.current) {
          audio.current.currentTime = 0;
          void audio.current
            .play()
            .catch(() => setNotice("재生ボタンを 눌러 주세요."));
        }
        return;
      }
      let i = ids.indexOf(current?.id || "") + delta;
      if (shuffle && ids.length > 1) {
        const options = ids.filter((id) => id !== current?.id);
        i = ids.indexOf(options[Math.floor(Math.random() * options.length)]);
      }
      if (i >= ids.length) {
        if (ended && repeat !== "all") return;
        i = 0;
      }
      if (i < 0) i = ids.length - 1;
      const t = tracks.find((t) => t.id === ids[i]);
      if (t) {
        playOnLoad.current = true;
        void playTrack(t);
      }
    },
    [queue, tracks, current, repeat, shuffle, playTrack],
  );
  useEffect(() => {
    if (!("mediaSession" in navigator) || !current) return;
    const ms = navigator.mediaSession;
    let artworkURL: string | undefined;
    if (current.art) artworkURL = URL.createObjectURL(current.art);
    ms.metadata = new MediaMetadata({
      title: current.title,
      artist: current.artist,
      album: "Tunely",
      artwork: artworkURL ? [{ src: artworkURL }] : [],
    });
    const handlers: Record<string, MediaSessionActionHandler> = {
      play: () => {
        void audio.current?.play().catch(() => {});
      },
      pause: () => audio.current?.pause(),
      previoustrack: () => next(-1),
      nexttrack: () => next(),
      seekto: (d) => {
        if (audio.current && d.seekTime !== undefined)
          audio.current.currentTime = d.seekTime;
      },
      seekbackward: (d) => {
        if (audio.current)
          audio.current.currentTime = Math.max(
            0,
            audio.current.currentTime - (d.seekOffset || 10),
          );
      },
      seekforward: (d) => {
        if (audio.current)
          audio.current.currentTime = Math.min(
            audio.current.duration,
            audio.current.currentTime + (d.seekOffset || 10),
          );
      },
    };
    for (const [action, handler] of Object.entries(handlers)) {
      try {
        ms.setActionHandler(action as MediaSessionAction, handler);
      } catch {}
    }
    return () => {
      if (artworkURL) URL.revokeObjectURL(artworkURL);
      for (const action of Object.keys(handlers)) {
        try {
          ms.setActionHandler(action as MediaSessionAction, null);
        } catch {}
      }
    };
  }, [current, next]);
  useEffect(() => {
    if ("mediaSession" in navigator)
      navigator.mediaSession.playbackState = playing ? "playing" : "paused";
  }, [playing]);
  async function login(e: React.FormEvent) {
    e.preventDefault();
    setLoginBusy(true);
    try {
      const r = await api("auth/login", { password });
      const d = await r.json();
      await setSetting("session-expiry", d.expires);
      setExpires(d.expires);
      setAuth(true);
      setPassword("");
    } catch (e) {
      setNotice(errorText(e));
    } finally {
      setLoginBusy(false);
    }
  }
  async function search(e?: React.FormEvent) {
    e?.preventDefault();
    if (!query.trim()) return;
    searchAbort.current?.abort();
    const c = new AbortController();
    searchAbort.current = c;
    setSearching(true);
    setSearched(true);
    setPicked([]);
    try {
      if (/^https?:/.test(query.trim())) {
        const v = canonicalClient(query.trim());
        setResults([
          {
            ...v,
            title: "URL에서 가져오기",
            artist: "다운로드 시 영상 정보 확인",
            duration: 0,
          },
        ]);
        return;
      }
      const r = await api("search", { query: query.trim() }, c.signal);
      setResults(await r.json());
    } catch (e) {
      if (!c.signal.aborted) {
        setResults([]);
        setNotice(errorText(e));
      }
    } finally {
      if (!c.signal.aborted) setSearching(false);
    }
  }
  function enqueue(items: Result[]) {
    if (!permitted) {
      setNotice("아래 저장 권한 확인에 동의해 주세요.");
      return;
    }
    setJobs((old) => {
      const added: Job[] = [];
      for (const t of items) {
        if (
          tracks.some((x) => x.id === t.id) ||
          old.some(
            (j) => j.id === t.id && ["waiting", "running"].includes(j.state),
          ) ||
          added.some((j) => j.id === t.id)
        )
          continue;
        added.push({
          key: crypto.randomUUID(),
          url: t.url || "https://www.youtube.com/watch?v=" + t.id,
          title: t.title,
          id: t.id,
          state: "waiting",
        });
      }
      if (!added.length)
        setNotice("이미 보관 중이거나 대기열에 있는 음악입니다.");
      return [...old, ...added];
    });
    setPicked([]);
  }
  useEffect(() => {
    if (running.current || !auth || !consent) return;
    const job = jobs.find((j) => j.state === "waiting");
    if (!job) return;
    running.current = true;
    const c = new AbortController();
    abort.current = c;
    const update = (patch: Partial<Job>) =>
      setJobs((old) =>
        old.map((j) => (j.key === job.key ? { ...j, ...patch } : j)),
      );
    update({ state: "running", stage: "연결 중" });
    (async () => {
      let chunks: ArrayBuffer[] = [];
      try {
        const res = await api(
          "import/convert",
          { url: job.url, permitted: true },
          c.signal,
        );
        const reader = res.body?.getReader();
        if (!reader) throw new Error("스트리밍을 지원하지 않는 환경입니다.");
        const decoder = new TextDecoder();
        let buffer = "",
          complete = false;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let cut;
          while ((cut = buffer.indexOf("\n")) >= 0) {
            const raw = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 1);
            if (!raw.trim()) continue;
            const data = JSON.parse(raw);
            if (c.signal.aborted) throw new DOMException("취소", "AbortError");
            if (data.type === "error") throw new Error(data.message);
            if (data.type === "progress") {
              update({ stage: data.stage, percent: data.percent });
              if (data.total && navigator.storage?.estimate) {
                const estimate = await navigator.storage.estimate();
                if (
                  estimate.quota &&
                  data.total > estimate.quota - (estimate.usage || 0)
                )
                  throw new Error("기기 저장 공간이 부족합니다.");
              }
            }
            if (data.type === "audio") {
              const binary = atob(data.data);
              const a = new Uint8Array(binary.length);
              for (let i = 0; i < binary.length; i++)
                a[i] = binary.charCodeAt(i);
              chunks.push(a.buffer);
              update({ stage: "기기에 저장 중", percent: data.percent });
            }
            if (data.type === "done") {
              const blob = new Blob(chunks, { type: "audio/mp4" });
              if (!blob.size) throw new Error("빈 오디오 파일입니다.");
              let art: Blob | undefined;
              try {
                if (data.track.thumbnail) {
                  const r = await fetch(data.track.thumbnail, {
                    signal: AbortSignal.any([
                      c.signal,
                      AbortSignal.timeout(5000),
                    ]),
                  });
                  if (
                    r.ok &&
                    r.headers.get("Content-Type")?.startsWith("image/")
                  )
                    art = await r.blob();
                }
              } catch {}
              if (c.signal.aborted)
                throw new DOMException("취소", "AbortError");
              if (!(await db.tracks.get(data.track.id))) {
                await db.tracks.add({
                  ...data.track,
                  thumbnail: undefined,
                  art,
                  audio: blob,
                  added: Date.now(),
                });
              }
              complete = true;
              chunks = [];
            }
          }
        }
        if (!complete)
          throw new Error("연결이 중단되었습니다. 파일을 다시 받아 주세요.");
        update({ state: "done", stage: "보관 완료", percent: 100 });
        await refresh();
      } catch (e) {
        update(
          c.signal.aborted
            ? { state: "cancelled", stage: "취소됨" }
            : { state: "error", error: errorText(e) },
        );
      } finally {
        chunks = [];
        running.current = false;
        setJobs((old) => [...old]);
      }
    })();
  }, [jobs, auth, consent, refresh]);
  function cancel(job: Job) {
    if (job.state === "running") abort.current?.abort();
    else
      setJobs((old) =>
        old.map((j) => (j.key === job.key ? { ...j, state: "cancelled" } : j)),
      );
  }
  async function deleteSelected(ids: string[]) {
    if (!confirm(`${ids.length}곡을 기기에서 삭제할까요?`)) return;
    try {
      if (current && ids.includes(current.id)) {
        audio.current?.pause();
        if (blobUrl.current) URL.revokeObjectURL(blobUrl.current);
        setCurrent(undefined);
        setPosition(0);
        savedRef.current = { ...savedRef.current, id: undefined, position: 0 };
      }
      await removeTracks(ids);
      setQueue((q) => q.filter((id) => !ids.includes(id)));
      setSelected([]);
      setSelectionMode(false);
      await refresh();
      persistPlayer();
    } catch (e) {
      setNotice(errorText(e));
    }
  }
  async function importFiles(files: FileList | null) {
    if (!files) return;
    try {
      for (const f of Array.from(files)) {
        if (
          !f.type.startsWith("audio/") &&
          !/\.(m4a|mp3|wav|aac|ogg|flac)$/i.test(f.name)
        )
          continue;
        await db.tracks.add({
          id: "local-" + crypto.randomUUID(),
          title: f.name.replace(/\.[^.]+$/, ""),
          artist: "내 오디오",
          duration: 0,
          audio: f,
          added: Date.now(),
        });
      }
      await refresh();
      setNotice("오디오 파일을 보관했습니다.");
    } catch (e) {
      setNotice(errorText(e));
    }
    if (fileInput.current) fileInput.current.value = "";
  }
  async function saveEdit() {
    if (!edit) return;
    try {
      await db.tracks.update(edit.id, {
        title: edit.title.trim() || "제목 없음",
        artist: edit.artist.trim() || "알 수 없음",
        art: edit.art,
      });
      if (current?.id === edit.id) setCurrent(edit);
      setEdit(undefined);
      await refresh();
    } catch (e) {
      setNotice(errorText(e));
    }
  }
  async function createList() {
    if (!listName.trim()) return;
    try {
      await db.playlists.add({
        id: crypto.randomUUID(),
        name: listName.trim(),
        tracks: [],
      });
      setListName("");
      setListDialog(false);
      await refresh();
    } catch (e) {
      setNotice(errorText(e));
    }
  }
  async function changeList(list: Playlist, ids: string[]) {
    try {
      await db.playlists.update(list.id, {
        tracks: [...new Set([...list.tracks, ...ids])],
      });
      setAddToList(null);
      await refresh();
      setNotice("재생목록에 담았습니다.");
    } catch (e) {
      setNotice(errorText(e));
    }
  }
  const active = lists.find((l) => l.id === activeList);
  let visible = tracks.filter(
    (t) =>
      (!active || active.tracks.includes(t.id)) &&
      `${t.title} ${t.artist}`.toLowerCase().includes(filter.toLowerCase()),
  );
  visible.sort((a, b) =>
    active
      ? active.tracks.indexOf(a.id) - active.tracks.indexOf(b.id)
      : sort === "title"
        ? a.title.localeCompare(b.title, "ko")
        : sort === "old"
          ? a.added - b.added
          : b.added - a.added,
  );
  const pending = jobs.filter((j) =>
    ["waiting", "running"].includes(j.state),
  ).length;
  const togglePlay = () => {
    if (playing) audio.current?.pause();
    else
      void audio.current
        ?.play()
        .catch(() => setNotice("재생할 수 없는 오디오 형식입니다."));
  };
  const trackRows = (items: Track[]) =>
    items.map((t, i) => (
      <div
        className={"track-row " + (current?.id === t.id ? "is-current" : "")}
        key={t.id}
      >
        {selectionMode ? (
          <input
            aria-label={`${t.title} 선택`}
            type="checkbox"
            checked={selected.includes(t.id)}
            onChange={() =>
              setSelected((s) =>
                s.includes(t.id) ? s.filter((id) => id !== t.id) : [...s, t.id],
              )
            }
          />
        ) : (
          <span className="row-no">
            {current?.id === t.id && playing ? (
              <span className="equalizer">▮▮▮</span>
            ) : (
              String(i + 1).padStart(2, "0")
            )}
          </span>
        )}
        <button
          className="track-main"
          onClick={() =>
            selectionMode
              ? setSelected((s) =>
                  s.includes(t.id)
                    ? s.filter((id) => id !== t.id)
                    : [...s, t.id],
                )
              : startTrack(
                  t,
                  items.map((t) => t.id),
                )
          }
        >
          <Cover track={t} />
          <span>
            <b>{t.title}</b>
            <small>{t.artist}</small>
          </span>
        </button>
        <span className="track-duration">{fmt(t.duration)}</span>
        <button
          className="icon subtle"
          aria-label={`${t.title} 수정`}
          onClick={() => setEdit({ ...t })}
        >
          <MoreHorizontal size={20} />
        </button>
      </div>
    ));
  const toast = notice ? (
    <div role="status" className="toast" onClick={() => setNotice("")}>
      {notice}
      <X size={16} />
    </div>
  ) : null;
  if (!ready)
    return (
      <div className="splash">
        <span className="brand-mark">
          <Music2 />
        </span>
        <p>{initPhase}</p>
        <LoaderCircle className="spin" size={20} />
        {toast}
      </div>
    );
  if (!consent)
    return (
      <div className="welcome">
        <span className="eyebrow">YOUR MUSIC, YOUR SPACE</span>
        <span className="brand-mark big">
          <Music2 size={42} />
        </span>
        <h1>
          좋아하는 소리를,
          <br />
          나만의 Tunely에.
        </h1>
        <p>한 번 담아두면, 연결 없이도 들을 수 있어요.</p>
        <div className="consent-card">
          <HardDrive />
          <b>음악은 이 기기에만 보관돼요</b>
          <p>
            iOS 저장 공간 정리, 앱 또는 웹사이트 데이터 삭제 시 음악과
            재생목록이 사라질 수 있어요. 백업·기기 간 동기화는 제공하지 않아요.
          </p>
          <p>저장할 권한이 있는 콘텐츠만 이용해 주세요.</p>
        </div>
        <button
          className="primary wide"
          onClick={async () => {
            try {
              await setSetting("consent-v1", true);
              setConsent(true);
              if (navigator.storage?.persist)
                setPersistent(await navigator.storage.persist());
            } catch (e) {
              setNotice(errorText(e));
            }
          }}
        >
          확인했어요, 시작하기 <ChevronLeft className="flip" size={18} />
        </button>
        <small>처음 한 번만 확인합니다.</small>
        {toast}
      </div>
    );
  if (!auth)
    return (
      <div className="welcome login">
        <span className="brand-mark big">
          <Headphones size={40} />
        </span>
        <h1>나만의 음악 공간</h1>
        <p>Tunely 전용 비밀번호로 열어 주세요.</p>
        <form onSubmit={login}>
          <label htmlFor="password">앱 비밀번호</label>
          <input
            autoFocus
            id="password"
            type="password"
            autoComplete="current-password"
            placeholder="비밀번호 입력"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <button className="primary wide" disabled={loginBusy}>
            {loginBusy ? (
              <LoaderCircle className="spin" size={18} />
            ) : (
              <Headphones size={18} />
            )}{" "}
            Tunely 열기
          </button>
        </form>
        <small>
          로그인은 30일 동안 유지됩니다.
          <br />
          아이폰 잠금 비밀번호와 별개의 비밀번호예요.
        </small>
        {toast}
      </div>
    );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Tunely 홈">
          <span className="brand-mark">
            <Music2 size={24} />
          </span>
          Tunely<span className="beta">BETA</span>
        </a>
        <p className="sidebar-caption">A LITTLE SPACE FOR YOUR MUSIC</p>
        <nav>
          {[
            ["library", "라이브러리", Library],
            ["search", "음악 찾기", Search],
            ["playlists", "재생목록", ListMusic],
          ].map(([id, label, Icon]) => {
            const I = Icon as typeof Search;
            return (
              <button
                key={id as string}
                className={tab === id ? "nav-active" : ""}
                onClick={() => {
                  setTab(id as string);
                  setActiveList(undefined);
                  setFilter("");
                  setSelectionMode(false);
                }}
              >
                <I size={20} />
                {label as string}
                {id === "library" && (
                  <span className="nav-count">{tracks.length}</span>
                )}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-lists">
          <span>MY PLAYLISTS</span>
          <button
            className="icon"
            aria-label="재생목록 만들기"
            onClick={() => setListDialog(true)}
          >
            <Plus size={16} />
          </button>
          {lists.map((l) => (
            <button
              key={l.id}
              onClick={() => {
                setTab("library");
                setActiveList(l.id);
                setFilter("");
              }}
            >
              <span className="list-dot" />
              {l.name}
            </button>
          ))}
        </div>
        <div className="sidebar-bottom">
          <div className="local-note">
            <span className="status-dot" />
            <div>
              <b>내 기기에 보관 중</b>
              <small>
                {bytes(tracks.reduce((n, t) => n + t.audio.size, 0))} ·{" "}
                {tracks.length}곡
              </small>
            </div>
          </div>
          <button
            className={
              "settings-link " + (tab === "settings" ? "nav-active" : "")
            }
            onClick={() => setTab("settings")}
          >
            <Settings size={19} />
            설정
          </button>
          <span className="version">Tunely v0.1.0</span>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <span className="mobile-brand">
            <Music2 size={22} /> Tunely
          </span>
          <span className="breadcrumb">
            내 음악 공간 <span>/</span>{" "}
            {tab === "library"
              ? active?.name || "라이브러리"
              : tab === "search"
                ? "음악 찾기"
                : tab === "playlists"
                  ? "재생목록"
                  : "설정"}
          </span>
          <div className="topbar-right">
            {offline ? (
              <span className="connection">
                <WifiOff size={13} /> 오프라인
              </span>
            ) : (
              <span className="connection">
                <span className="status-dot" />
                개인 보관함
              </span>
            )}
            <button
              className="avatar"
              aria-label="설정 열기"
              onClick={() => setTab("settings")}
            >
              Y
            </button>
          </div>
        </header>
        <div className="content">
          {tab === "library" && (
            <>
              <div className="section-heading">
                <div>
                  <span className="eyebrow">YOUR PERSONAL COLLECTION</span>
                  <h1>
                    {active?.name || "나의 라이브러리"}
                    <span className="title-dot">.</span>
                  </h1>
                  <p>
                    {active
                      ? "취향대로 모은 소리를 순서대로 들어보세요."
                      : "좋아하는 음악을 담아, 언제 어디서나."}
                  </p>
                </div>
                <button className="primary" onClick={() => setTab("search")}>
                  <Plus size={18} /> 음악 담기
                </button>
              </div>
              <div className="collection-banner">
                <div>
                  <span className="banner-kicker">
                    <Headphones size={15} /> MADE FOR YOUR EVERYDAY
                  </span>
                  <h2>
                    오늘의 순간에,
                    <br />
                    좋아하는 소리 한 곡.
                  </h2>
                  <p>네트워크가 없어도, 음악은 계속돼요.</p>
                  <button
                    className="banner-play"
                    disabled={!visible.length}
                    onClick={() =>
                      startTrack(
                        visible[0],
                        visible.map((t) => t.id),
                      )
                    }
                  >
                    <Play size={14} fill="currentColor" /> 전체 재생
                  </button>
                </div>
                <div className="record-art" aria-hidden="true">
                  <div className="record">
                    <div className="record-label">
                      <Music2 size={27} />
                      <small>TUNELY / 01</small>
                    </div>
                  </div>
                  <span className="record-caption">SOUNDS LIKE YOU.</span>
                </div>
                <span className="banner-index">01 — YOUR COLLECTION</span>
              </div>
              <div className="library-toolbar">
                <h3>
                  {active ? "수록곡" : "모든 음악"}{" "}
                  <span>{visible.length}</span>
                </h3>
                <div className="toolbar-controls">
                  <label className="filter">
                    <Search size={16} />
                    <input
                      aria-label="라이브러리 검색"
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                      placeholder="내 음악 검색"
                    />
                  </label>
                  {!active && (
                    <select
                      aria-label="정렬"
                      value={sort}
                      onChange={(e) => setSort(e.target.value)}
                    >
                      <option value="new">최근 추가순</option>
                      <option value="old">오래된순</option>
                      <option value="title">제목순</option>
                    </select>
                  )}
                  <button
                    className="text-button"
                    onClick={() => {
                      setSelectionMode(!selectionMode);
                      setSelected([]);
                    }}
                  >
                    {selectionMode ? "취소" : "선택"}
                  </button>
                </div>
              </div>
              {selectionMode && (
                <div className="selection-bar">
                  <button
                    className="text-button"
                    onClick={() =>
                      setSelected(
                        selected.length === visible.length
                          ? []
                          : visible.map((t) => t.id),
                      )
                    }
                  >
                    전체 선택
                  </button>
                  <span>{selected.length}곡 선택</span>
                  <button
                    className="text-button"
                    disabled={!selected.length}
                    onClick={() => setAddToList(selected)}
                  >
                    목록에 추가
                  </button>
                  {active && (
                    <button
                      className="text-button"
                      disabled={!selected.length}
                      onClick={async () => {
                        await db.playlists.update(active.id, {
                          tracks: active.tracks.filter(
                            (id) => !selected.includes(id),
                          ),
                        });
                        setSelected([]);
                        await refresh();
                      }}
                    >
                      목록에서 제거
                    </button>
                  )}
                  <button
                    className="text-button danger"
                    disabled={!selected.length}
                    onClick={() => deleteSelected(selected)}
                  >
                    <Trash2 size={14} /> 삭제
                  </button>
                </div>
              )}
              {visible.length ? (
                <div className="track-table">
                  <div className="table-head">
                    <span>#</span>
                    <span>제목 / 아티스트</span>
                    <span>재생 시간</span>
                    <span />
                  </div>
                  {trackRows(visible)}
                </div>
              ) : (
                <div className="empty-state">
                  <span className="empty-icon">
                    <Music2 size={32} />
                  </span>
                  <h3>
                    {filter
                      ? "검색 결과가 없어요"
                      : "첫 번째 음악을 담아볼까요?"}
                  </h3>
                  <p>
                    {filter
                      ? "다른 제목이나 아티스트로 찾아보세요."
                      : "음악을 찾거나, 가지고 있는 오디오 파일을 추가해 보세요."}
                  </p>
                  <div>
                    <button
                      className="secondary"
                      onClick={() => setTab("search")}
                    >
                      <Search size={16} /> 음악 찾기
                    </button>
                    <button
                      className="text-button"
                      onClick={() => fileInput.current?.click()}
                    >
                      <Upload size={16} /> 파일 가져오기
                    </button>
                  </div>
                </div>
              )}
              <div className="footer-note">
                <HardDrive size={14} /> 이 기기에 저장된 음악은 오프라인에서도
                재생할 수 있어요.
              </div>
            </>
          )}
          {tab === "search" && (
            <>
              <div className="section-heading">
                <div>
                  <span className="eyebrow">FIND YOUR NEXT FAVORITE</span>
                  <h1>
                    음악 찾기<span className="title-dot">.</span>
                  </h1>
                  <p>검색부터 저장까지, Tunely 안에서.</p>
                </div>
                <button
                  className="secondary"
                  onClick={() => fileInput.current?.click()}
                >
                  <Upload size={16} /> 파일 가져오기
                </button>
              </div>
              <form className="search-form" onSubmit={search}>
                <Search size={22} />
                <input
                  aria-label="YouTube 검색어 또는 URL"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="제목, 아티스트 또는 YouTube URL"
                />
                <button className="primary" disabled={searching || offline}>
                  {searching ? (
                    <LoaderCircle className="spin" size={18} />
                  ) : (
                    <Search size={18} />
                  )}
                  <span>검색</span>
                </button>
              </form>
              <label className="permission">
                <input
                  type="checkbox"
                  checked={permitted}
                  onChange={(e) => setPermitted(e.target.checked)}
                />
                저장할 권한이 있는 콘텐츠만 다운로드합니다.
              </label>
              {searching ? (
                <div className="empty-state">
                  <LoaderCircle className="spin" />
                  <p>YouTube에서 음악을 찾고 있어요.</p>
                  <button
                    className="text-button"
                    onClick={() => {
                      searchAbort.current?.abort();
                      setSearching(false);
                    }}
                  >
                    검색 취소
                  </button>
                </div>
              ) : results.length ? (
                <>
                  <div className="library-toolbar">
                    <h3>
                      검색 결과 <span>{results.length}</span>
                    </h3>
                    <button
                      className="primary"
                      disabled={!picked.length || !permitted || offline}
                      onClick={() =>
                        enqueue(results.filter((t) => picked.includes(t.id)))
                      }
                    >
                      <ArrowDownToLine size={16} /> {picked.length || ""} 선택
                      저장
                    </button>
                  </div>
                  <div className="result-grid">
                    {results.map((t) => (
                      <article
                        className={
                          "result-card " +
                          (picked.includes(t.id) ? "picked" : "")
                        }
                        key={t.id}
                      >
                        <button
                          className="result-select"
                          onClick={() =>
                            setPicked((s) =>
                              s.includes(t.id)
                                ? s.filter((id) => id !== t.id)
                                : [...s, t.id],
                            )
                          }
                          aria-label={`${t.title} 선택`}
                        >
                          <Cover track={t} large />
                          <span className="result-check">
                            {picked.includes(t.id) ? (
                              <Check size={14} />
                            ) : (
                              <Plus size={14} />
                            )}
                          </span>
                          {!!t.duration && (
                            <span className="result-time">
                              {fmt(t.duration)}
                            </span>
                          )}
                        </button>
                        <b>{t.title}</b>
                        <small>{t.artist}</small>
                        <button
                          className="text-button"
                          disabled={!permitted || offline}
                          onClick={() => enqueue([t])}
                        >
                          {tracks.some((x) => x.id === t.id) ? (
                            <>
                              <Check size={14} /> 보관 중
                            </>
                          ) : (
                            <>
                              <ArrowDownToLine size={14} /> Tunely에 담기
                            </>
                          )}
                        </button>
                      </article>
                    ))}
                  </div>
                </>
              ) : (
                <div className="empty-state">
                  <Search size={34} />
                  <h3>
                    {searched ? "검색 결과가 없어요" : "지금 듣고 싶은 소리는?"}
                  </h3>
                  <p>검색어 또는 영상 URL을 입력해 주세요.</p>
                </div>
              )}
            </>
          )}
          {tab === "playlists" && (
            <>
              <div className="section-heading">
                <div>
                  <span className="eyebrow">A MIX OF YOUR OWN</span>
                  <h1>
                    재생목록<span className="title-dot">.</span>
                  </h1>
                  <p>순간과 기분에 맞춰 모아두세요.</p>
                </div>
                <button className="primary" onClick={() => setListDialog(true)}>
                  <Plus size={18} /> 새 목록
                </button>
              </div>
              <div className="playlist-grid">
                {lists.map((l, i) => (
                  <article className="playlist-card" key={l.id}>
                    <button
                      className={"playlist-art color-" + (i % 4)}
                      onClick={() => {
                        setActiveList(l.id);
                        setTab("library");
                        setFilter("");
                      }}
                    >
                      <ListMusic size={44} />
                      <span>{l.tracks.length} TRACKS</span>
                    </button>
                    <button
                      className="playlist-title"
                      onClick={() => {
                        setActiveList(l.id);
                        setTab("library");
                        setFilter("");
                      }}
                    >
                      {l.name}
                    </button>
                    <div>
                      <span>{l.tracks.length}곡</span>
                      <button
                        className="icon"
                        aria-label={`${l.name} 이름 변경`}
                        onClick={async () => {
                          const name = prompt("새 재생목록 이름", l.name);
                          if (name?.trim()) {
                            await db.playlists.update(l.id, {
                              name: name.trim(),
                            });
                            await refresh();
                          }
                        }}
                      >
                        <MoreHorizontal size={18} />
                      </button>
                      <button
                        className="icon"
                        aria-label={`${l.name} 삭제`}
                        onClick={async () => {
                          if (
                            confirm(
                              "재생목록을 삭제할까요? 음악 파일은 유지됩니다.",
                            )
                          ) {
                            await db.playlists.delete(l.id);
                            if (activeList === l.id) setActiveList(undefined);
                            await refresh();
                          }
                        }}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </article>
                ))}
                <button
                  className="playlist-create"
                  onClick={() => setListDialog(true)}
                >
                  <Plus size={28} />
                  <span>새 재생목록 만들기</span>
                </button>
              </div>
              {active && (
                <div>
                  {active.tracks.map((id, i) => (
                    <div className="order-row" key={id}>
                      {tracks.find((t) => t.id === id)?.title}
                      <button
                        onClick={async () => {
                          if (!i) return;
                          const order = [...active.tracks];
                          [order[i - 1], order[i]] = [order[i], order[i - 1]];
                          await db.playlists.update(active.id, {
                            tracks: order,
                          });
                          await refresh();
                        }}
                      >
                        위로
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
          {tab === "settings" && (
            <>
              <div className="section-heading">
                <div>
                  <span className="eyebrow">KEEP IT PERSONAL</span>
                  <h1>
                    설정<span className="title-dot">.</span>
                  </h1>
                  <p>내 공간을 편안하게 관리해요.</p>
                </div>
              </div>
              <div className="settings-card">
                <HardDrive size={22} />
                <h3>기기 저장 공간</h3>
                <p>
                  오디오 {bytes(tracks.reduce((n, t) => n + t.audio.size, 0))} ·{" "}
                  {tracks.length}곡
                </p>
                <div className="storage-bar">
                  <span
                    style={{
                      width: storage.quota
                        ? Math.min((storage.usage / storage.quota) * 100, 100) +
                          "%"
                        : "0%",
                    }}
                  />
                </div>
                <small>
                  웹 저장소 {bytes(storage.usage)} / {bytes(storage.quota)} ·
                  기기 전체 용량과 다를 수 있어요.
                </small>
                <div className="setting-row">
                  <div>
                    <b>저장소 자동 정리 보호</b>
                    <small>
                      {persistent
                        ? "영구 저장이 허용되어 있어요."
                        : persistent === false
                          ? "현재 영구 저장이 허용되지 않았어요."
                          : "이 브라우저에서 지원 여부를 확인하지 못했어요."}
                    </small>
                  </div>
                  <button
                    className="secondary"
                    onClick={async () => {
                      try {
                        if (navigator.storage?.persist) {
                          const ok = await navigator.storage.persist();
                          setPersistent(ok);
                          setNotice(
                            ok
                              ? "영구 저장이 허용되었습니다."
                              : "브라우저가 허용하지 않았습니다. 홈 화면에 설치 후 다시 시도해 주세요.",
                          );
                        } else
                          setNotice(
                            "이 브라우저는 영구 저장 요청을 지원하지 않습니다.",
                          );
                      } catch (e) {
                        setNotice(errorText(e));
                      }
                    }}
                  >
                    보호 요청
                  </button>
                </div>
              </div>
              <div className="settings-card">
                <h3>iPhone에 설치하기</h3>
                <p>
                  Safari에서 공유 버튼 → ‘홈 화면에 추가’를 선택하세요.
                  <br />
                  저장된 음악은 설치한 Tunely에서 오프라인으로 재생할 수 있어요.
                </p>
                <small>
                  잠금 화면의 곡 전환은 iOS 버전에 따라 다를 수 있어요.
                </small>
              </div>
              <div className="settings-card">
                <h3>로그인 및 연결</h3>
                <p>
                  로그인 만료:{" "}
                  {new Date(expires * 1000).toLocaleDateString("ko-KR")}
                </p>
                <div className="setting-actions">
                  <button
                    className="secondary"
                    onClick={async () => {
                      try {
                        const r = await api("health");
                        const d = await r.json();
                        setHealth(
                          `yt-dlp ${d.yt_dlp} · FFmpeg ${d.ffmpeg ? "준비됨" : "없음"} · Deno ${d.deno ? "준비됨" : "없음"}`,
                        );
                      } catch (e) {
                        setHealth(errorText(e));
                      }
                    }}
                  >
                    서버 연결 확인
                  </button>
                  <button
                    className="secondary"
                    onClick={async () => {
                      try {
                        await api("auth/logout", {});
                      } catch {
                        setNotice(
                          "서버 로그아웃에 실패했습니다. 연결 후 다시 시도해 주세요.",
                        );
                        return;
                      }
                      audio.current?.pause();
                      abort.current?.abort();
                      searchAbort.current?.abort();
                      await setSetting("session-expiry", 0);
                      setAuth(false);
                    }}
                  >
                    <LogOut size={15} />
                    로그아웃
                  </button>
                </div>
                {health && <small className="health">{health}</small>}
              </div>
              <div className="settings-card warning-card">
                <h3>보관에 관한 안내</h3>
                <p>
                  iOS 저장 공간 정리, 앱·웹 데이터 삭제 시 음악과 재생목록이
                  사라질 수 있습니다. 영구 저장이 허용되어도 사용자의 삭제까지
                  막을 수는 없습니다. 원본 오디오는 별도로 보관해 주세요.
                </p>
                <small>Tunely v0.1.0 · 개인용 MVP</small>
              </div>
            </>
          )}
          {jobs.length > 0 && (
            <section className="queue-panel">
              <div className="queue-heading">
                <h3>
                  <ArrowDownToLine size={17} /> 다운로드{" "}
                  {pending > 0 && <span>{pending}곡 진행 중</span>}
                </h3>
                <button
                  className="text-button"
                  onClick={() =>
                    setJobs((j) =>
                      j.filter((x) => ["waiting", "running"].includes(x.state)),
                    )
                  }
                >
                  완료 기록 지우기
                </button>
              </div>
              {jobs.map((j) => (
                <div className="job" key={j.key}>
                  <div>
                    <b>{j.title}</b>
                    <small className={j.state === "error" ? "danger" : ""}>
                      {j.error ||
                        j.stage ||
                        (j.state === "waiting"
                          ? "대기 중"
                          : j.state === "cancelled"
                            ? "취소됨"
                            : "완료")}
                      {j.state === "running" && j.percent != null
                        ? ` · ${j.percent}%`
                        : ""}
                    </small>
                    {j.state === "running" && (
                      <progress max="100" value={j.percent ?? undefined} />
                    )}
                  </div>
                  {["waiting", "running"].includes(j.state) ? (
                    <button
                      className="icon"
                      aria-label={`${j.title} 다운로드 취소`}
                      onClick={() => cancel(j)}
                    >
                      <X size={17} />
                    </button>
                  ) : j.state === "error" || j.state === "cancelled" ? (
                    <button
                      className="text-button"
                      disabled={offline}
                      onClick={() =>
                        setJobs((old) =>
                          old.map((x) =>
                            x.key === j.key
                              ? {
                                  ...x,
                                  state: "waiting",
                                  error: undefined,
                                  stage: undefined,
                                  percent: undefined,
                                }
                              : x,
                          ),
                        )
                      }
                    >
                      재시도
                    </button>
                  ) : (
                    <Check size={18} />
                  )}
                </div>
              ))}
            </section>
          )}
        </div>
      </main>
      <input
        ref={fileInput}
        type="file"
        accept="audio/*,.m4a,.mp3,.wav,.aac,.flac"
        multiple
        hidden
        onChange={(e) => void importFiles(e.target.files)}
      />
      <audio
        ref={audio}
        preload="metadata"
        playsInline
        onPlay={() => setPlaying(true)}
        onPause={() => {
          setPlaying(false);
          persistPlayer();
        }}
        onLoadedMetadata={() => {
          const a = audio.current;
          if (!a) return;
          setDuration(Number.isFinite(a.duration) ? a.duration : 0);
          if (current && !current.duration && Number.isFinite(a.duration))
            void db.tracks
              .update(current.id, { duration: a.duration })
              .then(refresh);
          if (seekRef.current !== null) {
            a.currentTime = seekRef.current;
            seekRef.current = null;
          }
          if (playOnLoad.current) {
            playOnLoad.current = false;
            void a.play().catch(() => setNotice("재생 버튼을 눌러 주세요."));
          }
        }}
        onTimeUpdate={() => {
          const a = audio.current;
          if (!a) return;
          setPosition(a.currentTime);
          savedRef.current = { ...savedRef.current, position: a.currentTime };
          if (Date.now() - lastSave.current > 4000) {
            lastSave.current = Date.now();
            persistPlayer();
          }
          if (
            "mediaSession" in navigator &&
            Number.isFinite(a.duration) &&
            a.duration > 0
          ) {
            try {
              navigator.mediaSession.setPositionState({
                duration: a.duration,
                position: Math.min(a.currentTime, a.duration),
                playbackRate: a.playbackRate,
              });
            } catch {}
          }
        }}
        onEnded={() => next(1, true)}
        onError={() => {
          if (current)
            setNotice(
              "이 오디오를 재생할 수 없습니다. 파일 형식을 확인해 주세요.",
            );
        }}
      />
      {current && (
        <div className="mini-player">
          <button className="now-playing" onClick={() => setExpanded(true)}>
            <Cover track={current} />
            <span>
              <b>{current.title}</b>
              <small>{current.artist}</small>
            </span>
          </button>
          <div className="player-center">
            <div className="play-controls">
              <button
                className={"icon optional " + (shuffle ? "active" : "")}
                aria-label="셔플"
                onClick={() => setShuffle(!shuffle)}
              >
                <Shuffle size={17} />
              </button>
              <button
                className="icon"
                aria-label="이전 곡"
                onClick={() => next(-1)}
              >
                <SkipBack size={20} />
              </button>
              <button
                className="play-button"
                aria-label={playing ? "일시정지" : "재생"}
                onClick={togglePlay}
              >
                {playing ? (
                  <Pause size={20} fill="currentColor" />
                ) : (
                  <Play size={20} fill="currentColor" />
                )}
              </button>
              <button
                className="icon"
                aria-label="다음 곡"
                onClick={() => next()}
              >
                <SkipForward size={20} />
              </button>
              <button
                className={
                  "icon optional " + (repeat !== "off" ? "active" : "")
                }
                aria-label="반복"
                onClick={() =>
                  setRepeat(
                    repeat === "off" ? "all" : repeat === "all" ? "one" : "off",
                  )
                }
              >
                {repeat === "one" ? (
                  <Repeat1 size={17} />
                ) : (
                  <Repeat size={17} />
                )}
              </button>
            </div>
            <div className="seek">
              <span>{fmt(position)}</span>
              <input
                aria-label="재생 위치"
                type="range"
                min="0"
                max={duration || 1}
                step="0.1"
                value={Math.min(position, duration || 0)}
                onChange={(e) => {
                  if (audio.current) {
                    audio.current.currentTime = Number(e.target.value);
                    setPosition(Number(e.target.value));
                  }
                }}
              />
              <span>{fmt(duration)}</span>
            </div>
          </div>
          <div className="player-extra">
            <button className="text-button" onClick={() => setExpanded(true)}>
              {speed.toFixed(2).replace(/0$/, "")}×
            </button>
            <button
              className="icon"
              aria-label="전체 플레이어 열기"
              onClick={() => setExpanded(true)}
            >
              <ChevronUp size={21} />
            </button>
          </div>
        </div>
      )}
      <nav className={"mobile-nav " + (current ? "with-player" : "")}>
        {[
          ["library", "보관함", Library],
          ["search", "찾기", Search],
          ["playlists", "목록", ListMusic],
          ["settings", "설정", Settings],
        ].map(([id, label, Icon]) => {
          const I = Icon as typeof Search;
          return (
            <button
              key={id as string}
              className={tab === id ? "active" : ""}
              onClick={() => {
                setTab(id as string);
                setActiveList(undefined);
                setFilter("");
              }}
            >
              <I size={20} />
              <span>{label as string}</span>
            </button>
          );
        })}
      </nav>
      {expanded && current && (
        <div className="modal-backdrop">
          <section
            className="full-player"
            role="dialog"
            aria-modal="true"
            aria-label="오디오 플레이어"
          >
            <div className="modal-heading">
              <button
                className="icon"
                aria-label="플레이어 닫기"
                onClick={() => setExpanded(false)}
              >
                <ChevronDown />
              </button>
              <span className="eyebrow">NOW PLAYING</span>
              <button
                className="icon"
                aria-label="음악 정보 수정"
                onClick={() => setEdit({ ...current })}
              >
                <MoreHorizontal />
              </button>
            </div>
            <Cover track={current} large />
            <h2>{current.title}</h2>
            <p>{current.artist}</p>
            <div className="seek">
              <span>{fmt(position)}</span>
              <input
                aria-label="전체 플레이어 재생 위치"
                type="range"
                max={duration || 1}
                value={Math.min(position, duration || 0)}
                step="0.1"
                onChange={(e) => {
                  if (audio.current)
                    audio.current.currentTime = Number(e.target.value);
                  setPosition(Number(e.target.value));
                }}
              />
              <span>{fmt(duration)}</span>
            </div>
            <div className="full-controls">
              <button
                className={"icon " + (shuffle ? "active" : "")}
                aria-label="셔플 전환"
                onClick={() => setShuffle(!shuffle)}
              >
                <Shuffle />
              </button>
              <button
                className="icon"
                aria-label="이전 음악"
                onClick={() => next(-1)}
              >
                <SkipBack size={28} />
              </button>
              <button
                className="play-button"
                aria-label={playing ? "일시정지" : "재생"}
                onClick={togglePlay}
              >
                {playing ? (
                  <Pause size={26} fill="currentColor" />
                ) : (
                  <Play size={26} fill="currentColor" />
                )}
              </button>
              <button
                className="icon"
                aria-label="다음 음악"
                onClick={() => next()}
              >
                <SkipForward size={28} />
              </button>
              <button
                className={"icon " + (repeat !== "off" ? "active" : "")}
                aria-label="반복 전환"
                onClick={() =>
                  setRepeat(
                    repeat === "off" ? "all" : repeat === "all" ? "one" : "off",
                  )
                }
              >
                {repeat === "one" ? <Repeat1 /> : <Repeat />}
              </button>
            </div>
            <div className="speed-control">
              <span>재생 속도</span>
              <select
                aria-label="재생 속도"
                value={speed}
                onChange={(e) => setSpeed(Number(e.target.value))}
              >
                {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((s) => (
                  <option value={s} key={s}>
                    {s}×
                  </option>
                ))}
              </select>
            </div>
            <button
              className="secondary wide"
              onClick={() => setAddToList([current.id])}
            >
              <Plus size={16} />
              재생목록에 추가
            </button>
            <div className="up-next">
              <h3>다음 재생</h3>
              {queue
                .map((id) => tracks.find((t) => t.id === id))
                .filter((t): t is Track => !!t)
                .map((t) => (
                  <button
                    className={t.id === current.id ? "active" : ""}
                    key={t.id}
                    onClick={() => startTrack(t)}
                  >
                    {t.title}
                    <small>{t.artist}</small>
                  </button>
                ))}
            </div>
          </section>
        </div>
      )}
      {edit && (
        <div className="modal-backdrop">
          <form
            className="dialog"
            onSubmit={(e) => {
              e.preventDefault();
              void saveEdit();
            }}
            role="dialog"
            aria-modal="true"
            aria-label="음악 정보 수정"
          >
            <div className="modal-heading">
              <h2>음악 정보</h2>
              <button
                type="button"
                className="icon"
                aria-label="닫기"
                onClick={() => setEdit(undefined)}
              >
                <X />
              </button>
            </div>
            <Cover track={edit} />
            <label>
              제목
              <input
                required
                value={edit.title}
                onChange={(e) => setEdit({ ...edit, title: e.target.value })}
              />
            </label>
            <label>
              아티스트
              <input
                value={edit.artist}
                onChange={(e) => setEdit({ ...edit, artist: e.target.value })}
              />
            </label>
            <label>
              커버 이미지
              <input
                type="file"
                accept="image/*"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f && f.size <= 10 * 1024 ** 2)
                    setEdit({ ...edit, art: f });
                  else if (f)
                    setNotice("커버 이미지는 10MB 이하로 선택해 주세요.");
                }}
              />
            </label>
            <div className="dialog-actions">
              <button
                className="text-button danger"
                type="button"
                onClick={() => {
                  const id = edit.id;
                  setEdit(undefined);
                  void deleteSelected([id]);
                }}
              >
                음악 삭제
              </button>
              <button className="primary">저장</button>
            </div>
            {active && (
              <div className="order-buttons">
                <button
                  type="button"
                  className="secondary"
                  onClick={async () => {
                    const order = [...active.tracks],
                      i = order.indexOf(edit.id);
                    if (i > 0) {
                      [order[i - 1], order[i]] = [order[i], order[i - 1]];
                      await db.playlists.update(active.id, { tracks: order });
                      await refresh();
                    }
                  }}
                >
                  <ChevronUp size={15} />
                  목록 위로
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={async () => {
                    const order = [...active.tracks],
                      i = order.indexOf(edit.id);
                    if (i >= 0 && i < order.length - 1) {
                      [order[i + 1], order[i]] = [order[i], order[i + 1]];
                      await db.playlists.update(active.id, { tracks: order });
                      await refresh();
                    }
                  }}
                >
                  <ChevronDown size={15} />
                  목록 아래로
                </button>
              </div>
            )}
          </form>
        </div>
      )}
      {listDialog && (
        <div className="modal-backdrop">
          <form
            className="dialog"
            onSubmit={(e) => {
              e.preventDefault();
              void createList();
            }}
            role="dialog"
            aria-modal="true"
            aria-label="재생목록 만들기"
          >
            <div className="modal-heading">
              <h2>새 재생목록</h2>
              <button
                className="icon"
                type="button"
                aria-label="닫기"
                onClick={() => setListDialog(false)}
              >
                <X />
              </button>
            </div>
            <label>
              재생목록 이름
              <input
                autoFocus
                required
                maxLength={100}
                placeholder="예: 퇴근길에 듣는 음악"
                value={listName}
                onChange={(e) => setListName(e.target.value)}
              />
            </label>
            <button className="primary wide">만들기</button>
          </form>
        </div>
      )}
      {addToList && (
        <div className="modal-backdrop">
          <div
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-label="재생목록 선택"
          >
            <div className="modal-heading">
              <h2>재생목록에 추가</h2>
              <button
                className="icon"
                aria-label="닫기"
                onClick={() => setAddToList(null)}
              >
                <X />
              </button>
            </div>
            {lists.map((l) => (
              <button
                key={l.id}
                className="list-choice"
                onClick={() => void changeList(l, addToList)}
              >
                <ListMusic size={19} />
                {l.name}
                <Plus size={17} />
              </button>
            ))}
            {!lists.length && <p>먼저 재생목록을 만들어 주세요.</p>}
            <button
              className="secondary wide"
              onClick={() => {
                setAddToList(null);
                setListDialog(true);
              }}
            >
              새 재생목록
            </button>
          </div>
        </div>
      )}
      {toast}
    </div>
  );
}
