import { useEffect, useMemo, useState } from "react";
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
  | CustomFieldModule
  | "backup"
  | "settings";

export type PageKey = StandardPageKey | `custom:${string}`;

const mainItems: Array<{
  key: "dashboard" | CustomFieldModule;
  label: string;
  icon: string;
}> = [
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
  page: PageKey | null;
  onNavigate: (page: PageKey) => void;
  customSections: CustomSectionDefinition[];
  open: boolean;
  onClose: () => void;
}

export function Sidebar({
  page,
  onNavigate,
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

  const navigate = (nextPage: PageKey) => {
    onNavigate(nextPage);
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
          {mainItems.map((item) => {
            if (item.key === "dashboard") {
              return (
                <button
                  type="button"
                  key={item.key}
                  className={page === item.key ? "active" : ""}
                  onClick={() => navigate(item.key)}
                >
                  <span className="nav-icon">{item.icon}</span>
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
                    <span className="nav-icon">{item.icon}</span>
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
              <span>Власні кореневі розділи</span>
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

          {systemItems.map((item) => (
            <button
              type="button"
              key={item.key}
              className={page === item.key ? "active" : ""}
              onClick={() => navigate(item.key)}
            >
              <span className="nav-icon">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span>Ваші дані належать вам</span>
          <small>PostgreSQL + ваш Google Drive</small>
        </div>
      </aside>
    </>
  );
}
