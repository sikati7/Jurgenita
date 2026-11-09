// Les formats de sortie doivent tolérer une valeur inattendue de Claude dans
// une liste fermée (le SDK n'impose pas les enum côté API).
import { test } from "node:test";
import assert from "node:assert/strict";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import * as schemas from "../src/schemas.js";

test("une valeur hors liste prend la valeur de repli au lieu de faire échouer la réponse", () => {
  const review = betaZodOutputFormat(schemas.AdsReview).parse(JSON.stringify({
    synthese: "s",
    decisions: [{ annonce: "A", decision: "Augmenter le budget", raison: "r" }, { annonce: "B", decision: "couper", raison: "r" }],
    alertes: [],
    prochains_tests: [],
  }));
  assert.equal(review.decisions[0].decision, "garder");
  assert.equal(review.decisions[1].decision, "couper");
});

test("chaque liste fermée des formats a une valeur de repli", () => {
  for (const [name, schema] of Object.entries(schemas)) {
    const text = JSON.stringify(betaZodOutputFormat(schema).schema);
    const lists = text.match(/enum: \[/g)?.length ?? 0;
    const defaults = text.match(/default: \\"/g)?.length ?? 0;
    assert.equal(defaults, lists, `${name} : ${lists - defaults} liste(s) sans valeur de repli`);
  }
});
