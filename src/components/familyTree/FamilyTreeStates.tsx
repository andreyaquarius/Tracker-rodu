export function FamilyTreeLoadingState() {
  return (
    <section className="panel family-tree-state">
      <span className="eyebrow">Родове дерево</span>
      <h2>Завантажуємо граф зв'язків</h2>
      <p>Читаємо підготовлену модель дерева й будуємо перший перегляд.</p>
    </section>
  );
}

export function FamilyTreeErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <section className="panel family-tree-state">
      <span className="eyebrow">Помилка</span>
      <h2>Не вдалося показати родове дерево</h2>
      <p>{message}</p>
      <button type="button" className="button button-secondary" onClick={onRetry}>
        Спробувати ще раз
      </button>
    </section>
  );
}

export function FamilyTreeEmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <section className="panel family-tree-state">
      <span className="eyebrow">Родове дерево</span>
      <h2>{title}</h2>
      <p>{description}</p>
    </section>
  );
}
