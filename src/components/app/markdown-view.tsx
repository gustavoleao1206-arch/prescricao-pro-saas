import React from "react";

/**
 * Renderizador de Markdown mínimo (server component), suficiente para os
 * relatórios/peças gerados internamente: títulos, negrito, listas, tabelas,
 * citações e parágrafos. Evita dependência externa e não executa HTML do modelo.
 */
export function MarkdownView({ markdown }: { markdown: string }) {
  const lines = markdown.split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  const inline = (text: string): React.ReactNode => {
    const parts = text.split(/(\*\*[^*]+\*\*)/g);
    return parts.map((p, idx) =>
      p.startsWith("**") && p.endsWith("**") ? <strong key={idx}>{p.slice(2, -2)}</strong> : <React.Fragment key={idx}>{p}</React.Fragment>,
    );
  };

  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) { i++; continue; }

    if (line.startsWith("### ")) { blocks.push(<h3 key={key++} className="mt-5 text-base font-semibold text-marinho-700">{inline(line.slice(4))}</h3>); i++; continue; }
    if (line.startsWith("## ")) { blocks.push(<h2 key={key++} className="mt-6 text-lg font-bold text-marinho-700">{inline(line.slice(3))}</h2>); i++; continue; }
    if (line.startsWith("# ")) { blocks.push(<h1 key={key++} className="text-xl font-bold text-marinho-700">{inline(line.slice(2))}</h1>); i++; continue; }
    if (line.startsWith("> ")) { blocks.push(<blockquote key={key++} className="my-3 border-l-4 border-marca-300 bg-marca-50 px-4 py-2 text-sm text-neutro-600 dark:bg-marca-500/10">{inline(line.slice(2))}</blockquote>); i++; continue; }
    if (line.startsWith("---")) { blocks.push(<hr key={key++} className="my-4 border-neutro-200" />); i++; continue; }

    // Tabela (linha começando com | seguida da linha separadora)
    if (line.startsWith("|") && lines[i + 1]?.includes("---")) {
      const header = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.startsWith("|")) { rows.push(splitRow(lines[i]!)); i++; }
      blocks.push(
        <div key={key++} className="my-3 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead><tr>{header.map((h, hi) => <th key={hi} className="border border-neutro-200 bg-neutro-50 px-3 py-2 text-left font-semibold">{h}</th>)}</tr></thead>
            <tbody>{rows.map((r, ri) => <tr key={ri}>{r.map((c, ci) => <td key={ci} className="border border-neutro-200 px-3 py-2">{inline(c)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Lista
    if (line.startsWith("- ") || /^\s+- /.test(line)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && (lines[i]!.startsWith("- ") || /^\s+- /.test(lines[i]!))) {
        items.push(<li key={items.length}>{inline(lines[i]!.replace(/^\s*- /, ""))}</li>);
        i++;
      }
      blocks.push(<ul key={key++} className="my-2 list-disc space-y-1 pl-6 text-sm text-neutro-700">{items}</ul>);
      continue;
    }

    blocks.push(<p key={key++} className="my-2 text-sm leading-relaxed text-neutro-700">{inline(line)}</p>);
    i++;
  }

  return <div>{blocks}</div>;
}

function splitRow(line: string): string[] {
  return line.split("|").slice(1, -1).map((c) => c.trim());
}
