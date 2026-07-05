// Splitter ricorsivo per il testo estratto dai PDF: rispetta i confini
// (paragrafo → riga → frase), ~1000 token per chunk con overlap ~15%,
// e mantiene le pagine reali di provenienza di ogni chunk.

export type PageText = { page: number; text: string };

export type TextChunk = {
  content: string;
  pageStart: number;
  pageEnd: number;
};

export type ChunkingOptions = {
  targetTokens?: number;
  overlapRatio?: number;
};

const DEFAULT_TARGET_TOKENS = 1000;
const DEFAULT_OVERLAP_RATIO = 0.15;

// Euristica per manuali IT/EN: ~3.5 caratteri per token.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

// Un pezzo atomico di testo, come intervallo di offset nel testo completo.
type Piece = { start: number; end: number };

// Gerarchia dei confini: doppio a-capo, a-capo, fine frase.
const SEPARATORS = [/\n{2,}/g, /\n+/g, /(?<=[.!?…])\s+/g];

const PAGE_JOIN = "\n\n";

export function chunkPages(
  pages: PageText[],
  options: ChunkingOptions = {},
): TextChunk[] {
  const targetTokens = options.targetTokens ?? DEFAULT_TARGET_TOKENS;
  const overlapTokens = targetTokens * (options.overlapRatio ?? DEFAULT_OVERLAP_RATIO);

  // Testo completo + intervalli di offset di ogni pagina, per risalire
  // dalle posizioni dei chunk alle pagine di provenienza.
  let fullText = "";
  const pageRanges: { page: number; start: number; end: number }[] = [];
  for (const { page, text } of pages) {
    if (fullText.length > 0) fullText += PAGE_JOIN;
    pageRanges.push({ page, start: fullText.length, end: fullText.length + text.length });
    fullText += text;
  }

  if (fullText.trim().length === 0) return [];

  const pieces = splitRecursive(fullText, 0, targetTokens, 0);

  // Fusione greedy dei pezzi in chunk fino al target, con overlap:
  // il chunk successivo riparte dagli ultimi pezzi del precedente.
  const chunks: TextChunk[] = [];
  let current: Piece[] = [];
  let currentTokens = 0;

  const emit = () => {
    const content = fullText.slice(current[0].start, current[current.length - 1].end).trim();
    if (content.length === 0) return;
    chunks.push({
      content,
      pageStart: pageAt(pageRanges, current[0].start),
      pageEnd: pageAt(pageRanges, current[current.length - 1].end - 1),
    });
  };

  for (const piece of pieces) {
    const pieceTokens = estimateTokens(fullText.slice(piece.start, piece.end));
    if (current.length > 0 && currentTokens + pieceTokens > targetTokens) {
      emit();
      const kept: Piece[] = [];
      let keptTokens = 0;
      for (let i = current.length - 1; i >= 0; i--) {
        const t = estimateTokens(fullText.slice(current[i].start, current[i].end));
        if (keptTokens + t > overlapTokens) break;
        kept.unshift(current[i]);
        keptTokens += t;
      }
      current = kept;
      currentTokens = keptTokens;
    }
    current.push(piece);
    currentTokens += pieceTokens;
  }
  if (current.length > 0) emit();

  return chunks;
}

// Spezza [offset, offset+text.length) in pezzi <= maxTokens provando i
// separatori in ordine di priorità; in ultima istanza taglia a caratteri.
function splitRecursive(
  text: string,
  offset: number,
  maxTokens: number,
  level: number,
): Piece[] {
  if (estimateTokens(text) <= maxTokens) {
    return [{ start: offset, end: offset + text.length }];
  }

  if (level >= SEPARATORS.length) {
    const maxChars = Math.max(1, Math.floor(maxTokens * 3.5));
    const pieces: Piece[] = [];
    for (let i = 0; i < text.length; i += maxChars) {
      pieces.push({ start: offset + i, end: offset + Math.min(i + maxChars, text.length) });
    }
    return pieces;
  }

  const separator = new RegExp(SEPARATORS[level].source, "g");
  const pieces: Piece[] = [];
  let partStart = 0;
  let split = false;

  const pushPart = (from: number, to: number) => {
    const part = text.slice(from, to);
    if (part.length === 0) return;
    pieces.push(...splitRecursive(part, offset + from, maxTokens, level + 1));
  };

  for (const match of text.matchAll(separator)) {
    if (match[0].length === 0) break; // paranoia: evita loop su match vuoti
    split = true;
    pushPart(partStart, match.index);
    partStart = match.index + match[0].length;
  }

  if (!split) {
    // il separatore non compare: prova il livello successivo
    return splitRecursive(text, offset, maxTokens, level + 1);
  }

  pushPart(partStart, text.length);
  return pieces;
}

function pageAt(
  ranges: { page: number; start: number; end: number }[],
  position: number,
): number {
  for (const range of ranges) {
    if (position < range.end) return range.page;
  }
  return ranges.length > 0 ? ranges[ranges.length - 1].page : 1;
}
