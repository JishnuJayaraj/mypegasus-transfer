import { Button, InlineNotification } from "@transfer/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * A section's draft over the server's value and the revision it was read with (ADR-0010; no
 * silent loss). Clean, it follows every new server state. Dirty, it keeps the input; its token
 * moves on only while the server's value of this section is still the one the draft started from
 * (another section's save shares the revision); a draft equal to the new value is clean again; any
 * other changed value is a conflict, shown, which only
 * "Neu laden" resolves by taking the server's state. A save sends `token`, so a conflict's save is
 * refused (409), never silently applied.
 */
export function useDraft<T, R = number>(
  server: { revision: R; value: T },
  same: (a: T, b: T) => boolean,
) {
  const [base, setBase] = useState(server);
  const [draft, setDraft] = useState(server.value);
  const dirty = !same(draft, base.value);
  if (server.revision !== base.revision) {
    if (!dirty || same(draft, server.value)) {
      setBase(server);
      setDraft(server.value);
    } else if (same(server.value, base.value)) {
      setBase({ revision: server.revision, value: base.value });
    }
  }
  const conflict = dirty && server.revision !== base.revision && !same(server.value, base.value);
  /** Takes this server state as the draft's (after a save, or "Neu laden"). */
  const adopt = (next: { revision: R; value: T }) => {
    setBase(next);
    setDraft(next.value);
  };
  return { draft, setDraft, dirty, conflict, token: base.revision, adopt };
}

/**
 * A warning that the stored value changed elsewhere, with "Neu laden" (or the given action) beside
 * it (Carbon's inline notification takes no interactive children).
 */
export function ReloadNotice({
  title,
  onReload,
  action,
}: {
  title: string;
  onReload: () => void;
  action?: string;
}) {
  const { t } = useTranslation();
  return (
    <div>
      <InlineNotification kind="warning" title={title} hideCloseButton lowContrast />
      <Button kind="ghost" size="sm" onClick={onReload}>
        {action ?? t("draft.reload")}
      </Button>
    </div>
  );
}
