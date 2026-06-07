import type { AppDatabase } from "../types";

export function SettingsPage({
  db,
  onChange,
}: {
  db: AppDatabase;
  onChange: (db: AppDatabase) => void;
}) {
  return (
    <>
      <div className="page-heading">
        <div><span className="eyebrow">Персоналізація</span><h1>Налаштування</h1><p>Налаштуйте робочий простір під свій спосіб дослідження.</p></div>
      </div>
      <section className="panel settings-panel">
        <div className="section-heading"><div><h2>Загальні налаштування</h2><p>Зміни зберігаються автоматично.</p></div></div>
        <label><span>Ім’я дослідника</span><input value={db.settings.researcherName} placeholder="Як до вас звертатися" onChange={(event) => onChange({ ...db, settings: { ...db.settings, researcherName: event.target.value } })} /></label>
        <label className="setting-toggle">
          <div><strong>Компактні таблиці</strong><span>Зменшити вертикальні відступи у списках.</span></div>
          <input type="checkbox" checked={db.settings.compactTables} onChange={(event) => onChange({ ...db, settings: { ...db.settings, compactTables: event.target.checked } })} />
        </label>
      </section>
      <section className="panel privacy-panel">
        <span className="card-icon">✓</span>
        <div><h2>Приватність за задумом</h2><p>Застосунок не має власного сервера. Дані залишаються в цьому браузері та у приватній папці вашого Google Drive.</p></div>
      </section>
    </>
  );
}
