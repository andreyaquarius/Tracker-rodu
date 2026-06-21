import { Modal } from "./Modal";
import type { PlanCode, UpgradeReason } from "../types/subscription";

interface UpgradeRequiredModalProps extends UpgradeReason {
  currentPlan: PlanCode;
  trialExpired: boolean;
  onClose: () => void;
  onOpenPlans: () => void;
}

export function UpgradeRequiredModal({
  featureName,
  reason,
  currentPlan,
  recommendedPlan,
  used,
  limit,
  trialExpired,
  onClose,
  onOpenPlans,
}: UpgradeRequiredModalProps) {
  const planNames: Record<PlanCode, string> = {
    free: "Старт",
    researcher: "Дослідник",
    professional: "Професійний",
  };
  return (
    <Modal title={featureName} onClose={onClose}>
      <div className="upgrade-required">
        <span className="status-pill">PRO</span>
        <p>{reason}</p>
        {typeof used === "number" && typeof limit === "number" ? (
          <p className="muted-text">Використано: {used} із {limit}.</p>
        ) : null}
        {trialExpired ? (
          <div className="alert alert-notice">
            Пробний період завершився. Ваші дані збережено, а обліковий запис перейшов на тариф «Старт».
          </div>
        ) : null}
        <p className="muted-text">
          Поточний тариф: «{planNames[currentPlan]}». Рекомендований: «{planNames[recommendedPlan]}».
        </p>
        <div className="form-actions">
          <button type="button" className="button button-ghost" onClick={onClose}>Закрити</button>
          <button type="button" className="button button-primary" onClick={onOpenPlans}>Переглянути тарифи</button>
        </div>
      </div>
    </Modal>
  );
}
