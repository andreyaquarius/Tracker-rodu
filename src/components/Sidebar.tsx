import { useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  CustomFieldModule,
  CustomSectionDefinition,
  SectionParentKey,
} from "../types";
import {
  childSections,
  customSectionKey,
  sectionAncestors,
} from "../utils/sectionHierarchy";
import { SectionIcon } from "./SectionIcon";

export type StandardPageKey =
  | "dashboard"
  | "map"
  | CustomFieldModule
  | "backup"
  | "subscription"
  | "settings";

export type PageKey = StandardPageKey | `custom:${string}`;

const mainItems: Array<{
  key: "dashboard" | "map" | CustomFieldModule;
  label: string;
  icon: NavigationIconName;
}> = [
  { key: "dashboard", label: "Панель огляду", icon: "dashboard" },
  { key: "map", label: "Карта", icon: "map" },
  { key: "researches", label: "Дослідження", icon: "compass" },
  { key: "documents", label: "Документи", icon: "file-text" },
  { key: "archiveRequests", label: "Запити в архів", icon: "archive" },
  { key: "yearMatrix", label: "Матриця років", icon: "calendar-days" },
  { key: "tasks", label: "Завдання", icon: "list-checks" },
  { key: "findings", label: "Знахідки", icon: "bookmark-check" },
  { key: "hypotheses", label: "Гіпотези", icon: "lightbulb" },
  { key: "persons", label: "Особи", icon: "users" },
];

const systemItems: Array<{ key: StandardPageKey; label: string; icon: NavigationIconName }> = [
  { key: "backup", label: "Резервні копії", icon: "refresh" },
  { key: "subscription", label: "Тариф і підписка", icon: "credit-card" },
  { key: "settings", label: "Налаштування", icon: "settings" },
];

type NavigationIconName =
  | "dashboard"
  | "map"
  | "compass"
  | "file-text"
  | "archive"
  | "calendar-days"
  | "list-checks"
  | "bookmark-check"
  | "lightbulb"
  | "users"
  | "refresh"
  | "credit-card"
  | "settings";

function NavigationIcon({ icon }: { icon: NavigationIconName }) {
  const paths: Record<NavigationIconName, ReactNode> = {
    dashboard: (
      <>
        <rect x="3" y="3" width="7" height="8" rx="1.5" />
        <rect x="14" y="3" width="7" height="5" rx="1.5" />
        <rect x="14" y="12" width="7" height="9" rx="1.5" />
        <rect x="3" y="15" width="7" height="6" rx="1.5" />
      </>
    ),
    map: (
      <>
        <path d="M9 18 3 21V6l6-3 6 3 6-3v15l-6 3z" />
        <path d="M9 3v15M15 6v15" />
      </>
    ),
    compass: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="m15.6 8.4-2.3 5-4.9 2.2 2.3-4.9z" />
      </>
    ),
    "file-text": (
      <>
        <path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z" />
        <path d="M14 2v5h5" />
        <path d="M9 13h6M9 17h6M9 9h2" />
      </>
    ),
    archive: (
      <>
        <rect x="3" y="4" width="18" height="5" rx="1.5" />
        <path d="M5 9v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9" />
        <path d="M10 13h4" />
      </>
    ),
    "calendar-days": (
      <>
        <rect x="3" y="5" width="18" height="16" rx="2" />
        <path d="M8 3v4M16 3v4M3 10h18" />
        <path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01" />
      </>
    ),
    "list-checks": (
      <>
        <path d="m4 7 1.5 1.5L8.5 5" />
        <path d="m4 17 1.5 1.5 3-3.5" />
        <path d="M12 7h8M12 17h8" />
      </>
    ),
    "bookmark-check": (
      <>
        <path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z" />
        <path d="m9 10 2 2 4-4" />
      </>
    ),
    lightbulb: (
      <>
        <path d="M9 18h6" />
        <path d="M10 22h4" />
        <path d="M8.2 14.5A6.5 6.5 0 1 1 15.8 14.5c-.9.6-1.3 1.6-1.3 2.5h-5c0-.9-.4-1.9-1.3-2.5z" />
      </>
    ),
    users: (
      <>
        <path d="M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2" />
        <circle cx="9.5" cy="7" r="4" />
        <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </>
    ),
    refresh: (
      <>
        <path d="M20 12a8 8 0 0 1-14.4 4.8" />
        <path d="M4 12A8 8 0 0 1 18.4 7.2" />
        <path d="M18 3v4h-4M6 21v-4h4" />
      </>
    ),
    "credit-card": (
      <>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="M3 10h18M7 15h2M11 15h4" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 0 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2a2 2 0 0 1-4 0V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 0 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H3a2 2 0 0 1 0-4h.2a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.4 7A2 2 0 0 1 7.2 4.2l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.6V3a2 2 0 0 1 4 0v.2a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1A2 2 0 0 1 20 7.2l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2a2 2 0 0 1 0 4h-.2a1.7 1.7 0 0 0-1.8 1z" />
      </>
    ),
  };
  return (
    <svg
      aria-hidden="true"
      width="19"
      height="19"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
    >
      {paths[icon]}
    </svg>
  );
}

interface SidebarProps {
  page: PageKey | null;
  onNavigate: (page: PageKey) => void;
  onOpenProjects: () => void;
  customSections: CustomSectionDefinition[];
  open: boolean;
  onClose: () => void;
}

export function Sidebar({
  page,
  onNavigate,
  onOpenProjects,
  customSections,
  open,
  onClose,
}: SidebarProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const activeAncestors = useMemo(() => {
    if (!page?.startsWith("custom:")) return [];
    const section = customSections.find(
      (item) => customSectionKey(item.id) === page,
    );
    return section ? sectionAncestors(customSections, section).map((item) => item.key) : [];
  }, [customSections, page]);

  useEffect(() => {
    setExpanded((current) => {
      const next = new Set(current);
      activeAncestors.forEach((key) => next.add(key));
      return next;
    });
  }, [activeAncestors.join("|")]);

  useEffect(() => {
    document.body.classList.toggle("sidebar-mobile-open", open);
    return () => document.body.classList.remove("sidebar-mobile-open");
  }, [open]);

  const navigate = (nextPage: PageKey) => {
    onNavigate(nextPage);
    onClose();
  };
  const openProjects = () => {
    onOpenProjects();
    onClose();
  };
  const toggle = (key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const renderChildren = (parentKey: SectionParentKey, depth: number) => {
    return childSections(customSections, parentKey).map((section) => {
      const key = customSectionKey(section.id);
      const children = childSections(customSections, key);
      const isExpanded = expanded.has(key);
      return (
        <div className="nav-tree-branch" key={section.id}>
          <div className="nav-tree-row" style={{ paddingLeft: `${depth * 14}px` }}>
            <button
              type="button"
              className={`nav-tree-main ${page === key ? "active" : ""}`}
              onClick={() => navigate(key)}
            >
              <span className="nav-icon">
                <SectionIcon icon={section.icon} size={17} />
              </span>
              <span className="nav-tree-label">{section.name}</span>
            </button>
            {children.length ? (
              <button
                type="button"
                className="nav-tree-toggle"
                aria-label={isExpanded ? "Згорнути підрозділи" : "Розгорнути підрозділи"}
                aria-expanded={isExpanded}
                onClick={() => toggle(key)}
              >
                {isExpanded ? "−" : "+"}
              </button>
            ) : null}
          </div>
          {children.length && isExpanded ? renderChildren(key, depth + 1) : null}
        </div>
      );
    });
  };

  const rootCustomSections = childSections(customSections, null);

  return (
    <>
      {open ? (
        <button className="sidebar-scrim" aria-label="Закрити меню" onClick={onClose} />
      ) : null}
      <aside className={`sidebar ${open ? "sidebar-open" : ""}`}>
        <button
          type="button"
          className="brand"
          onClick={openProjects}
          aria-label="Відкрити список проєктів"
        >
          <div className="brand-mark">
            <img src="/tracker-rodu-logo.png" alt="" />
          </div>
          <div>
            <strong>Трекер Роду</strong>
            <small>Не губи сліди свого роду</small>
          </div>
        </button>
        <nav>
          {mainItems.map((item) => {
            if (item.key === "dashboard" || item.key === "map") {
              return (
                <button
                  type="button"
                  key={item.key}
                  className={page === item.key ? "active" : ""}
                  onClick={() => navigate(item.key)}
                >
                  <span className="nav-icon"><NavigationIcon icon={item.icon} /></span>
                  {item.label}
                </button>
              );
            }
            const children = childSections(customSections, item.key);
            const isExpanded = expanded.has(item.key);
            return (
              <div className="nav-tree-branch" key={item.key}>
                <div className="nav-tree-row">
                  <button
                    type="button"
                    className={`nav-tree-main ${page === item.key ? "active" : ""}`}
                    onClick={() => navigate(item.key)}
                  >
                    <span className="nav-icon"><NavigationIcon icon={item.icon} /></span>
                    <span className="nav-tree-label">{item.label}</span>
                  </button>
                  {children.length ? (
                    <button
                      type="button"
                      className="nav-tree-toggle"
                      aria-label={isExpanded ? "Згорнути підрозділи" : "Розгорнути підрозділи"}
                      aria-expanded={isExpanded}
                      onClick={() => toggle(item.key)}
                    >
                      {isExpanded ? "−" : "+"}
                    </button>
                  ) : null}
                </div>
                {children.length && isExpanded ? renderChildren(item.key, 1) : null}
              </div>
            );
          })}

          {rootCustomSections.length ? (
            <div className="custom-nav-group">
              <span>Власні розділи</span>
              {rootCustomSections.map((section) => {
                const key = customSectionKey(section.id);
                const children = childSections(customSections, key);
                const isExpanded = expanded.has(key);
                return (
                  <div className="nav-tree-branch" key={section.id}>
                    <div className="nav-tree-row">
                      <button
                        type="button"
                        className={`nav-tree-main ${page === key ? "active" : ""}`}
                        onClick={() => navigate(key)}
                      >
                        <span className="nav-icon">
                          <SectionIcon icon={section.icon} size={17} />
                        </span>
                        <span className="nav-tree-label">{section.name}</span>
                      </button>
                      {children.length ? (
                        <button
                          type="button"
                          className="nav-tree-toggle"
                          onClick={() => toggle(key)}
                        >
                          {isExpanded ? "−" : "+"}
                        </button>
                      ) : null}
                    </div>
                    {children.length && isExpanded ? renderChildren(key, 1) : null}
                  </div>
                );
              })}
            </div>
          ) : null}

          <div className="system-nav-group">
            {systemItems.map((item) => (
              <button
                type="button"
                key={item.key}
                className={page === item.key ? "active" : ""}
                onClick={() => navigate(item.key)}
              >
                <span className="nav-icon"><NavigationIcon icon={item.icon} /></span>
                {item.label}
              </button>
            ))}
          </div>
        </nav>
        <div className="sidebar-foot">
          <span>Ваші дані належать вам</span>
          <small>Захищене збереження та резервні копії</small>
        </div>
      </aside>
    </>
  );
}
