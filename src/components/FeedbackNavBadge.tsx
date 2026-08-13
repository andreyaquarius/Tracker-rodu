import { useEffect, useRef, useState } from "react";
import { loadFeedbackUnreadCount } from "../services/feedbackService";

interface FeedbackNavBadgeProps {
  accountId: string;
}

export function FeedbackNavBadge({ accountId }: FeedbackNavBadgeProps) {
  const [count, setCount] = useState(0);
  const generationRef = useRef(0);

  useEffect(() => {
    let timer = 0;
    const refresh = async () => {
      const generation = ++generationRef.current;
      try {
        const nextCount = await loadFeedbackUnreadCount(accountId);
        if (generationRef.current === generation) setCount(nextCount);
      } catch {
        // The inbox migration may not be deployed yet. Navigation remains usable
        // and the page itself explains the missing database step.
      }
    };
    const onChanged = () => void refresh();
    const onFocus = () => void refresh();
    void refresh();
    timer = window.setInterval(() => void refresh(), 60_000);
    window.addEventListener("focus", onFocus);
    window.addEventListener("tracker-rodu:feedback-inbox-changed", onChanged);
    return () => {
      generationRef.current += 1;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("tracker-rodu:feedback-inbox-changed", onChanged);
    };
  }, [accountId]);

  if (!count) return null;
  return <span className="nav-feedback-badge" aria-label={`${count} непрочитаних звернень`}>{count > 99 ? "99+" : count}</span>;
}
