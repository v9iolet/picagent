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
  useLayoutEffect(() => {
    const dialog = dialogRef.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);

  return createPortal(
    <dialog
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      aria-labelledby={labelledBy}
      className={`pa-modal-backdrop ${backdropClassName}`.trim()}
      onCancel={(event) => {
        event.preventDefault();
        if (!dismissDisabled && event.target === event.currentTarget) onClose();
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
