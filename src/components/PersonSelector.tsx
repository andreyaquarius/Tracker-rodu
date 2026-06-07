import { useMemo, useState } from "react";
import type { Person } from "../types";

export function PersonSelector({
  persons,
  selectedIds,
  researchId,
  createLabel = "Створити нову особу",
  onChange,
  onCreate,
}: {
  persons: Person[];
  selectedIds: string[];
  researchId?: string;
  createLabel?: string;
  onChange: (ids: string[]) => void;
  onCreate: () => void;
}) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const available = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("uk");
    return persons.filter((person) => {
      const matchesResearch = !researchId || !person.researchId || person.researchId === researchId;
      const text = [
        person.fullName,
        person.surname,
        person.givenName,
        person.patronymic,
        person.nameVariants,
        person.surnameVariants,
      ].join(" ").toLocaleLowerCase("uk");
      return matchesResearch && (!normalized || text.includes(normalized));
    });
  }, [persons, query, researchId]);
  const selectedPersons = selectedIds
    .map((id) => persons.find((person) => person.id === id))
    .filter((person): person is Person => Boolean(person));

  return (
    <fieldset className="relation-picker person-selector field-wide">
      <div className="person-selector-heading">
        <legend>Пов’язані особи</legend>
        <button
          type="button"
          className="button button-secondary relation-add-button"
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Закрити вибір" : "+ Додати пов’язану особу"}
        </button>
      </div>
      {selectedPersons.length ? (
        <div className="selected-relations">
          {selectedPersons.map((person) => (
            <div key={person.id}>
              <span>
                <strong>{person.fullName || [person.surname, person.givenName, person.patronymic].filter(Boolean).join(" ")}</strong>
                {person.birthPlace ? <small>{person.birthPlace}</small> : null}
              </span>
              <button
                type="button"
                aria-label="Прибрати особу"
                title="Прибрати особу"
                onClick={() => onChange(selectedIds.filter((id) => id !== person.id))}
              >×</button>
            </div>
          ))}
        </div>
      ) : (
        <p className="relation-empty-hint">Пов’язаних осіб не вибрано.</p>
      )}
      {expanded ? (
        <div className="relation-chooser">
          <div className="relation-chooser-tools">
            <input
              autoFocus
              value={query}
              placeholder="Пошук особи за ім’ям або варіантом написання…"
              onChange={(event) => setQuery(event.target.value)}
            />
            <button type="button" className="text-button" onClick={onCreate}>+ {createLabel}</button>
          </div>
          {available.length ? (
            <div className="relation-options">
              {available.map((person) => (
                <label key={person.id}>
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(person.id)}
                    onChange={(event) =>
                      onChange(
                        event.target.checked
                          ? [...selectedIds, person.id]
                          : selectedIds.filter((id) => id !== person.id),
                      )
                    }
                  />
                  <span>
                    {person.fullName || [person.surname, person.givenName, person.patronymic].filter(Boolean).join(" ")}
                    {person.birthPlace ? <small>{person.birthPlace}</small> : null}
                  </span>
                </label>
              ))}
            </div>
          ) : (
            <p>Осіб за цим запитом не знайдено. Можна створити нову особу або залишити текстове поле без прив’язки.</p>
          )}
        </div>
      ) : null}
    </fieldset>
  );
}
