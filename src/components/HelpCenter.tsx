import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { PageKey } from "./Sidebar";
import {
  HELP_STORAGE_KEYS,
  fullHelpTourKeys,
  helpGuideForPage,
  helpGuides,
  type HelpGuide,
  type HelpGuideKey,
  type HelpStep,
} from "../help/helpGuides";

interface HelpCenterProps {
  page: PageKey | null;
}

type ActiveHelpKey = HelpGuideKey | "full-tour";

type HelpGuideOption = {
  key: ActiveHelpKey;
  section: string;
  title: string;
};

type FullTourStep = {
  guide: HelpGuide;
  step: HelpStep;
  stepIndex: number;
};

function isStorageEnabled(key: string): boolean {
  return localStorage.getItem(key) === "1";
}

function saveStorageFlag(key: string, value: boolean): void {
  if (value) localStorage.setItem(key, "1");
  else localStorage.removeItem(key);
}

export function HelpCenter({ page }: HelpCenterProps) {
  const currentGuide = useMemo(() => helpGuideForPage(page), [page]);
  const [open, setOpen] = useState(false);
  const [activeKey, setActiveKey] = useState<ActiveHelpKey>("full-tour");
  const [stepIndex, setStepIndex] = useState(0);
  const [autoTipsDisabled, setAutoTipsDisabled] = useState(() =>
    isStorageEnabled(HELP_STORAGE_KEYS.autoTipsDisabled),
  );
  const fullTourSteps = useMemo(() => buildFullTourSteps(), []);

  useEffect(() => {
    if (!open) {
      setActiveKey("full-tour");
      setStepIndex(0);
    }
  }, [currentGuide.key, open]);

  useEffect(() => {
    if (
      !isStorageEnabled(HELP_STORAGE_KEYS.introCompleted) &&
      !isStorageEnabled(HELP_STORAGE_KEYS.autoTipsDisabled)
    ) {
      setActiveKey("full-tour");
      setStepIndex(0);
      setOpen(true);
    }
  }, []);

  const isFullTour = activeKey === "full-tour";
  const activeFullTourStep = fullTourSteps[stepIndex] ?? fullTourSteps[0];
  const guide = isFullTour ? activeFullTourStep.guide : helpGuides[activeKey];
  const currentStep = isFullTour
    ? activeFullTourStep.step
    : guide.steps[stepIndex] ?? guide.steps[0];
  const totalSteps = isFullTour ? fullTourSteps.length : guide.steps.length;
  const isLastStep = stepIndex >= totalSteps - 1;
  const guideOptions = buildGuideOptions(currentGuide);

  const closeHelp = (markIntroDone = false) => {
    if (markIntroDone || activeKey === "workspace-intro" || activeKey === "full-tour") {
      saveStorageFlag(HELP_STORAGE_KEYS.introCompleted, true);
    }
    setOpen(false);
  };

  const switchGuide = (key: ActiveHelpKey) => {
    setActiveKey(key);
    setStepIndex(0);
  };

  const toggleAutoTips = () => {
    const next = !autoTipsDisabled;
    setAutoTipsDisabled(next);
    saveStorageFlag(HELP_STORAGE_KEYS.autoTipsDisabled, next);
    if (next) saveStorageFlag(HELP_STORAGE_KEYS.introCompleted, true);
  };

  return (
    <>
      <button
        type="button"
        className="help-topbar-button"
        onClick={() => {
          setActiveKey("full-tour");
          setStepIndex(0);
          setOpen(true);
        }}
        aria-label="Відкрити підказки"
        title="Підказки"
      >
        ?
        <span>Підказки</span>
      </button>

      {open ? createPortal(
        <div className="help-backdrop" role="presentation" onMouseDown={() => closeHelp()}>
          <section
            className="help-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="help-panel-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="help-panel-header">
              <div>
                <span className="eyebrow">Помічник</span>
                <h2 id="help-panel-title">Підказки Трекера Роду</h2>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={() => closeHelp()}
                aria-label="Закрити підказки"
              >
                ×
              </button>
            </div>

            <div className="help-panel-body">
              <aside className="help-guide-list" aria-label="Розділи підказок">
                {guideOptions.map((option) => (
                  <button
                    type="button"
                    key={option.key}
                    className={activeKey === option.key ? "active" : ""}
                    onClick={() => switchGuide(option.key)}
                  >
                    <span>{option.section}</span>
                    <strong>{option.title}</strong>
                  </button>
                ))}
              </aside>

              <article className="help-guide-card">
                <div className="help-guide-heading">
                  <span>{guide.section}</span>
                  <h3>{guide.title}</h3>
                  <p>{guide.intro}</p>
                </div>

                <div className="help-step-card">
                  <div className="help-step-counter">
                    {isFullTour ? "Повний тур" : "Підказка"} · крок {stepIndex + 1} з {totalSteps}
                  </div>
                  <h4>{currentStep.title}</h4>
                  <p>{currentStep.text}</p>
                </div>

                {totalSteps > 8 ? (
                  <div className="help-step-progress" aria-hidden="true">
                    <span style={{ width: `${((stepIndex + 1) / totalSteps) * 100}%` }} />
                  </div>
                ) : (
                  <div className="help-step-dots" aria-hidden="true">
                    {Array.from({ length: totalSteps }, (_, index) => (
                      <span
                        key={index}
                        className={index === stepIndex ? "active" : ""}
                      />
                    ))}
                  </div>
                )}

                <label className="help-auto-toggle">
                  <input
                    type="checkbox"
                    checked={autoTipsDisabled}
                    onChange={toggleAutoTips}
                  />
                  Не показувати повний тур автоматично
                </label>
              </article>
            </div>

            <div className="help-panel-actions">
              <button
                type="button"
                className="button button-secondary"
                onClick={() => setStepIndex((value) => Math.max(0, value - 1))}
                disabled={stepIndex === 0}
              >
                Назад
              </button>
              {isLastStep ? (
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => closeHelp(true)}
                >
                  Завершити
                </button>
              ) : (
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() =>
                    setStepIndex((value) => Math.min(totalSteps - 1, value + 1))
                  }
                >
                  Далі
                </button>
              )}
            </div>
          </section>
        </div>,
        document.body,
      ) : null}
    </>
  );
}

function buildFullTourSteps(): FullTourStep[] {
  return fullHelpTourKeys.flatMap((key) => {
    const guide = helpGuides[key];
    return guide.steps.map((step, stepIndex) => ({ guide, step, stepIndex }));
  });
}

function buildGuideOptions(currentGuide: HelpGuide): HelpGuideOption[] {
  const options: HelpGuideOption[] = [
    {
      key: "full-tour",
      section: "Усі розділи",
      title: "Повний тур",
    },
  ];
  const keys = [
    currentGuide.key,
    ...fullHelpTourKeys,
  ];
  for (const key of keys) {
    const guide = helpGuides[key];
    options.push({
      key: guide.key,
      section: guide.section,
      title: guide.title,
    });
  }
  return options.filter((option, index, list) =>
    list.findIndex((item) => item.key === option.key) === index,
  );
}
