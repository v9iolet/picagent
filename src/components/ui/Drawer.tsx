import { useId, type ReactNode } from "react";
import { Icon } from "../../pages/shared";
import { Modal } from "./Modal";

interface DrawerProps {
  title: string;
  titleId?: string;
  eyebrow?: string;
  closeLabel?: string;
  onClose: () => void;
  dismissDisabled?: boolean;
  closeOnBackdrop?: boolean;
  className?: string;
  backdropClassName?: string;
  children: ReactNode;
}

export function Drawer({
  title, titleId, eyebrow, closeLabel = "关闭", onClose, dismissDisabled, closeOnBackdrop,
  className = "", backdropClassName = "", children,
}: DrawerProps) {
  const id = useId();
  return (
    <Modal
      as="aside"
      aria-labelledby={titleId ?? id}
      onClose={onClose}
      dismissDisabled={dismissDisabled}
      closeOnBackdrop={closeOnBackdrop}
      backdropClassName={`pa-drawer-backdrop ${backdropClassName}`}
      className={`pa-drawer ${className}`}
    >
      <header>
        <div>
          {eyebrow && <span>{eyebrow}</span>}
          <h2 id={titleId ?? id}>{title}</h2>
        </div>
        <button type="button" aria-label={closeLabel} disabled={dismissDisabled} onClick={onClose}><Icon name="x" /></button>
      </header>
      {children}
    </Modal>
  );
}
