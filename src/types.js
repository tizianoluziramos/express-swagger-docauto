import ts from "typescript";

const unknownFlags = ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter;
const undefinedFlags = ts.TypeFlags.Undefined | ts.TypeFlags.Void;
const unique = (schemas) => [...new Map(schemas.map((schema) => [JSON.stringify(schema), schema])).values()];
const canonical = (value) => JSON.stringify(value, (key, item) => {
  if (Array.isArray(item) && ["required", "enum", "type"].includes(key)) return [...item].sort();
  return item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item;
});

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
    this.equivalent = new Map();
    this.issueCache = new Map();
    this.nextId = 0;
  }
  union(types, depth) {
    let schemas = unique(types.filter((type) => !(type.flags & ts.TypeFlags.Never))
      .map((type) => this.convert(type, depth) ?? {}));
    const booleans = schemas.filter((schema) => schema.type === "boolean" && typeof schema.const === "boolean");
    if (booleans.some((schema) => schema.const) && booleans.some((schema) => !schema.const)) {
      schemas = [{ type: "boolean" }, ...schemas.filter((schema) => !booleans.includes(schema))];
    }
    if (!schemas.length) return { not: {} };
    return schemas.length === 1 ? schemas[0] : { anyOf: schemas };
  }
  convert(type, depth = 0) {
    if (!type) return null;
    if (type.flags & ts.TypeFlags.TypeParameter) {
      const constraint = this.checker.getBaseConstraintOfType(type);
      return constraint && constraint !== type ? this.convert(constraint, depth + 1) : null;
    }
    if (type.flags & unknownFlags) return null;
    if (type.flags & ts.TypeFlags.Never) return { not: {} };
    if (type.flags & undefinedFlags) return null;
    if (type.flags & ts.TypeFlags.Null) return { type: "null" };
    if (type.flags & ts.TypeFlags.StringLiteral) return { type: "string", const: type.value };
    if (type.flags & ts.TypeFlags.NumberLiteral) return { type: "number", const: type.value };
    if (type.flags & ts.TypeFlags.BooleanLiteral) return { type: "boolean", const: this.checker.typeToString(type) === "true" };
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
    const record = { name: `Type_${name.replace(/[^\w]/g, "_")}_${++this.nextId}`, used: false };
    this.active.set(type, record);
    let schema;
    try {
      schema = this.structured(type, depth);
      const reusable = schema?.type === "object" && name && !name.startsWith("__");
      if (schema && (record.used || reusable)) {
        const key = canonical(schema);
        const existing = !record.used && this.equivalent.get(key);
        if (!existing) {
          this.schemas[record.name] = structuredClone(schema);
          this.equivalent.set(key, record.name);
        }
        schema = { $ref: `#/components/schemas/${existing || record.name}` };
      }
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
      return { allOf: type.types.map((part) => this.convert(part, depth + 1) ?? {}) };
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
        ...(fixed ? { prefixItems: items.slice(0, fixed).map((item) => this.arrayItem(item, depth + 1)) } : {}),
        minItems: flags.slice(0, fixed).filter((flag) => flag & ts.ElementFlags.Required).length,
        ...(rest < 0 ? { maxItems: items.length, items: false } :
          { items: this.arrayItem(items[rest], depth + 1) }),
      };
    }
    const symbol = type.getSymbol();
    if (checker.isArrayType(type)) {
      return { type: "array", items: this.arrayItem(checker.getTypeArguments(type)[0], depth + 1) };
    }
    if (symbol?.getName() === "Date" && symbol.declarations?.some((decl) =>
      /[/\\]typescript[/\\]lib[/\\]lib\..*\.d\.ts$/.test(decl.getSourceFile().fileName))) {
      return { type: "string", format: "date-time" };
    }
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
      if (property.getName().startsWith("__@")) continue;
      const modifiers = declaration ? ts.getCombinedModifierFlags(declaration) : 0;
      if (modifiers & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected | ts.ModifierFlags.Static) ||
        declaration?.name && ts.isPrivateIdentifier(declaration.name)) continue;
      const value = declaration ? checker.getTypeOfSymbolAtLocation(property, declaration) : checker.getTypeOfSymbol(property);
      if (checker.getSignaturesOfType(value, ts.SignatureKind.Call).length ||
        value.flags & (undefinedFlags | ts.TypeFlags.ESSymbolLike)) continue;
      const parts = value.isUnion() ? value.types : [value];
      const omitted = (part) => part.flags & (undefinedFlags | ts.TypeFlags.ESSymbolLike) ||
        checker.getSignaturesOfType(part, ts.SignatureKind.Call).length;
      const optional = property.flags & ts.SymbolFlags.Optional || parts.some(omitted);
      const present = parts.filter((part) => !omitted(part));
      if (!present.length) continue;
      Object.defineProperty(properties, property.getName(), {
        value: describeSymbol(checker, property, this.union(present, depth + 1)),
        enumerable: true, configurable: true, writable: true,
      });
      if (!optional) required.push(property.getName());
    }
    const indexes = checker.getIndexInfosOfType(type);
    const schema = {
      type: "object", properties,
      ...(required.length ? { required } : {}),
    };
    if (indexes.length) {
      const values = indexes.map((index) => index.type);
      schema.additionalProperties = this.union(values, depth + 1);
    }
    // Do not assert additionalProperties:false: TS types are structurally open.
    return describeSymbol(checker, type.aliasSymbol ?? symbol, schema);
  }
  arrayItem(type, depth) {
    if (!type) return {};
    const parts = type.isUnion() ? type.types : [type];
    return this.union(parts.map((part) => part.flags & (undefinedFlags | ts.TypeFlags.ESSymbolLike)
      || this.checker.getSignaturesOfType(part, ts.SignatureKind.Call).length
      ? this.checker.getNullType() : part), depth);
  }
  // Keep uncertainty outside the generated JSON Schema. Empty schemas are
  // deliberately valid, and diagnostics explain their precise source.
  issues(type) {
    if (this.issueCache.has(type)) return this.issueCache.get(type);
    const out = [];
    const visit = (value, location, active, depth) => {
      if (!value || active.has(value)) return;
      const label = this.checker.typeToString(value);
      if (depth > 24) { out.push({ path: location, reason: `Type '${label}' exceeds the schema traversal limit` }); return; }
      if (value.flags & unknownFlags) {
        if (value.flags & ts.TypeFlags.TypeParameter) {
          const constraint = this.checker.getBaseConstraintOfType(value);
          if (constraint && constraint !== value) { visit(constraint, location, active, depth + 1); return; }
        }
        out.push({ path: location, reason: `Type '${label}' ${value.flags & ts.TypeFlags.TypeParameter
          ? "is an unresolved generic parameter" : "does not declare a concrete JSON structure"}` });
        return;
      }
      if (value.flags & (undefinedFlags | ts.TypeFlags.BigIntLike | ts.TypeFlags.ESSymbolLike)) {
        out.push({ path: location, reason: `Type '${label}' is not a JSON value` });
        return;
      }
      if (!(value.flags & (ts.TypeFlags.Object | ts.TypeFlags.Union | ts.TypeFlags.Intersection |
        ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.Null | ts.TypeFlags.Never))) {
        out.push({ path: location, reason: `Type '${label}' cannot be reduced to a concrete JSON type by TypeScript` });
        return;
      }
      const next = new Set(active); next.add(value);
      if (value.isUnionOrIntersection()) {
        for (const part of value.types) visit(part, location, next, depth + 1);
      } else if (this.checker.isTupleType(value)) {
        this.checker.getTypeArguments(value).forEach((item, index) => visit(item, `${location}[${index}]`, next, depth + 1));
      } else if (this.checker.isArrayType(value)) {
        visit(this.checker.getTypeArguments(value)[0], `${location}[]`, next, depth + 1);
      } else if (value.flags & ts.TypeFlags.Object) {
        const toJSON = this.checker.getPropertyOfType(value, "toJSON");
        const declaration = toJSON?.valueDeclaration ?? toJSON?.declarations?.[0];
        if (declaration) {
          const method = this.checker.getTypeOfSymbolAtLocation(toJSON, declaration);
          for (const signature of method.getCallSignatures()) visit(this.checker.getReturnTypeOfSignature(signature), location, next, depth + 1);
          return;
        }
        for (const property of this.checker.getPropertiesOfType(value)) {
          const decl = property.valueDeclaration ?? property.declarations?.[0];
          if (property.getName().startsWith("__@") ||
            decl && ts.getCombinedModifierFlags(decl) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected | ts.ModifierFlags.Static) ||
            decl?.name && ts.isPrivateIdentifier(decl.name)) continue;
          const child = decl ? this.checker.getTypeOfSymbolAtLocation(property, decl) : this.checker.getTypeOfSymbol(property);
          if (child.getCallSignatures().length) continue;
          for (const part of child.isUnion() ? child.types : [child]) {
            if (!(part.flags & (undefinedFlags | ts.TypeFlags.ESSymbolLike)) && !part.getCallSignatures().length) {
              visit(part, `${location}.${property.getName()}`, next, depth + 1);
            }
          }
        }
        for (const index of this.checker.getIndexInfosOfType(value)) visit(index.type, `${location}.*`, next, depth + 1);
      }
    };
    visit(type, "$", new Set(), 0);
    this.issueCache.set(type, out);
    return out;
  }
}
