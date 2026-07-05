const styles: Record<string, string> = {
  ready: "bg-green-950 text-green-400 border-green-900",
  processing: "bg-yellow-950 text-yellow-400 border-yellow-900",
  error: "bg-red-950 text-red-400 border-red-900",
  uploaded: "bg-zinc-900 text-zinc-400 border-zinc-700",
};

const labels: Record<string, string> = {
  ready: "Pronto",
  processing: "In elaborazione",
  error: "Errore",
  uploaded: "Caricato",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-block rounded-full border px-2 py-0.5 text-xs ${
        styles[status] ?? styles.uploaded
      }`}
    >
      {labels[status] ?? status}
    </span>
  );
}
