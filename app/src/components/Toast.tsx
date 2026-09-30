import { useEffect } from "react";

export type ToastMessage = { tone: "neutral" | "error"; text: string };

/** One message at a time, announced politely, gone after a few seconds or on dismiss. */
export function Toast({ message, onDismiss }: { message: ToastMessage | null; onDismiss: () => void }) {
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(onDismiss, message.tone === "error" ? 8000 : 4000);
    return () => window.clearTimeout(timer);
  }, [message, onDismiss]);

  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex justify-center sm:inset-x-auto sm:right-6 sm:bottom-6">
      {message && (
        <div
          role={message.tone === "error" ? "alert" : "status"}
          className={`pointer-events-auto flex max-w-md items-start gap-4 border bg-surface px-4 py-3 text-sm shadow-[0_12px_32px_rgb(22_20_15/0.14)] ${
            message.tone === "error" ? "border-error" : "border-ink"
          }`}
        >
          <span className="leading-relaxed">{message.text}</span>
          <button onClick={onDismiss} className="-my-1 -mr-2 min-h-11 min-w-11 cursor-pointer text-mute hover:text-ink" aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
