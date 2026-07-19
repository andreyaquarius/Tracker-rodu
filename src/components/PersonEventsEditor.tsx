import type { PersonEvent, PersonEventType } from "../types";
import { createId } from "../utils/id";
import { PERSON_EVENT_TYPES, personEventLabel } from "../utils/geo";

const CORE_FIELD_EVENTS = new Set<PersonEventType>(["birth", "marriage", "death", "residence"]);

function isSyntheticFieldEvent(event: PersonEvent): boolean {
  return CORE_FIELD_EVENTS.has(event.type) && event.id === event.type;
}

export function PersonEventsEditor({
  personId,
  events,
  onChange,
}: {
  personId: string;
  events: PersonEvent[];
  onChange: (events: PersonEvent[]) => void;
}) {
  const editableEvents = events.filter((event) => !isSyntheticFieldEvent(event));

  const updateEvent = (eventId: string, patch: Partial<PersonEvent>) => {
    onChange(events.map((event) => event.id === eventId ? { ...event, ...patch } : event));
  };

  const addEvent = () => {
    onChange([
      ...events,
      {
        id: createId(),
        personId,
        type: "other",
        title: "Інша подія",
        date: null,
        placeName: null,
        geo: null,
        notes: null,
      },
    ]);
  };

  const removeEvent = (eventId: string) => {
    onChange(events.filter((event) => event.id !== eventId));
  };

  return (
    <fieldset className="person-events-editor field-wide">
      <div className="person-events-editor-heading">
        <div>
          <legend>Інші життєві події та факти</legend>
          <p>
            Хрещення, переписи, ревізії, сповідні розписи, військова служба,
            освіта, поховання та інші події. Для однієї особи можна додати
            декілька подій одного типу.
          </p>
        </div>
        <button type="button" className="button button-secondary" onClick={addEvent}>
          + Додати подію
        </button>
      </div>

      {editableEvents.length ? (
        <div className="person-event-list">
          {editableEvents.map((event) => (
            <section className="person-event-row" key={event.id}>
              <label>
                <span>Тип події</span>
                <select
                  value={event.type}
                  onChange={(changeEvent) => {
                    const type = changeEvent.target.value as PersonEventType;
                    updateEvent(event.id, {
                      type,
                      title: !event.title || event.title === personEventLabel(event.type)
                        ? personEventLabel(type)
                        : event.title,
                    });
                  }}
                >
                  {PERSON_EVENT_TYPES.map((type) => (
                      <option key={type} value={type}>{personEventLabel(type)}</option>
                    ))}
                </select>
              </label>
              <label>
                <span>Назва або уточнення</span>
                <input
                  value={event.title ?? ""}
                  onChange={(changeEvent) => updateEvent(event.id, { title: changeEvent.target.value })}
                />
              </label>
              <label>
                <span>Дата або період</span>
                <input
                  value={event.date ?? ""}
                  placeholder="Наприклад: 1881–1886 або близько 1900"
                  onChange={(changeEvent) => updateEvent(event.id, { date: changeEvent.target.value || null })}
                />
              </label>
              <label>
                <span>Місце</span>
                <input
                  value={event.placeName ?? ""}
                  onChange={(changeEvent) => updateEvent(event.id, { placeName: changeEvent.target.value || null })}
                />
              </label>
              <label>
                <span>Зміст факту</span>
                <input
                  value={event.value ?? ""}
                  placeholder="Наприклад: 127-й піхотний полк або книга №23"
                  onChange={(changeEvent) => updateEvent(event.id, { value: changeEvent.target.value || null })}
                />
              </label>
              <label>
                <span>Вік у джерелі</span>
                <input
                  value={event.age ?? ""}
                  onChange={(changeEvent) => updateEvent(event.id, { age: changeEvent.target.value || null })}
                />
              </label>
              <label>
                <span>Точна адреса</span>
                <input
                  value={event.address ?? ""}
                  onChange={(changeEvent) => updateEvent(event.id, { address: changeEvent.target.value || null })}
                />
              </label>
              <label>
                <span>Причина</span>
                <input
                  value={event.cause ?? ""}
                  onChange={(changeEvent) => updateEvent(event.id, { cause: changeEvent.target.value || null })}
                />
              </label>
              <label className="field-wide">
                <span>Опис, архівний шифр або примітка</span>
                <textarea
                  rows={3}
                  value={event.notes ?? ""}
                  onChange={(changeEvent) => updateEvent(event.id, { notes: changeEvent.target.value || null })}
                />
              </label>
              <div className="person-event-row-actions field-wide">
                <button
                  type="button"
                  className="text-button danger"
                  onClick={() => removeEvent(event.id)}
                >
                  Видалити подію
                </button>
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="scan-empty">Додаткових подій поки немає.</div>
      )}
    </fieldset>
  );
}
