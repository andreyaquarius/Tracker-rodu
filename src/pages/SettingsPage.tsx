import type { AppDatabase, SectionParentKey } from "../types";
import { CustomSectionBuilder } from "../components/CustomSectionBuilder";

export function SettingsPage({
  db,
  onChange,
  readOnly = false,
  sectionCreateRequest,
  onSectionCreateRequestHandled,
}: {
  db: AppDatabase;
  onChange: (db: AppDatabase) => void;
  readOnly?: boolean;
  sectionCreateRequest?: { id: number; parentKey: SectionParentKey };
  onSectionCreateRequestHandled?: () => void;
}) {
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">Персоналізація</span>
          <h1>Налаштування</h1>
          <p>Налаштуйте робочий простір під свій спосіб дослідження.</p>
        </div>
      </div>

      <section className="panel settings-panel">
        <div className="section-heading">
          <div>
            <h2>Загальні налаштування</h2>
            <p>
              {readOnly
                ? "Перегляд налаштувань проєкту. Змінювати їх може власник."
                : "Зміни зберігаються автоматично для всього проєкту."}
            </p>
          </div>
        </div>

        <label>
          <span>Ім'я дослідника</span>
          <input
            value={db.settings.researcherName}
            disabled={readOnly}
            placeholder="Як до вас звертатися"
            onChange={(event) =>
              onChange({
                ...db,
                settings: {
                  ...db.settings,
                  researcherName: event.target.value,
                },
              })}
          />
        </label>

        <label className="setting-toggle">
          <div>
            <strong>Компактні таблиці</strong>
            <span>Зменшити вертикальні відступи у списках.</span>
          </div>
          <input
            type="checkbox"
            checked={db.settings.compactTables}
            disabled={readOnly}
            onChange={(event) =>
              onChange({
                ...db,
                settings: {
                  ...db.settings,
                  compactTables: event.target.checked,
                },
              })}
          />
        </label>
      </section>

      <CustomSectionBuilder
        db={db}
        onChange={onChange}
        readOnly={readOnly}
        createRequest={sectionCreateRequest}
        onCreateRequestHandled={onSectionCreateRequestHandled}
      />

      <section className="panel privacy-panel">
        <span className="card-icon">✓</span>
        <div>
          <h2>Приватність за задумом</h2>
          <p>
            Налаштування спільного проєкту зберігаються у захищеній базі та
            доступні на всіх пристроях. Змінювати їх може власник проєкту.
          </p>
        </div>
      </section>
    </>
  );
}
