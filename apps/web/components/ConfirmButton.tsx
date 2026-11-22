"use client";

import { useTransition, type ReactNode } from "react";

/** Кнопка, вызывающая server action после подтверждения. */
export function ConfirmButton({
  action,
  confirm,
  children,
  className = "",
}: {
  action: () => Promise<unknown>;
  confirm?: string;
  children: ReactNode;
  className?: string;
}) {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      className={`${className} disabled:opacity-50`}
      onClick={() => {
        if (confirm && !window.confirm(confirm)) return;
        start(async () => {
          try {
            await action();
          } catch (e) {
            if ((e as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw e;
            alert((e as Error).message);
          }
        });
      }}
    >
      {pending ? "…" : children}
    </button>
  );
}
