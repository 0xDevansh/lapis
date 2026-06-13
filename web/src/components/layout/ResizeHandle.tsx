import { useCallback, useEffect, useRef } from "react";

interface ResizeHandleProps {
  /** Which edge of the panel this handle sits on. Determines drag direction. */
  side: "left" | "right";
  /** Current width of the panel being resized. */
  width: number;
  /** Called with the next width as the user drags or presses arrow keys. */
  onResize: (width: number) => void;
  /** Called on double-click to reset to the default width. */
  onReset: () => void;
  min: number;
  max: number;
  ariaLabel: string;
}

const KEY_STEP = 16;

/**
 * A keyboard- and pointer-accessible separator for resizing a side panel.
 *
 * - `side: "left"` means the handle is on the panel's right edge (left sidebar),
 *   so dragging right grows the panel.
 * - `side: "right"` means the handle is on the panel's left edge (right panel),
 *   so dragging left grows the panel.
 */
export default function ResizeHandle({
  side,
  width,
  onResize,
  onReset,
  min,
  max,
  ariaLabel,
}: ResizeHandleProps) {
  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      if (!dragging.current) return;
      const delta = e.clientX - startX.current;
      const signed = side === "left" ? delta : -delta;
      onResize(startWidth.current + signed);
    },
    [side, onResize]
  );

  const onPointerUp = useCallback(() => {
    dragging.current = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
  }, [onPointerMove]);

  useEffect(() => {
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [onPointerMove, onPointerUp]);

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    dragging.current = true;
    startX.current = e.clientX;
    startWidth.current = width;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const grow = side === "left" ? "ArrowRight" : "ArrowLeft";
    const shrink = side === "left" ? "ArrowLeft" : "ArrowRight";
    if (e.key === grow) {
      e.preventDefault();
      onResize(width + KEY_STEP);
    } else if (e.key === shrink) {
      e.preventDefault();
      onResize(width - KEY_STEP);
    } else if (e.key === "Home") {
      e.preventDefault();
      onResize(min);
    } else if (e.key === "End") {
      e.preventDefault();
      onResize(max);
    }
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
      className="group relative z-10 w-1 shrink-0 cursor-col-resize outline-none"
    >
      {/* Wider invisible hit area */}
      <span className="absolute inset-y-0 -left-1 -right-1" />
      {/* Visible line, highlighted on hover/focus */}
      <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:bg-accent group-focus-visible:bg-accent" />
    </div>
  );
}
