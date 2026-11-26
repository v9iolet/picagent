import type { ReactNode } from "react";
import { Modal } from "../ui/Modal";

export function StudioDialog({
  title,
  close,
  children,
  wide = false,
  className = "",
}: {
  title: string;
  close: () => void;
  children: ReactNode;
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
      onClose={close}
    >
      <header>
        <h2>{title}</h2>
        <button onClick={close} aria-label="关闭">
          ×
        </button>
      </header>
      {children}
    </Modal>
  );
}
