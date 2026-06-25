import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
} from "react";
import { useWorkspaceWindowFrame } from "./WorkspaceWindows";

interface ModalProps {
  title: string;
  children: ReactNode;
  onClose: () => void;
  mode?: "dialog" | "window";
  minimizable?: boolean;
  stackIndex?: number;
  dockIndex?: number;
  onFocus?: () => void;
}

type ModalPosition = { left: number; top: number };

const DESKTOP_MODAL_BREAKPOINT = 850;
const DESKTOP_SIDEBAR_WIDTH = 340;
const MODAL_MARGIN = 18;
const MODAL_CASCADE_STEP = 26;
const MODAL_BASE_Z_INDEX = 100;
const WINDOW_BASE_Z_INDEX = 300;
const MINIMIZED_BASE_Z_INDEX = 720;
const MINIMIZED_CARD_WIDTH = 290;
const MINIMIZED_CARD_GAP = 10;
const MINIMIZED_CARD_HEIGHT = 58;

export function Modal({
  title,
  children,
  onClose,
  mode = "dialog",
  minimizable = mode === "window",
  stackIndex = 0,
  dockIndex = 0,
  onFocus,
}: ModalProps) {
  const frame = useWorkspaceWindowFrame();
  const resolvedStackIndex = frame?.stackIndex ?? stackIndex;
  const resolvedDockIndex = frame?.dockIndex ?? dockIndex;
  const titleId = useId();
  const modalRef = useRef<HTMLElement | null>(null);
  const initialStackIndexRef = useRef(resolvedStackIndex);
  const [position, setPosition] = useState<ModalPosition | null>(null);
  const [localMinimized, setLocalMinimized] = useState(false);
  const minimized = frame?.minimized ?? localMinimized;

  const setMinimized = (nextMinimized: boolean) => {
    if (frame) {
      frame.setMinimized(nextMinimized);
      return;
    }
    setLocalMinimized(nextMinimized);
  };

  useEffect(() => {
    const modal = modalRef.current;
    if (!modal || !isDraggableModalViewport()) {
      setPosition(null);
      return undefined;
    }

    const rect = modal.getBoundingClientRect();
    const initialPosition = centerModalInWorkspace(
      rect.width,
      rect.height,
      initialStackIndexRef.current,
    );
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
  }, []);

  const focusWindow = () => {
    if (frame) {
      frame.onFocus();
      return;
    }
    onFocus?.();
  };

  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!isDraggableModalViewport() || event.button !== 0) return;
    if ((event.target as HTMLElement).closest("button, a, input, select, textarea")) return;

    focusWindow();
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

  if (minimized) {
    return (
      <div
        className="modal-minimized-card"
        style={{
          zIndex: MINIMIZED_BASE_Z_INDEX + resolvedStackIndex,
          ...minimizedDockPosition(resolvedDockIndex),
        }}
      >
        <button
          type="button"
          className="modal-minimized-title"
          onClick={() => {
            setMinimized(false);
            focusWindow();
          }}
          title="Розгорнути вікно"
        >
          {title}
        </button>
        <div className="modal-minimized-actions">
          <button
            type="button"
            className="icon-button"
            onClick={() => {
              setMinimized(false);
              focusWindow();
            }}
            aria-label="Розгорнути"
            title="Розгорнути"
          >
            □
          </button>
          <button className="icon-button" onClick={onClose} aria-label="Закрити" title="Закрити">
            ×
          </button>
        </div>
      </div>
    );
  }

  const zIndex = (mode === "window" ? WINDOW_BASE_Z_INDEX : MODAL_BASE_Z_INDEX) + resolvedStackIndex;
  const modalStyle: CSSProperties = position
    ? { left: position.left, top: position.top, zIndex: zIndex + 1 }
    : { zIndex: zIndex + 1 };

  return (
    <div
      className={`modal-backdrop ${mode === "window" ? "modal-backdrop-windowed" : ""}`}
      role="presentation"
      style={{ zIndex }}
      onMouseDown={mode === "dialog" ? onClose : undefined}
    >
      <section
        ref={modalRef}
        className={`modal ${position ? "modal-draggable" : ""}`}
        style={modalStyle}
        role="dialog"
        aria-modal={mode === "dialog" ? true : undefined}
        aria-labelledby={titleId}
        onMouseDown={(event) => {
          event.stopPropagation();
          focusWindow();
        }}
      >
        <div className="modal-header" onPointerDown={startDrag}>
          <h2 id={titleId}>{title}</h2>
          <div className="modal-window-controls">
            {minimizable ? (
              <button
                type="button"
                className="icon-button"
                onClick={() => setMinimized(true)}
                aria-label="Згорнути"
                title="Згорнути"
              >
                -
              </button>
            ) : null}
            <button className="icon-button" onClick={onClose} aria-label="Закрити" title="Закрити">
              ×
            </button>
          </div>
        </div>
        {children}
      </section>
    </div>
  );
}

function minimizedDockPosition(dockIndex: number): CSSProperties {
  if (typeof window === "undefined") {
    return { left: MODAL_MARGIN, bottom: MODAL_MARGIN, width: MINIMIZED_CARD_WIDTH };
  }

  const isDesktop = window.innerWidth > DESKTOP_MODAL_BREAKPOINT;
  const startLeft = isDesktop ? DESKTOP_SIDEBAR_WIDTH + MODAL_MARGIN : 8;
  const endMargin = isDesktop ? MODAL_MARGIN : 8;
  const availableWidth = Math.max(220, window.innerWidth - startLeft - endMargin);
  const cardWidth = Math.min(MINIMIZED_CARD_WIDTH, availableWidth);
  const cardsPerRow = Math.max(1, Math.floor((availableWidth + MINIMIZED_CARD_GAP) / (cardWidth + MINIMIZED_CARD_GAP)));
  const row = Math.floor(dockIndex / cardsPerRow);
  const column = dockIndex % cardsPerRow;

  return {
    left: startLeft + column * (cardWidth + MINIMIZED_CARD_GAP),
    right: "auto",
    bottom: MODAL_MARGIN + row * MINIMIZED_CARD_HEIGHT,
    width: cardWidth,
  };
}

function isDraggableModalViewport(): boolean {
  return window.innerWidth > DESKTOP_MODAL_BREAKPOINT;
}

function centerModalInWorkspace(width: number, height: number, stackIndex = 0): ModalPosition {
  const minLeft = DESKTOP_SIDEBAR_WIDTH + MODAL_MARGIN;
  const maxLeft = Math.max(minLeft, window.innerWidth - width - MODAL_MARGIN);
  const cascadeOffset = (stackIndex % 6) * MODAL_CASCADE_STEP;
  const left = minLeft + Math.max(0, maxLeft - minLeft) / 2 + cascadeOffset;
  const top = Math.max(MODAL_MARGIN, (window.innerHeight - height) / 2) + cascadeOffset;
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
