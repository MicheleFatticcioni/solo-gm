import PDFDocument from "pdfkit";

// Renderer markdown → PDF in stile modulo GdR: pagina pergamena, serif,
// titoli rosso scuro, box "da leggere ad alta voce" per i blockquote.
// Supporta il sottoinsieme di markdown richiesto al modello dal prompt
// di module/route.ts (titoli #/##/###, elenchi, blockquote, ---, enfasi
// inline); tutto il resto degrada a paragrafo semplice.

const COLORS = {
  background: "#f7f0dd",
  text: "#2b2118",
  heading: "#7a1f1f",
  subtle: "#6b5d4a",
  rule: "#a8977a",
  boxFill: "#efe4c6",
  boxBorder: "#7a1f1f",
};

const FONTS = {
  regular: "Times-Roman",
  bold: "Times-Bold",
  italic: "Times-Italic",
  boldItalic: "Times-BoldItalic",
};

const PAGE_MARGIN = 64;
const BODY_SIZE = 10.5;
const BODY_GAP = 3;

export type ModulePdfMeta = {
  title: string;
  // Titolo evocativo scelto dal modello, mostrato sotto al titolo.
  subtitle?: string | null;
  gameSystem: string;
  concludedAt: Date | null;
};

type InlineSegment = { text: string; bold: boolean; italic: boolean };

// **grassetto**, *corsivo* e ***entrambi***; i link [testo](url) e il
// `codice` degradano al solo testo. Il non-breaking hyphen (U+2011,
// caro ai modelli) non ha glifo nei font AFM di pdfkit e diventerebbe
// uno spazio: si normalizza a trattino semplice.
function parseInline(text: string): InlineSegment[] {
  const cleaned = text
    .replace(/‑/g, "-")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1");
  const segments: InlineSegment[] = [];
  const re = /(\*\*\*|\*\*|\*|___|__|_)(.+?)\1/g;
  let last = 0;
  for (const match of cleaned.matchAll(re)) {
    const index = match.index ?? 0;
    if (index > last) {
      segments.push({ text: cleaned.slice(last, index), bold: false, italic: false });
    }
    const marker = match[1];
    segments.push({
      text: match[2],
      bold: marker === "**" || marker === "***" || marker === "__" || marker === "___",
      italic: marker === "*" || marker === "***" || marker === "_" || marker === "___",
    });
    last = index + match[0].length;
  }
  if (last < cleaned.length) {
    segments.push({ text: cleaned.slice(last), bold: false, italic: false });
  }
  return segments.filter((s) => s.text.length > 0);
}

function inlineFont(segment: InlineSegment): string {
  if (segment.bold && segment.italic) return FONTS.boldItalic;
  if (segment.bold) return FONTS.bold;
  if (segment.italic) return FONTS.italic;
  return FONTS.regular;
}

function plainText(text: string): string {
  return parseInline(text)
    .map((s) => s.text)
    .join("");
}

// Blocchi strutturali del documento.
type Block =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "paragraph"; text: string }
  | { type: "quote"; lines: string[] }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "rule" };

function parseBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let i = 0;

  const flushParagraph = (buffer: string[]) => {
    const text = buffer.join(" ").trim();
    if (text) blocks.push({ type: "paragraph", text });
    buffer.length = 0;
  };

  const paragraph: string[] = [];
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph(paragraph);
      i++;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushParagraph(paragraph);
      const level = Math.min(heading[1].length, 3) as 1 | 2 | 3;
      blocks.push({ type: "heading", level, text: heading[2].trim() });
      i++;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushParagraph(paragraph);
      blocks.push({ type: "rule" });
      i++;
      continue;
    }

    if (trimmed.startsWith(">")) {
      flushParagraph(paragraph);
      const quote: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        quote.push(lines[i].trim().replace(/^>\s?/, ""));
        i++;
      }
      // Le righe vuote interne separano i paragrafi del box.
      const joined = quote
        .join("\n")
        .split(/\n\s*\n/)
        .map((p) => p.replace(/\n/g, " ").trim())
        .filter(Boolean);
      if (joined.length > 0) blocks.push({ type: "quote", lines: joined });
      continue;
    }

    const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    if (bullet || numbered) {
      flushParagraph(paragraph);
      const ordered = !!numbered;
      const items: string[] = [];
      while (i < lines.length) {
        const itemLine = lines[i].trim();
        const m = ordered
          ? /^\d+[.)]\s+(.*)$/.exec(itemLine)
          : /^[-*+]\s+(.*)$/.exec(itemLine);
        if (m) {
          items.push(m[1]);
          i++;
        } else if (itemLine && /^\s{2,}/.test(lines[i]) && items.length > 0) {
          // continuazione indentata dell'item precedente
          items[items.length - 1] += ` ${itemLine}`;
          i++;
        } else {
          break;
        }
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    // Righe di tabella markdown (scoraggiate dal prompt): degradano a
    // testo, celle separate da " — ".
    if (trimmed.startsWith("|")) {
      if (!/^\|[\s:|-]+\|$/.test(trimmed)) {
        paragraph.push(
          trimmed
            .split("|")
            .map((cell) => cell.trim())
            .filter(Boolean)
            .join(" — "),
        );
        flushParagraph(paragraph);
      }
      i++;
      continue;
    }

    paragraph.push(trimmed);
    i++;
  }
  flushParagraph(paragraph);
  return blocks;
}

const dateFormatter = new Intl.DateTimeFormat("it-IT", { dateStyle: "long" });

export function renderModulePdf(
  markdown: string,
  meta: ModulePdfMeta,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: {
        top: PAGE_MARGIN,
        bottom: PAGE_MARGIN,
        left: PAGE_MARGIN,
        right: PAGE_MARGIN,
      },
      bufferPages: true,
      info: { Title: meta.title, Subject: `Modulo d'avventura — ${meta.gameSystem}` },
    });

    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageWidth = doc.page.width;
    const pageHeight = doc.page.height;
    const contentWidth = pageWidth - PAGE_MARGIN * 2;

    // Sfondo pergamena su ogni pagina, dipinto alla creazione (prima che
    // il contenuto ci scriva sopra).
    const paintBackground = () => {
      doc.save();
      doc.rect(0, 0, pageWidth, pageHeight).fill(COLORS.background);
      doc.restore();
    };
    paintBackground();
    doc.on("pageAdded", paintBackground);

    // Filetto orizzontale con rombo centrale, da separatore di sezione.
    const ornament = (y: number) => {
      const cx = pageWidth / 2;
      doc.save();
      doc
        .moveTo(PAGE_MARGIN + 20, y)
        .lineTo(cx - 12, y)
        .moveTo(cx + 12, y)
        .lineTo(pageWidth - PAGE_MARGIN - 20, y)
        .lineWidth(0.8)
        .stroke(COLORS.rule);
      doc
        .moveTo(cx, y - 4)
        .lineTo(cx + 5, y)
        .lineTo(cx, y + 4)
        .lineTo(cx - 5, y)
        .closePath()
        .fill(COLORS.heading);
      doc.restore();
    };

    // ---- Frontespizio ----
    doc.save();
    doc
      .rect(28, 28, pageWidth - 56, pageHeight - 56)
      .lineWidth(2)
      .stroke(COLORS.heading);
    doc
      .rect(36, 36, pageWidth - 72, pageHeight - 72)
      .lineWidth(0.8)
      .stroke(COLORS.rule);
    doc.restore();

    doc.font(FONTS.italic).fontSize(13).fillColor(COLORS.subtle);
    doc.text(meta.gameSystem, PAGE_MARGIN, 170, {
      width: contentWidth,
      align: "center",
    });
    ornament(220);
    doc.font(FONTS.bold).fontSize(34).fillColor(COLORS.heading);
    doc.text(meta.title, PAGE_MARGIN, 250, {
      width: contentWidth,
      align: "center",
    });
    ornament(doc.y + 24);
    if (meta.subtitle) {
      doc.font(FONTS.italic).fontSize(16).fillColor(COLORS.heading);
      doc.text(`«${meta.subtitle}»`, PAGE_MARGIN, doc.y + 40, {
        width: contentWidth,
        align: "center",
      });
    }
    doc.font(FONTS.regular).fontSize(14).fillColor(COLORS.text);
    doc.text("Modulo d'avventura", PAGE_MARGIN, doc.y + (meta.subtitle ? 24 : 44), {
      width: contentWidth,
      align: "center",
    });
    doc.font(FONTS.italic).fontSize(10.5).fillColor(COLORS.subtle);
    doc.text(
      `Ricavato da una campagna giocata${
        meta.concludedAt
          ? ` e conclusa il ${dateFormatter.format(meta.concludedAt)}`
          : ""
      }.`,
      PAGE_MARGIN,
      pageHeight - 150,
      { width: contentWidth, align: "center" },
    );

    // ---- Corpo ----
    const ensureSpace = (needed: number) => {
      if (doc.y + needed > pageHeight - PAGE_MARGIN) doc.addPage();
    };

    const writeInline = (
      text: string,
      options: { x?: number; width?: number; font?: string; size?: number },
    ) => {
      const segments = parseInline(text);
      const size = options.size ?? BODY_SIZE;
      const width = options.width ?? contentWidth;
      const x = options.x ?? PAGE_MARGIN;
      if (segments.length === 0) return;
      segments.forEach((segment, index) => {
        doc
          .font(
            segment.bold || segment.italic
              ? inlineFont(segment)
              : (options.font ?? FONTS.regular),
          )
          .fontSize(size)
          .fillColor(COLORS.text);
        if (index === 0) {
          doc.text(segment.text, x, doc.y, {
            width,
            lineGap: BODY_GAP,
            continued: segments.length > 1,
          });
        } else {
          doc.text(segment.text, {
            width,
            lineGap: BODY_GAP,
            continued: index < segments.length - 1,
          });
        }
      });
    };

    const blocks = parseBlocks(markdown);
    let bodyStarted = false;

    for (const block of blocks) {
      switch (block.type) {
        case "heading": {
          // Il primo h1 è già sul frontespizio come titolo: gli h1
          // successivi aprono un capitolo su pagina nuova.
          if (block.level === 1) {
            doc.addPage();
            bodyStarted = true;
            doc.font(FONTS.bold).fontSize(22).fillColor(COLORS.heading);
            doc.text(plainText(block.text), PAGE_MARGIN, PAGE_MARGIN + 10, {
              width: contentWidth,
              align: "center",
            });
            ornament(doc.y + 12);
            doc.y += 30;
            doc.x = PAGE_MARGIN;
          } else if (block.level === 2) {
            if (!bodyStarted) {
              doc.addPage();
              bodyStarted = true;
            }
            ensureSpace(60);
            doc.moveDown(1);
            doc.font(FONTS.bold).fontSize(15).fillColor(COLORS.heading);
            doc.text(plainText(block.text), PAGE_MARGIN, doc.y, {
              width: contentWidth,
            });
            doc
              .moveTo(PAGE_MARGIN, doc.y + 2)
              .lineTo(PAGE_MARGIN + contentWidth, doc.y + 2)
              .lineWidth(0.8)
              .stroke(COLORS.rule);
            doc.y += 10;
          } else {
            if (!bodyStarted) {
              doc.addPage();
              bodyStarted = true;
            }
            ensureSpace(45);
            doc.moveDown(0.7);
            doc.font(FONTS.bold).fontSize(12).fillColor(COLORS.heading);
            doc.text(plainText(block.text), PAGE_MARGIN, doc.y, {
              width: contentWidth,
            });
            doc.moveDown(0.2);
          }
          break;
        }
        case "paragraph": {
          if (!bodyStarted) {
            doc.addPage();
            bodyStarted = true;
          }
          ensureSpace(30);
          writeInline(block.text, {});
          doc.moveDown(0.5);
          break;
        }
        case "list": {
          if (!bodyStarted) {
            doc.addPage();
            bodyStarted = true;
          }
          block.items.forEach((item, index) => {
            ensureSpace(24);
            const marker = block.ordered ? `${index + 1}.` : "•";
            doc.font(FONTS.bold).fontSize(BODY_SIZE).fillColor(COLORS.heading);
            // text() avanza comunque il cursore di una riga: si salva la
            // y del marker e la si ripristina, così il testo dell'item
            // parte alla stessa altezza.
            const markerY = doc.y;
            doc.text(marker, PAGE_MARGIN + 6, markerY, {
              width: 18,
              lineBreak: false,
            });
            doc.y = markerY;
            writeInline(item, {
              x: PAGE_MARGIN + 26,
              width: contentWidth - 26,
            });
            doc.moveDown(0.15);
          });
          doc.x = PAGE_MARGIN;
          doc.moveDown(0.4);
          break;
        }
        case "quote": {
          if (!bodyStarted) {
            doc.addPage();
            bodyStarted = true;
          }
          // Box "da leggere ad alta voce": corsivo su fondo più scuro
          // con bordo. Altezza misurata in anticipo per decidere se
          // serve una pagina nuova; se supera la pagina intera degrada
          // a corsivo semplice. La misura usa il bold-italic (il font
          // più largo): i segmenti in grassetto occuperebbero più righe
          // della stima in corsivo e il testo uscirebbe dal box — e un
          // salto pagina non previsto dentro al box produceva pagine
          // bianche e contenuto disegnato fuori pagina.
          const pad = 12;
          const innerWidth = contentWidth - pad * 2;
          doc.font(FONTS.boldItalic).fontSize(BODY_SIZE);
          const textHeight = block.lines
            .map(
              (line) =>
                doc.heightOfString(plainText(line), {
                  width: innerWidth,
                  lineGap: BODY_GAP,
                }) + 4,
            )
            .reduce((a, b) => a + b, 0);
          const boxHeight = textHeight + pad * 2 - 4;
          const fits = boxHeight < pageHeight - PAGE_MARGIN * 2;
          if (fits) {
            ensureSpace(boxHeight + 12);
            const top = doc.y;
            const pagesBefore = doc.bufferedPageRange().count;
            doc.save();
            doc
              .rect(PAGE_MARGIN, top, contentWidth, boxHeight)
              .fillAndStroke(COLORS.boxFill, COLORS.boxBorder);
            doc
              .rect(PAGE_MARGIN, top, 3, boxHeight)
              .fill(COLORS.boxBorder);
            doc.restore();
            doc.y = top + pad;
            for (const line of block.lines) {
              writeInline(line, {
                x: PAGE_MARGIN + pad,
                width: innerWidth,
                font: FONTS.italic,
              });
              doc.moveDown(0.3);
            }
            if (doc.bufferedPageRange().count === pagesBefore) {
              // Il testo è rimasto nel box: si riparte da sotto il box,
              // senza mai tornare indietro se la stima era corta.
              doc.y = Math.max(doc.y, top + boxHeight) + 10;
            } else {
              // Nonostante la stima il testo ha cambiato pagina: si
              // riparte da dove è finito davvero, non da coordinate
              // della pagina precedente.
              doc.y += 10;
            }
            doc.x = PAGE_MARGIN;
          } else {
            for (const line of block.lines) {
              ensureSpace(30);
              writeInline(line, { font: FONTS.italic });
              doc.moveDown(0.3);
            }
            doc.moveDown(0.4);
          }
          break;
        }
        case "rule": {
          if (!bodyStarted) break;
          ensureSpace(30);
          ornament(doc.y + 10);
          doc.y += 24;
          doc.x = PAGE_MARGIN;
          break;
        }
      }
    }

    // ---- Piè di pagina (numeri pagina, frontespizio escluso) ----
    // Il numero sta SOTTO il margine inferiore: senza azzerare
    // temporaneamente margins.bottom, il text() oltre maxY fa scattare
    // l'auto-pagebreak di pdfkit, che in modalità buffered accoda una
    // pagina bianca in fondo al documento per OGNI footer scritto.
    const range = doc.bufferedPageRange();
    for (let i = range.start + 1; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const bottomMargin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font(FONTS.italic).fontSize(9).fillColor(COLORS.subtle);
      doc.text(
        `— ${i + 1} —`,
        PAGE_MARGIN,
        pageHeight - PAGE_MARGIN + 18,
        { width: contentWidth, align: "center", lineBreak: false },
      );
      doc.page.margins.bottom = bottomMargin;
    }

    doc.end();
  });
}
