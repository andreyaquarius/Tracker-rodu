import { useEffect, useState, type FormEvent } from "react";
import {
  deleteAiAgentKey,
  getAiAgentSettings,
  saveAiAgentKey,
  testAiAgentKey,
  type AiAgentMode,
  type AiAgentSettings as AiSettings,
} from "../services/aiAgent";

const costWarning =
  "Ви використовуєте власний API-ключ Google AI Studio. Запити до ШІ можуть витрачати вашу квоту або кошти згідно з тарифами Google. Трекер Роду не оплачує ці запити й не контролює тарифи Google.";

export function AiAgentSettings() {
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("gemini-3.5-flash");
  const [mode, setMode] = useState<AiAgentMode>("fast");
  const [busy, setBusy] = useState<"load" | "save" | "test" | "delete" | null>("load");
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);

  useEffect(() => {
    void getAiAgentSettings()
      .then((value) => {
        setSettings(value);
        setModel(value.model);
        setMode(value.mode);
      })
      .catch((error: unknown) => setMessage({
        text: readableError(error, "Не вдалося завантажити налаштування ШІ-агента."),
        error: true,
      }))
      .finally(() => setBusy(null));
  }, []);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!apiKey.trim()) {
      setMessage({ text: "Введіть API-ключ Google AI Studio.", error: true });
      return;
    }
    setBusy("save");
    setMessage(null);
    try {
      const saved = await saveAiAgentKey({ apiKey: apiKey.trim(), model: model.trim(), mode });
      setSettings(saved);
      setApiKey("");
      setMessage({ text: "API-ключ зашифровано та збережено." });
    } catch (error) {
      setMessage({ text: readableError(error, "Не вдалося зберегти API-ключ."), error: true });
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy("test");
    setMessage(null);
    try {
      await testAiAgentKey();
      setMessage({ text: "Ключ працює. Google Gemini відповів успішно." });
    } catch (error) {
      setMessage({ text: readableError(error, "Ключ не пройшов перевірку."), error: true });
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!window.confirm("Видалити збережений API-ключ ШІ-агента?")) return;
    setBusy("delete");
    setMessage(null);
    try {
      await deleteAiAgentKey();
      setSettings({ configured: false, provider: "google_gemini", apiKeyLast4: "", model, mode });
      setApiKey("");
      setMessage({ text: "API-ключ видалено." });
    } catch (error) {
      setMessage({ text: readableError(error, "Не вдалося видалити API-ключ."), error: true });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="panel settings-panel ai-settings-panel">
      <div className="section-heading">
        <div>
          <span className="eyebrow">Особисті налаштування</span>
          <h2>ШІ-агент</h2>
          <p>Безпечна перевірка дослідницьких гіпотез через ваш API-ключ.</p>
        </div>
      </div>

      <div className="import-warning">{costWarning}</div>
      {message ? (
        <div className={`alert ${message.error ? "alert-error" : "alert-notice"}`}>
          {message.text}
        </div>
      ) : null}
      {settings?.configured ? (
        <div className="ai-key-status">
          <span>Збережений ключ</span>
          <strong>••••••••••••••••{settings.apiKeyLast4}</strong>
        </div>
      ) : null}

      <form className="form-grid ai-settings-form" onSubmit={save}>
        <label>
          <span>Провайдер</span>
          <input value="Google Gemini" disabled />
        </label>
        <label>
          <span>Мова</span>
          <input value="Українська" disabled />
        </label>
        <label className="field-wide">
          <span>{settings?.configured ? "Новий API-ключ" : "API-ключ"}</span>
          <input
            type="password"
            autoComplete="off"
            value={apiKey}
            placeholder={settings?.configured ? "Введіть лише для заміни ключа" : "Вставте ключ із Google AI Studio"}
            onChange={(event) => setApiKey(event.target.value)}
          />
          <small className="field-hint">Ключ передається тільки захищеному серверному обробнику і зберігається зашифрованим.</small>
        </label>
        <label>
          <span>Модель</span>
          <input value={model} onChange={(event) => setModel(event.target.value)} />
        </label>
        <label>
          <span>Режим за замовчуванням</span>
          <select value={mode} onChange={(event) => setMode(event.target.value as AiAgentMode)}>
            <option value="fast">Швидкий</option>
            <option value="detailed">Детальний</option>
          </select>
        </label>
        <div className="field-wide ai-settings-actions">
          <button className="button button-primary" disabled={Boolean(busy)} type="submit">
            {busy === "save" ? "Збереження…" : "Зберегти ключ"}
          </button>
          <button
            className="button button-secondary"
            disabled={Boolean(busy) || !settings?.configured}
            type="button"
            onClick={() => void test()}
          >
            {busy === "test" ? "Перевірка…" : "Перевірити ключ"}
          </button>
          <button
            className="button button-ghost danger-text"
            disabled={Boolean(busy) || !settings?.configured}
            type="button"
            onClick={() => void remove()}
          >
            Видалити ключ
          </button>
        </div>
      </form>
    </section>
  );
}

function readableError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
