/**
 * Asking before something irreversible.
 *
 * Replaces `window.confirm`, which the browser draws in its own chrome at the
 * top of the window: it says "localhost:5173 says", it cannot explain what is
 * about to happen beyond one line, and it looks like the scam dialogs people
 * are trained to dismiss. Somebody clicking through it has not read it.
 *
 * This one names the thing by title, says what will actually happen, and puts
 * the consequence in the button rather than on "OK" -- so the last thing read
 * before pressing is the action, not an acknowledgement.
 */
import { useEffect, useRef } from 'react';

export function ConfirmDialog({
  title, body, confirmLabel, danger = false, busy = false, onConfirm, onCancel,
}: {
  title: string;
  body?: string;
  /** Says what happens, not "OK". */
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  /* Focus starts on Cancel, not on the destructive button: a stray Enter
     keypress should do nothing rather than delete something. */
  useEffect(() => { cancelRef.current?.focus(); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" className="modal__scrim" aria-label="Cancel" onClick={onCancel} />
      <div className="modal__panel confirm">
        <div className="confirm__body">
          <h2 className="confirm__title">{title}</h2>
          {body ? <p className="confirm__text">{body}</p> : null}
        </div>
        <div className="confirm__actions">
          <button ref={cancelRef} type="button" className="btn btn--ghost"
                  disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button type="button"
                  className={`btn ${danger ? 'btn--danger' : 'btn--primary'}`}
                  disabled={busy} onClick={onConfirm}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}