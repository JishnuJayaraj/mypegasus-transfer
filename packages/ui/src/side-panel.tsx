import { Button, ComposedModal, ModalBody, ModalFooter, ModalHeader } from "@carbon/react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { UI_NAMESPACE } from "./i18n";

/** A navigation the app's router holds back while the panel has unsaved input. */
export interface PendingNavigation {
  proceed: () => void;
  reset: () => void;
}

interface SidePanelProps {
  open: boolean;
  title: string;
  /** A line above the title (e.g. what the panel belongs to). */
  label?: string;
  /** Whether the input differs from what was saved; then closing asks first (C4). */
  dirty?: boolean;
  /** Closes the panel: called directly when nothing is unsaved, else after "Verwerfen". */
  onClose: () => void;
  /** A navigation blocked by the router while dirty: asks the same question. */
  pendingNavigation?: PendingNavigation;
  /** Where the focus returns on close; by default what had it when the panel opened. */
  returnFocusTo?: HTMLElement | null;
  /** Buttons at the bottom (e.g. "Abbrechen" and "Speichern" of a form in the panel). */
  footer?: ReactNode;
  children: ReactNode;
}

/**
 * A panel at the inline end for one task (a form, a filter, a bulk action), full width below
 * 42rem (ui-patterns.md, side panel). It is a Carbon modal dialog: the page behind is inert, the
 * focus stays inside and returns to the launcher. Closing with unsaved input (×, Escape, a click
 * outside, a blocked navigation, a reload) asks "Änderungen verwerfen?" with the focus on
 * "Weiter bearbeiten"; Escape there keeps the input. Drafts live in component state only.
 */
export function SidePanel({
  open,
  title,
  label,
  dirty = false,
  onClose,
  pendingNavigation,
  returnFocusTo,
  footer,
  children,
}: SidePanelProps) {
  const { t } = useTranslation(UI_NAMESPACE);
  const [askingClose, setAskingClose] = useState(false);
  const confirming = (askingClose || pendingNavigation !== undefined) && dirty;
  const keep = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  // Carbon's Escape listener keeps the first render's `onClose`; the current state is read here.
  const state = useRef({ confirming, dirty });
  // A layout effect, so the state is current within the same input event.
  useLayoutEffect(() => {
    state.current = { confirming, dirty };
  });
  const textId = useId();

  useEffect(() => {
    if (confirming) keep.current?.focus();
  }, [confirming]);

  // The focus returns to what opened the panel (WCAG 2.4.3).
  const opener = useRef<Element | null>(null);
  const returnTo = useRef(returnFocusTo);
  useLayoutEffect(() => {
    returnTo.current = returnFocusTo;
  });
  useLayoutEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;
    return () => {
      const target = returnTo.current ?? opener.current;
      if (target instanceof HTMLElement && target.isConnected) target.focus();
    };
  }, [open]);

  // A reload or closing the tab asks too (the browser's own dialog).
  useEffect(() => {
    if (!open || !dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [open, dirty]);

  const keepEditing = () => {
    setAskingClose(false);
    pendingNavigation?.reset();
  };
  const discard = () => {
    setAskingClose(false);
    if (pendingNavigation) pendingNavigation.proceed();
    else onClose();
  };

  if (!open) return null;
  return (
    <ComposedModal
      open
      className="tp-side-panel"
      aria-label={title}
      // The focus starts in the first field, not on × (whose tooltip would take the first Escape).
      selectorPrimaryFocus="input:not([type=hidden]), select, textarea, [data-modal-primary-focus]"
      onClose={() => {
        // Escape while asking is "Weiter bearbeiten": the input stays.
        if (state.current.confirming) {
          keepEditing();
          return false;
        }
        if (state.current.dirty) {
          setAskingClose(true);
          return false;
        }
        onClose();
        return false;
      }}
    >
      <ModalHeader title={title} label={label} iconDescription={t("sidePanel.close")} />
      <ModalBody hasScrollingContent>
        <div inert={confirming || undefined}>{children}</div>
      </ModalBody>
      {confirming ? (
        <div
          className="tp-side-panel-confirm"
          role="alertdialog"
          aria-labelledby={titleId}
          aria-describedby={textId}
        >
          <p id={titleId} className="tp-side-panel-confirm-title">
            {t("sidePanel.discardTitle")}
          </p>
          <p id={textId}>{t("sidePanel.discardText")}</p>
          <div className="tp-side-panel-confirm-actions">
            <Button kind="danger--tertiary" onClick={discard}>
              {t("sidePanel.discard")}
            </Button>
            <Button ref={keep} kind="primary" onClick={keepEditing}>
              {t("sidePanel.keep")}
            </Button>
          </div>
        </div>
      ) : (
        footer && <ModalFooter>{footer}</ModalFooter>
      )}
    </ComposedModal>
  );
}
