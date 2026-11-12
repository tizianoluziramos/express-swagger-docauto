import { syntax as ts, member, propertyName, unwrap } from "./project.js";

const copy = (obj) => structuredClone(obj);
const mark = "x-swaggerdoc-internal-optional";
const basic = {
  string: { type: "string" }, number: { type: "number" }, boolean: { type: "boolean" }, bigint: { type: "integer" },
  int: { type: "integer" }, int32: { type: "integer", format: "int32" }, int64: { type: "integer", format: "int64" },
  nan: { type: "number" }, any: {}, unknown: {}, never: { not: {} }, null: { type: "null" }, undefined: {},
  email: { type: "string", format: "email" }, uuid: { type: "string", format: "uuid" }, url: { type: "string", format: "uri" },
  hostname: { type: "string", format: "hostname" }, ipv4: { type: "string", format: "ipv4" }, ipv6: { type: "string", format: "ipv6" },
  isoDate: { type: "string", format: "date" }, date: { type: "string", format: "date-time" }, datetime: { type: "string", format: "date-time" },
  time: { type: "string", format: "time" }, dateTime: { type: "string", format: "date-time" },
};
function note(project, code, detail, node) {
  const src = node?.getSourceFile();
  const point = src ? src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1 : 0;
  project.diagnostics.push({ level: "warning", code, message: `${detail} (${src?.fileName ?? "source"}:${point})` });
}
function resolveLiteral(project, file, node) { return project.staticValue(file, node); }
function refinementMessage(project, file, expression) {
  const value = project.staticValue(file, expression);
  if (typeof value === "string") return value;
  if (value && typeof value.message === "string") return value.message;
  return null;
}
function addDescription(schema, description) {
  const text = description || "Additional validation is performed at runtime.";
  if (!schema.description) schema.description = text;
  else if (!schema.description.includes(text)) schema.description += ` ${text}`;
}
function isUndefined(node) {
  node = unwrap(node);
  return ts.isIdentifier(node) && node.text === "undefined" ||
    ts.isVoidExpression(node) && ts.isNumericLiteral(node.expression) && node.expression.text === "0";
}
// Recognize Object.values(data).some(value => value !== undefined), which is
// equivalent to minProperties: 1 for JSON request bodies.
function requiresNonEmptyObject(node) {
  node = unwrap(node);
  if (!node || !(ts.isArrowFunction(node) || ts.isFunctionExpression(node))) return false;
  const variable = node.parameters[0]?.name;
  if (!variable || !ts.isIdentifier(variable)) return false;
  let body = unwrap(node.body);
  if (ts.isBlock(body)) {
    if (body.statements.length !== 1 || !ts.isReturnStatement(body.statements[0])) return false;
    body = unwrap(body.statements[0].expression);
  }
  if (!body || !ts.isCallExpression(body) || member(body.expression) !== "some") return false;
  const receiver = unwrap(body.expression.expression);
  if (!ts.isCallExpression(receiver) || member(receiver.expression) !== "values") return false;
  const objectName = unwrap(receiver.expression.expression);
  if (!ts.isIdentifier(objectName) || objectName.text !== "Object") return false;
  const input = unwrap(receiver.arguments[0]);
  if (!ts.isIdentifier(input) || input.text !== variable.text) return false;
  const predicate = unwrap(body.arguments[0]);
  if (!predicate || !(ts.isArrowFunction(predicate) || ts.isFunctionExpression(predicate))) return false;
  const item = predicate.parameters[0]?.name;
  if (!item || !ts.isIdentifier(item)) return false;
  let comparison = unwrap(predicate.body);
  if (ts.isBlock(comparison)) {
    if (comparison.statements.length !== 1 || !ts.isReturnStatement(comparison.statements[0])) return false;
    comparison = unwrap(comparison.statements[0].expression);
  }
  if (!comparison || !ts.isBinaryExpression(comparison) || ![
    ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
  ].includes(comparison.operatorToken.kind)) return false;
  const left = unwrap(comparison.left);
  const right = unwrap(comparison.right);
  return ts.isIdentifier(left) && left.text === item.text && isUndefined(right) ||
    ts.isIdentifier(right) && right.text === item.text && isUndefined(left);
}
// A pipe validates the result of the preceding schema. Restrictions can be
// merged into the input schema only when both have the same primitive type.
function combinePipe(input, output) {
  if (!output) return input;
  const fields = ["format", "pattern", "minLength", "maxLength", "minimum", "maximum",
    "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minItems", "maxItems", "uniqueItems"];
  if (input.type && input.type === output.type) {
    for (const field of fields) if (output[field] !== undefined) input[field] = copy(output[field]);
  } else if (Object.keys(output).length) {
    // OpenAPI describes the wire input, not the transformed JavaScript result.
    // Preserve post-parse checks without making their output type a request type.
    input["x-swaggerdoc-post-parse-schema"] = output;
  }
  return input;
}
function schemaFromObject(project, file, object, seen, depth, calc) {
  object = unwrap(object);
  if (!object || !ts.isObjectLiteralExpression(object)) {
    const resolved = project.resolveExpression(file, object);
    if (resolved && resolved.node !== object) return schemaFromObject(project, resolved.file, resolved.node, seen, depth + 1, calc);
    return null;
  }
  const properties = {};
  const required = [];
  for (const item of object.properties) {
    if (ts.isSpreadAssignment(item)) {
      const nested = schemaFromObject(project, file, item.expression, seen, depth + 1, calc);
      if (!nested) { note(project, "SCHEMA_SPREAD", "Cannot statically resolve object spread", item); continue; }
      Object.assign(properties, nested.properties);
      required.push(...(nested.required ?? []));
      continue;
    }
    if (!ts.isPropertyAssignment(item) && !ts.isShorthandPropertyAssignment(item)) continue;
    const key = propertyName(item.name) ?? (ts.isComputedPropertyName(item.name) ? project.staticValue(file, item.name.expression) : null);
    if (key === null || key === undefined) { note(project, "SCHEMA_PROPERTY", "Dynamic schema property cannot be represented", item); continue; }
    const result = calc(file, ts.isPropertyAssignment(item) ? item.initializer : item.name, seen, depth + 1) ?? {};
    if (!result[mark]) required.push(String(key));
    delete result[mark];
    properties[String(key)] = result;
  }
  return { type: "object", properties, ...(required.length ? { required: [...new Set(required)] } : {}) };
}
function zodRoot(project, file, callee) {
  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return false;
  let root = unwrap(callee.expression);
  while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) root = unwrap(root.expression);
  if (!ts.isIdentifier(root)) return false;
  const imp = project.file(file)?.imports.get(root.text);
  return imp?.spec === "zod" || imp?.spec === "zod/v4" || imp?.spec?.startsWith("zod/v4/");
}
export function schemaFromExpression(project, file, root) {
  const calc = (file, node, seen = new Set(), depth = 0) => {
    if (!node || depth > 45 || seen.size > 180) return null;
    node = unwrap(node);
    const marker = `${file}:${node.pos}:${node.end}`;
    if (seen.has(marker)) { note(project, "SCHEMA_RECURSION", "Recursive schema reduced to unknown", node); return {}; }
    const next = new Set(seen); next.add(marker);
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const reference = project.resolveExpression(file, node);
      if (reference && reference.node !== node) return calc(reference.file, reference.node, next, depth + 1);
      return null;
    }
    if (!ts.isCallExpression(node)) return null;
    const operation = member(node.expression);
    if (!operation) return null;
    const base = unwrap(node.expression.expression);
    const args = node.arguments;
    const value = (index = 0) => resolveLiteral(project, file, args[index]);
    if (zodRoot(project, file, node.expression) && (
      ts.isIdentifier(base) || (ts.isPropertyAccessExpression(base) && ["coerce", "iso", "z"].includes(member(base)))
    )) {
      const known = basic[operation];
      if (known) return copy(known);
      switch (operation) {
        case "object": case "strictObject": case "looseObject": {
          const schema = schemaFromObject(project, file, args[0], next, depth + 1, calc);
          if (schema && operation === "strictObject") schema.additionalProperties = false;
          return schema;
        }
        case "array": return { type: "array", items: calc(file, args[0], next, depth + 1) ?? {} };
        case "tuple": return ts.isArrayLiteralExpression(args[0]) ? {
          type: "array", prefixItems: args[0].elements.map((item) => calc(file, item, next, depth + 1) ?? {}),
          minItems: args[0].elements.length, maxItems: args[0].elements.length,
        } : { type: "array" };
        case "union": case "discriminatedUnion": {
          const array = operation === "union" ? args[0] : args[1];
          return ts.isArrayLiteralExpression(array) ? { anyOf: array.elements.map((part) => calc(file, part, next, depth + 1) ?? {}) } : {};
        }
        case "intersection": return { allOf: args.slice(0, 2).map((part) => calc(file, part, next, depth + 1) ?? {}) };
        case "literal": {
          const literal = value();
          return literal === undefined ? {} : Array.isArray(literal) ? { enum: literal } : { const: literal };
        }
        case "enum": return Array.isArray(value()) ? { type: "string", enum: value() } : { type: "string", ...((value() && typeof value() === "object") ? { enum: Object.values(value()) } : {}) };
        case "nativeEnum": return value() && typeof value() === "object" ? { enum: Object.values(value()) } : {};
        case "record": return { type: "object", additionalProperties: calc(file, args.at(-1), next, depth + 1) ?? {} };
        case "set": return { type: "array", uniqueItems: true, items: calc(file, args[0], next, depth + 1) ?? {} };
        case "map": return { type: "array", items: { type: "array", prefixItems: args.slice(0, 2).map((item) => calc(file, item, next, depth + 1) ?? {}), minItems: 2, maxItems: 2 } };
        case "optional": { const child = calc(file, args[0], next, depth + 1) ?? {}; child[mark] = true; return child; }
        case "nullable": return { anyOf: [calc(file, args[0], next, depth + 1) ?? {}, { type: "null" }] };
        case "default": case "prefault": { const child = calc(file, args[0], next, depth + 1) ?? {}; child[mark] = true; return child; }
        case "lazy": { note(project, "SCHEMA_LAZY", "Lazy schema cannot be fully resolved statically", node); return {}; }
        case "promise": return calc(file, args[0], next, depth + 1) ?? {};
        default: return null;
      }
    }
    const schema = calc(file, base, next, depth + 1);
    if (!schema) return null;
    const out = copy(schema);
    switch (operation) {
      case "optional": case "default": case "prefault": case "catch": out[mark] = true; if (operation === "default" && value() !== undefined) out.default = value(); return out;
      case "nullable": case "nullish": {
        const result = { anyOf: [out, { type: "null" }] };
        if (operation === "nullish") result[mark] = true;
        return result;
      }
      case "array": return { type: "array", items: out };
      case "or": return { anyOf: [out, calc(file, args[0], next, depth + 1) ?? {}] };
      case "and": return { allOf: [out, calc(file, args[0], next, depth + 1) ?? {}] };
      case "min": case "max": {
        const target = operation === "min" ? { string: "minLength", array: "minItems", integer: "minimum", number: "minimum" } : { string: "maxLength", array: "maxItems", integer: "maximum", number: "maximum" };
        const prop = target[out.type]; if (prop && typeof value() === "number") out[prop] = value(); return out;
      }
      case "length": if (typeof value() === "number") {
        const min = out.type === "array" ? "minItems" : "minLength";
        const max = out.type === "array" ? "maxItems" : "maxLength";
        out[min] = value(); out[max] = value();
      } return out;
      case "positive": out.exclusiveMinimum = 0; return out;
      case "negative": out.exclusiveMaximum = 0; return out;
      case "nonnegative": out.minimum = 0; return out;
      case "nonpositive": out.maximum = 0; return out;
      case "gt": if (typeof value() === "number") out.exclusiveMinimum = value(); return out;
      case "gte": if (typeof value() === "number") out.minimum = value(); return out;
      case "lt": if (typeof value() === "number") out.exclusiveMaximum = value(); return out;
      case "lte": if (typeof value() === "number") out.maximum = value(); return out;
      case "int": case "safe": out.type = "integer"; return out;
      case "email": out.format = "email"; return out;
      case "uuid": out.format = "uuid"; return out;
      case "url": out.format = "uri"; return out;
      case "datetime": out.format = "date-time"; return out;
      case "regex": {
        if (args[0] && ts.isRegularExpressionLiteral(args[0])) {
          const raw = args[0].text;
          const match = /^\/(.*)\/([a-z]*)$/s.exec(raw);
          if (match) out.pattern = match[1];
        } else note(project, "SCHEMA_REGEX", "Dynamic regular expression unavailable", node);
        return out;
      }
      case "describe": if (typeof value() === "string") out.description = value(); return out;
      case "meta": if (value() && typeof value() === "object") Object.assign(out, value()); return out;
      case "strict": out.additionalProperties = false; return out;
      case "passthrough": case "loose": out.additionalProperties = true; return out;
      case "extend": case "safeExtend": {
        const right = schemaFromObject(project, file, args[0], next, depth + 1, calc);
        if (out.type !== "object" || !right) return out;
        out.properties = { ...out.properties, ...right.properties };
        out.required = [...new Set([...(out.required ?? []), ...(right.required ?? [])])];
        return out;
      }
      case "merge": {
        const right = calc(file, args[0], next, depth + 1);
        if (out.type !== "object" || right?.type !== "object") return out;
        out.properties = { ...out.properties, ...right.properties };
        out.required = [...new Set([...(out.required ?? []), ...(right.required ?? [])])];
        return out;
      }
      case "omit": case "pick": {
        const selection = value() ?? {};
        if (out.type !== "object") return out;
        for (const key of Object.keys(out.properties)) {
          if (operation === "omit" ? selection[key] : !selection[key]) delete out.properties[key];
        }
        out.required = (out.required ?? []).filter((name) => Object.hasOwn(out.properties, name));
        return out;
      }
      case "partial": {
        const selection = value();
        out.required = selection && typeof selection === "object" ? (out.required ?? []).filter((name) => !selection[name]) : [];
        return out;
      }
      case "required": {
        const selection = value();
        out.required = selection && typeof selection === "object" ? [...new Set([...(out.required ?? []), ...Object.keys(selection).filter((k) => selection[k])])] : Object.keys(out.properties ?? {});
        return out;
      }
      case "nonempty": if (out.type === "array") out.minItems = 1; else if (out.type === "string") out.minLength = 1; return out;
      case "pipe": return combinePipe(out, calc(file, args[0], next, depth + 1));
      case "refine": {
        if (out.type === "object" && requiresNonEmptyObject(args[0])) {
          out.minProperties = Math.max(out.minProperties ?? 0, 1);
        } else {
          out["x-swaggerdoc-runtime-validation"] = true;
        }
        addDescription(out, refinementMessage(project, file, args[1]));
        return out;
      }
      case "superRefine": case "check": case "custom":
        out["x-swaggerdoc-runtime-validation"] = true;
        addDescription(out, null);
        return out;
      case "transform": case "overwrite":
        // These change the parsed output, not the accepted wire input.
        return out;
      case "trim": case "toLowerCase": case "toUpperCase": case "readonly": case "brand": return out;
      default:
        note(project, "SCHEMA_METHOD", `Unknown schema method '${operation}'`, node);
        return out;
    }
  };
  const schema = calc(file, root);
  if (schema) delete schema[mark];
  return schema;
}
