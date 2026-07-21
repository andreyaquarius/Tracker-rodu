import { useEffect } from "react";
import { useRouteError } from "react-router-dom";
import { isChunkLoadFailure } from "../utils/chunkLoadRecovery.ts";

export function ApplicationRouteError() {
  const error = useRouteError();
  const outdatedBuild = isChunkLoadFailure(error);

  useEffect(() => {
    if (import.meta.env.DEV) console.error("Application route failed", error);
  }, [error]);

  return (
    <main className="app-route-error-page">
      <section className="panel empty-state app-route-error-card" role="alert">
        <span className="eyebrow">
          {outdatedBuild ? "Доступне оновлення" : "Помилка застосунку"}
        </span>
        <h1>
          {outdatedBuild
            ? "Потрібно оновити сторінку"
            : "Не вдалося відкрити сторінку"}
        </h1>
        <p>
          {outdatedBuild
            ? "Сайт був оновлений, а браузер намагався відкрити файл попередньої версії. Ваші дані в проєкті не пошкоджені."
            : "Сталася неочікувана помилка. Оновіть сторінку та спробуйте ще раз."}
        </p>
        <div className="app-route-error-actions">
          <button
            type="button"
            className="button button-primary"
            onClick={() => window.location.reload()}
          >
            Оновити сторінку
          </button>
          <a className="button button-secondary" href="/">
            На головну
          </a>
        </div>
      </section>
    </main>
  );
}
