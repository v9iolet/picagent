import type { ReactNode } from "react";
import { Modal } from "../ui/Modal";

export function StudioDialog({
  title,
  close,
  children,
  dismissDisabled,
  wide = false,
  className = "",
}: {
  title: string;
  close: () => void;
  children: ReactNode;
  dismissDisabled?: boolean;
  wide?: boolean;
  className?: string;
}) {
  return (
    <Modal
      aria-label={title}
      size={wide ? "xl" : "md"}
      className={`ss-dialog${wide ? " wide" : ""} ${className}`.trim()}
      backdropClassName="ss-dialog-backdrop"
      closeOnBackdrop={false}
      dismissDisabled={dismissDisabled}
      onClose={close}
    >
      <header>
        <h2>{title}</h2>
        <button onClick={close} aria-label="关闭" disabled={dismissDisabled}>
          ×
        </button>
      </header>
      {children}
    </Modal>
  );
}
