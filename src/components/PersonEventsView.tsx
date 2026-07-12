import type { PersonEvent } from "../types";
import { personEventLabel } from "../utils/geo";

const CORE_FIELD_EVENT_TYPES = new Set(["birth", "marriage", "death"]);

function isVisibleEvent(event: PersonEvent): boolean {
  if (CORE_FIELD_EVENT_TYPES.has(event.type)) return false;
  if (event.type === "residence" && event.id === "residence") return false;
  return Boolean(
    event.title || event.date || event.placeName || event.value || event.age
      || event.cause || event.address || event.notes,
  );
}

export function PersonEventsView({ events }: { events: PersonEvent[] }) {
  const visible = events.filter(isVisibleEvent);
  if (!visible.length) return <div className="detail-text">Додаткових подій немає.</div>;

  return (
    <div className="person-event-details">
      {visible.map((event) => (
        <article key={event.id} className="person-event-detail-card">
          <strong>{event.title?.trim() || personEventLabel(event.type)}</strong>
          <span>
            {[event.date, event.placeName].filter(Boolean).join(" · ") || "Дата і місце не вказані"}
          </span>
          {event.value ? <p><b>Зміст:</b> {event.value}</p> : null}
          {event.age ? <p><b>Вік у джерелі:</b> {event.age}</p> : null}
          {event.address && event.address !== event.placeName ? <p><b>Адреса:</b> {event.address}</p> : null}
          {event.cause ? <p><b>Причина:</b> {event.cause}</p> : null}
          {event.notes ? <p>{event.notes}</p> : null}
        </article>
      ))}
    </div>
  );
}
