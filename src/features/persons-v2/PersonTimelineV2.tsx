import type { Person, ScanAttachment } from "../../types";
import {
  buildPersonTimeline,
  personTimelineAttachments,
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
  onOpenAttachment?: (
    attachment: ScanAttachment,
    attachments: readonly ScanAttachment[],
  ) => void;
}

export function PersonTimelineV2({
  person,
  items,
  emptyMessage = "Для цієї особи ще не додано життєвих подій.",
  onSelectEvent,
  onOpenAttachment,
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
        const attachments = personTimelineAttachments(person, event);
        return (
          <li key={`${event.source}:${event.id}`} className={`persons-v2-timeline__item is-${event.type}`}>
            <article className="persons-v2-timeline__event">
              <PersonTimelineContentV2
                event={event}
                attachments={attachments}
                onSelectEvent={onSelectEvent}
                onOpenAttachment={onOpenAttachment}
              />
            </article>
          </li>
        );
      })}
    </ol>
  );
}

function PersonTimelineContentV2({
  event,
  attachments,
  onSelectEvent,
  onOpenAttachment,
}: {
  event: PersonTimelineItem;
  attachments: readonly ScanAttachment[];
  onSelectEvent?: (event: PersonTimelineItem) => void;
  onOpenAttachment?: (
    attachment: ScanAttachment,
    attachments: readonly ScanAttachment[],
  ) => void;
}) {
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
      <span className="persons-v2-timeline__footer">
        <span className="persons-v2-timeline__meta">
          {event.source === "core" ? "Основний факт" : "Додаткова подія"}
        </span>
        {attachments.length ? (
          onOpenAttachment ? (
            <button
              type="button"
              className="persons-v2-timeline__attachments"
              title={attachments.map((attachment) => attachment.name).join("\n")}
              aria-label={`Відкрити документи події «${displayTitle}»: ${attachments.length}`}
              onClick={() => onOpenAttachment(attachments[0], attachments)}
            >
              <AttachmentIconV2 />
              <span>Документи події</span>
              <strong>{attachments.length}</strong>
            </button>
          ) : (
            <span className="persons-v2-timeline__attachments is-static">
              <AttachmentIconV2 />
              <span>Документи події</span>
              <strong>{attachments.length}</strong>
            </span>
          )
        ) : null}
        {onSelectEvent ? (
          <button
            type="button"
            className="persons-v2-timeline__open-event"
            onClick={() => onSelectEvent(event)}
          >
            Відкрити подію
          </button>
        ) : null}
      </span>
    </>
  );
}

function AttachmentIconV2() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path d="M7.1 10.9 12 6a2.5 2.5 0 0 1 3.5 3.5l-6.1 6.1a4 4 0 0 1-5.7-5.7l6.5-6.5" />
    </svg>
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
