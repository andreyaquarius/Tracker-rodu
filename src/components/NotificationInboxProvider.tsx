import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { notificationInboxService, PartialInboxError, type NotificationInboxService } from "../services/notificationInboxService";
import { notificationKey, type InboxNotification, type NotificationKind } from "../utils/notificationInbox.ts";

interface NotificationInbox {
  items: InboxNotification[];
  unreadCount: number;
  loading: boolean;
  loaded: boolean;
  error: string;
  actionError: string;
  markingAll: boolean;
  refresh(): Promise<void>;
  loadOne(kind: NotificationKind, id: string): Promise<InboxNotification | null>;
  markRead(item: InboxNotification): Promise<boolean>;
  markAllRead(): Promise<void>;
}
const InboxContext = createContext<NotificationInbox | null>(null);

export function useNotificationInbox(): NotificationInbox {
  const inbox = useContext(InboxContext);
  if (!inbox) throw new Error("NotificationInboxProvider is required");
  return inbox;
}

interface Props { accountId: string; children: ReactNode; service?: NotificationInboxService }
export function NotificationInboxProvider(props: Props) {
  // Account changes reset both the cache and pending actions, including the reader.
  return <AccountInbox key={props.accountId} {...props} />;
}

function AccountInbox({ accountId, children, service = notificationInboxService }: Props) {
  const [items, setItems] = useState<InboxNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [markingAll, setMarkingAll] = useState(false);
  const alive = useRef(true);
  const generation = useRef(0);
  const refreshFlight = useRef<Promise<void> | null>(null);
  const readFlights = useRef(new Map<string, Promise<boolean>>());
  const confirmedReads = useRef(new Set<string>());
  const allFlight = useRef(false);
  const withReads = useCallback((next: InboxNotification[]) => next.map((item) =>
    confirmedReads.current.has(notificationKey(item)) ? { ...item, isRead: true } : item,
  ), []);

  const refresh = useCallback((): Promise<void> => {
    if (refreshFlight.current) return refreshFlight.current;
    const currentGeneration = generation.current;
    const isCurrent = () => alive.current && generation.current === currentGeneration;
    setLoading(true);
    const request = service.load(accountId).then((result) => {
      if (!isCurrent()) return;
      setItems(withReads(result.items));
      setError(result.warning);
    }).catch((reason: unknown) => {
      if (!isCurrent()) return;
      if (reason instanceof PartialInboxError) {
        setItems((previous) => withReads([
          ...previous.filter((item) => !reason.loadedKinds.includes(item.kind)), ...reason.items,
        ]));
      }
      setError(reason instanceof Error ? reason.message : "Не вдалося завантажити сповіщення.");
    }).finally(() => {
      if (!isCurrent()) return;
      refreshFlight.current = null;
      setLoading(false);
      setLoaded(true);
    });
    refreshFlight.current = request;
    return request;
  }, [accountId, service, withReads]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60 * 1000);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      alive.current = false;
      generation.current += 1;
      refreshFlight.current = null;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  const loadOne = useCallback(async (kind: NotificationKind, id: string) => {
    const currentGeneration = generation.current;
    const item = await service.loadOne(kind, id, accountId);
    if (!alive.current || generation.current !== currentGeneration) return null;
    return item ? withReads([item])[0] : null;
  }, [accountId, service, withReads]);

  const markRead = useCallback((item: InboxNotification): Promise<boolean> => {
    const key = notificationKey(item);
    if (item.isRead || confirmedReads.current.has(key)) return Promise.resolve(true);
    const pending = readFlights.current.get(key);
    if (pending) return pending;
    const currentGeneration = generation.current;
    const isCurrent = () => alive.current && generation.current === currentGeneration;
    setActionError("");
    const request = service.markRead(item, accountId).then(() => {
      if (!isCurrent()) return false;
      confirmedReads.current.add(key);
      setItems((previous) => withReads(previous));
      return true;
    }).catch(() => {
      if (isCurrent()) setActionError("Не вдалося позначити повідомлення прочитаним. Його текст доступний; спробуйте ще раз.");
      return false;
    }).finally(() => readFlights.current.delete(key));
    readFlights.current.set(key, request);
    return request;
  }, [accountId, service, withReads]);

  const markAllRead = useCallback(async () => {
    if (allFlight.current || !items.some((item) => !item.isRead)) return;
    allFlight.current = true;
    setMarkingAll(true);
    setActionError("");
    const currentGeneration = generation.current;
    const isCurrent = () => alive.current && generation.current === currentGeneration;
    try {
      await service.markAll(items, accountId);
      if (!isCurrent()) return;
      items.forEach((item) => confirmedReads.current.add(notificationKey(item)));
      setItems((previous) => withReads(previous));
    } catch (reason) {
      if (!isCurrent()) return;
      setActionError(reason instanceof Error ? reason.message : "Не вдалося позначити повідомлення прочитаними.");
      await refresh();
    } finally {
      if (isCurrent()) { allFlight.current = false; setMarkingAll(false); }
    }
  }, [accountId, items, refresh, service, withReads]);

  const value = useMemo(() => ({
    items, unreadCount: items.filter((item) => !item.isRead).length, loading, loaded,
    error, actionError, markingAll, refresh, loadOne, markRead, markAllRead,
  }), [items, loading, loaded, error, actionError, markingAll, refresh, loadOne, markRead, markAllRead]);
  return <InboxContext.Provider value={value}>{children}</InboxContext.Provider>;
}
