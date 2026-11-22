"use client";

import { useState, useTransition } from "react";
import type { Role } from "@e2e/shared";
import { setRole } from "./actions";

const LABEL: Record<Role, string> = { viewer: "наблюдатель", qa: "QA-инженер", admin: "администратор" };

export function RoleSelect({ userId, role, roles, disabled }: { userId: string; role: Role; roles: Role[]; disabled?: boolean }) {
  const [value, setValue] = useState(role);
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  return (
    <span className="flex items-center gap-2">
      <select
        className="input h-8 w-auto py-0"
        value={value}
        disabled={disabled || pending}
        onChange={(e) => {
          const next = e.target.value as Role;
          const prev = value;
          setValue(next);
          start(async () => {
            try {
              setErr(null);
              await setRole(userId, next);
            } catch (er) {
              setValue(prev);
              setErr((er as Error).message);
            }
          });
        }}
      >
        {roles.map((r) => (
          <option key={r} value={r}>
            {LABEL[r]}
          </option>
        ))}
      </select>
      {err && <span className="text-xs text-bad">{err}</span>}
    </span>
  );
}
