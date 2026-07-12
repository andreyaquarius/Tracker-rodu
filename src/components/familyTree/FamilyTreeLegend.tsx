export function FamilyTreeLegend() {
  return (
    <section className="panel family-tree-legend">
      <span className="eyebrow">Легенда</span>
      <div>
        <span className="family-tree-line-sample solid" />
        <p><strong>Суцільна</strong> біологічний або доведений зв'язок</p>
      </div>
      <div>
        <span className="family-tree-line-sample dashed" />
        <p><strong>Пунктирна</strong> усиновлення, опіка, нерідний або соціальний зв'язок</p>
      </div>
      <div>
        <span className="family-tree-line-sample dotted" />
        <p><strong>Точкова</strong> сумнівний, невідомий або потребує перевірки</p>
      </div>
      <div>
        <span className="family-tree-node-sample" />
        <p><strong>Картка</strong> одна візуальна поява особи у дереві</p>
      </div>
    </section>
  );
}
