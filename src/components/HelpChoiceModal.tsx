import type { ReactNode } from "react";
import { Modal } from "./Modal";

interface HelpChoiceModalProps {
  onClose: () => void;
  onOpenTrackerSupport: () => void;
  onOpenGeneHelp: () => void;
  showGeneHelp: boolean;
}

export function HelpChoiceModal({
  onClose,
  onOpenTrackerSupport,
  onOpenGeneHelp,
  showGeneHelp,
}: HelpChoiceModalProps) {
  return (
    <Modal title="Допомога" onClose={onClose} className="help-choice-modal">
      <div className="help-choice-content">
        <div className="help-choice-intro">
          <h3>З чим вам потрібна допомога?</h3>
          <p>
            Оберіть напрям звернення — так ваше питання одразу потрапить до потрібної команди.
          </p>
        </div>

        <div
          className={`help-choice-grid ${showGeneHelp ? "" : "help-choice-grid-single"}`.trim()}
        >
          <HelpChoiceCard
            icon={<SupportIcon />}
            title="Підтримка Трекера Роду"
            description="Помилки, робота функцій, акаунт, тариф, оплата, резервні копії, відображення даних і пропозиції."
            recipient="Команда Трекера Роду"
            actionLabel="Написати в підтримку"
            onAction={onOpenTrackerSupport}
          />

          {showGeneHelp ? (
            <HelpChoiceCard
              icon={<ResearchIcon />}
              title="Допомога з дослідженням — GeneHelp"
              description="Пошук предків, архівних справ і документів, розбір записів та складання плану дослідження."
              recipient="Партнерський сервіс GeneHelp"
              actionLabel="Створити запит у GeneHelp"
              onAction={onOpenGeneHelp}
              partner
            />
          ) : null}
        </div>

        {showGeneHelp ? (
          <p className="help-choice-note">
            GeneHelp допомагає з генеалогічним дослідженням, але не вирішує технічні питання роботи Трекера Роду.
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

interface HelpChoiceCardProps {
  icon: ReactNode;
  title: string;
  description: string;
  recipient: string;
  actionLabel: string;
  onAction: () => void;
  partner?: boolean;
}

function HelpChoiceCard({
  icon,
  title,
  description,
  recipient,
  actionLabel,
  onAction,
  partner = false,
}: HelpChoiceCardProps) {
  return (
    <section className="help-choice-card">
      <div className="help-choice-card-heading">
        <span className="help-choice-icon" aria-hidden="true">
          {icon}
        </span>
        <div>
          {partner ? <span className="help-choice-partner">Партнерський сервіс</span> : null}
          <h3>{title}</h3>
        </div>
      </div>

      <p className="help-choice-description">{description}</p>
      <p className="help-choice-recipient">
        <span>Одержувач</span>
        <strong>{recipient}</strong>
      </p>

      <button type="button" className="button button-primary help-choice-action" onClick={onAction}>
        {actionLabel}
      </button>
    </section>
  );
}

function SupportIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" />
      <path d="M8 9h8M8 13h5" />
    </svg>
  );
}

function ResearchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 5.5A3.5 3.5 0 0 1 7.5 2H12v18H7.5A3.5 3.5 0 0 0 4 23z" />
      <path d="M20 5.5A3.5 3.5 0 0 0 16.5 2H12v18h4.5A3.5 3.5 0 0 1 20 23z" />
      <path d="M7.5 7H9M15 7h1.5" />
    </svg>
  );
}
