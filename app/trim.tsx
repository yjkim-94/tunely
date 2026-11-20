"use client";
/**
 * 구간 설정 sheet (DESIGN.md §8.3). The file is never cut; only start/end seconds are
 * stored on the track. While this sheet is open for the playing track, the player
 * ignores the saved range so the whole file can be scrubbed.
 */
import { useEffect, useRef, useState } from "react";
import { db, trackAudio, type Track } from "./db";
import { Cover } from "./cover";
import { Play, X } from "./icons";

const fmt = (s: number) =>
  `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, "0")}`;
const MIN_LENGTH = 5;
const PHONE_PEAKS_MAX = 30 * 60; // decode on the phone only up to 30 minutes
const BUCKETS = 300;

async function phonePeaks(t: Track): Promise<number[] | undefined> {
  const blob = await trackAudio(t);
  const data = await blob.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, 22050);
  const buf = await ctx.decodeAudioData(data);
  const ch = buf.getChannelData(0);
  const size = Math.max(1, Math.floor(ch.length / BUCKETS));
  const out: number[] = [];
  for (let b = 0; b < BUCKETS; b++) {
    let sum = 0;
    const from = b * size,
      to = Math.min(ch.length, from + size);
    for (let i = from; i < to; i += 8) sum += Math.abs(ch[i]);
    out.push(sum / Math.max(1, (to - from) / 8));
  }
  const top = Math.max(...out) || 1;
  return out.map((v) => Math.round((v / top) * 100));
}

export function TrimSheet({
  track,
  fullDuration,
  isCurrent,
  position,
  canFade,
  onPlayFrom,
  onSeek,
  onSave,
  onClose,
}: {
  track: Track;
  fullDuration: number;
  isCurrent: boolean;
  position: number;
  canFade: boolean;
  onPlayFrom: (seconds: number) => void;
  onSeek: (seconds: number) => void;
  onSave: (range: { start: number; end: number } | undefined) => void;
  onClose: () => void;
}) {
  const dur = fullDuration;
  const [range, setRange] = useState({
    start: track.trim?.start ?? 0,
    end: Math.min(track.trim?.end ?? dur, dur || Infinity),
  });
  const [peaks, setPeaks] = useState<number[] | undefined>(track.peaks);
  const [peaksState, setPeaksState] = useState<"ready" | "busy" | "none">(
    track.peaks ? "ready" : "none",
  );
  const wave = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  // End defaults to the full length once it is known (e.g. metadata loaded late).
  useEffect(() => {
    if (dur && !track.trim) setRange((r) => (r.end ? r : { ...r, end: dur }));
  }, [dur, track.trim]);

  useEffect(() => {
    if (track.peaks || !dur || dur > PHONE_PEAKS_MAX) return;
    let alive = true;
    setPeaksState("busy");
    phonePeaks(track)
      .then(async (p) => {
        if (!alive || !p) return;
        setPeaks(p);
        setPeaksState("ready");
        await db.tracks.update(track.id, { peaks: p });
      })
      .catch(() => alive && setPeaksState("none"));
    return () => {
      alive = false;
    };
  }, [track, dur]);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !dur) return;
    const draw = () => {
      const r = c.getBoundingClientRect();
      const dpr = devicePixelRatio || 1;
      c.width = r.width * dpr;
      c.height = r.height * dpr;
      const g = c.getContext("2d");
      if (!g) return;
      g.scale(dpr, dpr);
      const css = getComputedStyle(c);
      const accent = css.getPropertyValue("--accent").trim();
      const soft = css.getPropertyValue("--ink-soft").trim();
      const w = r.width,
        h = r.height;
      const list = peaks?.length
        ? peaks
        : Array.from({ length: 120 }, () => 22);
      const bw = w / list.length;
      list.forEach((v, i) => {
        const t = ((i + 0.5) / list.length) * dur;
        const inside = t >= range.start && t <= range.end;
        const bh = Math.max(3, (v / 100) * (h - 14));
        g.fillStyle = inside ? accent : soft;
        g.globalAlpha = inside ? 1 : 0.35;
        g.fillRect(i * bw + 0.5, (h - bh) / 2, Math.max(1, bw - 1), bh);
      });
      // hatch the parts that will be skipped
      g.globalAlpha = 0.25;
      g.strokeStyle = soft;
      g.lineWidth = 1;
      const hatch = (x0: number, x1: number) => {
        if (x1 <= x0) return;
        g.save();
        g.beginPath();
        g.rect(x0, 0, x1 - x0, h);
        g.clip();
        for (let x = x0 - h; x < x1; x += 7) {
          g.beginPath();
          g.moveTo(x, h);
          g.lineTo(x + h, 0);
          g.stroke();
        }
        g.restore();
      };
      hatch(0, (range.start / dur) * w);
      hatch((range.end / dur) * w, w);
      g.globalAlpha = 1;
    };
    draw();
    addEventListener("resize", draw);
    return () => removeEventListener("resize", draw);
  }, [peaks, range, dur]);

  const set = (key: "start" | "end", value: number) =>
    setRange((r) => {
      const next = { ...r, [key]: Math.round(value * 10) / 10 };
      if (key === "start")
        next.start = Math.max(0, Math.min(next.start, r.end - MIN_LENGTH));
      else next.end = Math.min(dur, Math.max(next.end, r.start + MIN_LENGTH));
      return next;
    });
  const toSeconds = (clientX: number) => {
    const r = wave.current!.getBoundingClientRect();
    return Math.min(dur, Math.max(0, ((clientX - r.left) / r.width) * dur));
  };
  const drag = (key: "start" | "end") => (e: React.PointerEvent) => {
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => set(key, toSeconds(ev.clientX));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  const keyMove = (key: "start" | "end") => (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    set(key, range[key] + (e.key === "ArrowLeft" ? -1 : 1));
  };
  const pct = (s: number) => `${dur ? (s / dur) * 100 : 0}%`;
  const whole = range.start <= 0.05 && range.end >= dur - 0.5;

  return (
    <div className="modal-backdrop trim-backdrop" onClick={onClose}>
      <section
        className="dialog trim-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="구간 설정"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="grabber" aria-hidden="true" />
        <div className="modal-heading">
          <h2>구간 설정</h2>
          <button
            className="icon"
            type="button"
            aria-label="닫기"
            onClick={onClose}
          >
            <X />
          </button>
        </div>
        <div className="trim-track">
          <Cover track={track} />
          <span>
            <b>{track.title}</b>
            <small>
              {track.artist} · 원본 {fmt(dur)}
            </small>
          </span>
        </div>

        {!dur ? (
          <p className="trim-note">
            곡 길이를 아직 몰라요. 이 곡을 한 번 재생한 뒤 다시 열어 주세요.
          </p>
        ) : (
          <>
            <div
              className="trim-wave"
              ref={wave}
              onPointerDown={(e) => isCurrent && onSeek(toSeconds(e.clientX))}
            >
              <canvas ref={canvas} aria-hidden="true" />
              {isCurrent && (
                <span
                  className="trim-playhead"
                  style={{ left: pct(position) }}
                />
              )}
              {(["start", "end"] as const).map((key) => (
                <span
                  key={key}
                  className="trim-handle"
                  style={{ left: pct(range[key]) }}
                  role="slider"
                  tabIndex={0}
                  aria-label={key === "start" ? "시작" : "끝"}
                  aria-valuemin={0}
                  aria-valuemax={Math.round(dur)}
                  aria-valuenow={Math.round(range[key])}
                  aria-valuetext={fmt(range[key])}
                  onPointerDown={drag(key)}
                  onKeyDown={keyMove(key)}
                >
                  <span>{fmt(range[key])}</span>
                </span>
              ))}
            </div>
            <div className="trim-scale">
              <span>0:00</span>
              <span>{fmt(dur / 2)}</span>
              <span>{fmt(dur)}</span>
            </div>
            {peaksState === "busy" && (
              <p className="trim-note">파형을 그리는 중…</p>
            )}
            {peaksState === "none" && !peaks && dur > PHONE_PEAKS_MAX && (
              <p className="trim-note">
                긴 곡이라 파형 없이 표시해요. 버튼으로 맞춰 주세요.
              </p>
            )}
            <div className="trim-sum">
              <span>
                들을 구간 <b>{fmt(range.end - range.start)}</b>
              </span>
              <span>
                지금 위치 <b>{isCurrent ? fmt(position) : "—"}</b>
              </span>
            </div>

            <div className="trim-actions">
              <button
                type="button"
                className="chip-button"
                onClick={() => onPlayFrom(range.start)}
              >
                <Play size={16} fill="currentColor" /> 시작부터 듣기
              </button>
              <button
                type="button"
                className="chip-button"
                onClick={() => onPlayFrom(Math.max(range.start, range.end - 5))}
              >
                <Play size={16} fill="currentColor" /> 끝 5초 전부터
              </button>
              <button
                type="button"
                className="chip-button strong"
                disabled={!isCurrent}
                onClick={() => set("start", position)}
              >
                여기서 시작
              </button>
              <button
                type="button"
                className="chip-button strong"
                disabled={!isCurrent}
                onClick={() => set("end", position)}
              >
                여기서 끝
              </button>
            </div>
            {!isCurrent && (
              <p className="trim-note">
                ‘여기서 시작·끝’은 이 곡을 들으면서 쓸 수 있어요.
              </p>
            )}

            <div className="trim-fine">
              {(["start", "end"] as const).map((key) => (
                <div key={key}>
                  <span>{key === "start" ? "시작" : "끝"}</span>
                  {[-5, -1].map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => set(key, range[key] + d)}
                    >
                      {d}초
                    </button>
                  ))}
                  <output>{fmt(range[key])}</output>
                  {[1, 5].map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => set(key, range[key] + d)}
                    >
                      +{d}초
                    </button>
                  ))}
                </div>
              ))}
            </div>
            <p className="trim-note">
              {canFade
                ? "시작은 0.5초, 끝은 1초 동안 소리가 부드럽게 커지고 줄어요. "
                : "iPhone은 앱이 소리 크기를 바꿀 수 없어 페이드 없이 잘라요. "}
              파일은 그대로 두고 구간만 기억해요.
            </p>
          </>
        )}
        <div className="dialog-actions">
          <button
            type="button"
            className="text-button"
            onClick={() => setRange({ start: 0, end: dur })}
          >
            원래대로
          </button>
          <button
            type="button"
            className="primary"
            disabled={!dur}
            onClick={() => onSave(whole ? undefined : range)}
          >
            저장
          </button>
        </div>
      </section>
    </div>
  );
}
