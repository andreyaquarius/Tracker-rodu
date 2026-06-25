import { useEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";

interface ModalProps {
  title: string;
  children: ReactNode;
  onClose: () => void;
}

type ModalPosition = { left: number; top: number };

const DESKTOP_MODAL_BREAKPOINT = 850;
const DESKTOP_SIDEBAR_WIDTH = 340;
const MODAL_MARGIN = 18;

export function Modal({ title, children, onClose }: ModalProps) {
  const modalRef = useRef<HTMLElement | null>(null);
  const [position, setPosition] = useState<ModalPosition | null>(null);

  useEffect(() => {
    const modal = modalRef.current;
    if (!modal || !isDraggableModalViewport()) {
      setPosition(null);
      return undefined;
    }

    const rect = modal.getBoundingClientRect();
    const initialPosition = centerModalInWorkspace(rect.width, rect.height);
    setPosition(initialPosition);

    const handleResize = () => {
      if (!isDraggableModalViewport()) {
        setPosition(null);
        return;
      }
      const nextRect = modal.getBoundingClientRect();
      setPosition((current) => clampModalPosition(current ?? initialPosition, nextRect.width, nextRect.height));
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [title]);

  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!isDraggableModalViewport() || event.button !== 0) return;
    if ((event.target as HTMLElement).closest("button, a, input, select, textarea")) return;

    const modal = modalRef.current;
    if (!modal) return;

    const rect = modal.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;

    event.currentTarget.setPointerCapture(event.pointerId);
    setPosition({ left: rect.left, top: rect.top });

    const move = (moveEvent: globalThis.PointerEvent) => {
      setPosition(clampModalPosition(
        {
          left: moveEvent.clientX - offsetX,
          top: moveEvent.clientY - offsetY,
        },
        rect.width,
        rect.height,
      ));
    };

    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  const modalStyle: CSSProperties | undefined = position
    ? { left: position.left, top: position.top }
    : undefined;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={modalRef}
        className={`modal ${position ? "modal-draggable" : ""}`}
        style={modalStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header" onPointerDown={startDrag}>
          <h2 id="modal-title">{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="Закрити">
            ×
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

function isDraggableModalViewport(): boolean {
  return window.innerWidth > DESKTOP_MODAL_BREAKPOINT;
}

function centerModalInWorkspace(width: number, height: number): ModalPosition {
  const minLeft = DESKTOP_SIDEBAR_WIDTH + MODAL_MARGIN;
  const maxLeft = Math.max(minLeft, window.innerWidth - width - MODAL_MARGIN);
  const left = minLeft + Math.max(0, maxLeft - minLeft) / 2;
  const top = Math.max(MODAL_MARGIN, (window.innerHeight - height) / 2);
  return clampModalPosition({ left, top }, width, height);
}

function clampModalPosition(position: ModalPosition, width: number, height: number): ModalPosition {
  const minLeft = DESKTOP_SIDEBAR_WIDTH + MODAL_MARGIN;
  const maxLeft = Math.max(minLeft, window.innerWidth - width - MODAL_MARGIN);
  const minTop = MODAL_MARGIN;
  const maxTop = Math.max(minTop, window.innerHeight - height - MODAL_MARGIN);

  return {
    left: Math.min(Math.max(minLeft, position.left), maxLeft),
    top: Math.min(Math.max(minTop, position.top), maxTop),
  };
}
