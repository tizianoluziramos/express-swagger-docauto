import ts from "typescript";

const unknownFlags = ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter;
const undefinedFlags = ts.TypeFlags.Undefined | ts.TypeFlags.Void;
const unique = (schemas) => [...new Map(schemas.map((schema) => [JSON.stringify(schema), schema])).values()];

// Documentation is evidence for descriptions, not for HTTP statuses or schemas.
export function describeSymbol(checker, symbol, schema) {
  if (!symbol || !schema) return schema;
  const description = ts.displayPartsToString(symbol.getDocumentationComment(checker));
  const tags = symbol.getJsDocTags(checker);
  return {
    ...schema,
    ...(description ? { description } : {}),
    ...(tags.some((tag) => tag.name === "deprecated") ? { deprecated: true } : {}),
  };
}

export class TypeSchemas {
  constructor(checker) {
    this.checker = checker;
    this.schemas = {};
    this.cache = new Map();
    this.active = new Map();
    this.nextId = 0;
  }
  union(types, depth) {
    const schemas = unique(types.filter((type) => !(type.flags & ts.TypeFlags.Never))
      .map((type) => this.convert(type, depth) ?? {}));
    if (!schemas.length) return { not: {} };
    return schemas.length === 1 ? schemas[0] : { anyOf: schemas };
  }
  convert(type, depth = 0) {
    if (!type || type.flags & unknownFlags) return null;
    if (type.flags & ts.TypeFlags.Never) return { not: {} };
    if (type.flags & (ts.TypeFlags.Null | undefinedFlags)) return { type: "null" };
    if (type.flags & ts.TypeFlags.StringLiteral) return { type: "string", const: type.value };
    if (type.flags & ts.TypeFlags.NumberLiteral) return { type: "number", const: type.value };
    if (type.flags & ts.TypeFlags.BooleanLiteral) return { type: "boolean", const: type.intrinsicName === "true" };
    if (type.flags & ts.TypeFlags.StringLike) return { type: "string" };
    if (type.flags & ts.TypeFlags.NumberLike) return { type: "number" };
    if (type.flags & ts.TypeFlags.BooleanLike) return { type: "boolean" };
    // BigInt, symbols and unresolved generics are not JSON wire types.
    if (!(type.flags & (ts.TypeFlags.Object | ts.TypeFlags.Union | ts.TypeFlags.Intersection))) return null;
    if (this.cache.has(type)) return structuredClone(this.cache.get(type));
    const active = this.active.get(type);
    if (active) {
      active.used = true;
      return { $ref: `#/components/schemas/${active.name}` };
    }
    if (depth > 24) return null;
    const name = (type.aliasSymbol ?? type.getSymbol())?.getName() ?? "Value";
    const record = { name: `External_${name.replace(/[^\w]/g, "_")}_${++this.nextId}`, used: false };
    this.active.set(type, record);
    let schema;
    try {
      schema = this.structured(type, depth);
      if (schema && record.used) this.schemas[record.name] = structuredClone(schema);
      if (schema) this.cache.set(type, structuredClone(schema));
    } finally {
      this.active.delete(type);
    }
    return schema;
  }
  structured(type, depth) {
    const checker = this.checker;
    if (type.isUnion()) return this.union(type.types, depth + 1);
    if (type.isIntersection()) {
      const primitive = type.types.find((part) => part.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike));
      if (primitive) return this.convert(primitive, depth + 1);
    }
    if (checker.isTupleType(type)) {
      const items = checker.getTypeArguments(type);
      const flags = type.target.elementFlags;
      const rest = flags.findIndex((flag) => flag & ts.ElementFlags.Variable);
      const fixed = rest < 0 ? items.length : rest;
      // A variadic middle cannot be represented as JSON Schema prefixItems.
      if (rest >= 0 && rest !== items.length - 1) return { type: "array", items: {} };
      return {
        type: "array",
        ...(fixed ? { prefixItems: items.slice(0, fixed).map((item) => this.convert(item, depth + 1) ?? {}) } : {}),
        minItems: flags.slice(0, fixed).filter((flag) => flag & ts.ElementFlags.Required).length,
        ...(rest < 0 ? { maxItems: items.length, items: false } :
          { items: this.convert(items[rest], depth + 1) ?? {} }),
      };
    }
    const symbol = type.getSymbol();
    if (checker.isArrayType(type) || symbol?.getName() === "ReadonlyArray") {
      return { type: "array", items: this.convert(checker.getTypeArguments(type)[0], depth + 1) ?? {} };
    }
    if (symbol?.getName() === "Date") return { type: "string", format: "date-time" };
    const toJSON = checker.getPropertyOfType(type, "toJSON");
    if (toJSON) {
      const declaration = toJSON.valueDeclaration ?? toJSON.declarations?.[0];
      if (declaration) {
        const method = checker.getTypeOfSymbolAtLocation(toJSON, declaration);
        const signatures = checker.getSignaturesOfType(method, ts.SignatureKind.Call);
        if (signatures.length) return this.union(signatures.map((signature) => checker.getReturnTypeOfSignature(signature)), depth + 1);
      }
    }
    // Callable values disappear from objects during JSON serialization.
    if (checker.getSignaturesOfType(type, ts.SignatureKind.Call).length) return null;
    const properties = {};
    const required = [];
    for (const property of checker.getPropertiesOfType(type)) {
      const declaration = property.valueDeclaration ?? property.declarations?.[0];
      if (!declaration || property.getName().startsWith("__@")) continue;
      const modifiers = ts.getCombinedModifierFlags(declaration);
      if (modifiers & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected | ts.ModifierFlags.Static) ||
        declaration.name && ts.isPrivateIdentifier(declaration.name)) continue;
      const value = checker.getTypeOfSymbolAtLocation(property, declaration);
      if (checker.getSignaturesOfType(value, ts.SignatureKind.Call).length ||
        value.flags & (undefinedFlags | ts.TypeFlags.ESSymbolLike)) continue;
      const parts = value.isUnion() ? value.types : [value];
      const optional = property.flags & ts.SymbolFlags.Optional || parts.some((part) => part.flags & undefinedFlags);
      const present = parts.filter((part) => !(part.flags & undefinedFlags));
      properties[property.getName()] = describeSymbol(checker, property, this.union(present, depth + 1));
      if (!optional) required.push(property.getName());
    }
    const indexes = checker.getIndexInfosOfType(type);
    const schema = {
      type: "object", properties,
      ...(required.length ? { required } : {}),
    };
    if (indexes.length) {
      const values = indexes.map((index) => index.type);
      schema.additionalProperties = values.some((value) => value.flags & unknownFlags) ? true : this.union(values, depth + 1);
    }
    // Do not assert additionalProperties:false: TS types are structurally open.
    return describeSymbol(checker, type.aliasSymbol ?? symbol, schema);
  }
}
