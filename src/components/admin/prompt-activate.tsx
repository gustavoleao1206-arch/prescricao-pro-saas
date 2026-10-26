"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function PromptActivate({ id, active }: { id: string; active: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  if (active) return <span className="badge bg-sucesso-100 text-sucesso">Ativa</span>;

  async function activate() {
    setBusy(true);
    await fetch(`/api/admin/prompts/${id}/ativar`, { method: "POST" });
    setBusy(false);
    router.refresh();
  }

  return (
    <button disabled={busy} onClick={activate} className="text-xs font-medium text-marinho-600 hover:underline">
      {busy ? "…" : "Ativar"}
    </button>
  );
}
