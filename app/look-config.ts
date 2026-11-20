/**
 * "꾸미기" settings (server-safe part): theme, accent, title font and icon set (DESIGN.md §13).
 * Stored per device in localStorage and applied as data attributes on <html>.
 * layout.tsx runs the same logic inline before first paint to avoid a flash.
 */

export type Look = {
  theme: "auto" | "day" | "night";
  accent: "forest" | "tomato" | "cobalt" | "roast";
  font: "gaegu" | "nanum-pen" | "jua" | "hi-melody" | "poor-story";
  icons: "hand" | "lucide";
};
export const DEFAULT_LOOK: Look = {
  theme: "auto",
  accent: "forest",
  font: "gaegu",
  icons: "hand",
};
export const LOOK_KEY = "tunely-look";

export const THEMES: [Look["theme"], string][] = [
  ["auto", "자동"],
  ["day", "낮의 노트"],
  ["night", "밤의 노트"],
];
export const ACCENTS: [Look["accent"], string, string][] = [
  ["forest", "지금 초록", "#366348"],
  ["tomato", "토마토 레드", "#c8392f"],
  ["cobalt", "코발트 블루", "#2f5fd0"],
  ["roast", "홍차 브라운", "#7a4a2a"],
];
// family = Google Fonts family name, weight = the one weight we load.
export const FONTS: [Look["font"], string, string, number][] = [
  ["gaegu", "Gaegu", "Gaegu", 700],
  ["nanum-pen", "Nanum Pen Script", "Nanum Pen Script", 400],
  ["jua", "Jua", "Jua", 400],
  ["hi-melody", "Hi Melody", "Hi Melody", 400],
  ["poor-story", "Poor Story", "Poor Story", 400],
];
export const ICON_SETS: [Look["icons"], string][] = [
  ["hand", "손그림"],
  ["lucide", "깔끔한 선"],
];

export function fontHref(font: Look["font"]) {
  const f = FONTS.find((x) => x[0] === font) || FONTS[0];
  return `https://fonts.googleapis.com/css2?family=${f[2].replace(/ /g, "+")}:wght@${f[3]}&display=swap`;
}

/** Inline script for <head>: same as applyLook, before React loads. */
export const EARLY_LOOK_SCRIPT = `(function(){try{
var d=${JSON.stringify(DEFAULT_LOOK)},l={};try{l=JSON.parse(localStorage.getItem(${JSON.stringify(LOOK_KEY)})||"{}")}catch(e){}
var ok={theme:${JSON.stringify(THEMES.map((t) => t[0]))},accent:${JSON.stringify(ACCENTS.map((a) => a[0]))},font:${JSON.stringify(FONTS.map((f) => f[0]))},icons:${JSON.stringify(ICON_SETS.map((i) => i[0]))}};
var g=function(k){return ok[k].indexOf(l[k])>=0?l[k]:d[k]};
var r=document.documentElement;r.dataset.theme=g("theme");r.dataset.accent=g("accent");r.dataset.titleFont=g("font");r.dataset.icons=g("icons");
var fonts=${JSON.stringify(Object.fromEntries(FONTS.map((f) => [f[0], fontHref(f[0])])))};
var k=document.createElement("link");k.id="title-font";k.rel="stylesheet";k.href=fonts[g("font")];document.head.appendChild(k);
}catch(e){}})();`;
