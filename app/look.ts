"use client";
/** Client store for the 꾸미기 settings; constants live in look-config.ts. */
import { useSyncExternalStore } from "react";
import {
  ACCENTS,
  DEFAULT_LOOK,
  FONTS,
  ICON_SETS,
  LOOK_KEY,
  THEMES,
  fontHref,
  type Look,
} from "./look-config";
export { ACCENTS, DEFAULT_LOOK, FONTS, ICON_SETS, THEMES, type Look };

function valid(l: Partial<Look>): Look {
  const pick = <K extends keyof Look>(
    k: K,
    list: readonly (readonly [Look[K], ...unknown[]])[],
  ) => (list.some((x) => x[0] === l[k]) ? (l[k] as Look[K]) : DEFAULT_LOOK[k]);
  return {
    theme: pick("theme", THEMES),
    accent: pick("accent", ACCENTS),
    font: pick("font", FONTS),
    icons: pick("icons", ICON_SETS),
  };
}

let current: Look = DEFAULT_LOOK;
const listeners = new Set<() => void>();
if (typeof window !== "undefined") {
  try {
    current = valid(JSON.parse(localStorage.getItem(LOOK_KEY) || "{}"));
  } catch {}
}

export function applyLook(l: Look) {
  const root = document.documentElement;
  root.dataset.theme = l.theme;
  root.dataset.accent = l.accent;
  root.dataset.titleFont = l.font;
  root.dataset.icons = l.icons;
  let link = document.getElementById("title-font") as HTMLLinkElement | null;
  if (!link) {
    link = document.createElement("link");
    link.id = "title-font";
    link.rel = "stylesheet";
    document.head.appendChild(link);
  }
  const href = fontHref(l.font);
  if (link.href !== href) link.href = href;
  // Status bar matches the desk colour of the active theme.
  const night =
    l.theme === "night" ||
    (l.theme === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", night ? "#1d1916" : "#efe6d3");
}

/** Current settings outside React (the hook returns defaults during hydration). */
export function getLook(): Look {
  return current;
}

export function setLook(patch: Partial<Look>) {
  current = valid({ ...current, ...patch });
  try {
    localStorage.setItem(LOOK_KEY, JSON.stringify(current));
  } catch {}
  applyLook(current);
  listeners.forEach((fn) => fn());
}

export function useLook(): Look {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    () => current,
    () => DEFAULT_LOOK,
  );
}
