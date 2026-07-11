// Pulizia del testo estratto pagina per pagina dai PDF, PRIMA del
// chunking. Rimuove artefatti di impaginazione che pdf.js incolla al
// contenuto reale e che altrimenti finirebbero in ogni chunk:
//
//  1. Watermark di acquisto (riga con un indirizzo email), tipico delle
//     copie vendute con marcatura anti-pirateria. Ripetuto identico su
//     quasi ogni pagina: puro rumore + spreco di token.
//  2. Running header/footer con il numero di pagina incollato senza
//     spazio (es. "capitolo 12170", "pelagia113"): pdf.js lo estrae come
//     prima riga della pagina, mescolandolo alla prima parola del
//     contenuto reale.
//
// Volutamente conservativa e riga per riga: nel dubbio NON rimuove, per
// non erodere contenuto di gioco reale.

// Una riga è watermark se contiene un indirizzo email: nei manuali di GdR
// il testo di gioco non contiene email, mentre le marcature di acquisto
// sì. Cattura anche watermark di venditori diversi. NB: niente flag `g`,
// per poter usare .test() su ogni riga senza stato condiviso.
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;

// Running header/footer isolato su una riga: solo lettere minuscole
// (anche accentate), spazi, apostrofi e cifre, che TERMINA con una cifra
// (il numero di pagina), max ~40 caratteri. La combinazione "nessuna
// maiuscola + nessuna punteggiatura di frase + termina con una cifra" è
// la firma che distingue un header impaginato da una riga di contenuto.
const RUNNING_HEADER_LINE = /^[\p{Ll}\p{M} \t''`.\-–—\d]{1,40}\d[ \t]*$/u;

export function cleanPageText(text: string): string {
  const kept: string[] = [];
  let firstRealLineSeen = false;

  for (const line of text.split("\n")) {
    // Watermark: rimosso ovunque compaia.
    if (EMAIL.test(line)) continue;

    // Running header: solo la PRIMA riga non vuota della pagina.
    if (!firstRealLineSeen && line.trim() !== "") {
      firstRealLineSeen = true;
      if (RUNNING_HEADER_LINE.test(line)) continue;
    }

    kept.push(line);
  }

  return kept.join("\n").trim();
}
