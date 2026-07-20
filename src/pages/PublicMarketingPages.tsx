import type { ReactNode } from "react";
import {
  publicFeatures,
  publicPricingPlans,
} from "../utils/publicSiteContent";

type PublicPageKind = "features" | "pricing";

function PublicNav({ current }: { current: PublicPageKind }) {
  const items = [
    { href: "/", label: "Головна", key: "home" },
    { href: "/features", label: "Можливості", key: "features" },
    { href: "/pricing", label: "Тарифи", key: "pricing" },
    { href: "/privacy", label: "Політика конфіденційності", key: "privacy" },
    { href: "/terms", label: "Умови користування", key: "terms" },
  ];

  return (
    <nav className="public-nav" aria-label="Публічна навігація">
      {items.map((item) => (
        <a
          aria-current={item.key === current ? "page" : undefined}
          href={item.href}
          key={item.key}
        >
          {item.label}
        </a>
      ))}
    </nav>
  );
}

function PublicLayout({
  current,
  eyebrow,
  title,
  description,
  children,
}: {
  current: PublicPageKind;
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <main className="public-page">
      <header className="public-hero">
        <a className="brand public-brand" href="/" aria-label="Перейти на головну">
          <span className="brand-mark">
            <img src="/tracker-rodu-logo.png" alt="" />
          </span>
          <span>
            <strong>Трекер Роду</strong>
            <small>Trekerrodu</small>
          </span>
        </a>
        <PublicNav current={current} />
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </header>
      {children}
      <footer className="public-footer">
        <a href="/">Головна</a>
        <a href="/features">Можливості</a>
        <a href="/pricing">Тарифи</a>
        <a href="/privacy">Політика конфіденційності</a>
        <a href="/terms">Умови користування</a>
      </footer>
    </main>
  );
}

export function FeaturesPage() {
  return (
    <PublicLayout
      current="features"
      eyebrow="Можливості"
      title="Інструменти для генеалогічного дослідження"
      description="Трекер Роду допомагає зібрати дослідження, джерела, людей, гіпотези, карту подій і командну роботу в одному робочому просторі."
    >
      <section className="public-section">
        <div className="public-section-heading">
          <h2>Що вже є в застосунку</h2>
        </div>
        <div className="feature-grid">
          {publicFeatures.map((feature) => (
            <article className="feature-card" key={feature.title}>
              {feature.planned ? <span className="planned-pill">Планується</span> : null}
              <h3>{feature.title}</h3>
              <p>{feature.description}</p>
            </article>
          ))}
        </div>
      </section>
    </PublicLayout>
  );
}

export function PricingPage() {
  return (
    <PublicLayout
      current="pricing"
      eyebrow="Тарифи"
      title="Тарифи Трекера Роду"
      description="Три рівні доступу для різних масштабів родового дослідження."
    >
      <section className="trial-panel">
        <div>
          <h2>30 днів можливостей Professional</h2>
          <p>
            Новий користувач отримує можливості Professional із лімітом до 15 000 осіб,
            5 редакторами та 100 ШІ-кредитами. Платіжна картка не потрібна. Після
            завершення пробного періоду акаунт переходить на безкоштовний тариф,
            а створені дані не видаляються.
          </p>
        </div>
      </section>

      <section className="public-section">
        <div className="public-section-heading">
          <h2>Плани доступу</h2>
        </div>
        <div className="public-plan-grid">
          {publicPricingPlans.map((plan) => (
            <article className="public-plan-card" key={plan.code}>
              <h3>{plan.name}</h3>
              <p>{plan.description}</p>
              <strong className="public-plan-price">
                <span>{plan.price}</span>
                {plan.yearlyPrice ? <span className="price-yearly">{plan.yearlyPrice}</span> : null}
              </strong>
              <ul>
                {plan.limits.map((limit) => (
                  <li key={limit.label}>
                    <span>{limit.label}</span>
                    <strong>{limit.value}</strong>
                  </li>
                ))}
              </ul>
              {plan.code === "free" ? (
                <a className="public-cta" href="/">Почати роботу</a>
              ) : (
                <span className="public-cta muted">Оплата готується</span>
              )}
            </article>
          ))}
        </div>
        <p>
          Особи рахуються у всіх проєктах власника; одна картка у кількох деревах
          рахується один раз. Один редактор займає одне місце незалежно від кількості
          проєктів, а власник і глядачі редакторські місця не займають.
        </p>
      </section>
    </PublicLayout>
  );
}
