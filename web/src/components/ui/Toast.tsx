import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
} from "react";
import { CheckCircle, Info, WarningCircle, X } from "@phosphor-icons/react";

export type ToastTone = "info" | "success" | "error";

export interface ToastOptions {
  tone?: ToastTone;
  /** Auto-dismiss delay in ms. Defaults to 4000 (6000 for errors). */
  duration?: number;
}

interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}

interface ToastContextValue {
  toast: (message: string, opts?: ToastOptions) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider");
  return ctx;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const remove = useCallback((id: number) => {
    setItems((xs) => xs.filter((x) => x.id !== id));
  }, []);

  const toast = useCallback(
    (message: string, opts?: ToastOptions) => {
      const id = ++idRef.current;
      const tone = opts?.tone ?? "info";
      setItems((xs) => [...xs, { id, message, tone }]);
      const duration = opts?.duration ?? (tone === "error" ? 6000 : 4000);
      window.setTimeout(() => remove(id), duration);
    },
    [remove]
  );

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div
        className="pointer-events-none fixed bottom-9 right-4 z-[100] flex w-80 flex-col gap-2"
        role="status"
        aria-live="polite"
      >
        {items.map((t) => (
          <ToastCard key={t.id} item={t} onDismiss={() => remove(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastCard({
  item,
  onDismiss,
}: {
  item: ToastItem;
  onDismiss: () => void;
}) {
  const Icon =
    item.tone === "success"
      ? CheckCircle
      : item.tone === "error"
        ? WarningCircle
        : Info;
  const iconColor =
    item.tone === "success"
      ? "text-success"
      : item.tone === "error"
        ? "text-danger"
        : "text-accent-soft";
  return (
    <div className="pointer-events-auto flex items-start gap-2.5 rounded-lg border border-border bg-elevated px-3 py-2.5 shadow-2xl animate-[fadeIn_0.12s_ease-out]">
      <Icon size={18} weight="fill" className={`mt-0.5 shrink-0 ${iconColor}`} />
      <p className="flex-1 text-[13px] leading-snug text-ink">{item.message}</p>
      <button
        onClick={onDismiss}
        aria-label="Dismiss"
        className="shrink-0 rounded p-0.5 text-faint transition-colors hover:bg-hover hover:text-ink"
      >
        <X size={14} />
      </button>
    </div>
  );
}
