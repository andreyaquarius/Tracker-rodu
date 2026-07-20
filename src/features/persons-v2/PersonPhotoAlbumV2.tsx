import {
  useEffect,
  useMemo,
  useState,
} from "react";
import type { Person, ScanAttachment } from "../../types";
import { getScanPreviewSource } from "../../services/scanStorage";
import { isPhotoReferenceAvailable } from "../../utils/personPhotos";

export interface PersonPhotoPreviewSourceState {
  url: string;
  loading: boolean;
  error: string;
}

export interface PersonPhotoAlbumV2Props {
  person: Person;
  onOpenPhoto?: (
    photo: ScanAttachment,
    availablePhotos: readonly ScanAttachment[],
  ) => void;
}

const emptyPreviewState: PersonPhotoPreviewSourceState = {
  url: "",
  loading: false,
  error: "",
};

/**
 * Resolves a person photo into a browser-safe image source and owns the
 * lifetime of any temporary blob URL returned by the storage layer.
 */
export function usePersonPhotoPreviewSource(
  photo: ScanAttachment | null | undefined,
): PersonPhotoPreviewSourceState {
  const [state, setState] = useState<PersonPhotoPreviewSourceState>(emptyPreviewState);
  const identity = personPhotoPreviewIdentity(photo);

  useEffect(() => {
    let active = true;
    let ownedUrl = "";

    if (!photo) {
      setState(emptyPreviewState);
      return () => {
        active = false;
      };
    }

    if (!isPhotoReferenceAvailable(photo)) {
      setState({
        url: "",
        loading: false,
        error: photo.statusMessage
          || "Фотографія недоступна. Додайте файл повторно в режимі редагування.",
      });
      return () => {
        active = false;
      };
    }

    setState({ url: "", loading: true, error: "" });
    void getScanPreviewSource(photo)
      .then((source) => {
        if (!active) {
          revokePreviewUrl(source.url, source.revokeOnClose);
          return;
        }
        if (source.kind !== "image") {
          revokePreviewUrl(source.url, source.revokeOnClose);
          setState({
            url: "",
            loading: false,
            error: "Цей файл не є підтримуваним зображенням.",
          });
          return;
        }
        if (source.revokeOnClose) ownedUrl = source.url;
        setState({ url: source.url, loading: false, error: "" });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setState({
          url: "",
          loading: false,
          error: error instanceof Error
            ? error.message
            : "Не вдалося завантажити фотографію.",
        });
      });

    return () => {
      active = false;
      revokePreviewUrl(ownedUrl, Boolean(ownedUrl));
    };
  }, [identity]);

  return state;
}

export function PersonPhotoAlbumV2({ person, onOpenPhoto }: PersonPhotoAlbumV2Props) {
  const photos = person.photos ?? [];
  const availablePhotos = useMemo(
    () => photos.filter(isPhotoReferenceAvailable),
    [photos],
  );

  if (!photos.length) {
    return (
      <div className="persons-v2-photo-album__empty" role="status">
        Фотографій цієї особи поки немає.
      </div>
    );
  }

  return (
    <section
      className="persons-v2-photo-album"
      aria-label={`Альбом особи: ${person.fullName || [person.surname, person.givenName, person.patronymic].filter(Boolean).join(" ")}`}
    >
      <div className="persons-v2-photo-album__grid" role="list">
        {photos.map((photo) => (
          <PersonPhotoThumbnailV2
            key={photo.id}
            photo={photo}
            primary={photo.id === person.primaryPhotoId}
            availablePhotos={availablePhotos}
            onOpenPhoto={onOpenPhoto}
          />
        ))}
      </div>
    </section>
  );
}

function PersonPhotoThumbnailV2({
  photo,
  primary,
  availablePhotos,
  onOpenPhoto,
}: {
  photo: ScanAttachment;
  primary: boolean;
  availablePhotos: readonly ScanAttachment[];
  onOpenPhoto: PersonPhotoAlbumV2Props["onOpenPhoto"];
}) {
  const preview = usePersonPhotoPreviewSource(photo);
  const missing = !isPhotoReferenceAvailable(photo);
  const [imageError, setImageError] = useState("");

  useEffect(() => {
    setImageError("");
  }, [photo.id, preview.url]);

  const error = imageError || preview.error;
  const openPhoto = () => {
    if (!missing) onOpenPhoto?.(photo, availablePhotos);
  };

  return (
    <article
      className={`persons-v2-photo-album__tile${primary ? " is-primary" : ""}${missing ? " is-missing" : ""}`}
      role="listitem"
    >
      {missing ? (
        <div className="persons-v2-photo-album__preview" aria-disabled="true">
          <PhotoStateV2 message={error || "Фотографія недоступна."} />
        </div>
      ) : (
        <button
          type="button"
          className="persons-v2-photo-album__preview"
          aria-label={`Переглянути фотографію ${photo.name}`}
          disabled={!onOpenPhoto}
          onClick={openPhoto}
        >
          {preview.loading ? <PhotoStateV2 message="Завантаження фотографії…" busy /> : null}
          {!preview.loading && error ? <PhotoStateV2 message={error} /> : null}
          {!preview.loading && !error && preview.url ? (
            <img
              className="persons-v2-photo-album__image"
              src={preview.url}
              alt={photo.name}
              loading="lazy"
              decoding="async"
              draggable={false}
              referrerPolicy="no-referrer"
              onError={() => setImageError("Не вдалося показати мініатюру фотографії.")}
            />
          ) : null}
        </button>
      )}
      <div className="persons-v2-photo-album__caption">
        <strong title={photo.name}>{photo.name}</strong>
        {primary ? <span className="persons-v2-photo-album__badge">Головне фото</span> : null}
      </div>
    </article>
  );
}

function PhotoStateV2({ message, busy = false }: { message: string; busy?: boolean }) {
  return (
    <span
      className="persons-v2-photo-album__state"
      role="status"
      aria-live="polite"
      aria-busy={busy || undefined}
    >
      {message}
    </span>
  );
}

function personPhotoPreviewIdentity(photo: ScanAttachment | null | undefined): string {
  if (!photo) return "";
  return [
    photo.id,
    photo.storage,
    photo.storagePath,
    photo.webViewLink ?? "",
    photo.mimeType,
    photo.size,
    photo.availability ?? "available",
    photo.statusMessage ?? "",
    photo.driveRevisionId ?? "",
    photo.driveMd5Checksum ?? "",
    photo.driveModifiedTime ?? "",
    photo.driveResourceKey ?? "",
  ].join("\u001f");
}

function revokePreviewUrl(url: string, revoke: boolean) {
  if (!url || !revoke || typeof URL === "undefined") return;
  URL.revokeObjectURL(url);
}
