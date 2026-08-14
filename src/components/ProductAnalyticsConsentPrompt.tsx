import { useCallback, useEffect, useState } from "react";
import {
  loadMyProductAnalyticsConsent,
  saveMyProductAnalyticsConsent,
  type ProductAnalyticsConsentChoice,
} from "../services/productAnalyticsConsent.ts";

interface ProductAnalyticsConsentPromptProps {
  enabled: boolean;
}

export function ProductAnalyticsConsentPrompt({ enabled }: ProductAnalyticsConsentPromptProps) {
  const [choice, setChoice] = useState<ProductAnalyticsConsentChoice>("unset");
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [available, setAvailable] = useState(true);

  useEffect(() => {
    if (!enabled) {
      setReady(false);
      return;
    }
    let active = true;
    void loadMyProductAnalyticsConsent()
      .then((record) => {
        if (!active) return;
        setChoice(record ? (record.granted ? "granted" : "denied") : "unset");
        setReady(true);
        setAvailable(true);
      })
      .catch(() => {
        if (!active) return;
        // A missing migration or temporary outage must never block the app.
        setAvailable(false);
        setReady(true);
      });
    return () => {
      active = false;
    };
  }, [enabled]);

  const decide = useCallback(async (granted: boolean) => {
    setSaving(true);
    try {
      await saveMyProductAnalyticsConsent(granted);
      setChoice(granted ? "granted" : "denied");
    } catch {
      setAvailable(false);
    } finally {
      setSaving(false);
    }
  }, []);

  if (!enabled || !ready || !available || choice !== "unset") return null;
  return (
    <aside className="product-analytics-consent" role="dialog" aria-labelledby="product-analytics-consent-title">
      <div>
        <strong id="product-analytics-consent-title">Допомогти покращувати Трекер Роду?</strong>
        <p>
          Дозвольте анонімно рахувати відвідування розділів і активний час. Ми не
          збираємо родинні дані, імена, пошукові запити, адреси сторінок чи вміст документів.
        </p>
      </div>
      <div className="product-analytics-consent-actions">
        <button type="button" className="button button-primary" disabled={saving} onClick={() => void decide(true)}>
          Дозволити
        </button>
        <button type="button" className="button button-secondary" disabled={saving} onClick={() => void decide(false)}>
          Не дозволяти
        </button>
      </div>
    </aside>
  );
}
