import type { FamilyTreeIssueDto } from "../../types/familyTree";
import { familyTreeIssueDisplay } from "../../utils/familyTreeIssueLabels";

export function FamilyTreeIssuesPanel({
  issues,
  selectedIssueKey,
  onSelectIssue,
}: {
  issues: FamilyTreeIssueDto[];
  selectedIssueKey: string;
  onSelectIssue: (issue: FamilyTreeIssueDto, key: string) => void;
}) {
  return (
    <section className="panel family-tree-issues-panel">
      <div className="family-tree-panel-heading">
        <div>
          <span className="eyebrow">Перевірка</span>
          <h2>Проблеми в дереві</h2>
        </div>
        <strong>{issues.length}</strong>
      </div>
      {issues.length ? (
        <div className="family-tree-issue-list">
          {issues.map((issue, index) => {
            const key = `${issue.code}-${index}`;
            const display = familyTreeIssueDisplay(issue);
            return (
              <button
                key={key}
                type="button"
                className={selectedIssueKey === key ? "active" : ""}
                onClick={() => onSelectIssue(issue, key)}
              >
                <span>{display.severity}</span>
                <strong>{display.title}</strong>
                <small>{display.description}</small>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="empty-inline">Проблем для поточного перегляду не знайдено.</div>
      )}
    </section>
  );
}
