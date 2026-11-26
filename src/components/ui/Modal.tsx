import { useLayoutEffect, useRef, type HTMLAttributes } from "react";
import { createPortal } from "react-dom";
import "./ui.css";

type DialogName = { "aria-label": string } | { "aria-labelledby": string };

export type ModalProps = DialogName & HTMLAttributes<HTMLElement> & {
  onClose: () => void;
  dismissDisabled?: boolean;
  closeOnBackdrop?: boolean;
  size?: "sm" | "md" | "lg" | "xl";
  backdropClassName?: string;
  as?: "section" | "aside";
};

export function Modal({
  onClose, dismissDisabled = false, closeOnBackdrop = true, size = "md",
  backdropClassName = "", className = "", as: Panel = "section",
  "aria-label": label, "aria-labelledby": labelledBy, children, ...panelProps
}: ModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closingRef = useRef(false);
  useLayoutEffect(() => {
    const dialog = dialogRef.current!;
    closingRef.current = false;
    dialog.showModal();
    return () => {
      closingRef.current = true;
      dialog.close();
    };
  }, []);

  return createPortal(
    <dialog
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      aria-labelledby={labelledBy}
      className={`pa-modal-backdrop ${backdropClassName}`.trim()}
      onKeyDown={(event) => {
        if (event.key === "Escape" && dismissDisabled && event.target instanceof Node && event.currentTarget.contains(event.target)) {
          event.preventDefault();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        if (!dismissDisabled && event.target === event.currentTarget) onClose();
      }}
      onClose={(event) => {
        const dialog = dialogRef.current;
        // Native close requests can be non-cancelable while React still renders the modal.
        if (!closingRef.current && event.target === event.currentTarget && dialog && !dialog.open) {
          dialog.showModal();
        }
      }}
      onMouseDown={(event) => {
        if (closeOnBackdrop && !dismissDisabled && event.target === event.currentTarget) onClose();
      }}
    >
      <Panel {...panelProps} className={`pa-modal pa-modal-${size} ${className}`.trim()}>
        {children}
      </Panel>
    </dialog>,
    document.body,
  );
}
