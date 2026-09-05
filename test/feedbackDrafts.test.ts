import assert from "node:assert/strict";
import test from "node:test";
import {
  clearFeedbackComposerDraft,
  clearFeedbackReplyDraft,
  loadFeedbackComposerDraft,
  loadFeedbackReplyDraft,
  saveFeedbackComposerDraft,
  saveFeedbackReplyDraft,
} from "../src/utils/feedbackDrafts.ts";

function memoryStorage() {
  const entries = new Map<string, string>();
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); },
  };
}

test("feedback reply drafts are isolated by both account and thread", () => {
  const storage = memoryStorage();
  saveFeedbackReplyDraft("admin-a", "thread-a", "Відповідь A", storage);
  saveFeedbackReplyDraft("admin-a", "thread-b", "Відповідь B", storage);
  saveFeedbackReplyDraft("admin-b", "thread-a", "Інший адміністратор", storage);

  assert.equal(loadFeedbackReplyDraft("admin-a", "thread-a", storage), "Відповідь A");
  assert.equal(loadFeedbackReplyDraft("admin-a", "thread-b", storage), "Відповідь B");
  assert.equal(loadFeedbackReplyDraft("admin-b", "thread-a", storage), "Інший адміністратор");

  clearFeedbackReplyDraft("admin-a", "thread-a", storage);
  assert.equal(loadFeedbackReplyDraft("admin-a", "thread-a", storage), "");
  assert.equal(loadFeedbackReplyDraft("admin-b", "thread-a", storage), "Інший адміністратор");
});

test("new feedback composer survives reload and clears only after success", () => {
  const storage = memoryStorage();
  saveFeedbackComposerDraft("user-a", {
    subject: "Проблема зі сторінкою",
    category: "problem",
    body: "Опис незбереженого звернення",
  }, storage);

  assert.deepEqual(loadFeedbackComposerDraft("user-a", storage), {
    subject: "Проблема зі сторінкою",
    category: "problem",
    body: "Опис незбереженого звернення",
  });
  assert.deepEqual(loadFeedbackComposerDraft("user-b", storage), {
    subject: "",
    category: "question",
    body: "",
  });

  clearFeedbackComposerDraft("user-a", storage);
  assert.equal(loadFeedbackComposerDraft("user-a", storage).body, "");
});

test("malformed or unavailable storage never breaks the feedback editor", () => {
  const brokenStorage = {
    getItem() { throw new DOMException("blocked", "SecurityError"); },
    setItem() { throw new DOMException("blocked", "SecurityError"); },
    removeItem() { throw new DOMException("blocked", "SecurityError"); },
  };

  assert.equal(loadFeedbackReplyDraft("user-a", "thread-a", brokenStorage), "");
  assert.deepEqual(loadFeedbackComposerDraft("user-a", brokenStorage), {
    subject: "",
    category: "question",
    body: "",
  });
  assert.doesNotThrow(() => saveFeedbackReplyDraft("user-a", "thread-a", "text", brokenStorage));
});
