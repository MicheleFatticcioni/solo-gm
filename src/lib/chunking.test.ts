import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { chunkPages, estimateTokens } from "./chunking";

describe("chunkPages", () => {
  it("testo corto: un solo chunk con le pagine giuste", () => {
    const chunks = chunkPages([{ page: 1, text: "Regole base del gioco." }]);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].content, "Regole base del gioco.");
    assert.equal(chunks[0].pageStart, 1);
    assert.equal(chunks[0].pageEnd, 1);
  });

  it("testo vuoto o solo spazi: nessun chunk", () => {
    assert.deepEqual(chunkPages([]), []);
    assert.deepEqual(chunkPages([{ page: 1, text: "   \n\n  " }]), []);
  });

  it("paragrafi: spezza ai doppi a-capo senza superare il target", () => {
    const paragraph = "Il mostro attacca con artigli affilati. ".repeat(10).trim();
    const text = Array.from({ length: 10 }, () => paragraph).join("\n\n");
    const chunks = chunkPages([{ page: 1, text }], { targetTokens: 200 });

    assert.ok(chunks.length > 1, "il testo lungo deve produrre più chunk");
    for (const chunk of chunks) {
      // ogni paragrafo (~115 token) sta nel target: nessuna frase troncata
      assert.ok(estimateTokens(chunk.content) <= 200 + 1);
      assert.ok(chunk.content.endsWith("."), `chunk troncato: …${chunk.content.slice(-30)}`);
    }
  });

  it("paragrafo lungo senza a-capo: ripiega sui confini di frase", () => {
    const text = "Il drago dorme sul tesoro. ".repeat(60).trim();
    const chunks = chunkPages([{ page: 1, text }], { targetTokens: 100 });

    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      assert.ok(chunk.content.endsWith("."), `chunk troncato: …${chunk.content.slice(-30)}`);
    }
  });

  it("overlap: i chunk consecutivi condividono la coda del precedente", () => {
    const sentences = Array.from({ length: 40 }, (_, i) => `Frase numero ${i}.`);
    const chunks = chunkPages([{ page: 1, text: sentences.join(" ") }], {
      targetTokens: 50,
      overlapRatio: 0.3,
    });

    assert.ok(chunks.length > 1);
    for (let i = 1; i < chunks.length; i++) {
      const previousTail = chunks[i - 1].content.split(" ").slice(-2).join(" ");
      assert.ok(
        chunks[i].content.includes(previousTail.slice(-15)) ||
          chunks[i - 1].content.length < 30,
        `nessun overlap tra chunk ${i - 1} e ${i}`,
      );
    }
  });

  it("confini di pagina: page_start/page_end reali", () => {
    const pageText = (n: number) =>
      Array.from({ length: 8 }, (_, i) => `Pagina ${n}, paragrafo ${i}.`).join("\n\n");
    const chunks = chunkPages(
      [
        { page: 1, text: pageText(1) },
        { page: 2, text: pageText(2) },
        { page: 3, text: pageText(3) },
      ],
      { targetTokens: 60 },
    );

    assert.ok(chunks.length >= 3);
    assert.equal(chunks[0].pageStart, 1);
    assert.equal(chunks[chunks.length - 1].pageEnd, 3);
    for (const chunk of chunks) {
      assert.ok(chunk.pageStart <= chunk.pageEnd);
      // il contenuto cita solo pagine dentro l'intervallo dichiarato
      for (const match of chunk.content.matchAll(/Pagina (\d)/g)) {
        const page = Number(match[1]);
        assert.ok(
          page >= chunk.pageStart && page <= chunk.pageEnd,
          `"Pagina ${page}" fuori da [${chunk.pageStart}, ${chunk.pageEnd}]`,
        );
      }
    }
  });

  it("testo senza alcun separatore: taglio duro a caratteri", () => {
    const text = "x".repeat(2000);
    const chunks = chunkPages([{ page: 1, text }], { targetTokens: 100 });
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      assert.ok(estimateTokens(chunk.content) <= 100 + 1);
    }
  });
});
