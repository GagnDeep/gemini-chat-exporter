// Lightweight inline SVG icons (no icon-library dependency).
import React from "react";

type P = { size?: number; className?: string };
const S = (size = 20) => ({ width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const });

export const Search = ({ size, className }: P) => (
  <svg {...S(size)} className={className}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
);
export const Sparkle = ({ size = 18, className }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="#fff" className={className}>
    <path d="M12 2l2.2 6.3L20.5 10l-6.3 2.2L12 18.5 9.8 12.2 3.5 10l6.3-1.7z" />
  </svg>
);
export const Plus = ({ size, className }: P) => (
  <svg {...S(size)} className={className}><path d="M12 5v14M5 12h14" /></svg>
);
export const SettingsIcon = ({ size, className }: P) => (
  <svg {...S(size)} className={className}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
);
export const Brain = ({ size, className }: P) => (
  <svg {...S(size)} className={className}><path d="M12 5a3 3 0 0 0-3 3 3 3 0 0 0-3 3 3 3 0 0 0 0 6 3 3 0 0 0 3 2 3 3 0 0 0 6 0 3 3 0 0 0 3-2 3 3 0 0 0 0-6 3 3 0 0 0-3-3 3 3 0 0 0-3-3Z" /><path d="M12 5v14" /></svg>
);
export const Wave = ({ size, className }: P) => (
  <svg {...S(size)} className={className}><path d="M2 12c2 0 2-4 4-4s2 8 4 8 2-12 4-12 2 8 4 8 2-4 2-4" /></svg>
);
export const Type = ({ size, className }: P) => (
  <svg {...S(size)} className={className}><path d="M4 7V5h16v2M9 19h6M12 5v14" /></svg>
);
export const Link = ({ size, className }: P) => (
  <svg {...S(size)} className={className}><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5" /><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5" /></svg>
);
export const Tag = ({ size, className }: P) => (
  <svg {...S(size)} className={className}><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0l-7.2-7.2A2 2 0 0 1 2.8 12V4a1.2 1.2 0 0 1 1.2-1.2h8a2 2 0 0 1 1.4.6l7.2 7.2a2 2 0 0 1 0 2.8Z" /><circle cx="7.5" cy="7.5" r="1.2" /></svg>
);
export const Globe = ({ size, className }: P) => (
  <svg {...S(size)} className={className}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18Z" /></svg>
);
export const User = ({ size, className }: P) => (
  <svg {...S(size)} className={className}><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>
);
// Bulleted list — used for the in-chat "all matches" overlay.
export const List = ({ size, className }: P) => (
  <svg {...S(size)} className={className}><path d="M8 6h13M8 12h13M8 18h13" /><circle cx="3.5" cy="6" r="1" /><circle cx="3.5" cy="12" r="1" /><circle cx="3.5" cy="18" r="1" /></svg>
);
// Indented outline — used for the table-of-contents.
export const Outline = ({ size, className }: P) => (
  <svg {...S(size)} className={className}><path d="M4 6h16M7 11h13M7 16h13" /><path d="M4 11v5" /></svg>
);
// Markdown mark — disambiguates the "export Markdown" action.
export const Markdown = ({ size, className }: P) => (
  <svg {...S(size)} className={className}><rect x="2.5" y="5" width="19" height="14" rx="2" /><path d="M6 15V9l3 3 3-3v6" /><path d="M17 9v4m0 0 1.8-1.8M17 13l-1.8-1.8" /></svg>
);
// Lightbulb — insights (distinct from the Sparkle app logo).
export const Bulb = ({ size, className }: P) => (
  <svg {...S(size)} className={className}><path d="M9 18h6M10 21h4" /><path d="M12 3a6 6 0 0 0-4 10.5c.6.6 1 1.3 1 2.1V16h6v-.4c0-.8.4-1.5 1-2.1A6 6 0 0 0 12 3Z" /></svg>
);
export const Close = ({ size, className }: P) => (
  <svg {...S(size)} className={className}><path d="M18 6 6 18M6 6l12 12" /></svg>
);
export const Back = ({ size, className }: P) => (
  <svg {...S(size)} className={className}><path d="m15 18-6-6 6-6" /></svg>
);
export const Download = ({ size, className }: P) => (
  <svg {...S(size)} className={className}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" /></svg>
);
export const Json = ({ size, className }: P) => (
  <svg {...S(size)} className={className}><path d="M8 3H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1M16 3h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-1" /></svg>
);
export const Doc = ({ size, className }: P) => (
  <svg {...S(size)} className={className}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M9 13h6M9 17h6" /></svg>
);
export const Trash = ({ size, className }: P) => (
  <svg {...S(size)} className={className}><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></svg>
);
export const Open = ({ size, className }: P) => (
  <svg {...S(size)} className={className}><path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></svg>
);
export const Sun = ({ size, className }: P) => (
  <svg {...S(size)} className={className}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4" /></svg>
);
export const Moon = ({ size, className }: P) => (
  <svg {...S(size)} className={className}><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" /></svg>
);
export const Msg = ({ size, className }: P) => (
  <svg {...S(size)} className={className}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
);
// Upward arrow — the "send prompt to Gemini" action (mirrors Gemini's composer).
export const Send = ({ size, className }: P) => (
  <svg {...S(size)} className={className}><path d="M12 20V5M6 11l6-6 6 6" /></svg>
);
export const Copy = ({ size, className }: P) => (
  <svg {...S(size)} className={className}><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
);
export const Command = ({ size, className }: P) => (
  <svg {...S(size)} className={className}><path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 0 0 0-6Z" /></svg>
);
export const Help = ({ size, className }: P) => (
  <svg {...S(size)} className={className}><circle cx="12" cy="12" r="9" /><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" /><path d="M12 17h.01" /></svg>
);
export const Pin = ({ size, className }: P) => (
  <svg {...S(size)} className={className}><path d="M9 4h6l-1 7 3 3v2H7v-2l3-3-1-7Z" /><path d="M12 16v5" /></svg>
);
export const PinOff = ({ size, className }: P) => (
  <svg {...S(size)} className={className}><path d="M9 4h6l-1 7 3 3v2H7v-2l3-3-1-7Z" /><path d="M12 16v5" /><path d="M3 3l18 18" /></svg>
);
export const Edit = ({ size, className }: P) => (
  <svg {...S(size)} className={className}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
);
export const Top = ({ size, className }: P) => (
  <svg {...S(size)} className={className}><path d="M12 19V5M5 12l7-7 7 7" /></svg>
);
export const ChevDown = ({ size, className }: P) => (
  <svg {...S(size)} className={className}><path d="m6 9 6 6 6-6" /></svg>
);
// Left panel / sidebar toggle — the chat-switcher rail button.
export const PanelLeft = ({ size, className }: P) => (
  <svg {...S(size)} className={className}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></svg>
);
