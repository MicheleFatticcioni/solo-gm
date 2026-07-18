import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { markdownToSpeechText, splitForSpeech } from "./tts";

describe("markdownToSpeechText", () => {
  it("toglie enfasi, intestazioni e citazioni", () => {
    assert.equal(
      markdownToSpeechText("# Titolo\n\n**Bran** urla. *Un urlo solo.*\n\n> Cosa fai?"),
      "Titolo\n\nBran urla. Un urlo solo.\n\nCosa fai?",
    );
  });

  it("mantiene punteggiatura, virgolette e trattini lunghi", () => {
    const text = "«No. NO. NON PUOI—»\n\nMa il rituale... è già partito.";
    assert.equal(markdownToSpeechText(text), text);
  });

  it("scioglie link, codice e marcatori di lista", () => {
    assert.equal(
      markdownToSpeechText(
        "- Vedi [la wiki](https://example.com)\n1. Tira `1d20`\n\n---\n\nFine.",
      ),
      "Vedi la wiki\nTira 1d20\n\nFine.",
    );
  });
});

describe("splitForSpeech", () => {
  it("testo corto: un solo segmento", () => {
    assert.deepEqual(splitForSpeech("Ciao mondo."), ["Ciao mondo."]);
  });

  it("spezza sui paragrafi senza superare il limite", () => {
    const a = "a".repeat(60);
    const b = "b".repeat(60);
    const c = "c".repeat(60);
    const chunks = splitForSpeech([a, b, c].join("\n\n"), 130);
    assert.deepEqual(chunks, [`${a}\n\n${b}`, c]);
  });

  it("paragrafo oltre il limite: spezza sulle frasi", () => {
    const sentence = "Una frase di prova che riempie spazio. ";
    const long = sentence.repeat(10).trim();
    const chunks = splitForSpeech(long, 100);
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) assert.ok(chunk.length <= 100);
    assert.equal(
      chunks.join(" ").replace(/\s+/g, " "),
      long.replace(/\s+/g, " "),
    );
  });
});
