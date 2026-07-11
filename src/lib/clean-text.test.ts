import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cleanPageText } from "./clean-text";

describe("cleanPageText", () => {
  it("rimuove il watermark con email mantenendo il resto", () => {
    const page = [
      "REMBREDO",
      "Rembredo è un sacerdote ambizioso.",
      "wyrdedizioni.com 48237, Andrea Maggiorotti, < maggiorotti.andrea@gmail.com >, April 6, 2024",
    ].join("\n");
    assert.equal(cleanPageText(page), "REMBREDO\nRembredo è un sacerdote ambizioso.");
  });

  it("cattura formati di watermark diversi (altro venditore)", () => {
    const page = "Fatticcioni michelefatticcioni@gmail.com 52077 Dicembre 8, 2025";
    assert.equal(cleanPageText(page), "");
  });

  it("rimuove il running header con numero di pagina incollato", () => {
    // "misericordia a vond" (header) + "5" (numero pagina) fusi da pdf.js
    const page = "misericordia a vond5\ndella chiesa si era assottigliata.";
    assert.equal(cleanPageText(page), "della chiesa si era assottigliata.");
  });

  it("rimuove header anche con numero di capitolo nel titolo", () => {
    const page = "capitolo 12170\nREMBREDO";
    assert.equal(cleanPageText(page), "REMBREDO");
  });

  it("NON rimuove una prima riga di contenuto reale (ha maiuscole)", () => {
    const page = "MISERICORDIA A VOND\nInizio del capitolo.";
    assert.equal(cleanPageText(page), "MISERICORDIA A VOND\nInizio del capitolo.");
  });

  it("NON rimuove una prima riga che è una frase (non finisce con cifra)", () => {
    const page = "il drago dorme sul tesoro accumulato nei secoli.\nAltro testo.";
    assert.equal(
      cleanPageText(page),
      "il drago dorme sul tesoro accumulato nei secoli.\nAltro testo.",
    );
  });

  it("lo strip dell'header colpisce solo la prima riga, non righe simili sotto", () => {
    // Una riga lowercase che finisce con cifra più in basso NON va toccata.
    const page = "capitolo 12170\nla porta ha 3 serrature\ntesto normale";
    assert.equal(cleanPageText(page), "la porta ha 3 serrature\ntesto normale");
  });

  it("pagina di sola illustrazione (header + segnaposto mappa + watermark)", () => {
    const page = "capitolo 552\n4\n8\n10\n11\nfoo@bar.com 123";
    // header e watermark via; restano i numeri-segnaposto della mappa
    assert.equal(cleanPageText(page), "4\n8\n10\n11");
  });

  it("testo pulito resta invariato", () => {
    const page = "Un paragrafo perfettamente normale, senza artefatti.";
    assert.equal(cleanPageText(page), page);
  });
});
