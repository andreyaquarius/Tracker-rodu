import type { Person } from "../../types";
import {
  buildPersonTimeline,
  type PersonTimelineItem,
} from "./model";
import {
  personTimelineDateDisplay,
  personTimelineDateTimeValue,
  personTimelineEventDisplaySubtitle,
  personTimelineEventDisplayTitle,
} from "./presentation";
import { PersonEventIconV2 } from "./PersonEventIconV2.tsx";

export interface PersonTimelineV2Props {
  person: Person;
  items?: readonly PersonTimelineItem[];
  emptyMessage?: string;
  onSelectEvent?: (event: PersonTimelineItem) => void;
}

export function PersonTimelineV2({
  person,
  items,
  emptyMessage = "Для цієї особи ще не додано життєвих подій.",
  onSelectEvent,
}: PersonTimelineV2Props) {
  const timeline = items ?? buildPersonTimeline(person);

  if (!timeline.length) {
    return (
      <div className="empty-inline persons-v2-timeline__empty">
        <strong>Хронологія порожня</strong>
        <span>{emptyMessage}</span>
      </div>
    );
  }

  return (
    <ol className="persons-v2-timeline" aria-label="Хронологія життя">
      {timeline.map((event) => {
        const content = <PersonTimelineContentV2 event={event} />;
        return (
          <li key={`${event.source}:${event.id}`} className={`persons-v2-timeline__item is-${event.type}`}>
            {onSelectEvent ? (
              <button
                type="button"
                className="persons-v2-timeline__event"
                onClick={() => onSelectEvent(event)}
              >
                {content}
              </button>
            ) : (
              <article className="persons-v2-timeline__event">{content}</article>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function PersonTimelineContentV2({ event }: { event: PersonTimelineItem }) {
  const details = [event.value, event.age ? `Вік: ${event.age}` : "", event.cause]
    .filter(Boolean)
    .join(" · ");
  const place = [event.placeName, event.address].filter(Boolean).join(", ");
  const displayDate = personTimelineDateDisplay(event.date) || "Дата невідома";
  const dateTime = personTimelineDateTimeValue(event.date);
  const displayTitle = personTimelineEventDisplayTitle(event);
  const displaySubtitle = personTimelineEventDisplaySubtitle(event);
  return (
    <>
      <time
        {...(dateTime ? { dateTime } : {})}
        className="persons-v2-timeline__date"
        title={event.date && displayDate !== event.date ? event.date : undefined}
      >
        <span>{displayDate}</span>
        <small>{precisionLabelV2(event.datePrecision)}</small>
      </time>
      <span className="persons-v2-timeline__marker" aria-hidden="true">
        <PersonEventIconV2 type={event.type} />
      </span>
      <span className="persons-v2-timeline__body">
        <strong>{displayTitle}</strong>
        {displaySubtitle ? <span className="persons-v2-timeline__original-title">{displaySubtitle}</span> : null}
        {place ? <span>{place}</span> : null}
        {details ? <small>{details}</small> : null}
        {event.notes ? <small>{event.notes}</small> : null}
      </span>
      <span className="persons-v2-timeline__meta">
        {event.source === "core" ? "Основний факт" : "Додаткова подія"}
      </span>
    </>
  );
}

function precisionLabelV2(precision: PersonTimelineItem["datePrecision"]): string {
  switch (precision) {
    case "exact": return "Точна дата";
    case "month": return "Місяць";
    case "year": return "Рік";
    case "range": return "Діапазон";
    case "approximate": return "Приблизно";
    case "unknown": return "Без точної дати";
  }
}
