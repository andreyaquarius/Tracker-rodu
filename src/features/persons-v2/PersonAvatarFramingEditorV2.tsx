import {
  useEffect,
  useId,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { PersonAvatarCrop, ScanAttachment } from "../../types";
import {
  normalizePersonAvatarCrop,
  personAvatarImageStyle,
} from "../../utils/personPhotos";
import { usePersonPhotoPreviewSource } from "./PersonPhotoAlbumV2";

export interface PersonAvatarFramingEditorV2Props {
  photo?: ScanAttachment;
  value: PersonAvatarCrop;
  onChange: (value: PersonAvatarCrop) => void;
}

/**
 * Adjusts only the presentation metadata of a person's primary photo. The
 * source image is never cropped or re-uploaded: the same focal point and zoom
 * can therefore be reused by every avatar size in the application.
 */
export function PersonAvatarFramingEditorV2({
  photo,
  value,
  onChange,
}: PersonAvatarFramingEditorV2Props) {
  const fieldId = useId().replace(/:/g, "");
  const activePointerRef = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const preview = usePersonPhotoPreviewSource(photo);
  const normalizedValue = normalizePersonAvatarCrop(value);
  const framedPhoto = photo
    ? { ...photo, avatarCrop: normalizedValue }
    : undefined;
  const previewAvailable = Boolean(preview.url && !imageFailed);
  const controlsDisabled = !photo || !previewAvailable;

  useEffect(() => {
    setImageFailed(false);
  }, [photo?.id, preview.url]);

  const updateValue = (patch: Partial<PersonAvatarCrop>) => {
    onChange(normalizePersonAvatarCrop({ ...normalizedValue, ...patch }));
  };

  const updateFocalPoint = (event: ReactPointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    updateValue({
      x: ((event.clientX - bounds.left) / bounds.width) * 100,
      y: ((event.clientY - bounds.top) / bounds.height) * 100,
    });
  };

  const startDragging = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!previewAvailable || event.button !== 0) return;
    event.preventDefault();
    activePointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    updateFocalPoint(event);
  };

  const continueDragging = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (activePointerRef.current !== event.pointerId) return;
    event.preventDefault();
    updateFocalPoint(event);
  };

  const finishDragging = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (activePointerRef.current !== event.pointerId) return;
    if (event.type !== "pointercancel") updateFocalPoint(event);
    activePointerRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const reset = () => onChange(normalizePersonAvatarCrop(undefined));

  return (
    <section className="person-avatar-framing-v2" aria-labelledby={`${fieldId}-title`}>
      <div className="person-avatar-framing-v2__heading">
        <div>
          <strong id={`${fieldId}-title`}>Кадрування аватара</strong>
          <p>Перетягніть точку фокусу до обличчя та за потреби збільште масштаб.</p>
        </div>
        <button type="button" className="button button-ghost" onClick={reset} disabled={!photo}>
          Скинути
        </button>
      </div>

      <div className="person-avatar-framing-v2__layout">
        <div
          className={`person-avatar-framing-v2__preview${dragging ? " is-dragging" : ""}`}
          onPointerDown={startDragging}
          onPointerMove={continueDragging}
          onPointerUp={finishDragging}
          onPointerCancel={finishDragging}
          onLostPointerCapture={() => {
            activePointerRef.current = null;
            setDragging(false);
          }}
          style={{
            aspectRatio: "1",
            overflow: "hidden",
            touchAction: "none",
          }}
          aria-label="Попередній перегляд аватара"
        >
          {previewAvailable ? (
            <img
              src={preview.url}
              alt={`Попередній перегляд: ${photo?.name ?? "фото особи"}`}
              draggable={false}
              onError={() => setImageFailed(true)}
              style={{
                display: "block",
                width: "100%",
                height: "100%",
                objectFit: "cover",
                ...personAvatarImageStyle(framedPhoto),
              }}
            />
          ) : (
            <div className="person-avatar-framing-v2__placeholder" role="status" aria-live="polite">
              {preview.loading
                ? "Завантажуємо фото…"
                : preview.error
                  ? preview.error
                  : imageFailed
                    ? "Не вдалося показати це фото. Перевірте доступ або виберіть інше головне фото."
                    : "Оберіть головне фото, щоб налаштувати аватар."}
            </div>
          )}
          {previewAvailable ? (
            <span
              className="person-avatar-framing-v2__focus-marker"
              style={{ left: `${normalizedValue.x}%`, top: `${normalizedValue.y}%` }}
              aria-hidden="true"
            />
          ) : null}
        </div>

        <div className="person-avatar-framing-v2__controls">
          <AvatarRangeField
            id={`${fieldId}-x`}
            label="Положення по горизонталі"
            min={0}
            max={100}
            step={1}
            value={normalizedValue.x}
            output={`${Math.round(normalizedValue.x)}%`}
            disabled={controlsDisabled}
            onChange={(x) => updateValue({ x })}
          />
          <AvatarRangeField
            id={`${fieldId}-y`}
            label="Положення по вертикалі"
            min={0}
            max={100}
            step={1}
            value={normalizedValue.y}
            output={`${Math.round(normalizedValue.y)}%`}
            disabled={controlsDisabled}
            onChange={(y) => updateValue({ y })}
          />
          <AvatarRangeField
            id={`${fieldId}-zoom`}
            label="Масштаб"
            min={1}
            max={3}
            step={0.05}
            value={normalizedValue.zoom}
            output={`${Math.round(normalizedValue.zoom * 100)}%`}
            disabled={controlsDisabled}
            onChange={(zoom) => updateValue({ zoom })}
          />
        </div>
      </div>
    </section>
  );
}

function AvatarRangeField({
  id,
  label,
  min,
  max,
  step,
  value,
  output,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  output: string;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  const outputId = `${id}-output`;
  return (
    <div className="person-avatar-framing-v2__range">
      <div>
        <label htmlFor={id}>{label}</label>
        <output id={outputId} htmlFor={id}>{output}</output>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-describedby={outputId}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}
