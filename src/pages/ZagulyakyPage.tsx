import { useEffect, useMemo, useRef, useState } from "react";
import { ZagulyakaDetailDialog } from "../components/zagulyaky/ZagulyakaDetailDialog";
import { ZagulyakaDraftDialog } from "../components/zagulyaky/ZagulyakaDraftDialog";
import type { SupabaseAccount } from "../services/supabaseAuth";
import {
  loadMyZagulyakaDraft,
  loadMyZagulyaky,
  loadPublicZagulyaka,
  deleteMyZagulyakaDraft,
  loadZagulyakyStats,
  searchZagulyakyDocuments,
  searchZagulyakyPeople,
  withdrawZagulyakaDraft,
} from "../services/zagulyakyService";
import type {
  ZagulyakaDetail,
  ZagulyakaDocumentListItem,
  ZagulyakaEditableDraft,
  ZagulyakaDraftSummary,
  ZagulyakaKind,
  ZagulyakaPersonListItem,
  ZagulyakySearchCursor,
  ZagulyakyDocumentFilters,
  ZagulyakyPeopleFilters,
  ZagulyakyStats,
} from "../types/zagulyaky";
import {
  zagulyakaEventLabels,
  zagulyakaVerificationLabels,
  zagulyakaWorkflowLabels,
} from "../utils/zagulyakyLabels";
import { zagulyakyTabPath } from "../utils/zagulyakyRoutePath";
import "./ZagulyakyPage.css";

export type ZagulyakyTab = "people" | "documents" | "mine";

const initialStats: ZagulyakyStats = {
  peopleCount: 0,
  documentCount: 0,
  placesCount: 0,
  archiveCount: 0,
  earliestYear: null,
  latestYear: null,
  verifiedCount: 0,
  contributorsCount: 0,
  addedLast30Days: 0,
};

const initialPeopleFilters: ZagulyakyPeopleFilters = {
  query: "",
  originPlace: "",
  foundPlace: "",
  eventType: "",
  yearFrom: null,
  yearTo: null,
  verificationStatus: "",
};

const initialDocumentFilters: ZagulyakyDocumentFilters = {
  query: "",
  institutionName: "",
  officialPlace: "",
  foundPlace: "",
  documentType: "",
  yearFrom: null,
  yearTo: null,
  verificationStatus: "",
};

export interface ZagulyakyPageProps {
  account?: SupabaseAccount | null;
  initialTab?: ZagulyakyTab;
  initialRecordSlug?: string;
  initialRecordKind?: ZagulyakaKind;
  onRequestSignIn?: () => void;
  onNavigate?: (path: string) => void;
}

export function ZagulyakyPage({
  account = null,
  initialTab = "people",
  initialRecordSlug = "",
  onRequestSignIn,
  onNavigate,
}: ZagulyakyPageProps) {
  const [activeTab, setActiveTab] = useState<ZagulyakyTab>(initialTab);
  const [stats, setStats] = useState<ZagulyakyStats>(initialStats);
  const [statsLoading, setStatsLoading] = useState(true);
  const [peopleFilters, setPeopleFilters] = useState(initialPeopleFilters);
  const [documentFilters, setDocumentFilters] = useState(initialDocumentFilters);
  const [showFilters, setShowFilters] = useState(false);
  const [people, setPeople] = useState<ZagulyakaPersonListItem[]>([]);
  const [documents, setDocuments] = useState<ZagulyakaDocumentListItem[]>([]);
  const [myRecords, setMyRecords] = useState<ZagulyakaDraftSummary[]>([]);
  const [myRecordsRevision, setMyRecordsRevision] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [cursorHistory, setCursorHistory] = useState<Array<ZagulyakySearchCursor | null>>([null]);
  const [nextCursor, setNextCursor] = useState<ZagulyakySearchCursor | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showHowItWorks, setShowHowItWorks] = useState(false);
  const [createKind, setCreateKind] = useState<ZagulyakaKind | null>(null);
  const [editingDraft, setEditingDraft] = useState<ZagulyakaEditableDraft | null>(null);
  const [editingLoadingId, setEditingLoadingId] = useState("");
  const [myRecordAction, setMyRecordAction] = useState<{ id: string; type: "withdraw" | "delete" } | null>(null);
  const [selectedSlug, setSelectedSlug] = useState(initialRecordSlug);
  const [detail, setDetail] = useState<ZagulyakaDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(Boolean(initialRecordSlug));
  const [detailError, setDetailError] = useState("");
  const requestGeneration = useRef(0);

  useEffect(() => {
    setSelectedSlug(initialRecordSlug);
  }, [initialRecordSlug]);

  useEffect(() => {
    setActiveTab(initialTab);
    resetPagination(setPage, setCursorHistory, setNextCursor);
  }, [initialTab]);

  useEffect(() => {
    let active = true;
    setStatsLoading(true);
    void loadZagulyakyStats().then((next) => {
      if (active) setStats(next);
    }).catch(() => {
      if (active) setStats(initialStats);
    }).finally(() => {
      if (active) setStatsLoading(false);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (activeTab === "mine") {
      if (!account) {
        ++requestGeneration.current;
        setLoading(false);
        setError("");
        setMyRecords([]);
        return;
      }
      const generation = ++requestGeneration.current;
      setLoading(true);
      setError("");
      void loadMyZagulyaky(account.id).then((items) => {
        if (requestGeneration.current !== generation) return;
        setMyRecords(items);
      }).catch((loadError) => {
        if (requestGeneration.current === generation) setError(catalogError(loadError));
      }).finally(() => {
        if (requestGeneration.current === generation) setLoading(false);
      });
      return;
    }

    const generation = ++requestGeneration.current;
    setLoading(true);
    setError("");
    const timeout = window.setTimeout(() => {
      const request = activeTab === "people"
        ? searchZagulyakyPeople(peopleFilters, cursorHistory[page - 1] ?? null, pageSize)
        : searchZagulyakyDocuments(documentFilters, cursorHistory[page - 1] ?? null, pageSize);
      void request.then((result) => {
        if (requestGeneration.current !== generation) return;
        if (activeTab === "people") setPeople(result.items as ZagulyakaPersonListItem[]);
        else setDocuments(result.items as ZagulyakaDocumentListItem[]);
        setNextCursor(result.nextCursor);
      }).catch((loadError) => {
        if (requestGeneration.current === generation) setError(catalogError(loadError));
      }).finally(() => {
        if (requestGeneration.current === generation) setLoading(false);
      });
    }, 320);
    return () => window.clearTimeout(timeout);
  }, [account, activeTab, cursorHistory, documentFilters, myRecordsRevision, page, pageSize, peopleFilters]);

  useEffect(() => {
    if (!selectedSlug) {
      setDetail(null);
      setDetailError("");
      setDetailLoading(false);
      return;
    }
    let active = true;
    setDetailLoading(true);
    setDetailError("");
    setDetail(null);
    void loadPublicZagulyaka(selectedSlug).then((next) => {
      if (active) setDetail(next);
    }).catch((loadError) => {
      if (active) setDetailError(catalogError(loadError));
    }).finally(() => {
      if (active) setDetailLoading(false);
    });
    return () => { active = false; };
  }, [selectedSlug]);

  const currentItemsCount = activeTab === "people" ? people.length : activeTab === "documents" ? documents.length : myRecords.length;
  const searchQuery = activeTab === "documents" ? documentFilters.query : peopleFilters.query;
  const filterCount = activeTab === "people"
    ? countActiveFilters(peopleFilters, ["query"])
    : activeTab === "documents"
      ? countActiveFilters(documentFilters, ["query"])
      : 0;

  const statsCards = useMemo(() => [
    activeTab === "documents"
      ? { label: "Загуляк документів", value: stats.documentCount, icon: "▤" }
      : { label: "Загуляк людей", value: stats.peopleCount, icon: "◎" },
    activeTab === "documents"
      ? { label: "Архівів та установ", value: stats.archiveCount, icon: "⌂" }
      : { label: "Населених пунктів", value: stats.placesCount, icon: "⌖" },
    { label: "Період записів", value: yearRange(stats.earliestYear, stats.latestYear), icon: "▣" },
    { label: "Джерело перевірено", value: stats.verifiedCount, icon: "✓" },
    { label: "Дослідників долучилось", value: stats.contributorsCount, icon: "♙" },
  ], [activeTab, stats]);

  const setTab = (next: ZagulyakyTab) => {
    if (next === "mine" && !account) {
      rememberReturnPath("/zahuliaky/my");
      requestSignIn(onRequestSignIn);
      return;
    }
    setActiveTab(next);
    setPage(1);
    setCursorHistory([null]);
    setNextCursor(null);
    setError("");
    onNavigate?.(zagulyakyTabPath(next));
  };

  const requestCreate = (kind: ZagulyakaKind) => {
    if (!account) {
      rememberReturnPath();
      requestSignIn(onRequestSignIn);
      return;
    }
    setCreateKind(kind);
  };

  const editMyRecord = async (record: ZagulyakaDraftSummary) => {
    if (!account || !["draft", "needs_changes", "withdrawn"].includes(record.status)) return;
    setEditingLoadingId(record.id);
    setError("");
    try {
      setEditingDraft(await loadMyZagulyakaDraft(record.id, account.id));
    } catch (loadError) {
      setError(catalogError(loadError));
    } finally {
      setEditingLoadingId("");
    }
  };

  const withdrawMyRecord = async (record: ZagulyakaDraftSummary) => {
    if (!account || !["pending_review", "needs_changes"].includes(record.status)) return;
    if (!window.confirm("Відкликати запис з модерації? Він залишиться приватним у «Моїх записах», де його можна буде відредагувати або видалити.")) return;
    setMyRecordAction({ id: record.id, type: "withdraw" });
    setError("");
    try {
      await withdrawZagulyakaDraft({ id: record.id, lockVersion: record.lockVersion }, account.id);
      setMyRecordsRevision((current) => current + 1);
    } catch (actionError) {
      setError(catalogError(actionError));
    } finally {
      setMyRecordAction(null);
    }
  };

  const deleteMyRecord = async (record: ZagulyakaDraftSummary) => {
    if (!account || !["draft", "needs_changes", "withdrawn"].includes(record.status)) return;
    if (!window.confirm("Видалити приватну чернетку назавжди? Опубліковані дані це не змінить.")) return;
    setMyRecordAction({ id: record.id, type: "delete" });
    setError("");
    try {
      await deleteMyZagulyakaDraft({ id: record.id, lockVersion: record.lockVersion }, account.id);
      if (editingDraft?.handle.id === record.id) setEditingDraft(null);
      setMyRecordsRevision((current) => current + 1);
    } catch (actionError) {
      setError(catalogError(actionError));
    } finally {
      setMyRecordAction(null);
    }
  };

  const openDetail = (kind: ZagulyakaKind, slug: string) => {
    if (!slug) return;
    setSelectedSlug(slug);
    onNavigate?.(`/zahuliaky/${kind === "person" ? "people" : "documents"}/${encodeURIComponent(slug)}`);
  };

  const closeDetail = () => {
    setSelectedSlug("");
    setDetail(null);
    setDetailError("");
    onNavigate?.(activeTab === "documents" ? "/zahuliaky/documents" : activeTab === "mine" ? "/zahuliaky/my" : "/zahuliaky");
  };

  return (
    <main className="zagulyaky-page">
      <header className="zagulyaky-public-header">
        <div className="zagulyaky-public-topline">
          <a className="brand zagulyaky-brand" href="/" aria-label="Трекер Роду — головна">
            <span className="brand-mark"><img src="/tracker-rodu-logo.png" alt="" /></span>
            <span><strong>Трекер Роду</strong><small>генеалогічний робочий простір</small></span>
          </a>
          <nav className="zagulyaky-public-nav" aria-label="Публічна навігація">
            <a href="/">Головна</a>
            <a href="/features">Можливості</a>
            <a href="/faq">FAQ</a>
            <a href="/zahuliaky" aria-current="page">Загуляки</a>
          </nav>
        </div>
        <div className="zagulyaky-hero-row">
          <div>
            <span className="eyebrow">Публічний генеалогічний каталог</span>
            <h1>Загуляки</h1>
            <p>Люди й документи, знайдені поза очікуваним місцем пошуку.</p>
          </div>
          <div className="zagulyaky-hero-actions">
            <button type="button" className="button button-secondary" onClick={() => setShowHowItWorks((current) => !current)}>
              ? Як це працює
            </button>
            <button type="button" className="button button-primary" onClick={() => requestCreate(activeTab === "documents" ? "document" : "person")}>
              + Додати загуляку
            </button>
          </div>
        </div>
      </header>

      {showHowItWorks ? (
        <section className="zagulyaky-how-it-works" aria-labelledby="zagulyaky-how-title">
          <div>
            <span>1</span><strong>Знайдіть несподіваний запис</strong><p>Людину або частину справи з іншого населеного пункту.</p>
          </div>
          <div>
            <span>2</span><strong>Додайте джерело</strong><p>Вкажіть місце, рік, архівний шифр і сторінку.</p>
          </div>
          <div>
            <span>3</span><strong>Дочекайтеся перевірки</strong><p>До публікації модератор перевіряє джерело, дублі і приватність.</p>
          </div>
        </section>
      ) : null}

      <section className="zagulyaky-catalog" aria-label="Каталог загуляк">
        <nav className="zagulyaky-tabs" aria-label="Розділи каталогу">
          <button type="button" className={activeTab === "people" ? "active" : ""} onClick={() => setTab("people")}>Люди <span>{stats.peopleCount.toLocaleString("uk-UA")}</span></button>
          <button type="button" className={activeTab === "documents" ? "active" : ""} onClick={() => setTab("documents")}>Документи <span>{stats.documentCount.toLocaleString("uk-UA")}</span></button>
          {account ? (
            <button type="button" className={activeTab === "mine" ? "active" : ""} onClick={() => setTab("mine")}>Мої записи</button>
          ) : null}
        </nav>

        {activeTab !== "mine" ? (
          <div className="zagulyaky-search-row">
            <label>
              <span className="visually-hidden">Пошук</span>
              <input
                type="search"
                value={searchQuery}
                onChange={(event) => {
                  resetPagination(setPage, setCursorHistory, setNextCursor);
                  if (activeTab === "people") setPeopleFilters((current) => ({ ...current, query: event.target.value }));
                  else setDocumentFilters((current) => ({ ...current, query: event.target.value }));
                }}
                placeholder={activeTab === "people" ? "Прізвище, ім’я, населений пункт або джерело" : "Назва, архів, населений пункт або шифр"}
              />
            </label>
            <button type="button" className="button button-secondary" onClick={() => setShowFilters((current) => !current)} aria-expanded={showFilters}>
              ≡ Фільтри {filterCount ? <span>{filterCount}</span> : null}
            </button>
          </div>
        ) : null}

        {showFilters && activeTab === "people" ? <PeopleFilters value={peopleFilters} onChange={(next) => { setPeopleFilters(next); resetPagination(setPage, setCursorHistory, setNextCursor); }} /> : null}
        {showFilters && activeTab === "documents" ? <DocumentFilters value={documentFilters} onChange={(next) => { setDocumentFilters(next); resetPagination(setPage, setCursorHistory, setNextCursor); }} /> : null}

        {activeTab !== "mine" ? (
          <div className="zagulyaky-stats-grid" aria-label="Статистика каталогу">
            {statsCards.map((card) => (
              <article key={card.label} className={statsLoading ? "loading" : ""}>
                <span aria-hidden="true">{card.icon}</span>
                <div><strong>{typeof card.value === "number" ? card.value.toLocaleString("uk-UA") : card.value}</strong><small>{card.label}</small></div>
              </article>
            ))}
          </div>
        ) : null}

        {error ? <div className="alert alert-error zagulyaky-alert" role="alert">{error}</div> : null}
        {loading ? <CatalogSkeleton /> : null}
        {!loading && !error && activeTab === "people" ? <PeopleTable items={people} onOpen={(slug) => openDetail("person", slug)} /> : null}
        {!loading && !error && activeTab === "documents" ? <DocumentsTable items={documents} onOpen={(slug) => openDetail("document", slug)} /> : null}
        {!loading && !error && activeTab === "mine" ? (
          account ? (
            <MyRecords
              items={myRecords}
              editingLoadingId={editingLoadingId}
              action={myRecordAction}
              onCreate={() => requestCreate("person")}
              onEdit={(record) => void editMyRecord(record)}
              onWithdraw={(record) => void withdrawMyRecord(record)}
              onDelete={(record) => void deleteMyRecord(record)}
              onOpenPublic={(record) => record.publishedSlug && openDetail(record.kind, record.publishedSlug)}
            />
          ) : (
            <div className="zagulyaky-empty">
              <span aria-hidden="true">◎</span>
              <h3>Увійдіть, щоб переглянути свої записи</h3>
              <p>Чернетки та записи на модерації приватні й доступні лише їх автору.</p>
              <button
                type="button"
                className="button button-primary"
                onClick={() => {
                  rememberReturnPath("/zahuliaky/my");
                  requestSignIn(onRequestSignIn);
                }}
              >
                Увійти до Трекера Роду
              </button>
            </div>
          )
        ) : null}

        {!loading && !error && activeTab !== "mine" ? (
          <CursorPagination
            page={page}
            pageSize={pageSize}
            currentCount={currentItemsCount}
            hasNext={Boolean(nextCursor)}
            onPrevious={() => setPage((current) => Math.max(1, current - 1))}
            onNext={() => {
              if (!nextCursor) return;
              setCursorHistory((current) => [...current.slice(0, page), nextCursor]);
              setPage((current) => current + 1);
            }}
            onPageSizeChange={(next) => {
              setPageSize(next);
              resetPagination(setPage, setCursorHistory, setNextCursor);
            }}
          />
        ) : null}
      </section>

      <footer className="zagulyaky-footer">
        <span>Випадкова згадка може допомогти іншому досліднику знайти родину.</span>
        <nav><a href="/privacy">Конфіденційність</a><a href="/terms">Умови</a><a href="/faq">FAQ</a></nav>
      </footer>

      {createKind && account ? (
        <ZagulyakaDraftDialog
          account={account}
          initialKind={createKind}
          onClose={() => setCreateKind(null)}
          onSaved={(submitted) => {
            setMyRecordsRevision((current) => current + 1);
            if (submitted) {
              setCreateKind(null);
              setActiveTab("mine");
              onNavigate?.("/zahuliaky/my");
            }
          }}
        />
      ) : null}

      {editingDraft && account ? (
        <ZagulyakaDraftDialog
          key={editingDraft.handle.id}
          account={account}
          initialKind={editingDraft.input.kind}
          initialDraft={editingDraft.input}
          initialHandle={editingDraft.handle}
          initialRightsConfirmed={editingDraft.rightsConfirmed}
          initialAttachments={editingDraft.attachments}
          onClose={() => setEditingDraft(null)}
          onSaved={(submitted) => {
            setMyRecordsRevision((current) => current + 1);
            if (submitted) setEditingDraft(null);
          }}
        />
      ) : null}

      {selectedSlug ? (
        <ZagulyakaDetailDialog
          detail={detail}
          loading={detailLoading}
          error={detailError}
          account={account}
          onClose={closeDetail}
          onRequestSignIn={() => {
            rememberReturnPath(selectedSlug ? `/zahuliaky/${detail?.kind === "document" ? "documents" : "people"}/${encodeURIComponent(selectedSlug)}` : undefined);
            requestSignIn(onRequestSignIn);
          }}
        />
      ) : null}
    </main>
  );
}

function PeopleFilters({ value, onChange }: { value: ZagulyakyPeopleFilters; onChange: (next: ZagulyakyPeopleFilters) => void }) {
  return (
    <div className="zagulyaky-filter-panel">
      <label><span>Походження</span><input value={value.originPlace} onChange={(event) => onChange({ ...value, originPlace: event.target.value })} /></label>
      <label><span>Де знайдено</span><input value={value.foundPlace} onChange={(event) => onChange({ ...value, foundPlace: event.target.value })} /></label>
      <label><span>Подія</span><select value={value.eventType} onChange={(event) => onChange({ ...value, eventType: event.target.value as ZagulyakyPeopleFilters["eventType"] })}><option value="">Усі події</option>{Object.entries(zagulyakaEventLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <YearFilter value={value} onChange={onChange} />
      <VerificationFilter value={value} onChange={onChange} />
      <button type="button" className="button button-ghost" onClick={() => onChange({ ...initialPeopleFilters, query: value.query })}>Скинути фільтри</button>
    </div>
  );
}

function DocumentFilters({ value, onChange }: { value: ZagulyakyDocumentFilters; onChange: (next: ZagulyakyDocumentFilters) => void }) {
  return (
    <div className="zagulyaky-filter-panel">
      <label><span>Архів або установа</span><input value={value.institutionName} onChange={(event) => onChange({ ...value, institutionName: event.target.value })} /></label>
      <label><span>Місце в описі</span><input value={value.officialPlace} onChange={(event) => onChange({ ...value, officialPlace: event.target.value })} /></label>
      <label><span>Додатково знайдено</span><input value={value.foundPlace} onChange={(event) => onChange({ ...value, foundPlace: event.target.value })} /></label>
      <label><span>Тип документа</span><input value={value.documentType} onChange={(event) => onChange({ ...value, documentType: event.target.value })} /></label>
      <YearFilter value={value} onChange={onChange} />
      <VerificationFilter value={value} onChange={onChange} />
      <button type="button" className="button button-ghost" onClick={() => onChange({ ...initialDocumentFilters, query: value.query })}>Скинути фільтри</button>
    </div>
  );
}

function YearFilter<T extends { yearFrom: number | null; yearTo: number | null }>({ value, onChange }: { value: T; onChange: (next: T) => void }) {
  return (
    <div className="zagulyaky-year-filter"><label><span>Рік від</span><input type="number" inputMode="numeric" value={value.yearFrom ?? ""} onChange={(event) => onChange({ ...value, yearFrom: optionalNumber(event.target.value) })} /></label><label><span>Рік до</span><input type="number" inputMode="numeric" value={value.yearTo ?? ""} onChange={(event) => onChange({ ...value, yearTo: optionalNumber(event.target.value) })} /></label></div>
  );
}

function VerificationFilter<T extends { verificationStatus: ZagulyakyPeopleFilters["verificationStatus"] }>({ value, onChange }: { value: T; onChange: (next: T) => void }) {
  return (
    <label><span>Статус</span><select value={value.verificationStatus} onChange={(event) => onChange({ ...value, verificationStatus: event.target.value as T["verificationStatus"] })}><option value="">Усі статуси</option>{Object.entries(zagulyakaVerificationLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
  );
}

function PeopleTable({ items, onOpen }: { items: ZagulyakaPersonListItem[]; onOpen: (slug: string) => void }) {
  if (!items.length) return <EmptyCatalog kind="people" />;
  return (
    <div className="zagulyaky-table-wrap"><table className="zagulyaky-table"><thead><tr><th>Особа</th><th>Походження</th><th>Де знайдено</th><th>Подія</th><th>Дата</th><th>Джерело</th><th>Статус</th></tr></thead><tbody>{items.map((item) => (
      <tr key={item.id} onDoubleClick={() => onOpen(item.slug)}>
        <td data-label="Особа"><button type="button" className="zagulyaky-record-link" onClick={() => onOpen(item.slug)}><span className={`zagulyaky-person-avatar gender-${item.gender}`}>{initials(item.displayName)}</span><span><strong>{item.displayName}</strong>{item.originalName && item.originalName !== item.displayName ? <small>{item.originalName}</small> : null}</span></button></td>
        <td data-label="Походження">{item.originPlace || "—"}</td>
        <td data-label="Де знайдено">{item.foundPlace || "—"}</td>
        <td data-label="Подія">{zagulyakaEventLabels[item.eventType]}</td>
        <td data-label="Дата">{item.eventDateLabel || item.eventYear || "—"}</td>
        <td data-label="Джерело"><span className="zagulyaky-source-cell">{item.sourceCitation || "—"}{item.pageLabel ? <small>{item.pageLabel}</small> : null}</span></td>
        <td data-label="Статус"><span className={`zagulyaky-status status-${item.verificationStatus}`}>{zagulyakaVerificationLabels[item.verificationStatus]}</span>{item.confirmationsCount ? <small className="zagulyaky-confirmations">{item.confirmationsCount} підтв.</small> : null}</td>
      </tr>
    ))}</tbody></table></div>
  );
}

function DocumentsTable({ items, onOpen }: { items: ZagulyakaDocumentListItem[]; onOpen: (slug: string) => void }) {
  if (!items.length) return <EmptyCatalog kind="documents" />;
  return (
    <div className="zagulyaky-table-wrap"><table className="zagulyaky-table"><thead><tr><th>Документ</th><th>В описі</th><th>Додатково знайдено</th><th>Записи / роки</th><th>Архівний шифр</th><th>Сторінки</th><th>Статус</th></tr></thead><tbody>{items.map((item) => (
      <tr key={item.id} onDoubleClick={() => onOpen(item.slug)}>
        <td data-label="Документ"><button type="button" className="zagulyaky-record-link" onClick={() => onOpen(item.slug)}><span className="zagulyaky-document-icon">▤</span><span><strong>{item.title}</strong><small>{item.documentType}</small></span></button></td>
        <td data-label="В описі">{item.officialPlace || "—"}</td>
        <td data-label="Додатково знайдено">{item.foundPlaces.join(", ") || "—"}</td>
        <td data-label="Записи / роки"><span className="zagulyaky-source-cell">{item.recordTypes.join(", ") || "—"}<small>{yearRange(item.actualYearFrom, item.actualYearTo)}</small></span></td>
        <td data-label="Архівний шифр">{[item.institutionName, item.archiveReference].filter(Boolean).join(" · ") || "—"}</td>
        <td data-label="Сторінки">{item.pageRange || "—"}</td>
        <td data-label="Статус"><span className={`zagulyaky-status status-${item.verificationStatus}`}>{zagulyakaVerificationLabels[item.verificationStatus]}</span></td>
      </tr>
    ))}</tbody></table></div>
  );
}

function MyRecords({
  items,
  editingLoadingId,
  action,
  onCreate,
  onEdit,
  onWithdraw,
  onDelete,
  onOpenPublic,
}: {
  items: ZagulyakaDraftSummary[];
  editingLoadingId: string;
  action: { id: string; type: "withdraw" | "delete" } | null;
  onCreate: () => void;
  onEdit: (record: ZagulyakaDraftSummary) => void;
  onWithdraw: (record: ZagulyakaDraftSummary) => void;
  onDelete: (record: ZagulyakaDraftSummary) => void;
  onOpenPublic: (record: ZagulyakaDraftSummary) => void;
}) {
  if (!items.length) return <div className="zagulyaky-empty"><span>✎</span><h3>У вас ще немає записів</h3><p>Додайте першу загуляку — чернетка залишатиметься приватною.</p><button type="button" className="button button-primary" onClick={onCreate}>+ Додати запис</button></div>;
  return <div className="zagulyaky-my-records">{items.map((item) => {
    const editable = ["draft", "needs_changes", "withdrawn"].includes(item.status);
    const withdrawable = ["pending_review", "needs_changes"].includes(item.status);
    const deletable = ["draft", "needs_changes", "withdrawn"].includes(item.status);
    const busy = action?.id === item.id || Boolean(editingLoadingId);
    return <article key={item.id}><div><span className="eyebrow">{item.kind === "person" ? "Людина" : "Документ"}</span><h3>{item.title}</h3><small>Оновлено {formatDate(item.updatedAt)}</small></div><div><span className={`zagulyaky-status workflow-${item.status}`}>{zagulyakaWorkflowLabels[item.status]}</span>{item.rejectionReason ? <p>{item.rejectionReason}</p> : null}<div className="zagulyaky-my-record-actions">{editable ? <button type="button" className="button button-secondary" disabled={busy} onClick={() => onEdit(item)}>{editingLoadingId === item.id ? "Відкриваємо…" : "Редагувати"}</button> : null}{withdrawable ? <button type="button" className="button button-secondary" disabled={busy} onClick={() => onWithdraw(item)}>{action?.id === item.id && action.type === "withdraw" ? "Відкликаємо…" : "Відкликати"}</button> : null}{deletable ? <button type="button" className="button button-ghost zagulyaky-delete-draft" disabled={busy} onClick={() => onDelete(item)}>{action?.id === item.id && action.type === "delete" ? "Видаляємо…" : "Видалити"}</button> : null}{item.publishedSlug ? <button type="button" className="button button-secondary" onClick={() => onOpenPublic(item)}>Відкрити публічну картку</button> : null}</div></div></article>;
  })}</div>;
}

function EmptyCatalog({ kind }: { kind: "people" | "documents" }) {
  return <div className="zagulyaky-empty"><span>{kind === "people" ? "◎" : "▤"}</span><h3>Нічого не знайдено</h3><p>Змініть запит або скиньте частину фільтрів.</p></div>;
}

function CatalogSkeleton() {
  return <div className="zagulyaky-catalog-skeleton" aria-label="Завантажуємо каталог">{Array.from({ length: 6 }, (_, index) => <span key={index} />)}</div>;
}

function CursorPagination({
  page,
  pageSize,
  currentCount,
  hasNext,
  onPrevious,
  onNext,
  onPageSizeChange,
}: {
  page: number;
  pageSize: number;
  currentCount: number;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onPageSizeChange: (value: number) => void;
}) {
  const from = currentCount ? (page - 1) * pageSize + 1 : 0;
  const to = currentCount ? from + currentCount - 1 : 0;
  return (
    <nav className="zagulyaky-cursor-pagination" aria-label="Сторінки каталогу">
      <span>{currentCount ? `Показано ${from}–${to}` : "Записів немає"}</span>
      <label>
        <span>На сторінці</span>
        <select value={pageSize} onChange={(event) => onPageSizeChange(Number(event.target.value))}>
          <option value={10}>10</option>
          <option value={20}>20</option>
          <option value={50}>50</option>
        </select>
      </label>
      <div>
        <button type="button" className="button button-secondary" onClick={onPrevious} disabled={page <= 1}>← Назад</button>
        <strong aria-label={`Поточна сторінка ${page}`}>{page}</strong>
        <button type="button" className="button button-secondary" onClick={onNext} disabled={!hasNext}>Далі →</button>
      </div>
    </nav>
  );
}

function resetPagination(
  setPage: (value: number) => void,
  setCursorHistory: (value: Array<ZagulyakySearchCursor | null>) => void,
  setNextCursor: (value: ZagulyakySearchCursor | null) => void,
): void {
  setPage(1);
  setCursorHistory([null]);
  setNextCursor(null);
}

function countActiveFilters<T extends object>(filters: T, ignored: string[]): number {
  return Object.entries(filters).filter(([key, value]) => !ignored.includes(key) && value !== "" && value !== null && value !== undefined).length;
}

function optionalNumber(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function yearRange(from: number | null, to: number | null): string {
  if (from === null && to === null) return "—";
  if (from === to || to === null) return String(from ?? to);
  if (from === null) return `до ${to}`;
  return `${from}–${to}`;
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toLocaleUpperCase()).join("") || "?";
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
}

function catalogError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/function .* does not exist|could not find the function|PGRST202/i.test(message)) return "База даних каталогу ще не оновлена. Застосуйте міграцію «Загуляки» і оновіть сторінку.";
  return message || "Не вдалося завантажити каталог.";
}

function requestSignIn(callback?: () => void): void {
  if (callback) callback();
  else window.location.assign("/");
}

function rememberReturnPath(path = "/zahuliaky"): void {
  try { window.sessionStorage.setItem("tracker-rodu:post-auth-return", path); } catch { /* storage can be blocked */ }
}
