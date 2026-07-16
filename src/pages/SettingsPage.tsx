import type { AppDatabase, SectionParentKey } from "../types";
import { CustomSectionBuilder } from "../components/CustomSectionBuilder";
import { AiAgentSettings } from "../components/AiAgentSettings";
import { openAnalyticsPreferences } from "../services/siteAnalytics";

export function SettingsPage({
  db,
  onChange,
  readOnly = false,
  canCreateCustomSection = true,
  customSectionLimitMessage,
  canCreateCustomField = true,
  customFieldLimitMessage,
  onUpgradeRequired,
  onCustomFieldUpgradeRequired,
  sectionCreateRequest,
  onSectionCreateRequestHandled,
}: {
  db: AppDatabase;
  onChange: (db: AppDatabase) => void;
  readOnly?: boolean;
  canCreateCustomSection?: boolean;
  customSectionLimitMessage?: string;
  canCreateCustomField?: boolean;
  customFieldLimitMessage?: string;
  onUpgradeRequired?: () => void;
  onCustomFieldUpgradeRequired?: () => void;
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

      <AiAgentSettings />

      <CustomSectionBuilder
        db={db}
        onChange={onChange}
        readOnly={readOnly}
        canCreate={canCreateCustomSection}
        createBlockedMessage={customSectionLimitMessage}
        canAddFields={canCreateCustomField}
        fieldBlockedMessage={customFieldLimitMessage}
        onCreateBlocked={onUpgradeRequired}
        onFieldBlocked={onCustomFieldUpgradeRequired}
        createRequest={sectionCreateRequest}
        onCreateRequestHandled={onSectionCreateRequestHandled}
      />

      <section className="panel privacy-panel">
        <span className="card-icon">✓</span>
        <div>
          <h2>Приватність і аналітика</h2>
          <p>
            Налаштування спільного проєкту зберігаються у захищеній базі та
            доступні на всіх пристроях. Змінювати їх може власник проєкту.
          </p>
          <p>
            Google Analytics не отримує приватні маршрути, дані проєктів або дії
            всередині застосунку. Ви можете будь-коли змінити згоду на обмежену
            аналітику публічних відвідувань, входів і загального активного часу.
          </p>
          <button
            type="button"
            className="button button-secondary analytics-preferences-button"
            onClick={openAnalyticsPreferences}
          >
            Налаштування аналітики
          </button>
        </div>
      </section>
    </>
  );
}
