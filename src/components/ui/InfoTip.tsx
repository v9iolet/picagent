import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../pages/shared";
import "./InfoTip.css";

export interface InfoTipProps {
  /** Optional short bold heading displayed at the top of the popover */
  title?: string;
  /** Popover body copy or content */
  content: ReactNode;
  /** Accessible aria-label on the trigger button */
  label?: string;
  /** Preferred vertical placement (auto-flips when near viewport edge) */
  placement?: "bottom" | "top";
  /** Preferred horizontal alignment relative to the trigger */
  align?: "center" | "start" | "end";
  /** Additional className on the anchor wrapper */
  className?: string;
  /** Optional explicit popover id (used for aria-controls / aria-describedby) */
  id?: string;
}

const HOVER_OPEN_DELAY_MS = 150;
const HOVER_CLOSE_DELAY_MS = 120;
const VIEWPORT_MARGIN = 12;
const POPOVER_GAP = 8;

interface PopoverCoords {
  top: number;
  left: number;
  placement: "bottom" | "top";
  arrowLeft: number;
}

type PopoverElement = HTMLDivElement & {
  showPopover?: () => void;
  hidePopover?: () => void;
};

export function InfoTip({
  title,
  content,
  label,
  placement = "bottom",
  align = "center",
  className = "",
  id,
}: InfoTipProps) {
  const generatedId = useId();
  const popoverId = id ?? generatedId;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<PopoverElement>(null);
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const suppressHoverRef = useRef(false);

  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [coords, setCoords] = useState<PopoverCoords | null>(null);

  const clearTimers = useCallback(() => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const closeImmediately = useCallback(() => {
    clearTimers();
    setOpen(false);
    setPinned(false);
  }, [clearTimers]);

  useEffect(() => () => clearTimers(), [clearTimers]);

  const computePosition = useCallback(() => {
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (!trigger || !popover) return;

    const triggerRect = trigger.getBoundingClientRect();
    const popWidth = popover.offsetWidth || 292;
    const popHeight = popover.offsetHeight || 80;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const triggerCenterX = triggerRect.left + triggerRect.width / 2;
    let left: number;
    if (align === "start") {
      left = triggerRect.left - 6;
    } else if (align === "end") {
      left = triggerRect.right + 6 - popWidth;
    } else {
      left = triggerCenterX - popWidth / 2;
    }
    left = Math.max(VIEWPORT_MARGIN, Math.min(left, vw - popWidth - VIEWPORT_MARGIN));

    const spaceBelow = vh - triggerRect.bottom - VIEWPORT_MARGIN;
    const spaceAbove = triggerRect.top - VIEWPORT_MARGIN;
    let resolvedPlacement: "bottom" | "top" = placement;
    if (placement === "bottom" && spaceBelow < popHeight + POPOVER_GAP && spaceAbove > spaceBelow) {
      resolvedPlacement = "top";
    } else if (placement === "top" && spaceAbove < popHeight + POPOVER_GAP && spaceBelow > spaceAbove) {
      resolvedPlacement = "bottom";
    }

    const rawTop =
      resolvedPlacement === "bottom"
        ? triggerRect.bottom + POPOVER_GAP
        : triggerRect.top - popHeight - POPOVER_GAP;
    const top = Math.max(VIEWPORT_MARGIN, Math.min(rawTop, vh - popHeight - VIEWPORT_MARGIN));
    const arrowLeft = Math.max(14, Math.min(triggerCenterX - left, popWidth - 14));

    setCoords({ top, left, placement: resolvedPlacement, arrowLeft });
  }, [align, placement]);

  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    const popover = popoverRef.current;
    let usedTopLayer = false;
    if (popover && typeof popover.showPopover === "function") {
      popover.setAttribute("popover", "manual");
      try {
        popover.showPopover();
        usedTopLayer = true;
      } catch {
        popover.removeAttribute("popover");
      }
    }
    computePosition();
    const onReposition = () => computePosition();
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
      if (usedTopLayer && popover && typeof popover.hidePopover === "function") {
        try {
          popover.hidePopover();
        } catch {
          // Ignore if already hidden or detached
        }
      }
    };
  }, [open, computePosition]);

  useEffect(() => {
    if (!open) return;
    const dialogEl = triggerRef.current?.closest("dialog[open]") ?? null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        closeImmediately();
        triggerRef.current?.focus({ preventScroll: true });
      }
    };
    const onDialogCancel = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      closeImmediately();
      triggerRef.current?.focus({ preventScroll: true });
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) {
        return;
      }
      closeImmediately();
    };
    window.addEventListener("keydown", onKeyDown, true);
    dialogEl?.addEventListener("cancel", onDialogCancel, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      dialogEl?.removeEventListener("cancel", onDialogCancel, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open, closeImmediately]);

  const handleTriggerMouseEnter = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (open || suppressHoverRef.current) return;
    openTimerRef.current = window.setTimeout(() => {
      openTimerRef.current = null;
      setOpen(true);
    }, HOVER_OPEN_DELAY_MS);
  };

  const handleTriggerMouseLeave = () => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    suppressHoverRef.current = false;
    if (pinned) return;
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      if (popoverRef.current?.contains(document.activeElement)) return;
      setOpen(false);
    }, HOVER_CLOSE_DELAY_MS);
  };

  const handlePopoverMouseEnter = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const handlePopoverMouseLeave = () => {
    if (pinned) return;
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      if (popoverRef.current?.contains(document.activeElement)) return;
      setOpen(false);
    }, HOVER_CLOSE_DELAY_MS);
  };

  const handleTriggerClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    clearTimers();
    if (open) {
      suppressHoverRef.current = true;
      setOpen(false);
      setPinned(false);
    } else {
      suppressHoverRef.current = false;
      setOpen(true);
      setPinned(true);
    }
  };

  const handleTriggerBlur = (event: FocusEvent<HTMLButtonElement>) => {
    const nextTarget = event.relatedTarget as Node | null;
    if (nextTarget && popoverRef.current?.contains(nextTarget)) return;
    if (open) closeImmediately();
  };

  const handlePopoverBlur = (event: FocusEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget as Node | null;
    if (
      nextTarget &&
      (triggerRef.current?.contains(nextTarget) || popoverRef.current?.contains(nextTarget))
    ) {
      return;
    }
    if (open) closeImmediately();
  };

  const handlePopoverMouseDown = () => {
    setPinned(true);
  };

  const ariaLabel = label ?? (title ? `${title}说明` : "查看说明");
  const portalTarget =
    typeof document !== "undefined"
      ? triggerRef.current?.closest("dialog[open]") ?? document.body
      : null;

  return (
    <span className={`pa-info-anchor ${className}`.trim()}>
      <button
        ref={triggerRef}
        type="button"
        className={`pa-info-trigger${open ? " is-open" : ""}`}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        aria-describedby={open ? popoverId : undefined}
        onMouseEnter={handleTriggerMouseEnter}
        onMouseLeave={handleTriggerMouseLeave}
        onClick={handleTriggerClick}
        onBlur={handleTriggerBlur}
      >
        <Icon name="info" />
      </button>
      {open &&
        portalTarget &&
        createPortal(
          <div
            ref={popoverRef}
            id={popoverId}
            role="tooltip"
            tabIndex={-1}
            className="pa-info-popover"
            data-placement={coords?.placement ?? placement}
            style={
              coords
                ? ({
                    top: `${coords.top}px`,
                    left: `${coords.left}px`,
                    "--pa-info-arrow-left": `${coords.arrowLeft}px`,
                  } as CSSProperties)
                : { top: "-9999px", left: "-9999px", visibility: "hidden" }
            }
            onMouseEnter={handlePopoverMouseEnter}
            onMouseLeave={handlePopoverMouseLeave}
            onMouseDown={handlePopoverMouseDown}
            onBlur={handlePopoverBlur}
          >
            {title && (
              <div className="pa-info-popover-title">
                <Icon name="info" />
                <span>{title}</span>
              </div>
            )}
            <div className="pa-info-popover-body">{content}</div>
          </div>,
          portalTarget,
        )}
    </span>
  );
}
