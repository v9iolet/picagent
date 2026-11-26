import { useId, type ReactNode } from "react";
import { Icon } from "../../pages/shared";
import { Modal } from "./Modal";

interface ConfirmDialogProps {
  title: string;
  titleId?: string;
  eyebrow?: string;
  children: ReactNode;
  onClose: () => void;
  onConfirm: () => void;
  confirmLabel?: string;
  closeLabel?: string;
  danger?: boolean;
  loading?: boolean;
}

export function ConfirmDialog({
  title, titleId, eyebrow, children, onClose, onConfirm, confirmLabel = "确认",
  closeLabel = "关闭确认弹窗", danger = false, loading = false,
}: ConfirmDialogProps) {
  const id = useId();
  return (
    <Modal size="sm" aria-labelledby={titleId ?? id} onClose={onClose} dismissDisabled={loading}
      backdropClassName="style-library-modal-backdrop" className="style-delete-confirm-modal">
      <header>
        <div>
          {eyebrow && <span className="style-library-modal-kicker">{eyebrow}</span>}
          <h2 id={titleId ?? id}>{title}</h2>
        </div>
        <button className="icon-btn" type="button" aria-label={closeLabel} disabled={loading} onClick={onClose}>
          <Icon name="x" />
        </button>
      </header>
      <p className="style-delete-confirm-desc">{children}</p>
      <div className="style-delete-confirm-actions">
        <button className="btn" type="button" disabled={loading} onClick={onClose}>取消</button>
        <button className={`btn ${danger ? "btn-danger" : "btn-primary"}`} type="button" disabled={loading} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
