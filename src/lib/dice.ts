import type Anthropic from "@anthropic-ai/sdk";

// Risultato di un tiro completo: tutti i dadi usciti (in ordine di
// notazione, con segno già applicato), la somma dei modificatori fissi
// e il totale.
export type DiceResult = {
  rolls: number[];
  modifier: number;
  total: number;
};

// Limiti anti-abuso: la notazione arriva dal modello, non dall'utente,
// ma un "1000000d1000000" allocherebbe comunque memoria inutilmente.
const MAX_DICE_PER_GROUP = 100;
const MAX_SIDES = 10000;

// Un termine della notazione: gruppo di dadi (`2d6`) o costante (`+3`),
// con segno. `NdM` senza N esplicito vale `1dM`.
type Term =
  | { kind: "dice"; sign: 1 | -1; count: number; sides: number }
  | { kind: "constant"; sign: 1 | -1; value: number };

const TERM_RE = /^(\d*)[dD](\d+)$|^(\d+)$/;

// Parsa notazioni tipo "1d20+5", "3d6", "1d100", "2d6+1d4-1":
// più gruppi e costanti sommati/sottratti. Lancia Error su input invalido.
export function parseNotation(notation: string): Term[] {
  const compact = notation.replaceAll(/\s+/g, "");
  if (compact.length === 0) {
    throw new Error("Notazione dadi vuota");
  }

  // Spezza in termini firmati: "2d6+3-1d4" → ["+2d6", "+3", "-1d4"].
  // Se i termini non ricompongono l'input (es. "1d20++5", dove il
  // regex salterebbe un segno), la notazione è malformata.
  const signed = compact.match(/[+-]?[^+-]+/g) ?? [];
  if (signed.join("") !== compact) {
    throw new Error(`Notazione dadi non valida: "${notation}"`);
  }
  const terms: Term[] = [];

  for (const raw of signed) {
    const sign: 1 | -1 = raw.startsWith("-") ? -1 : 1;
    const body = raw.replace(/^[+-]/, "");
    const match = TERM_RE.exec(body);
    if (!match) {
      throw new Error(`Notazione dadi non valida: "${notation}"`);
    }

    if (match[3] !== undefined) {
      terms.push({ kind: "constant", sign, value: Number(match[3]) });
      continue;
    }

    const count = match[1] === "" ? 1 : Number(match[1]);
    const sides = Number(match[2]);
    if (count < 1 || count > MAX_DICE_PER_GROUP) {
      throw new Error(`Numero di dadi fuori range (1-${MAX_DICE_PER_GROUP}): "${notation}"`);
    }
    if (sides < 2 || sides > MAX_SIDES) {
      throw new Error(`Numero di facce fuori range (2-${MAX_SIDES}): "${notation}"`);
    }
    terms.push({ kind: "dice", sign, count, sides });
  }

  if (!terms.some((t) => t.kind === "dice")) {
    throw new Error(`Notazione senza dadi: "${notation}"`);
  }

  return terms;
}

// Tira la notazione con RNG crittografico. `randomInt` è iniettabile
// solo per i test.
export function rollDice(
  notation: string,
  randomInt: (sides: number) => number = cryptoRandomInt,
): DiceResult {
  const terms = parseNotation(notation);

  const rolls: number[] = [];
  let modifier = 0;
  for (const term of terms) {
    if (term.kind === "constant") {
      modifier += term.sign * term.value;
      continue;
    }
    for (let i = 0; i < term.count; i++) {
      rolls.push(term.sign * randomInt(term.sides));
    }
  }

  const total = rolls.reduce((sum, roll) => sum + roll, modifier);
  return { rolls, modifier, total };
}

// Intero uniforme in [1, sides] via crypto.getRandomValues, con
// rejection sampling per non sbilanciare la distribuzione (il modulo
// semplice favorirebbe i valori bassi).
function cryptoRandomInt(sides: number): number {
  const range = 0x1_0000_0000; // 2^32
  const limit = range - (range % sides);
  const buffer = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buffer);
    if (buffer[0] < limit) return (buffer[0] % sides) + 1;
  }
}

// Definizione del tool per l'API Anthropic: il modello dichiara i tiri,
// il server li esegue (un LLM non sa generare casualità vera).
export const rollDiceTool: Anthropic.Tool = {
  name: "roll_dice",
  description:
    "Tira dadi per prove, attacchi, tabelle casuali. Usalo SEMPRE quando le regole richiedono un tiro: non inventare mai risultati.",
  input_schema: {
    type: "object",
    properties: {
      notation: {
        type: "string",
        description: "Notazione dadi, es. '1d20+5', '3d6', '1d100'",
      },
      reason: { type: "string", description: "Cosa rappresenta il tiro" },
    },
    required: ["notation", "reason"],
    additionalProperties: false,
  },
  strict: true,
};

export type RollDiceInput = { notation: string; reason: string };
