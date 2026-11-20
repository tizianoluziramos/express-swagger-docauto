import assert from "node:assert/strict";
import test from "node:test";
import { schemaAlternatives, serializationAnnotation as annotation } from "../src/schema-variants.js";

test("merges serialization evidence without duplicating wire schemas or mutating inputs", () => {
  const live = { type: "array", items: { type: "string" } };
  const cached = { ...live, [annotation]: {
    kind: "storage-roundtrip", runtimeValidated: false, reads: [{ file: "a.js", line: 2 }],
    writes: [{ file: "a.js", line: 4 }],
  } };
  const other = { ...live, [annotation]: {
    kind: "storage-roundtrip", runtimeValidated: false, reads: [{ file: "b.js", line: 2 }],
    writes: [{ file: "a.js", line: 4 }],
  } };
  const merged = schemaAlternatives([live, cached, other]);
  assert.equal(merged.anyOf, undefined);
  assert.equal(merged[annotation].reads.length, 2);
  assert.equal(merged[annotation].writes.length, 1);
  assert.equal(live[annotation], undefined);
  assert.equal(cached[annotation].reads.length, 1);
});

test("does not confuse data property names or example values with schema annotations", () => {
  const field = { type: "object", properties: { [annotation]: { type: "string" } } };
  const empty = { type: "object", properties: {} };
  const variants = schemaAlternatives([field, empty]);
  assert.equal(variants.anyOf.length, 2);
  assert.equal(variants.anyOf[0].properties[annotation].type, "string");
  const example = { type: "object", example: { [annotation]: "value" } };
  const another = { type: "object", example: {} };
  assert.equal(schemaAlternatives([example, another]).anyOf.length, 2);
});
