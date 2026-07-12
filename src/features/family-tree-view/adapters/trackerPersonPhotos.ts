import type { Person } from "../../../types/index.ts";
import {
  isPhotoReferenceAvailable,
  primaryPersonPhoto,
} from "../../../utils/personPhotos.ts";
import type { FamilyGraphData } from "../types.ts";

type TrackerPersonPhotoRecord = Pick<Person, "id" | "photos" | "primaryPhotoId">;

/**
 * RPC graph payloads intentionally stay small. Attach only the primary photo
 * metadata already loaded for the project; image bytes remain in Drive and
 * are fetched lazily by mounted cards.
 */
export function attachTrackerPersonPhotos(
  graph: FamilyGraphData,
  people: readonly TrackerPersonPhotoRecord[],
): FamilyGraphData {
  const photoByPersonId = new Map(
    people.flatMap((person) => {
      const photo = primaryPersonPhoto(person.photos, person.primaryPhotoId);
      return photo && isPhotoReferenceAvailable(photo)
        ? [[person.id, photo] as const]
        : [];
    }),
  );
  if (!photoByPersonId.size) return graph;

  let changed = false;
  const persons = graph.persons.map((person) => {
    // Do not reintroduce private data that the server deliberately masked.
    if (person.badges?.privacy === "masked") return person;
    const photo = photoByPersonId.get(person.id);
    if (!photo || person.photo === photo) return person;
    changed = true;
    return { ...person, photo };
  });
  return changed ? { ...graph, persons } : graph;
}
