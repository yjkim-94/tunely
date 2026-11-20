/**
 * Icon components with the same names as the lucide-react ones the app uses.
 * They draw the "손그림 B · 연필 스케치" set or Lucide A (stroke 2.75) depending on
 * the 꾸미기 setting (DESIGN.md §7). Both sets cover every name below.
 */
import type { CSSProperties } from "react";
import * as Lu from "lucide-react";
import { useLook } from "./look";

type IconProps = {
  size?: number | string;
  className?: string;
  fill?: string;
  style?: CSSProperties;
  "aria-hidden"?: boolean;
};

// 24×24 grid. class "f" = filled shape (light pencil tint, solid when fill="currentColor"),
// "s" = stroke only, "d" = always-solid dot.
const SHAPES: Record<string, string> = {
  Music2:
    '<path class="s" d="M14 4.5v11"/><path class="s" d="M14 4.5c2.3 1 3.8 2.2 3.6 5"/><ellipse class="f" cx="10.8" cy="16.3" rx="3.2" ry="2.5" transform="rotate(-20 10.8 16.3)"/>',
  Search:
    '<circle class="f" cx="10.5" cy="10.5" r="6"/><path class="s" d="M15 15l5 5"/>',
  Library:
    '<rect class="f" x="4" y="4" width="3.5" height="16" rx=".8"/><rect class="f" x="9.5" y="4" width="3.5" height="16" rx=".8"/><rect class="f" x="15" y="5" width="3.5" height="15" rx=".8" transform="rotate(-14 16.7 12.5)"/>',
  ListMusic:
    '<path class="s" d="M3 6h11M3 11h11M3 16h7"/><path class="s" d="M18.5 17V7l3 1"/><circle class="f" cx="16.3" cy="17" r="2.2"/>',
  Settings:
    '<path class="s" d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1"/><circle class="f" cx="12" cy="12" r="5.5"/><circle class="s" cx="12" cy="12" r="1.9"/>',
  Plus: '<path class="s" d="M12 5v14M5 12h14"/>',
  ArrowDownToLine:
    '<path class="s" d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/>',
  Play: '<path class="f" d="M8 5.5 18.5 12 8 18.5Z"/>',
  Pause:
    '<rect class="f" x="6.5" y="5" width="4" height="14" rx="1.2"/><rect class="f" x="13.5" y="5" width="4" height="14" rx="1.2"/>',
  SkipBack:
    '<rect class="f" x="5" y="6" width="2.6" height="12" rx="1"/><path class="f" d="M19 6 9.5 12 19 18Z"/>',
  SkipForward:
    '<rect class="f" x="16.4" y="6" width="2.6" height="12" rx="1"/><path class="f" d="M5 6 14.5 12 5 18Z"/>',
  Shuffle:
    '<path class="s" d="M3.5 7.5H7c3.5 0 5.5 9 9 9h4.5M3.5 16.5H7c3.5 0 5.5-9 9-9h4.5"/><path class="s" d="M17.5 5l3 2.5-3 2.5M17.5 14l3 2.5-3 2.5"/>',
  Repeat:
    '<path class="s" d="M5 12.5V10a3 3 0 0 1 3-3h11.5M16.5 4.5 19.5 7l-3 2.5M19 11.5V14a3 3 0 0 1-3 3H4.5M7.5 14.5 4.5 17l3 2.5"/>',
  Repeat1:
    '<path class="s" d="M5 12.5V10a3 3 0 0 1 3-3h11.5M16.5 4.5 19.5 7l-3 2.5M19 11.5V14a3 3 0 0 1-3 3H4.5M7.5 14.5 4.5 17l3 2.5"/><path class="s" d="M11.2 10.8l1.3-.9v4.4"/>',
  X: '<path class="s" d="M6 6l12 12M18 6 6 18"/>',
  Check: '<path class="s" d="M5 12.5l4.5 4.5L19 7"/>',
  Trash2:
    '<path class="f" d="M6 6.5l1 13h10l1-13Z"/><path class="s" d="M4 6.5h16M9 6.5v-2h6v2M10 10v6M14 10v6"/>',
  ChevronUp: '<path class="s" d="M6 15l6-6 6 6"/>',
  ChevronDown: '<path class="s" d="M6 9l6 6 6-6"/>',
  Headphones:
    '<path class="s" d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect class="f" x="3" y="13.5" width="4" height="6.5" rx="1.5"/><rect class="f" x="17" y="13.5" width="4" height="6.5" rx="1.5"/>',
  WifiOff:
    '<path class="s" d="M2.5 8.5a14 14 0 0 1 19 0M5.5 12a9.5 9.5 0 0 1 13 0M9 15.5a4.5 4.5 0 0 1 6 0M3 3l18 18"/><circle class="d" cx="12" cy="19" r="1.2"/>',
  HardDrive:
    '<path class="s" d="M3 13l3-8h12l3 8"/><rect class="f" x="3" y="13" width="18" height="6.5" rx="1.5"/><circle class="d" cx="7" cy="16.3" r="1"/>',
  LogOut: '<path class="s" d="M9.5 4.5h-4v15h4M14.5 8l4 4-4 4M18.5 12H9"/>',
  Link: '<path class="s" d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  LoaderCircle: '<path class="s" d="M20 12a8 8 0 1 1-8-8"/>',
  MoreHorizontal:
    '<circle class="d" cx="5" cy="12" r="1.7"/><circle class="d" cx="12" cy="12" r="1.7"/><circle class="d" cx="19" cy="12" r="1.7"/>',
  RotateCcw: '<path class="s" d="M4 12a8 8 0 1 0 2.4-5.7M4 4.5v4h4"/>',
  RotateCw: '<path class="s" d="M20 12a8 8 0 1 1-2.4-5.7M20 4.5v4h-4"/>',
};

function make(name: keyof typeof SHAPES, Lucide: Lu.LucideIcon) {
  function Icon({ size = 24, className, fill, style, ...rest }: IconProps) {
    const { icons } = useLook();
    if (icons === "lucide")
      return (
        <Lucide
          size={size}
          className={className}
          style={style}
          strokeWidth={2.75}
          aria-hidden
          {...(fill ? { fill } : {})}
          {...rest}
        />
      );
    const inner = { __html: SHAPES[name] };
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.95}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={
          "hand-icon" +
          (fill === "currentColor" ? " solid" : "") +
          (className ? " " + className : "")
        }
        style={style}
        aria-hidden
        {...rest}
      >
        <g className="hand-ghost" dangerouslySetInnerHTML={inner} />
        <g className="hand-main" dangerouslySetInnerHTML={inner} />
      </svg>
    );
  }
  Icon.displayName = name;
  return Icon;
}

export const Music2 = make("Music2", Lu.Music2);
export const Search = make("Search", Lu.Search);
export const Library = make("Library", Lu.Library);
export const ListMusic = make("ListMusic", Lu.ListMusic);
export const Settings = make("Settings", Lu.Settings);
export const Plus = make("Plus", Lu.Plus);
export const ArrowDownToLine = make("ArrowDownToLine", Lu.ArrowDownToLine);
export const Play = make("Play", Lu.Play);
export const Pause = make("Pause", Lu.Pause);
export const SkipBack = make("SkipBack", Lu.SkipBack);
export const SkipForward = make("SkipForward", Lu.SkipForward);
export const Shuffle = make("Shuffle", Lu.Shuffle);
export const Repeat = make("Repeat", Lu.Repeat);
export const Repeat1 = make("Repeat1", Lu.Repeat1);
export const X = make("X", Lu.X);
export const Check = make("Check", Lu.Check);
export const Trash2 = make("Trash2", Lu.Trash2);
export const ChevronUp = make("ChevronUp", Lu.ChevronUp);
export const ChevronDown = make("ChevronDown", Lu.ChevronDown);
export const Headphones = make("Headphones", Lu.Headphones);
export const WifiOff = make("WifiOff", Lu.WifiOff);
export const HardDrive = make("HardDrive", Lu.HardDrive);
export const LogOut = make("LogOut", Lu.LogOut);
export const Link = make("Link", Lu.Link);
export const LoaderCircle = make("LoaderCircle", Lu.LoaderCircle);
export const MoreHorizontal = make("MoreHorizontal", Lu.MoreHorizontal);
export const RotateCcw = make("RotateCcw", Lu.RotateCcw);
export const RotateCw = make("RotateCw", Lu.RotateCw);
