export const serializationAnnotation = "x-swaggerdoc-serialization";

const single = ["items", "additionalProperties", "contains", "not", "if", "then", "else",
  "propertyNames", "unevaluatedProperties", "unevaluatedItems"];
const lists = ["allOf", "anyOf", "oneOf", "prefixItems"];
const maps = ["properties", "patternProperties", "$defs", "dependentSchemas"];

function withoutEvidence(schema) {
  if (!schema || typeof schema !== "object") return schema;
  const out = { ...schema };
  delete out[serializationAnnotation];
  for (const key of single) if (out[key] !== undefined) out[key] = withoutEvidence(out[key]);
  for (const key of lists) if (Array.isArray(out[key])) out[key] = out[key].map(withoutEvidence);
  for (const key of maps) if (out[key]) out[key] = Object.fromEntries(
    Object.entries(out[key]).map(([name, value]) => [name, withoutEvidence(value)]),
  );
  return out;
}
const identity = (schema) => JSON.stringify(withoutEvidence(schema));

function mergeEvidence(target, source) {
  if (!target || !source || typeof target !== "object" || typeof source !== "object") return;
  const value = source[serializationAnnotation];
  if (value) {
    const evidence = target[serializationAnnotation] ??= structuredClone(value);
    for (const location of ["reads", "writes"]) {
      if (value[location]) evidence[location] = [...new Map(
        [...(evidence[location] ?? []), ...value[location]].map((entry) => [JSON.stringify(entry), entry]),
      ).values()];
    }
  }
  for (const key of single) mergeEvidence(target[key], source[key]);
  for (const key of lists) for (const [index, part] of (source[key] ?? []).entries()) mergeEvidence(target[key]?.[index], part);
  for (const key of maps) for (const [name, part] of Object.entries(source[key] ?? {})) mergeEvidence(target[key]?.[name], part);
}

// A cache hit and its live producer have the same wire schema. Provenance
// must survive deduplication without creating duplicate anyOf alternatives.
export function schemaAlternatives(values) {
  const variants = new Map();
  for (const value of values) {
    const key = identity(value);
    const existing = variants.get(key);
    if (existing) mergeEvidence(existing, value);
    else variants.set(key, structuredClone(value));
  }
  const schemas = [...variants.values()];
  return schemas.length === 1 ? schemas[0] : schemas.length ? { anyOf: schemas } : {};
}
