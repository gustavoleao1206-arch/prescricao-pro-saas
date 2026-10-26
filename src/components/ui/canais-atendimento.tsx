import { ATENDIMENTO, linkWhatsApp } from "@/lib/contato";

/**
 * Lista dos canais de atendimento por WhatsApp, com número e horário.
 * Usada no site público (/contato) e na área do cliente (/suporte).
 */
export function CanaisAtendimento({ className = "" }: { className?: string }) {
  return (
    <ul className={`space-y-3 ${className}`}>
      {ATENDIMENTO.map((canal) => (
        <li key={canal.whatsapp}>
          <a
            href={linkWhatsApp(canal)}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`${canal.rotulo} ${canal.numero}, ${canal.horario}`}
            className="flex items-start gap-3 rounded-xl border border-neutro-200 p-4 transition hover:border-marca-300 hover:bg-marca-50 dark:hover:bg-marca-500/10"
          >
            <span className="mt-0.5 text-marca-600 dark:text-marca-300" aria-hidden>
              <IconeWhatsApp />
            </span>
            <span className="min-w-0">
              <span className="block text-xs font-medium uppercase tracking-wide text-neutro-500">{canal.rotulo}</span>
              <span className="block font-semibold text-marinho-700">{canal.numero}</span>
              <span className="block text-sm text-neutro-500">{canal.horario}</span>
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

function IconeWhatsApp() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2Zm0 1.67c2.2 0 4.27.86 5.83 2.42a8.19 8.19 0 0 1 2.41 5.82c0 4.54-3.7 8.24-8.25 8.24a8.24 8.24 0 0 1-4.2-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.19 8.19 0 0 1-1.26-4.38c0-4.54 3.7-8.24 8.26-8.24Zm-2.4 4.1c-.16 0-.42.06-.64.3-.22.24-.85.83-.85 2.02s.87 2.34.99 2.5c.12.16 1.7 2.6 4.13 3.64.58.25 1.03.4 1.38.51.58.19 1.11.16 1.53.1.47-.07 1.44-.59 1.64-1.16.2-.57.2-1.05.14-1.16-.06-.1-.22-.16-.46-.28-.24-.12-1.44-.71-1.66-.79-.22-.08-.38-.12-.55.12-.16.24-.63.79-.77.95-.14.16-.28.18-.52.06-.24-.12-1.03-.38-1.96-1.21-.72-.65-1.21-1.44-1.35-1.68-.14-.24-.02-.37.1-.49.11-.11.24-.28.36-.42.12-.14.16-.24.24-.4.08-.16.04-.3-.02-.42-.06-.12-.55-1.32-.75-1.81-.2-.47-.4-.41-.55-.42h-.46Z" />
    </svg>
  );
}
