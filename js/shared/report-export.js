// Export only on the owner's explicit click; no ledger or network writes.
export function reportCsv(headers, rows) {
  const cell = (value) => {
    if (value === null || value === undefined || typeof value === "number" && !Number.isFinite(value)) return '""';
    let text = String(value);
    if (typeof value !== "number" && /^[\s]*[=+\-@\t\r]/.test(text)) text = "'" + text;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return "\uFEFF" + [headers, ...rows].map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}

export function downloadReport(filename, headers, rows) {
  if (document.documentElement.dataset.privateBlocked === "true") return;
  const url = URL.createObjectURL(new Blob([reportCsv(headers, rows)], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url; link.download = filename;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
