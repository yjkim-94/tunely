"use client";
import { useEffect, useState } from "react";
import type { Track } from "./db";
import { Music2 } from "./icons";

export function Cover({
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
