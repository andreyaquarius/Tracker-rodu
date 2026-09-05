import type { AppDatabase, SectionParentKey } from "../types";
import { CustomSectionBuilder } from "../components/CustomSectionBuilder";
import { AiAgentSettings } from "../components/AiAgentSettings";
import { ProductAnalyticsPreferences } from "../components/ProductAnalyticsPreferences";
import { AppAppearanceSettings } from "../components/appearance/AppAppearanceSettings.tsx";
import { TelegramBotSettings } from "../components/settings/TelegramBotSettings";
import { openAnalyticsPreferences } from "../services/siteAnalytics";
import type { SupabaseAccount } from "../services/supabaseAuth";
import {
  DEFAULT_PERSON_NAME_DISPLAY_LANGUAGE,
  normalizePersonNameDisplayMode,
} from "../utils/personNameDisplay.ts";

export function SettingsPage({
  db,
  account,
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
  account?: SupabaseAccount | null;
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
  const personNameDisplayMode = normalizePersonNameDisplayMode(
    db.settings.personNameDisplayMode,
  );
  const personNameDisplayLanguage = db.settings.personNameDisplayLanguage
    ?? DEFAULT_PERSON_NAME_DISPLAY_LANGUAGE;

  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">Персоналізація</span>
          <h1>Налаштування</h1>
          <p>Налаштуйте робочий простір під свій спосіб дослідження.</p>
        </div>
      </div>

      <AppAppearanceSettings />
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

        <div className="settings-person-name-display">
          <div>
            <strong>Відображення історичних імен</strong>
            <p>
              Це лише спосіб показу в картці особи. Поточне ім’я, поля особи та
              вже збережені налаштування не змінюються.
            </p>
          </div>

          <label>
            <span>Яке ім’я показувати</span>
            <select
              value={personNameDisplayMode}
              disabled={readOnly}
              onChange={(event) => onChange({
                ...db,
                settings: {
                  ...db.settings,
                  personNameDisplayMode: normalizePersonNameDisplayMode(event.target.value),
                },
              })}
            >
              <option value="current">Поточне ім’я картки (як зараз)</option>
              <option value="primary">Основне історичне ім’я</option>
              <option value="interface_language">Ім’я мовою інтерфейсу</option>
              <option value="valid_at_date">Ім’я, чинне на вибрану дату</option>
              <option value="original">Точне написання з джерела</option>
              <option value="primary_with_variants">Основне ім’я та всі варіанти</option>
            </select>
          </label>

          {personNameDisplayMode === "interface_language" ? (
            <label>
              <span>Код мови інтерфейсу</span>
              <input
                value={personNameDisplayLanguage}
                disabled={readOnly}
                placeholder="uk"
                inputMode="text"
                onChange={(event) => onChange({
                  ...db,
                  settings: {
                    ...db.settings,
                    personNameDisplayLanguage: event.target.value,
                  },
                })}
              />
              <small>Наприклад: uk, pl, ru, la. Якщо варіанта немає, буде показано основне або поточне ім’я.</small>
            </label>
          ) : null}

          {personNameDisplayMode === "valid_at_date" ? (
            <label>
              <span>Дата, на яку показувати ім’я</span>
              <input
                type="date"
                value={db.settings.personNameDisplayDate ?? ""}
                disabled={readOnly}
                onChange={(event) => onChange({
                  ...db,
                  settings: {
                    ...db.settings,
                    personNameDisplayDate: event.target.value,
                  },
                })}
              />
              <small>Використовуються періоди «чинне від / до», зазначені у варіантах імені.</small>
            </label>
          ) : null}
        </div>
      </section>

      <TelegramBotSettings account={account} />

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

      <ProductAnalyticsPreferences />
    </>
  );
}
