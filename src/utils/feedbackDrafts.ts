import type { FeedbackCategory } from "../types/feedback";

export const FEEDBACK_DRAFT_STORAGE_PREFIX = "tracker-rodu.feedback-draft.v1:";

const MAX_SUBJECT_LENGTH = 160;
const MAX_MESSAGE_LENGTH = 5000;
const feedbackCategories = new Set<FeedbackCategory>([
  "question",
  "suggestion",
  "problem",
  "other",
]);

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface FeedbackComposerDraft {
  subject: string;
  category: FeedbackCategory;
  body: string;
}

const emptyComposerDraft: FeedbackComposerDraft = Object.freeze({
  subject: "",
  category: "question",
  body: "",
});

export function loadFeedbackReplyDraft(
  userId: string,
  threadId: string,
  storage: StorageLike | undefined = browserStorage(),
): string {
  if (!storage || !userId || !threadId) return "";
  try {
    return (storage.getItem(replyKey(userId, threadId)) ?? "").slice(0, MAX_MESSAGE_LENGTH);
  } catch {
    return "";
  }
}

export function saveFeedbackReplyDraft(
  userId: string,
  threadId: string,
  body: string,
  storage: StorageLike | undefined = browserStorage(),
): void {
  if (!storage || !userId || !threadId) return;
  const key = replyKey(userId, threadId);
  try {
    const safeBody = body.slice(0, MAX_MESSAGE_LENGTH);
    if (safeBody) storage.setItem(key, safeBody);
    else storage.removeItem(key);
  } catch {
    // Private browsing or a full storage quota must not break the reply form.
  }
}

export function clearFeedbackReplyDraft(
  userId: string,
  threadId: string,
  storage: StorageLike | undefined = browserStorage(),
): void {
  if (!storage || !userId || !threadId) return;
  try {
    storage.removeItem(replyKey(userId, threadId));
  } catch {
    // Best-effort cleanup; the successful server write remains authoritative.
  }
}

export function loadFeedbackComposerDraft(
  userId: string,
  storage: StorageLike | undefined = browserStorage(),
): FeedbackComposerDraft {
  if (!storage || !userId) return { ...emptyComposerDraft };
  try {
    const raw = storage.getItem(composerKey(userId));
    if (!raw) return { ...emptyComposerDraft };
    const parsed = JSON.parse(raw) as Partial<FeedbackComposerDraft>;
    const category = feedbackCategories.has(parsed.category as FeedbackCategory)
      ? parsed.category as FeedbackCategory
      : "question";
    return {
      subject: typeof parsed.subject === "string"
        ? parsed.subject.slice(0, MAX_SUBJECT_LENGTH)
        : "",
      category,
      body: typeof parsed.body === "string"
        ? parsed.body.slice(0, MAX_MESSAGE_LENGTH)
        : "",
    };
  } catch {
    return { ...emptyComposerDraft };
  }
}

export function saveFeedbackComposerDraft(
  userId: string,
  draft: FeedbackComposerDraft,
  storage: StorageLike | undefined = browserStorage(),
): void {
  if (!storage || !userId) return;
  const key = composerKey(userId);
  try {
    const safeDraft: FeedbackComposerDraft = {
      subject: draft.subject.slice(0, MAX_SUBJECT_LENGTH),
      category: feedbackCategories.has(draft.category) ? draft.category : "question",
      body: draft.body.slice(0, MAX_MESSAGE_LENGTH),
    };
    if (!safeDraft.subject && !safeDraft.body && safeDraft.category === "question") {
      storage.removeItem(key);
      return;
    }
    storage.setItem(key, JSON.stringify(safeDraft));
  } catch {
    // Draft persistence is a safety net and must never block the editor.
  }
}

export function clearFeedbackComposerDraft(
  userId: string,
  storage: StorageLike | undefined = browserStorage(),
): void {
  if (!storage || !userId) return;
  try {
    storage.removeItem(composerKey(userId));
  } catch {
    // Best-effort cleanup after a successful server write.
  }
}

function replyKey(userId: string, threadId: string): string {
  return `${FEEDBACK_DRAFT_STORAGE_PREFIX}${encodeURIComponent(userId)}:reply:${encodeURIComponent(threadId)}`;
}

function composerKey(userId: string): string {
  return `${FEEDBACK_DRAFT_STORAGE_PREFIX}${encodeURIComponent(userId)}:new`;
}

function browserStorage(): StorageLike | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
