const PROJECT_DELETION_PHASE_LABELS: Readonly<Record<string, string>> = {
  queued: "Готуємо видалення",
  storage_cleanup: "Очищаємо резервні копії та вкладення",
  finalizing: "Завершуємо видалення",
  completed: "Проєкт видалено",
  legacy_person_relation_graph_edges: "Очищаємо застарілі зв’язки графа",
  ai_hypothesis_reviews: "Видаляємо перевірки гіпотез",
  family_tree_research_issues: "Очищаємо дослідницькі питання дерева",
  tree_layout_positions: "Очищаємо збережене розташування дерева",
  gedcom_xref_maps: "Очищаємо відповідності GEDCOM",
  family_tree_merge_history: "Видаляємо історію об’єднань дерева",
  person_timeline_events: "Очищаємо події життєписів",
  person_names: "Очищаємо варіанти імен осіб",
  association_relationships: "Видаляємо асоціативні зв’язки",
  parent_child_relationships: "Видаляємо зв’язки батьків і дітей",
  parent_sets: "Очищаємо набори батьків",
  partner_relationships: "Видаляємо партнерські зв’язки",
  family_group_members: "Очищаємо учасників сімейних груп",
  family_groups: "Видаляємо сімейні групи",
  family_tree_persons: "Очищаємо склад родових дерев",
  gedcom_import_batches: "Очищаємо пакети імпорту GEDCOM",
  family_trees: "Видаляємо родові дерева",
  finding_participants: "Очищаємо учасників знахідок",
  task_persons: "Очищаємо осіб у завданнях",
  task_notifications: "Видаляємо нагадування завдань",
  archive_request_persons: "Очищаємо осіб в архівних запитах",
  hypothesis_links: "Видаляємо зв’язки гіпотез",
  record_links: "Видаляємо зв’язки записів",
  custom_records: "Видаляємо записи власних розділів",
  custom_section_fields: "Очищаємо поля власних розділів",
  attachments: "Видаляємо вкладення",
  activity_log: "Очищаємо журнал активності",
  year_matrix: "Видаляємо матрицю років",
  tasks: "Видаляємо завдання",
  findings: "Видаляємо знахідки",
  hypotheses: "Видаляємо гіпотези",
  archive_requests: "Видаляємо архівні запити",
  person_relations: "Видаляємо родинні зв’язки",
  documents: "Видаляємо документи",
  persons: "Видаляємо осіб",
  custom_field_definitions: "Очищаємо налаштування власних полів",
  custom_sections: "Видаляємо власні розділи",
  researches: "Видаляємо дослідження",
  project_invitations: "Очищаємо запрошення",
  project_members: "Очищаємо учасників проєкту",
};

export function projectDeletionPhaseLabel(phase: string): string {
  return PROJECT_DELETION_PHASE_LABELS[phase] ?? "Очищаємо дані проєкту";
}

function validTimestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function projectDeletionServerActivityLabel(
  updatedAt: string | null,
  nowMs = Date.now(),
): string {
  const updatedAtMs = validTimestamp(updatedAt);
  if (updatedAtMs === null) return "Очікуємо перше оновлення від сервера.";

  const elapsedSeconds = Math.max(0, Math.floor((nowMs - updatedAtMs) / 1_000));
  if (elapsedSeconds < 15) return "Сервер обробляє дані зараз.";
  if (elapsedSeconds < 60) {
    return `Остання активність сервера — ${elapsedSeconds} с тому.`;
  }

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 5) {
    return `Остання активність сервера — ${elapsedMinutes} хв тому. Великий етап може тривати кілька хвилин.`;
  }

  return `Остання активність сервера — ${elapsedMinutes} хв тому. Завдання збережене; фоновий обробник автоматично продовжить його.`;
}
