import type { PersonEventType } from "../types/index.ts";

export type PersonEventIconName =
  | "baby"
  | "church"
  | "heart"
  | "heart-off"
  | "home"
  | "people"
  | "document"
  | "book"
  | "travel-in"
  | "travel-out"
  | "shield"
  | "briefcase"
  | "education"
  | "flag"
  | "cross"
  | "grave"
  | "flame"
  | "scale"
  | "search-document"
  | "calendar";

export interface PersonEventVisual {
  icon: PersonEventIconName;
  color: string;
  background: string;
}

export const PERSON_EVENT_VISUALS = {
  birth: { icon: "baby", color: "#2f7d4f", background: "#e5f3e9" },
  baptism: { icon: "church", color: "#2f6f9f", background: "#e7f0fb" },
  christening: { icon: "church", color: "#2f6f9f", background: "#e7f0fb" },
  marriage: { icon: "heart", color: "#b84e49", background: "#fbe9ed" },
  divorce: { icon: "heart-off", color: "#9a5b20", background: "#faeedf" },
  residence: { icon: "home", color: "#0f4a42", background: "#e3f1eb" },
  census: { icon: "people", color: "#6f5aa8", background: "#eeeafb" },
  revision_list: { icon: "document", color: "#6f5aa8", background: "#eeeafb" },
  confession_list: { icon: "book", color: "#6f5aa8", background: "#eeeafb" },
  household_register: { icon: "book", color: "#6f5aa8", background: "#eeeafb" },
  immigration: { icon: "travel-in", color: "#2f6f9f", background: "#e7f0fb" },
  emigration: { icon: "travel-out", color: "#c49a32", background: "#fff2d8" },
  military: { icon: "shield", color: "#2f6f9f", background: "#e7f0fb" },
  occupation: { icon: "briefcase", color: "#9a5b20", background: "#faeedf" },
  education: { icon: "education", color: "#6f5aa8", background: "#eeeafb" },
  nationality: { icon: "flag", color: "#c49a32", background: "#fff2d8" },
  death: { icon: "cross", color: "#1f2937", background: "#e8e9eb" },
  burial: { icon: "grave", color: "#1f2937", background: "#e8e9eb" },
  cremation: { icon: "flame", color: "#b84e49", background: "#fbe9ed" },
  probate: { icon: "scale", color: "#6f5aa8", background: "#eeeafb" },
  mention: { icon: "search-document", color: "#c49a32", background: "#fff2d8" },
  other: { icon: "calendar", color: "#0f4a42", background: "#e3f1eb" },
} as const satisfies Record<PersonEventType, PersonEventVisual>;

const PERSON_EVENT_ICON_SVG_BODY = {
  baby: '<circle cx="12" cy="7" r="3"/><path d="M7 20v-3.5A5 5 0 0 1 12 11a5 5 0 0 1 5 5.5V20M9 16h6M12 13v6"/>',
  church: '<path d="M4 21h16M6 21V10l6-4 6 4v11M9 21v-6h6v6M12 2v4M10 4h4"/>',
  heart: '<path d="M20.8 5.8a5.5 5.5 0 0 0-7.8 0L12 6.9l-1.1-1.1a5.5 5.5 0 1 0-7.8 7.8L12 22l8.8-8.4a5.5 5.5 0 0 0 0-7.8Z"/>',
  "heart-off": '<path d="M3 3l18 18M9.4 5.2A5.5 5.5 0 0 0 3.1 13L12 21.4l2.2-2.1M14.6 5.2a5.5 5.5 0 0 1 6.3 7.8l-2.2 2.1"/>',
  home: '<path d="M3 11.5 12 4l9 7.5M5.5 10.5V21h13V10.5M9 21v-6h6v6"/>',
  people: '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.3"/><path d="M3.5 20v-2a5.5 5.5 0 0 1 11 0v2M14 14.5a4.5 4.5 0 0 1 6.5 4V20"/>',
  document: '<path d="M6 2h8l4 4v16H6zM14 2v5h4M9 11h6M9 15h6M9 19h4"/>',
  book: '<path d="M3 5.5A3.5 3.5 0 0 1 6.5 2H11v17H6.5A3.5 3.5 0 0 0 3 22zM21 5.5A3.5 3.5 0 0 0 17.5 2H13v17h4.5A3.5 3.5 0 0 1 21 22z"/>',
  "travel-in": '<path d="M15 3h5v18h-5M11 8l-4 4 4 4M7 12h10"/>',
  "travel-out": '<path d="M9 3H4v18h5M13 8l4 4-4 4M7 12h10"/>',
  shield: '<path d="M12 2 20 5v6c0 5.3-3.3 9-8 11-4.7-2-8-5.7-8-11V5zM9 12l2 2 4-5"/>',
  briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V4h6v3M3 12h18M10 12v2h4v-2"/>',
  education: '<path d="m2 9 10-5 10 5-10 5zM6 11.5V17c3.5 2.7 8.5 2.7 12 0v-5.5M22 9v7"/>',
  flag: '<path d="M5 22V3M5 4h12l-2 4 2 4H5"/>',
  cross: '<path d="M9 2h6v6h5v6h-5v8H9v-8H4V8h5z"/>',
  grave: '<path d="M6 21v-8a6 6 0 0 1 12 0v8zM3 21h18M9 10h6M12 7v6"/>',
  flame: '<path d="M13.5 2c.5 4-3 5-3 8 0 1.5 1 2.5 2 3.2.2-2.2 1.5-3.5 3-4.7 2.2 2 3.5 4.3 3.5 7A7 7 0 1 1 6 12c1.8-1.4 3.4-3.3 4.2-6 .5 1.8 1.5 3 3.3 4"/>',
  scale: '<path d="M12 3v18M7 21h10M4 7h16M7 7l-4 7h8zM17 7l-4 7h8z"/>',
  "search-document": '<path d="M5 2h9l4 4v7M14 2v5h4M9 11h5M9 15h2"/><circle cx="15" cy="17" r="3"/><path d="m17.3 19.3 2.7 2.7"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 2v6M17 2v6M3 10h18M12 13v5M9.5 15.5h5"/>',
} as const satisfies Record<PersonEventIconName, string>;

export function personEventVisual(type: PersonEventType): PersonEventVisual {
  return PERSON_EVENT_VISUALS[type] ?? PERSON_EVENT_VISUALS.other;
}

/** Static trusted SVG only; user-controlled event content is never interpolated. */
export function personEventIconSvgBody(icon: PersonEventIconName): string {
  return PERSON_EVENT_ICON_SVG_BODY[icon] ?? PERSON_EVENT_ICON_SVG_BODY.calendar;
}

export function personEventIconSvgMarkup(type: PersonEventType): string {
  const visual = personEventVisual(type);
  return `<svg viewBox="0 0 24 24" data-event-icon="${visual.icon}" aria-hidden="true" focusable="false">${personEventIconSvgBody(visual.icon)}</svg>`;
}
