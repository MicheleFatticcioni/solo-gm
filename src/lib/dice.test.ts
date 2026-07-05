import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseNotation, rollDice } from "./dice";

describe("parseNotation", () => {
  it("gruppo singolo con modificatore", () => {
    assert.deepEqual(parseNotation("1d20+5"), [
      { kind: "dice", sign: 1, count: 1, sides: 20 },
      { kind: "constant", sign: 1, value: 5 },
    ]);
  });

  it("modificatore negativo e più gruppi", () => {
    assert.deepEqual(parseNotation("2d6+1d4-1"), [
      { kind: "dice", sign: 1, count: 2, sides: 6 },
      { kind: "dice", sign: 1, count: 1, sides: 4 },
      { kind: "constant", sign: -1, value: 1 },
    ]);
  });

  it("N implicito, maiuscole e spazi tollerati", () => {
    assert.deepEqual(parseNotation(" d8 + 2 "), [
      { kind: "dice", sign: 1, count: 1, sides: 8 },
      { kind: "constant", sign: 1, value: 2 },
    ]);
    assert.deepEqual(parseNotation("3D6"), [
      { kind: "dice", sign: 1, count: 3, sides: 6 },
    ]);
  });

  it("input invalidi: errore esplicito", () => {
    for (const bad of ["", "ciao", "d", "1d", "20", "+5", "1d20++5", "2x6"]) {
      assert.throws(() => parseNotation(bad), Error, `doveva fallire: "${bad}"`);
    }
  });

  it("limiti su numero di dadi e facce", () => {
    assert.throws(() => parseNotation("101d6"));
    assert.throws(() => parseNotation("1d1"));
    assert.throws(() => parseNotation("1d100000"));
    assert.throws(() => parseNotation("0d6"));
  });
});

describe("rollDice", () => {
  it("somma tiri e modificatori con RNG iniettato", () => {
    // RNG deterministico: restituisce sempre il massimo
    const result = rollDice("2d6+1d4+3", (sides) => sides);
    assert.deepEqual(result, { rolls: [6, 6, 4], modifier: 3, total: 19 });
  });

  it("gruppi sottratti: tiri con segno negativo", () => {
    const result = rollDice("1d20-1d4-2", (sides) => sides);
    assert.deepEqual(result, { rolls: [20, -4], modifier: -2, total: 14 });
  });

  it("RNG vero: sempre nel range, distribuzione plausibile", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const { rolls, total } = rollDice("1d6");
      assert.equal(rolls.length, 1);
      assert.ok(rolls[0] >= 1 && rolls[0] <= 6, `fuori range: ${rolls[0]}`);
      assert.equal(total, rolls[0]);
      seen.add(rolls[0]);
    }
    // su 2000 tiri devono uscire tutte e sei le facce
    assert.equal(seen.size, 6);
  });

  it("1d100 resta nel range", () => {
    for (let i = 0; i < 500; i++) {
      const { total } = rollDice("1d100");
      assert.ok(total >= 1 && total <= 100, `fuori range: ${total}`);
    }
  });
});
