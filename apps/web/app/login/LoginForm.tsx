"use client";

import { useState } from "react";
import { ActionForm, SubmitButton } from "@/components/forms";
import { magicLink, signIn, signUp } from "./actions";

type Mode = "password" | "magic" | "signup";

export function LoginForm({ next }: { next?: string }) {
  const [mode, setMode] = useState<Mode>("password");
  const action = mode === "password" ? signIn : mode === "magic" ? magicLink : signUp;

  return (
    <div>
      <div className="mb-5 grid grid-cols-3 gap-1 rounded-md bg-panel-2 p-1 text-xs">
        {(
          [
            ["password", "Пароль"],
            ["magic", "По ссылке"],
            ["signup", "Регистрация"],
          ] as const
        ).map(([m, label]) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={`rounded px-2 py-1.5 font-medium transition ${mode === m ? "bg-panel text-ink shadow" : "text-ink-3 hover:text-ink"}`}
          >
            {label}
          </button>
        ))}
      </div>
      <ActionForm key={mode} action={action} className="space-y-4">
        <input type="hidden" name="next" value={next ?? ""} />
        <label className="block">
          <span className="label">Email</span>
          <input className="input" name="email" type="email" autoComplete="email" required />
        </label>
        {mode !== "magic" && (
          <label className="block">
            <span className="label">Пароль</span>
            <input
              className="input"
              name="password"
              type="password"
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              minLength={8}
              required
            />
          </label>
        )}
        <SubmitButton pendingText="Секунду…">
          {mode === "password" ? "Войти" : mode === "magic" ? "Прислать ссылку" : "Создать аккаунт"}
        </SubmitButton>
        {mode === "signup" && (
          <p className="text-xs text-ink-3">
            Новый аккаунт получает роль «наблюдатель». Права QA или администратора выдаёт администратор.
          </p>
        )}
      </ActionForm>
    </div>
  );
}
