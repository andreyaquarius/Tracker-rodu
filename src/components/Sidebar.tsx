import type { CustomSectionDefinition } from "../types";
import { SectionIcon } from "./SectionIcon";

export type StandardPageKey =
  | "dashboard"
  | "researches"
  | "documents"
  | "archiveRequests"
  | "yearMatrix"
  | "tasks"
  | "findings"
  | "hypotheses"
  | "persons"
  | "backup"
  | "settings";

export type PageKey = StandardPageKey | `custom:${string}`;

const mainItems: Array<{ key: StandardPageKey; label: string; icon: string }> = [
  { key: "dashboard", label: "Панель огляду", icon: "⌂" },
  { key: "researches", label: "Дослідження", icon: "Д" },
  { key: "documents", label: "Документи", icon: "Ф" },
  { key: "archiveRequests", label: "Запити в архів", icon: "А" },
  { key: "yearMatrix", label: "Матриця років", icon: "Р" },
  { key: "tasks", label: "Завдання", icon: "З" },
  { key: "findings", label: "Знахідки", icon: "✓" },
  { key: "hypotheses", label: "Гіпотези", icon: "?" },
  { key: "persons", label: "Особи", icon: "О" },
];

const systemItems: Array<{ key: StandardPageKey; label: string; icon: string }> = [
  { key: "backup", label: "Резервні копії", icon: "↻" },
  { key: "settings", label: "Налаштування", icon: "⚙" },
];

interface SidebarProps {
  page: PageKey;
  onNavigate: (page: PageKey) => void;
  customSections: CustomSectionDefinition[];
  open: boolean;
  onClose: () => void;
}

export function Sidebar({ page, onNavigate, customSections, open, onClose }: SidebarProps) {
  return (
    <>
      {open && <button className="sidebar-scrim" aria-label="Закрити меню" onClick={onClose} />}
      <aside className={`sidebar ${open ? "sidebar-open" : ""}`}>
        <div className="brand">
          <div className="brand-mark">
            <img src="/tracker-rodu-logo.png" alt="" />
          </div>
          <div>
            <strong>Трекер Роду</strong>
            <small>Не губи сліди свого роду</small>
          </div>
        </div>
        <nav>
          {mainItems.map((item) => (
            <button
              key={item.key}
              className={page === item.key ? "active" : ""}
              onClick={() => {
                onNavigate(item.key);
                onClose();
              }}
            >
              <span className="nav-icon">{item.icon}</span>
              {item.label}
            </button>
          ))}
          {customSections.length ? (
            <div className="custom-nav-group">
              <span>Власні розділи</span>
              {customSections.map((section) => {
                const key = `custom:${section.id}` as const;
                return (
                  <button
                    key={section.id}
                    className={page === key ? "active" : ""}
                    onClick={() => {
                      onNavigate(key);
                      onClose();
                    }}
                  >
                    <span className="nav-icon">
                      <SectionIcon icon={section.icon} size={17} />
                    </span>
                    {section.name}
                  </button>
                );
              })}
            </div>
          ) : null}
          {systemItems.map((item) => (
            <button
              key={item.key}
              className={page === item.key ? "active" : ""}
              onClick={() => {
                onNavigate(item.key);
                onClose();
              }}
            >
              <span className="nav-icon">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span>Ваші дані належать вам</span>
          <small>PostgreSQL + приватне сховище Supabase</small>
        </div>
      </aside>
    </>
  );
}
