import type { SupabaseWorkspace } from "../services/supabaseAuth";

interface ProjectsPageProps {
  workspaces: SupabaseWorkspace[];
  onOpen: (projectId: string) => void;
  onOpenDeletion: (projectId: string) => void;
  onCreate: () => void;
  creating: boolean;
}

function roleLabel(role: SupabaseWorkspace["role"]): string {
  if (role === "owner") return "Власник";
  if (role === "editor") return "Редактор";
  return "Лише перегляд";
}

export function ProjectsPage({
  workspaces,
  onOpen,
  onOpenDeletion,
  onCreate,
  creating,
}: ProjectsPageProps) {
  return (
    <section>
      <div className="page-heading">
        <div>
          <span className="eyebrow">Робочі простори</span>
          <h1>Ваші проєкти</h1>
          <p>Виберіть дослідження або створіть новий робочий простір.</p>
        </div>
        <button
          type="button"
          className="button button-primary"
          onClick={onCreate}
          disabled={creating}
        >
          {creating ? "Створення…" : "+ Новий проєкт"}
        </button>
      </div>
      <div className="project-route-grid">
        {workspaces.map((workspace) => workspace.deletionPending ? (
          <article
            className="panel project-route-card project-route-card-pending"
            key={workspace.projectId}
            aria-label={`Проєкт ${workspace.projectName} видаляється`}
          >
            <strong>{workspace.projectName}</strong>
            <span>{roleLabel(workspace.role)} · Видаляється</span>
            <button
              type="button"
              className="button button-secondary project-deletion-open"
              onClick={() => onOpenDeletion(workspace.projectId)}
              disabled={creating || !workspace.deletionJobId}
            >
              Переглянути видалення
            </button>
          </article>
        ) : (
          <button
            type="button"
            className="panel project-route-card"
            key={workspace.projectId}
            onClick={() => onOpen(workspace.projectId)}
          >
            <strong>{workspace.projectName}</strong>
            <span>{roleLabel(workspace.role)}</span>
            <small>Відкрити проєкт →</small>
          </button>
        ))}
        {!workspaces.length ? (
          <div className="panel empty-state">
            <strong>У вас ще немає доступних проєктів.</strong>
            <p>Створіть перший проєкт або прийміть запрошення від іншого дослідника.</p>
          </div>
        ) : null}
      </div>
    </section>
  );
}
