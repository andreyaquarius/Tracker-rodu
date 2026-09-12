import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { HELP_STORAGE_KEYS, type HelpGuideKey } from "./helpGuides.ts";
import { createScopedHelpStorage, readHelpStorageFlag, saveHelpStorageFlag } from "./helpProgress.ts";
import { HELP_CONTEXT_PROGRESS_KEY, helpArticleFor, parseHelpContextProgress, searchHelpArticles, type HelpArticle } from "./helpArticles.ts";
import "./contextHelp.css";

interface HelpPreferences {
  seen: Record<string, true>; disabled: boolean; revision: number;
  markSeen: (key: string) => void; toggleTips: () => void; resetTips: () => void;
  manualOpen: boolean; setManualOpen: (open: boolean) => void;
}
const HelpContext = createContext<HelpPreferences | null>(null);
export function HelpProvider({ accountId, children }: { accountId: string; children: ReactNode }) {
  // Reset in-memory preferences as well as storage scope on account changes.
  return <ScopedHelpProvider key={accountId} accountId={accountId}>{children}</ScopedHelpProvider>;
}
function ScopedHelpProvider({ accountId, children }: { accountId: string; children: ReactNode }) {
  const storage = useMemo(() => createScopedHelpStorage(accountId), [accountId]);
  const [seen, setSeen] = useState(() => {
    try { return parseHelpContextProgress(storage?.getItem(HELP_CONTEXT_PROGRESS_KEY) ?? null); } catch { return {}; }
  });
  const [disabled, setDisabled] = useState(() => readHelpStorageFlag(HELP_STORAGE_KEYS.autoTipsDisabled, storage));
  const [revision, setRevision] = useState(0);
  const [manualOpen, setManualOpen] = useState(false);
  const markSeen = useCallback((key: string) => setSeen((current) => current[key] ? current : { ...current, [key]: true }), []);
  useEffect(() => {
    try { storage?.setItem(HELP_CONTEXT_PROGRESS_KEY, JSON.stringify(seen)); } catch { /* Optional UI state. */ }
  }, [seen, storage]);
  const value: HelpPreferences = {
    seen, disabled, revision, markSeen, manualOpen, setManualOpen,
    toggleTips() {
      const next = !disabled; setDisabled(next);
      saveHelpStorageFlag(HELP_STORAGE_KEYS.autoTipsDisabled, next, storage);
      setRevision((current) => current + 1);
    },
    resetTips() {
      setSeen({}); setDisabled(false); setRevision((current) => current + 1);
      saveHelpStorageFlag(HELP_STORAGE_KEYS.autoTipsDisabled, false, storage);
    },
  };
  return <HelpContext.Provider value={value}>{children}</HelpContext.Provider>;
}

/** A small toolbar button: neither it nor its temporary tip creates a page-wide row. */
export function SectionHelp({ guideKey, topic, automatic = true }: { guideKey: HelpGuideKey; topic?: string; compact?: boolean; automatic?: boolean }) {
  const preferences = useContext(HelpContext);
  if (!preferences) return <HelpProvider accountId="anonymous"><SectionHelp guideKey={guideKey} topic={topic} automatic={automatic} /></HelpProvider>;
  const article = helpArticleFor(guideKey, topic);
  return <SectionHelpContent key={article.key} article={article} preferences={preferences} automatic={automatic} />;
}
function SectionHelpContent({ article, preferences, automatic }: { article: HelpArticle; preferences: HelpPreferences; automatic: boolean }) {
  const [hint, setHint] = useState(() => !preferences.disabled && !preferences.seen[article.key]);
  const [manual, setManual] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const showHint = automatic && hint && !preferences.disabled && !manual && !preferences.manualOpen;
  useEffect(() => { setHint(!preferences.disabled && !preferences.seen[article.key]); }, [preferences.revision]);
  const closeHint = useCallback(() => setHint(false), []);
  const openManual = useCallback(() => { button.current?.focus(); preferences.markSeen(article.key); setHint(false); setManual(true); }, [article.key, preferences.markSeen]);
  const markVisible = useCallback(() => preferences.markSeen(article.key), [article.key, preferences.markSeen]);
  return <span className="context-help">
    <button ref={button} type="button" className="context-help__button" onClick={openManual}
      aria-label={`Інструкція: ${article.title}`} title={`Інструкція: ${article.title}`} aria-haspopup="dialog"><span aria-hidden="true">?</span></button>
    {showHint ? <FirstVisitTip article={article} anchor={button} onVisible={markVisible} onClose={closeHint} onOpenManual={openManual} /> : null}
    {manual ? <HelpManualDialog initialArticle={article} onClose={() => setManual(false)} /> : null}
  </span>;
}

function FirstVisitTip({ article, anchor, onVisible, onClose, onOpenManual }: {
  article: HelpArticle; anchor: RefObject<HTMLButtonElement | null>; onVisible: () => void; onClose: () => void; onOpenManual: () => void;
}) {
  const popup = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [paused, setPaused] = useState(false);
  useLayoutEffect(() => {
    const button = anchor.current;
    const element = popup.current;
    if (!button || !element) return;
    const show = () => {
      const box = button.getBoundingClientRect();
      if (box.bottom <= 0 || box.top >= window.innerHeight || box.right <= 0 || box.left >= window.innerWidth) {
        element.style.visibility = "hidden"; setVisible(false); return;
      }
      element.style.width = `${Math.min(320, window.innerWidth - 24)}px`;
      element.showPopover?.();
      const height = element.getBoundingClientRect().height;
      element.style.left = `${Math.max(12, Math.min(box.right - element.offsetWidth, window.innerWidth - element.offsetWidth - 12))}px`;
      element.style.top = `${Math.max(12, Math.min(box.bottom + 8, window.innerHeight - height - 12))}px`;
      element.style.visibility = "visible";
      setVisible(true); onVisible();
    };
    show();
    // Editors may open a section below the fold: do not mark invisible hints as read.
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) show(); });
    observer?.observe(button);
    window.addEventListener("resize", show);
    window.addEventListener("scroll", show, true);
    return () => { observer?.disconnect(); window.removeEventListener("resize", show); window.removeEventListener("scroll", show, true); element.hidePopover?.(); };
  }, [anchor, onVisible]);
  useEffect(() => {
    if (!visible) return;
    const dismissOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", dismissOnEscape, true);
    const timer = paused ? undefined : window.setTimeout(onClose, 14000);
    return () => { window.removeEventListener("keydown", dismissOnEscape, true); window.clearTimeout(timer); };
  }, [visible, paused, onClose]);
  return createPortal(<div ref={popup} popover="manual" className="context-help-tip" role="note" aria-label={`Підказка: ${article.title}`}
    onPointerEnter={() => setPaused(true)} onPointerLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false); }}>
    <strong>{article.title}</strong><p>{article.intro}</p>
    <div className="context-help__actions"><button type="button" className="context-help__text-button" onClick={onOpenManual}>Докладніше</button>
      <button type="button" className="context-help__text-button" onClick={onClose}>Зрозуміло</button></div>
  </div>, document.body);
}

export function HelpManualDialog({ initialArticle, onClose }: { initialArticle: HelpArticle; onClose: () => void }) {
  const preferences = useContext(HelpContext);
  const [article, setArticle] = useState(initialArticle);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const articleLayout = useRef<HTMLDivElement>(null);
  const setManualOpen = preferences?.setManualOpen;
  const titleId = useId();
  const results = useMemo(() => searchHelpArticles(query), [query]);
  const related = useMemo(() => searchHelpArticles("").filter((item) => item.parent === article.parent), [article.parent]);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element.showModal();
    searchInput.current?.focus();
    setManualOpen?.(true);
    return () => { element.close(); setManualOpen?.(false); if (opener?.isConnected) opener.focus(); };
  }, [setManualOpen]);
  useEffect(() => { if (articleLayout.current) articleLayout.current.scrollTop = 0; }, [article.key]);
  return createPortal(<dialog ref={dialog} className="help-manual" aria-labelledby={titleId}
    onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
      if (event.key === "Tab") {
        const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href], summary, [tabindex="0"]')].filter((item) => item.getClientRects().length > 0);
        const first = focusable[0]; const last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}
    onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="help-manual__shell">
      <header className="help-manual__header"><div><span className="eyebrow">Довідка застосунку</span><h2 id={titleId}>Інструкції Трекера Роду</h2></div>
        <button type="button" className="icon-button" aria-label="Закрити інструкції" onClick={onClose}>×</button></header>
      <div ref={articleLayout} className="help-manual__layout">
        <aside className="help-manual__navigation">
          <label>Пошук в інструкціях<input ref={searchInput} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Наприклад: свідок, GEDCOM, дата смерті" /></label>
          <small role="status">Знайдено: {results.length}</small>
          <nav aria-label="Розділи інструкцій">{results.map((item) => <button type="button" key={item.key} aria-current={item.key === article.key ? "page" : undefined}
            onClick={() => { setArticle(item); setNotice(""); }}>{item.title}</button>)}</nav>
          {!results.length ? <p>Нічого не знайдено. Спробуйте коротше слово або назву розділу.</p> : null}
        </aside>
        <article className="help-manual__article" key={article.key}>
          <h3>{article.title}</h3><p>{article.intro}</p>
          <ol>{article.steps.map((item, index) => <li key={`${article.key}:${index}`}><h4>{item.title}</h4><p>{item.text}</p></li>)}</ol>
          {article.warning ? <p className="help-manual__warning"><strong>Важливо.</strong> {article.warning}</p> : null}
          <p className="help-manual__warning">Якщо дія недоступна, перевірте права в проєкті та пояснення біля кнопки. Не повторюйте збереження багато разів під час завантаження.</p>
          {related.length > 1 ? <details className="help-manual__related"><summary>Інші інструкції цього розділу</summary>{related.filter((item) => item.key !== article.key).map((item) => <button type="button" key={item.key} onClick={() => setArticle(item)}>{item.title}</button>)}</details> : null}
        </article>
      </div>
      <footer className="help-manual__footer">
        {preferences ? <><label><input type="checkbox" checked={preferences.disabled} onChange={preferences.toggleTips} /> Не показувати підказки автоматично</label>
          <button type="button" className="context-help__text-button" onClick={() => { preferences.resetTips(); setNotice("Автопідказки відновлено. Вони знову з’являтимуться при відкритті розділів і вкладок."); }}>Показати підказки знову</button></> : null}
        <a href="/faq" target="_blank" rel="noreferrer">FAQ</a><button type="button" className="button button-primary" onClick={onClose}>Готово</button>
        <small className="help-manual__storage-note">Підказки запам’ятовуються для вашого облікового запису в цьому браузері, не змінюють дані проєкту та не надсилаються в аналітику.</small>
        {notice ? <p role="status">{notice}</p> : null}
      </footer>
    </div>
  </dialog>, document.body);
}
