import { ToastNotification } from "@carbon/react";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

interface Toast {
  id: number;
  title: string;
  subtitle?: string;
}

type ShowToast = (toast: Omit<Toast, "id">) => void;

const ToastContext = createContext<ShowToast>(() => {});

/** Success toasts in the top corner; each closes itself after a few seconds. */
export function ToastProvider({
  children,
  closeLabel,
}: {
  children: ReactNode;
  closeLabel: string;
}) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const show = useCallback<ShowToast>((toast) => {
    setToasts((current) => [...current, { ...toast, id: Date.now() + Math.random() }]);
  }, []);
  const close = (id: number) => setToasts((current) => current.filter((t) => t.id !== id));

  return (
    <ToastContext value={show}>
      {children}
      <div className="tp-toasts">
        {toasts.map((toast) => (
          <ToastNotification
            key={toast.id}
            kind="success"
            title={toast.title}
            subtitle={toast.subtitle}
            timeout={6000}
            aria-label={closeLabel}
            onClose={() => close(toast.id)}
          />
        ))}
      </div>
    </ToastContext>
  );
}

export function useToast(): ShowToast {
  return useContext(ToastContext);
}
