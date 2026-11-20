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
  ChevronUp,
  ChevronDown,
  Headphones,
  WifiOff,
  HardDrive,
  LogOut,
  Link as LinkIcon,
  LoaderCircle,
  MoreHorizontal,
  RotateCcw,
  RotateCw,
} from "./icons";
import {
  ACCENTS,
  FONTS,
  ICON_SETS,
  THEMES,
  applyLook,
  getLook,
  setLook,
  useLook,
} from "./look";
import {
  db,
  removeTracks,
  setting,
  setSetting,
  trackAudio,
  trackSize,
  type Track,
  type Playlist,
} from "./db";
import {
  flushLibrary,
  initialBackup,
  installSyncHooks,
  onSyncChange,
  setSyncPoster,
  syncStatus,
} from "./sync";

if (typeof window !== "undefined") installSyncHooks();
type LibTrack = {
  video_id: string;
  title: string;
  artist: string;
  duration: number;
  codec?: string | null;
};
type LibPlaylist = { id: string; name: string; tracks: string[] };
type PushState = "unsupported" | "off" | "on" | "denied" | "busy";
const pushSupported = () =>
  typeof window !== "undefined" &&
  "serviceWorker" in navigator &&
  "PushManager" in window &&
  "Notification" in window;
const b64ToBytes = (b64: string) => {
  const s = atob(
    (b64 + "=".repeat((4 - (b64.length % 4)) % 4))
      .replace(/-/g, "+")
      .replace(/_/g, "/"),
  );
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};
// navigator.serviceWorker.ready never settles without a registered worker (e.g. dev).
const swReady = () =>
  Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("앱을 홈 화면에서 다시 열어 주세요.")),
        5000,
      ),
    ),
  ]);

type Result = Omit<Track, "audio" | "added"> & {
  views?: number | null;
  published?: number | null;
};
type SearchSort = "relevance" | "date" | "views";
const sorts: [SearchSort, string][] = [
  ["relevance", "관련도"],
  ["date", "최신순"],
  ["views", "조회수순"],
];
const compact = (n: number) =>
  n >= 1e8
    ? `${+(n / 1e8).toFixed(n < 1e9 ? 1 : 0)}억`
    : n >= 1e4
      ? `${+(n / 1e4).toFixed(n < 1e5 ? 1 : 0)}만`
      : n.toLocaleString("ko-KR");
const ago = (ts: number) => {
  const d = (Date.now() / 1000 - ts) / 86400;
  return d >= 365
    ? `${Math.floor(d / 365)}년 전`
    : d >= 30
      ? `${Math.floor(d / 30)}개월 전`
      : d >= 7
        ? `${Math.floor(d / 7)}주 전`
        : d >= 1
          ? `${Math.floor(d)}일 전`
          : "오늘";
};
const resultMeta = (t: Result) =>
  [
    t.views != null && `조회수 ${compact(t.views)}${t.views < 1e4 ? "회" : ""}`,
    t.published && ago(t.published),
  ]
    .filter(Boolean)
    .join(" · ");
type Job = {
  id: string;
  video_id: string;
  title: string;
  artist: string;
  duration: number;
  thumbnail?: string;
  status: "queued" | "processing" | "ready" | "failed";
  progress?: number | null;
  stage?: string | null;
  error?: string | null;
  size?: number | null;
  source_codec?: string | null;
  audio_urls?: string[];
  cover_url?: string;
  receiving?: boolean;
  receivePercent?: number;
  receiveError?: string;
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
async function api(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  method?: string,
) {
  const r = await fetch("/api/" + path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
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
    [searchSort, setSearchSort] = useState<SearchSort>("relevance"),
    [searchLimit, setSearchLimit] = useState(20),
    [lastQuery, setLastQuery] = useState(""),
    [loadingMore, setLoadingMore] = useState(false),
    [picked, setPicked] = useState<string[]>([]),
    [jobs, setJobs] = useState<Job[]>([]),
    [agentOnline, setAgentOnline] = useState<boolean>(),
    [syncInfo, setSyncInfo] = useState({ pending: 0, lastSync: 0 }),
    [restore, setRestore] = useState<{
      tracks: LibTrack[];
      playlists: LibPlaylist[];
      total: number;
    } | null>(null),
    [restorePicks, setRestorePicks] = useState<string[]>([]),
    [restoreBusy, setRestoreBusy] = useState(false),
    [pushState, setPushState] = useState<PushState>();
  const look = useLook();
  useEffect(() => {
    // Re-apply once on mount so the status-bar colour matches (the inline script ran earlier).
    applyLook(getLook());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    // Font previews in 꾸미기: Google Fonts only sends the glyphs that are used.
    if (tab !== "settings" || document.getElementById("font-previews")) return;
    const link = document.createElement("link");
    link.id = "font-previews";
    link.rel = "stylesheet";
    link.href =
      "https://fonts.googleapis.com/css2?" +
      FONTS.map((f) => `family=${f[2].replace(/ /g, "+")}:wght@${f[3]}`).join(
        "&",
      ) +
      "&display=swap&text=" +
      encodeURIComponent(
        "나의 라이브러리GaeguNanumPenScriptJuaHiMelodyPoorStory",
      );
    document.head.appendChild(link);
  }, [tab]);
  // Titles/artists from the backup win over YouTube's when a track is restored.
  const serverMeta = useRef(new Map<string, LibTrack>());
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
    [pickFor, setPickFor] = useState<string | null>(null),
    [picks, setPicks] = useState<string[]>([]),
    [pickFilter, setPickFilter] = useState(""),
    [health, setHealth] = useState("");
  const audio = useRef<HTMLAudioElement>(null),
    blobUrl = useRef<string | undefined>(undefined),
    abort = useRef<AbortController | undefined>(undefined),
    searchAbort = useRef<AbortController | undefined>(undefined),
    receivingRef = useRef(new Set<string>()),
    savedRef = useRef<Saved>(emptySaved),
    seekRef = useRef<number | null>(null),
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
    let alive = true;
    void trackAudio(current)
      .then((blob) => {
        if (!alive) return;
        if (blobUrl.current) URL.revokeObjectURL(blobUrl.current);
        blobUrl.current = URL.createObjectURL(blob);
        a.src = blobUrl.current;
        a.playbackRate = savedRef.current.speed;
      })
      .catch((e) => setNotice(errorText(e)));
    return () => {
      alive = false;
      a.pause();
    };
  }, [current?.id, auth, ready]);
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
    [current?.id, auth, ready],
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
    const handlers: Record<string, MediaSessionActionHandler | null> = {
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
      // iOS shows either ±10s or previous/next on the lock screen, never both.
      // Clearing the seek actions makes it show previous/next track buttons.
      seekbackward: null,
      seekforward: null,
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
      if (navigator.storage?.persist)
        void navigator.storage
          .persist()
          .then(setPersistent)
          .catch(() => {});
    } catch (e) {
      setNotice(errorText(e));
    } finally {
      setLoginBusy(false);
    }
  }
  async function search(
    e?: React.FormEvent,
    sortBy = searchSort,
    limit = 20,
    text = query.trim(),
  ) {
    e?.preventDefault();
    if (!text) return;
    const more = limit > 20;
    searchAbort.current?.abort();
    const c = new AbortController();
    searchAbort.current = c;
    if (more) setLoadingMore(true);
    else {
      setSearching(true);
      setSearched(true);
      setPicked([]);
      setSearchLimit(20);
    }
    try {
      if (/^https?:/.test(text)) {
        const v = canonicalClient(text);
        setLastQuery("");
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
      // yt-dlp can't continue a search, so "more" asks again for 40 or 60 results.
      const r = await api(
        "search",
        { query: text, sort: sortBy, limit },
        c.signal,
      );
      const items: Result[] = await r.json();
      setResults(items);
      setSearchLimit(limit);
      setLastQuery(text);
    } catch (e) {
      if (!c.signal.aborted) {
        if (!more) setResults([]);
        setNotice(errorText(e));
      }
    } finally {
      if (!c.signal.aborted) {
        setSearching(false);
        setLoadingMore(false);
      }
    }
  }
  const receive = useCallback(
    async (job: Job) => {
      if (!job.audio_urls?.length || receivingRef.current.has(job.id)) return;
      receivingRef.current.add(job.id);
      const mark = (patch: Partial<Job>) =>
        setJobs((old) =>
          old.map((j) => (j.id === job.id ? { ...j, ...patch } : j)),
        );
      mark({ receiving: true, receiveError: undefined });
      try {
        if (!(await db.tracks.get(job.video_id))) {
          const urls = job.audio_urls || [];
          if (!urls.length) throw new Error("받을 음원이 없습니다.");
          const total = job.size || 0;
          if (total && navigator.storage?.estimate) {
            const e = await navigator.storage.estimate();
            if (e.quota && total > e.quota - (e.usage || 0))
              throw new Error("기기 저장 공간이 부족합니다.");
          }
          // Each chunk (≤40MB) goes straight to IndexedDB, so a 10-hour file
          // never has to sit in memory at once. Saved chunks survive a retry.
          const fetchPart = async (url: string) => {
            const r = await fetch(url, { signal: AbortSignal.timeout(300000) });
            if (!r.ok) throw new Error(`음원을 받지 못했습니다. (${r.status})`);
            const blob = await r.blob();
            if (!blob.size) throw new Error("빈 오디오 파일입니다.");
            return blob;
          };
          let single: Blob | undefined;
          if (urls.length === 1) single = await fetchPart(urls[0]);
          else
            for (let i = 0; i < urls.length; i++) {
              mark({ receivePercent: Math.round((i / urls.length) * 100) });
              if (await db.parts.get([job.video_id, i])) continue;
              await db.parts.put({
                track: job.video_id,
                index: i,
                blob: await fetchPart(urls[i]),
              });
            }
          let art: Blob | undefined;
          try {
            if (job.cover_url) {
              const c = await fetch(job.cover_url, {
                signal: AbortSignal.timeout(20000),
              });
              if (c.ok) art = await c.blob();
            }
          } catch {}
          if (!(await db.tracks.get(job.video_id)))
            await db.tracks.add({
              id: job.video_id,
              title: serverMeta.current.get(job.video_id)?.title || job.title,
              artist:
                serverMeta.current.get(job.video_id)?.artist || job.artist,
              duration: job.duration,
              url: "https://www.youtube.com/watch?v=" + job.video_id,
              codec: job.source_codec || undefined,
              art: art?.size
                ? new Blob([art], { type: "image/jpeg" })
                : undefined,
              ...(single
                ? { audio: new Blob([single], { type: "audio/mp4" }) }
                : { parts: urls.length, size: total }),
              added: Date.now(),
            });
          await refresh();
        }
        await api(`jobs/${job.id}/received`, {});
        setJobs((old) => old.filter((j) => j.id !== job.id));
        setNotice(`‘${job.title}’을 보관함에 담았어요.`);
      } catch (e) {
        mark({ receiving: false, receiveError: errorText(e) });
      } finally {
        receivingRef.current.delete(job.id);
      }
    },
    [refresh],
  );
  useEffect(() => {
    if (!auth) return;
    setSyncPoster((body) => api("library/sync", body));
    const update = () => setSyncInfo(syncStatus());
    const off = onSyncChange(update);
    update();
    void initialBackup().then(flushLibrary);
    const retry = () => {
      if (document.visibilityState === "visible") void flushLibrary();
    };
    window.addEventListener("online", retry);
    document.addEventListener("visibilitychange", retry);
    return () => {
      off();
      window.removeEventListener("online", retry);
      document.removeEventListener("visibilitychange", retry);
    };
  }, [auth]);
  useEffect(() => {
    if (!auth) return;
    if (!pushSupported()) return setPushState("unsupported");
    if (Notification.permission === "denied") return setPushState("denied");
    (async () => {
      try {
        const sub = await (await swReady()).pushManager.getSubscription();
        if (sub && Notification.permission === "granted") {
          setPushState("on");
          // Re-register so the server still knows this phone after any cleanup.
          await api("push/subscribe", sub.toJSON()).catch(() => {});
        } else setPushState("off");
      } catch {
        setPushState("off");
      }
    })();
  }, [auth]);
  async function enablePush() {
    setPushState("busy");
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setPushState(permission === "denied" ? "denied" : "off");
        return;
      }
      const reg = await swReady();
      const { key } = await (await api("push/key")).json();
      const sub =
        (await reg.pushManager.getSubscription()) ||
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: b64ToBytes(key),
        }));
      await api("push/subscribe", sub.toJSON());
      setPushState("on");
      setNotice("알림을 켰어요. PC가 곡을 준비하면 알려 드릴게요.");
    } catch (e) {
      setPushState("off");
      setNotice(errorText(e));
    }
  }
  async function disablePush() {
    setPushState("busy");
    try {
      const sub = await (await swReady()).pushManager.getSubscription();
      if (sub) {
        await api("push/unsubscribe", { endpoint: sub.endpoint }).catch(
          () => {},
        );
        await sub.unsubscribe();
      }
      setPushState("off");
    } catch (e) {
      setPushState("on");
      setNotice(errorText(e));
    }
  }
  async function openRestore() {
    setRestoreBusy(true);
    try {
      await flushLibrary();
      const d: { tracks: LibTrack[]; playlists: LibPlaylist[] } = await (
        await api("library")
      ).json();
      d.tracks.forEach((t) => serverMeta.current.set(t.video_id, t));
      const have = new Set(await db.tracks.toCollection().primaryKeys());
      const lists = new Set(await db.playlists.toCollection().primaryKeys());
      const missing = d.tracks.filter((t) => !have.has(t.video_id));
      setRestore({
        tracks: missing,
        playlists: d.playlists.filter((p) => !lists.has(p.id)),
        total: d.tracks.length,
      });
      setRestorePicks(missing.map((t) => t.video_id));
    } catch (e) {
      setNotice(errorText(e));
    } finally {
      setRestoreBusy(false);
    }
  }
  async function runRestore() {
    if (!restore) return;
    setRestoreBusy(true);
    try {
      // Playlists come back right away; their songs appear as each one is received.
      for (const pl of restore.playlists)
        if (!(await db.playlists.get(pl.id)))
          await db.playlists.add({
            id: pl.id,
            name: pl.name,
            tracks: pl.tracks,
          });
      await refresh();
      const picked = restore.tracks.filter((t) =>
        restorePicks.includes(t.video_id),
      );
      if (picked.length)
        await enqueue(
          picked.map((t) => ({
            id: t.video_id,
            title: t.title,
            artist: t.artist,
            duration: t.duration,
            url: "https://www.youtube.com/watch?v=" + t.video_id,
          })),
        );
      else if (restore.playlists.length)
        setNotice(`재생목록 ${restore.playlists.length}개를 복구했어요.`);
      setRestore(null);
    } catch (e) {
      setNotice(errorText(e));
    } finally {
      setRestoreBusy(false);
    }
  }
  const syncJobs = useCallback(async () => {
    try {
      const r = await api("jobs");
      const d: { jobs: Job[]; agent: { online: boolean } } = await r.json();
      setAgentOnline(d.agent.online);
      setJobs((old) =>
        d.jobs.map((j) => {
          const prev = old.find((o) => o.id === j.id);
          return prev
            ? {
                ...j,
                receiving: prev.receiving,
                receiveError: prev.receiveError,
              }
            : j;
        }),
      );
      for (const j of d.jobs) if (j.status === "ready") await receive(j);
    } catch {}
  }, [receive]);
  const activeJobs = jobs.some((j) =>
    ["queued", "processing", "ready"].includes(j.status),
  );
  useEffect(() => {
    if (!auth || offline) return;
    void syncJobs();
    const timer = setInterval(
      () => {
        if (document.visibilityState === "visible") void syncJobs();
      },
      activeJobs ? 5000 : 30000,
    );
    const onVisible = () => {
      if (document.visibilityState === "visible") void syncJobs();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [auth, offline, activeJobs, syncJobs]);
  async function enqueue(items: Result[]) {
    const fresh = items.filter(
      (t) =>
        !tracks.some((x) => x.id === t.id) &&
        !jobs.some((j) => j.video_id === t.id),
    );
    setPicked([]);
    if (!fresh.length) {
      setNotice("이미 보관 중이거나 대기열에 있는 음악입니다.");
      return;
    }
    let failed = 0;
    for (const t of fresh) {
      try {
        await api("jobs", {
          url: t.url || "https://www.youtube.com/watch?v=" + t.id,
          title: t.title === "URL에서 가져오기" ? "" : t.title,
          artist: t.title === "URL에서 가져오기" ? "" : t.artist,
          duration: t.duration || 0,
          thumbnail: t.thumbnail,
        });
      } catch (e) {
        failed++;
        setNotice(errorText(e));
      }
    }
    if (fresh.length > failed)
      setNotice(
        agentOnline
          ? `${fresh.length - failed}곡을 PC에 저장 요청했어요.`
          : `${fresh.length - failed}곡을 대기열에 담았어요. PC 에이전트를 켜면 처리돼요.`,
      );
    await syncJobs();
  }
  async function cancel(job: Job) {
    try {
      await api(`jobs/${job.id}`, undefined, undefined, "DELETE");
      setJobs((old) => old.filter((j) => j.id !== job.id));
      if (!(await db.tracks.get(job.video_id)))
        await db.parts.where("track").equals(job.video_id).delete();
    } catch (e) {
      setNotice(errorText(e));
    }
  }
  async function retry(job: Job) {
    try {
      if (job.status === "failed") await api(`jobs/${job.id}/retry`, {});
      else await receive(job);
      await syncJobs();
    } catch (e) {
      setNotice(errorText(e));
    }
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
      const id = crypto.randomUUID();
      await db.playlists.add({ id, name: listName.trim(), tracks: [] });
      setListName("");
      setListDialog(false);
      await refresh();
      if (tracks.length) openPicker(id);
    } catch (e) {
      setNotice(errorText(e));
    }
  }
  function openPicker(id: string) {
    setPicks([]);
    setPickFilter("");
    setPickFor(id);
  }
  async function addPicked() {
    const list = lists.find((l) => l.id === pickFor);
    if (!list || !picks.length) return setPickFor(null);
    try {
      await db.playlists.update(list.id, {
        tracks: [...new Set([...list.tracks, ...picks])],
      });
      setPickFor(null);
      await refresh();
      setNotice(`${picks.length}곡을 ‘${list.name}’에 담았어요.`);
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
    ["queued", "processing", "ready"].includes(j.status),
  ).length;
  // Swipe the full player down to close it (DESIGN.md §10). Only starts from the upper
  // part of the sheet while it is scrolled to the top, so the seek bar and buttons work.
  const sheetRef = useRef<HTMLElement>(null);
  const drag = useRef<{ y: number; t: number; dy: number } | null>(null);
  const onSheetTouchStart = (e: React.TouchEvent) => {
    const el = sheetRef.current;
    if (!el || e.touches.length !== 1) return;
    const target = e.target as HTMLElement;
    if (target.closest("input, select, .seek, .full-controls, .skip-row"))
      return;
    const y = e.touches[0].clientY;
    const top = el.getBoundingClientRect().top;
    if (el.scrollTop > 0 || y - top > el.clientHeight * 0.55) return;
    drag.current = { y, t: performance.now(), dy: 0 };
    el.style.transition = "none";
  };
  const onSheetTouchMove = (e: React.TouchEvent) => {
    const el = sheetRef.current;
    if (!el || !drag.current) return;
    const dy = Math.max(0, e.touches[0].clientY - drag.current.y);
    drag.current.dy = dy;
    el.style.transform = `translateY(${dy}px)`;
    el.parentElement?.style.setProperty(
      "--sheet-fade",
      String(Math.max(0, 1 - dy / 400)),
    );
  };
  const onSheetTouchEnd = () => {
    const el = sheetRef.current;
    const d = drag.current;
    drag.current = null;
    if (!el || !d) return;
    el.style.transition = "";
    const speed = d.dy / Math.max(1, performance.now() - d.t);
    if (d.dy > 110 || (speed > 0.6 && d.dy > 30)) {
      const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
      el.style.transform = "translateY(110%)";
      el.parentElement?.style.setProperty("--sheet-fade", "0");
      setTimeout(() => setExpanded(false), reduce ? 0 : 280);
    } else {
      el.style.transform = "";
      el.parentElement?.style.setProperty("--sheet-fade", "1");
    }
  };
  const seekBy = (delta: number) => {
    const a = audio.current;
    if (!a) return;
    a.currentTime = Math.min(
      Math.max(0, a.currentTime + delta),
      Number.isFinite(a.duration) ? a.duration : a.currentTime + delta,
    );
    setPosition(a.currentTime);
  };
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
            <small>
              {t.codec === "aac" && (
                <span
                  className="codec-badge"
                  title="YouTube AAC 음원을 변환 없이 저장"
                >
                  AAC 원본
                </span>
              )}
              {t.artist}
            </small>
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
                {bytes(tracks.reduce((n, t) => n + trackSize(t), 0))} ·{" "}
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
                {active ? (
                  <button
                    className="primary"
                    onClick={() => openPicker(active.id)}
                  >
                    <Plus size={18} /> 곡 추가
                  </button>
                ) : (
                  <button className="primary" onClick={() => setTab("search")}>
                    <Plus size={18} /> 음악 담기
                  </button>
                )}
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
                <div className="banner-photos" aria-hidden="true">
                  {(visible.length ? visible.slice(0, 3) : [undefined]).map(
                    (t, i) => (
                      <div className="polaroid" key={t?.id ?? i}>
                        {i === 0 && <span className="tape" />}
                        <Cover track={t} />
                      </div>
                    ),
                  )}
                </div>
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
                    <span className="select-wrap">
                      <select
                        aria-label="정렬"
                        value={sort}
                        onChange={(e) => setSort(e.target.value)}
                      >
                        <option value="new">최근 추가순</option>
                        <option value="old">오래된순</option>
                        <option value="title">제목순</option>
                      </select>
                    </span>
                  )}
                  <button
                    className="chip-button"
                    aria-pressed={selectionMode}
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
                      : active
                        ? "아직 담긴 곡이 없어요"
                        : "첫 번째 음악을 담아볼까요?"}
                  </h3>
                  <p>
                    {filter
                      ? "다른 제목이나 아티스트로 찾아보세요."
                      : active
                        ? tracks.length
                          ? "보관함에 저장된 곡 중에서 골라 담아 보세요."
                          : "보관함이 비어 있어요. 먼저 음악 찾기에서 곡을 저장해 주세요."
                        : "음악 찾기에서 듣고 싶은 곡을 저장해 보세요."}
                  </p>
                  {active && !filter ? (
                    <div>
                      {tracks.length ? (
                        <button
                          className="secondary"
                          onClick={() => openPicker(active.id)}
                        >
                          <Plus size={16} /> 보관함에서 고르기
                        </button>
                      ) : (
                        <button
                          className="secondary"
                          onClick={() => {
                            setActiveList(undefined);
                            setTab("search");
                          }}
                        >
                          <Search size={16} /> 음악 찾기
                        </button>
                      )}
                    </div>
                  ) : (
                    <div>
                      <button
                        className="secondary"
                        onClick={() => setTab("search")}
                      >
                        <Search size={16} /> 음악 찾기
                      </button>
                    </div>
                  )}
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
              <div className="sort-chips" role="group" aria-label="검색 정렬">
                {sorts.map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    className={searchSort === key ? "on" : ""}
                    aria-pressed={searchSort === key}
                    disabled={searching}
                    onClick={() => {
                      setSearchSort(key);
                      if (lastQuery) void search(undefined, key, 20, lastQuery);
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p
                className={
                  "agent-status " + (agentOnline ? "online" : "offline")
                }
              >
                <span className="dot" />
                {agentOnline === undefined
                  ? "PC 연결 상태를 확인하고 있어요."
                  : agentOnline
                    ? "PC가 연결되어 있어요. 저장하면 바로 처리돼요."
                    : "PC가 꺼져 있어요. 저장 요청은 대기열에 남았다가 PC를 켜면 처리돼요."}
              </p>
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
                      disabled={!picked.length || offline}
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
                        {resultMeta(t) && (
                          <small className="result-meta">{resultMeta(t)}</small>
                        )}
                        <button
                          className="text-button"
                          disabled={offline}
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
                  {lastQuery &&
                    searchLimit < 60 &&
                    results.length >= searchLimit && (
                      <button
                        className="secondary wide more-results"
                        disabled={loadingMore || offline}
                        onClick={() =>
                          void search(
                            undefined,
                            searchSort,
                            searchLimit + 20,
                            lastQuery,
                          )
                        }
                      >
                        {loadingMore ? (
                          <>
                            <LoaderCircle className="spin" size={16} /> 더
                            불러오는 중…
                          </>
                        ) : (
                          `더 보기 (${searchLimit + 1}–${searchLimit + 20}번째)`
                        )}
                      </button>
                    )}
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
                <h3>꾸미기</h3>
                <p>이 기기에만 저장돼요. 바로 바뀝니다.</p>
                <div className="look-group" role="group" aria-label="화면">
                  <b>화면</b>
                  <div className="look-options">
                    {THEMES.map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        aria-pressed={look.theme === id}
                        onClick={() => setLook({ theme: id })}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="look-group" role="group" aria-label="포인트 색">
                  <b>포인트 색</b>
                  <div className="look-options">
                    {ACCENTS.map(([id, label, hex]) => (
                      <button
                        key={id}
                        type="button"
                        aria-pressed={look.accent === id}
                        onClick={() => setLook({ accent: id })}
                      >
                        <span className="swatch" style={{ background: hex }} />
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="look-group" role="group" aria-label="제목 글꼴">
                  <b>제목 글꼴</b>
                  <div className="look-options">
                    {FONTS.map(([id, label, family, weight]) => (
                      <button
                        key={id}
                        type="button"
                        aria-pressed={look.font === id}
                        onClick={() => setLook({ font: id })}
                        style={{
                          fontFamily: `"${family}", var(--font-body)`,
                          fontWeight: weight,
                        }}
                      >
                        <span className="font-sample">{label}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="look-group" role="group" aria-label="아이콘">
                  <b>아이콘</b>
                  <div className="look-options">
                    {ICON_SETS.map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        aria-pressed={look.icons === id}
                        onClick={() => setLook({ icons: id })}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="settings-card">
                <HardDrive size={22} />
                <h3>기기 저장 공간</h3>
                <p>
                  오디오 {bytes(tracks.reduce((n, t) => n + trackSize(t), 0))} ·{" "}
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
                <h3>보관함 백업</h3>
                <p>
                  곡 제목·아티스트와 재생목록만 서버에 백업해요. 음원은 백업하지
                  않아요.
                </p>
                <small>
                  {syncInfo.pending
                    ? `서버에 반영할 변경 ${syncInfo.pending}건 · 연결되면 자동으로 보내요`
                    : syncInfo.lastSync
                      ? `마지막 백업 ${new Date(syncInfo.lastSync).toLocaleString("ko-KR")}`
                      : "아직 백업하지 않았어요."}
                </small>
                <div className="setting-actions">
                  <button
                    className="secondary"
                    disabled={restoreBusy || offline}
                    onClick={() => void openRestore()}
                  >
                    {restoreBusy ? (
                      <LoaderCircle className="spin" size={15} />
                    ) : (
                      <ArrowDownToLine size={15} />
                    )}
                    보관함 복구
                  </button>
                </div>
              </div>
              <div className="settings-card">
                <h3>알림</h3>
                <p>PC가 곡을 준비하거나 저장에 실패하면 알림을 보내요.</p>
                <small>
                  {pushState === "unsupported"
                    ? "홈 화면에 추가한 Tunely(iOS 16.4 이상)에서만 켤 수 있어요."
                    : pushState === "denied"
                      ? "알림이 차단되어 있어요. iPhone 설정 > 알림 > Tunely에서 허용해 주세요."
                      : pushState === "on"
                        ? "이 기기에서 알림을 받고 있어요."
                        : "꺼져 있어요."}
                </small>
                {pushState !== "unsupported" && pushState !== "denied" && (
                  <div className="setting-actions">
                    {pushState === "on" ? (
                      <>
                        <button
                          className="secondary"
                          disabled={offline}
                          onClick={() =>
                            void api("push/test", {})
                              .then(() => setNotice("테스트 알림을 보냈어요."))
                              .catch((e) => setNotice(errorText(e)))
                          }
                        >
                          테스트 알림
                        </button>
                        <button
                          className="text-button"
                          onClick={() => void disablePush()}
                        >
                          알림 끄기
                        </button>
                      </>
                    ) : (
                      <button
                        className="secondary"
                        disabled={pushState === "busy" || offline}
                        onClick={() => void enablePush()}
                      >
                        {pushState === "busy" ? (
                          <LoaderCircle className="spin" size={15} />
                        ) : null}
                        알림 켜기
                      </button>
                    )}
                  </div>
                )}
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
                          `서버 연결됨 · yt-dlp ${d.yt_dlp} · PC 에이전트 ${d.agent_online ? "연결됨" : "꺼짐"}`,
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
                  <ArrowDownToLine size={17} /> PC 저장 대기열{" "}
                  {pending > 0 && <span>{pending}곡</span>}
                </h3>
                <small
                  className={
                    "agent-status " + (agentOnline ? "online" : "offline")
                  }
                >
                  <span className="dot" />
                  {agentOnline ? "PC 연결됨" : "PC 꺼짐"}
                </small>
              </div>
              {jobs.map((j) => {
                const failed = j.status === "failed" || !!j.receiveError;
                const text =
                  j.receiveError ||
                  (j.status === "failed"
                    ? j.error || "처리에 실패했습니다."
                    : j.status === "queued"
                      ? agentOnline
                        ? "대기 중"
                        : "PC를 켜면 처리돼요"
                      : j.status === "processing"
                        ? `PC ${j.stage || "처리 중"}${j.progress != null ? ` · ${j.progress}%` : ""}`
                        : j.receiving
                          ? `iPhone으로 받는 중${j.receivePercent ? ` · ${j.receivePercent}%` : ""}`
                          : "전송 대기");
                return (
                  <div className="job" key={j.id}>
                    <div>
                      <b>{j.title}</b>
                      <small className={failed ? "danger" : ""}>{text}</small>
                      {j.status === "processing" && (
                        <progress max="100" value={j.progress ?? undefined} />
                      )}
                      {j.receiving && (
                        <progress max="100" value={j.receivePercent} />
                      )}
                    </div>
                    {failed && (
                      <button
                        className="text-button"
                        disabled={offline}
                        onClick={() => void retry(j)}
                      >
                        재시도
                      </button>
                    )}
                    {j.receiving ? (
                      <LoaderCircle className="spin" size={18} />
                    ) : (
                      <button
                        className="icon"
                        aria-label={`${j.title} 저장 취소`}
                        disabled={offline}
                        onClick={() => void cancel(j)}
                      >
                        <X size={17} />
                      </button>
                    )}
                  </div>
                );
              })}
            </section>
          )}
        </div>
      </main>
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
                aria-pressed={shuffle}
                onClick={() => setShuffle(!shuffle)}
              >
                <Shuffle size={22} />
                {shuffle && <span className="stamp">ON</span>}
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
                aria-pressed={repeat !== "off"}
                onClick={() =>
                  setRepeat(
                    repeat === "off" ? "all" : repeat === "all" ? "one" : "off",
                  )
                }
              >
                {repeat === "one" ? (
                  <Repeat1 size={22} />
                ) : (
                  <Repeat size={22} />
                )}
                {repeat !== "off" && (
                  <span className="stamp">
                    {repeat === "one" ? "1곡" : "ON"}
                  </span>
                )}
              </button>
            </div>
            <div className="seek">
              <span>{fmt(position)}</span>
              <input
                aria-label="재생 위치"
                style={
                  {
                    "--pct": `${duration ? Math.min(100, (position / duration) * 100) : 0}%`,
                  } as React.CSSProperties
                }
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
            ref={sheetRef}
            className="full-player"
            onTouchStart={onSheetTouchStart}
            onTouchMove={onSheetTouchMove}
            onTouchEnd={onSheetTouchEnd}
            onTouchCancel={onSheetTouchEnd}
            role="dialog"
            aria-modal="true"
            aria-label="오디오 플레이어"
          >
            <span className="grabber" aria-hidden="true" />
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
                style={
                  {
                    "--pct": `${duration ? Math.min(100, (position / duration) * 100) : 0}%`,
                  } as React.CSSProperties
                }
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
            <div className="skip-row">
              <button
                className="text-button"
                aria-label="10초 뒤로"
                onClick={() => seekBy(-10)}
              >
                <RotateCcw size={16} /> 10초
              </button>
              <button
                className="text-button"
                aria-label="10초 앞으로"
                onClick={() => seekBy(10)}
              >
                10초 <RotateCw size={16} />
              </button>
            </div>
            <div className="full-controls">
              <button
                className={"icon " + (shuffle ? "active" : "")}
                aria-label="셔플 전환"
                aria-pressed={shuffle}
                onClick={() => setShuffle(!shuffle)}
              >
                <Shuffle size={26} />
                {shuffle && <span className="stamp">ON</span>}
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
                aria-pressed={repeat !== "off"}
                onClick={() =>
                  setRepeat(
                    repeat === "off" ? "all" : repeat === "all" ? "one" : "off",
                  )
                }
              >
                {repeat === "one" ? (
                  <Repeat1 size={26} />
                ) : (
                  <Repeat size={26} />
                )}
                {repeat !== "off" && (
                  <span className="stamp">
                    {repeat === "one" ? "1곡" : "ON"}
                  </span>
                )}
              </button>
            </div>
            <div className="speed-control">
              <span>재생 속도</span>
              <span className="select-wrap">
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
              </span>
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
      {pickFor && (
        <div className="modal-backdrop">
          <div
            className="dialog picker"
            role="dialog"
            aria-modal="true"
            aria-label="보관함에서 곡 고르기"
          >
            <div className="modal-heading">
              <h2>보관함에서 고르기</h2>
              <button
                className="icon"
                aria-label="닫기"
                onClick={() => setPickFor(null)}
              >
                <X />
              </button>
            </div>
            <input
              aria-label="보관함 검색"
              placeholder="제목이나 아티스트로 찾기"
              value={pickFilter}
              onChange={(e) => setPickFilter(e.target.value)}
            />
            <div className="picker-list">
              {tracks
                .filter((t) =>
                  `${t.title} ${t.artist}`
                    .toLowerCase()
                    .includes(pickFilter.toLowerCase()),
                )
                .sort((a, b) => b.added - a.added)
                .map((t) => {
                  const inList = !!lists
                    .find((l) => l.id === pickFor)
                    ?.tracks.includes(t.id);
                  const on = inList || picks.includes(t.id);
                  return (
                    <button
                      key={t.id}
                      className={"pick-row " + (on ? "on" : "")}
                      disabled={inList}
                      onClick={() =>
                        setPicks((s) =>
                          s.includes(t.id)
                            ? s.filter((x) => x !== t.id)
                            : [...s, t.id],
                        )
                      }
                    >
                      <Cover track={t} />
                      <span>
                        <b>{t.title}</b>
                        <small>{inList ? "이미 담김" : t.artist}</small>
                      </span>
                      <span className="pick-check">
                        {on && <Check size={14} />}
                      </span>
                    </button>
                  );
                })}
              {!tracks.length && <p>보관함에 저장된 곡이 없어요.</p>}
            </div>
            <button
              className="primary wide"
              disabled={!picks.length}
              onClick={() => void addPicked()}
            >
              {picks.length ? `${picks.length}곡 담기` : "곡을 선택하세요"}
            </button>
          </div>
        </div>
      )}
      {restore && (
        <div className="modal-backdrop">
          <div
            className="dialog picker"
            role="dialog"
            aria-modal="true"
            aria-label="보관함 복구"
          >
            <div className="modal-heading">
              <h2>보관함 복구</h2>
              <button
                className="icon"
                aria-label="닫기"
                onClick={() => setRestore(null)}
              >
                <X />
              </button>
            </div>
            <p className="restore-summary">
              백업된 {restore.total}곡 중 이 기기에 없는 곡{" "}
              {restore.tracks.length}개
              {restore.playlists.length
                ? ` · 없는 재생목록 ${restore.playlists.length}개`
                : ""}
              . 고른 곡은 PC가 다시 내려받아 보내요.
            </p>
            {restore.tracks.length > 0 && (
              <button
                className="text-button"
                onClick={() =>
                  setRestorePicks(
                    restorePicks.length === restore.tracks.length
                      ? []
                      : restore.tracks.map((t) => t.video_id),
                  )
                }
              >
                {restorePicks.length === restore.tracks.length
                  ? "모두 해제"
                  : "모두 선택"}
              </button>
            )}
            <div className="picker-list">
              {restore.tracks.map((t) => {
                const on = restorePicks.includes(t.video_id);
                return (
                  <button
                    key={t.video_id}
                    className={"pick-row " + (on ? "on" : "")}
                    onClick={() =>
                      setRestorePicks((s) =>
                        s.includes(t.video_id)
                          ? s.filter((x) => x !== t.video_id)
                          : [...s, t.video_id],
                      )
                    }
                  >
                    <Cover
                      track={{
                        id: t.video_id,
                        thumbnail: `https://i.ytimg.com/vi/${t.video_id}/hqdefault.jpg`,
                      }}
                    />
                    <span>
                      {/* Rows recovered from server logs have no title yet; it is filled in when the song arrives. */}
                      <b>{t.title || "제목 미확인 · 받으면 채워져요"}</b>
                      <small>
                        {[
                          t.artist,
                          t.duration ? fmt(t.duration) : "",
                          t.title ? "" : t.video_id,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </small>
                    </span>
                    <span className="pick-check">
                      {on && <Check size={14} />}
                    </span>
                  </button>
                );
              })}
              {!restore.tracks.length && (
                <p>
                  {restore.total
                    ? "백업된 곡이 모두 이 기기에 있어요."
                    : "아직 백업된 곡이 없어요."}
                </p>
              )}
            </div>
            <button
              className="primary wide"
              disabled={
                restoreBusy ||
                offline ||
                (!restorePicks.length && !restore.playlists.length)
              }
              onClick={() => void runRestore()}
            >
              {restorePicks.length
                ? `${restorePicks.length}곡 다시 받기${restore.playlists.length ? " · 재생목록 복구" : ""}`
                : restore.playlists.length
                  ? "재생목록만 복구"
                  : "복구할 항목이 없어요"}
            </button>
          </div>
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
