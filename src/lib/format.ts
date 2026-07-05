const dateFormatter = new Intl.DateTimeFormat("it-IT", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

export function formatDate(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return dateFormatter.format(typeof value === "string" ? new Date(value) : value);
}

export const docTypeLabels: Record<string, string> = {
  regolamento: "Regolamento",
  avventura: "Avventura",
  bestiario: "Bestiario",
  tabelle: "Tabelle",
  ambientazione: "Ambientazione",
  altro: "Altro",
};
