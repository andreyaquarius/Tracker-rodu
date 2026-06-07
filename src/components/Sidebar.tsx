export type PageKey =
  | "dashboard"
  | "researches"
  | "documents"
  | "yearMatrix"
  | "tasks"
  | "findings"
  | "hypotheses"
  | "persons"
  | "backup"
  | "settings";

const items: Array<{ key: PageKey; label: string; icon: string }> = [
  { key: "dashboard", label: "Панель огляду", icon: "⌂" },
  { key: "researches", label: "Дослідження", icon: "Д" },
  { key: "documents", label: "Документи", icon: "Ф" },
  { key: "yearMatrix", label: "Матриця років", icon: "Р" },
  { key: "tasks", label: "Завдання", icon: "З" },
  { key: "findings", label: "Знахідки", icon: "✓" },
  { key: "hypotheses", label: "Гіпотези", icon: "?" },
  { key: "persons", label: "Особи", icon: "О" },
  { key: "backup", label: "Резервні копії", icon: "↻" },
  { key: "settings", label: "Налаштування", icon: "⚙" },
];

interface SidebarProps {
  page: PageKey;
  onNavigate: (page: PageKey) => void;
  open: boolean;
  onClose: () => void;
}

export function Sidebar({ page, onNavigate, open, onClose }: SidebarProps) {
  return (
    <>
      {open && <button className="sidebar-scrim" aria-label="Закрити меню" onClick={onClose} />}
      <aside className={`sidebar ${open ? "sidebar-open" : ""}`}>
        <div className="brand">
          <div className="brand-mark">ТР</div>
          <div>
            <strong>Трекер Роду</strong>
            <small>Не губи сліди свого роду</small>
          </div>
        </div>
        <nav>
          {items.map((item) => (
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
          <small>Локальна копія + Google Drive</small>
        </div>
      </aside>
    </>
  );
}
