const dateFormatter = new Intl.DateTimeFormat("it-IT", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

export function formatDate(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return dateFormatter.format(typeof value === "string" ? new Date(value) : value);
}

// Slug ASCII per i filename dei download: gli header Content-Disposition
// non gradiscono i caratteri non latini e le virgolette.
export function asciiSlug(value: string): string {
  return (
    value
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "campagna"
  );
}

export const docTypeLabels: Record<string, string> = {
  regolamento: "Regolamento",
  avventura: "Avventura",
  bestiario: "Bestiario",
  tabelle: "Tabelle",
  ambientazione: "Ambientazione",
  altro: "Altro",
};
