import { useEffect, useState } from "react";
import {
  loadMyProductAnalyticsConsent,
  saveMyProductAnalyticsConsent,
  type ProductAnalyticsConsentChoice,
} from "../services/productAnalyticsConsent.ts";

export function ProductAnalyticsPreferences() {
  const [choice, setChoice] = useState<ProductAnalyticsConsentChoice>("unset");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void loadMyProductAnalyticsConsent()
      .then((record) => {
        if (!active) return;
        setChoice(record ? (record.granted ? "granted" : "denied") : "unset");
      })
      .catch(() => {
        if (active) setError("Налаштування внутрішньої аналітики поки недоступне.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const save = async (granted: boolean) => {
    setLoading(true);
    setError("");
    try {
      await saveMyProductAnalyticsConsent(granted);
      setChoice(granted ? "granted" : "denied");
    } catch {
      setError("Не вдалося зберегти вибір. Спробуйте ще раз.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="settings-card product-analytics-preferences">
      <div>
        <span className="eyebrow">Приватність</span>
        <h2>Внутрішня аналітика застосунку</h2>
        <p>
          Збирає лише код відкритого розділу та активний час. Родинні дані, імена,
          пошукові запити, URL, ідентифікатори проєктів і вміст файлів не передаються.
        </p>
        <p className="muted">
          Поточний вибір: {choice === "granted" ? "дозволено" : choice === "denied" ? "заборонено" : "не вибрано"}.
        </p>
        {error ? <p className="form-error">{error}</p> : null}
      </div>
      <div className="settings-inline-actions">
        <button type="button" className="button button-primary" disabled={loading} onClick={() => void save(true)}>
          Дозволити
        </button>
        <button type="button" className="button button-secondary" disabled={loading} onClick={() => void save(false)}>
          Не дозволяти
        </button>
      </div>
    </section>
  );
}
