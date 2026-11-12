import http from "node:http";
import { syntax as ts, member, propertyName, unwrap, walk } from "./project.js";
import { schemaFromExpression } from "./schemas.js";

const phrases = new Map(Object.entries(http.STATUS_CODES).map(([code, name]) => [name.toUpperCase().replace(/[^A-Z0-9]/g, ""), Number(code)]));
export const statusText = (code) => http.STATUS_CODES[code] ?? "Response";
const names = (text) => typeof text === "string" ? text.toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
const functionLike = (node) => node && (ts.isArrowFunction(node) || ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node));
const empty = () => ({});
const unique = (items) => [...new Set(items)];
const unwrapAwait = (expr) => { let node = unwrap(expr); while (node && ts.isAwaitExpression(node)) node = unwrap(node.expression); return node; };

function scopeOf(fn) {
  const binds = new Map();
  const destructured = new Map();
  walk(fn.body ?? fn, (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) binds.set(node.name.text, node.initializer);
      else if (ts.isObjectBindingPattern(node.name)) for (const element of node.name.elements) {
        const key = element.propertyName ? propertyName(element.propertyName) : propertyName(element.name);
        if (key && ts.isIdentifier(element.name)) destructured.set(element.name.text, { source: node.initializer, key });
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) binds.set(node.left.text, node.right);
  });
  const parameterName = (index, fallback) => {
    const param = fn.parameters?.[index]?.name;
    return param && ts.isIdentifier(param) ? param.text : fallback;
  };
  return { binds, destructured, req: parameterName(0, "req"), res: parameterName(1, "res") };
}
function resolveLocal(project, file, node, scope, depth = 0) {
  node = unwrapAwait(node);
  if (depth > 15 || !node) return node;
  if (ts.isIdentifier(node) && scope.binds.has(node.text)) {
    const initial = scope.binds.get(node.text);
    if (initial !== node) return resolveLocal(project, file, initial, scope, depth + 1);
  }
  const resolved = project.resolveExpression(file, node);
  if (resolved && resolved.node !== node) return resolveLocal(project, resolved.file, resolved.node, scope, depth + 1);
  return node;
}
function expressionLocation(project, file, expression, scope, depth = 0) {
  if (!expression || depth > 12) return null;
  expression = unwrapAwait(expression);
  if (ts.isIdentifier(expression) && scope.binds.has(expression.text)) return expressionLocation(project, file, scope.binds.get(expression.text), scope, depth + 1);
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    const prop = member(expression) ?? (ts.isElementAccessExpression(expression) ? project.staticValue(file, expression.argumentExpression) : null);
    const source = unwrap(expression.expression);
    if (ts.isIdentifier(source) && source.text === scope.req) return { kind: prop };
    const base = expressionLocation(project, file, source, scope, depth + 1);
    if (base) return base;
  }
  return null;
}
function responseRoot(expression, name) {
  let current = unwrap(expression);
  for (let depth = 0; depth < 10; depth++) {
    if (ts.isIdentifier(current)) return current.text === name;
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) current = unwrap(current.expression);
    else if (ts.isCallExpression(current)) current = unwrap(current.expression);
    else return false;
  }
  return false;
}
function returnedObject(project, file, expression, scope, visited = new Set(), depth = 0) {
  if (depth > 12) return [];
  let node = unwrapAwait(expression);
  if (!node) return [];
  const key = `${file}:${node.pos}:${node.end}`;
  if (visited.has(key)) return [];
  const seen = new Set(visited); seen.add(key);
  if (ts.isObjectLiteralExpression(node)) return [{ file, node, scope }];
  if (ts.isConditionalExpression(node)) return [...returnedObject(project, file, node.whenTrue, scope, seen, depth + 1), ...returnedObject(project, file, node.whenFalse, scope, seen, depth + 1)];
  if (ts.isIdentifier(node)) {
    const local = scope.binds.get(node.text);
    if (local && local !== node) return returnedObject(project, file, local, scope, seen, depth + 1);
  }
  if (ts.isCallExpression(node)) {
    const target = project.resolveExpression(file, node.expression);
    if (target && functionLike(target.node)) {
      const childScope = scopeOf(target.node);
      const out = [];
      walk(target.node.body, (inner) => {
        if (ts.isReturnStatement(inner) && inner.expression) out.push(...returnedObject(project, target.file, inner.expression, childScope, seen, depth + 1));
      });
      return out;
    }
  }
  const resolved = project.resolveExpression(file, node);
  if (resolved && resolved.node !== node) return returnedObject(project, resolved.file, resolved.node, scope, seen, depth + 1);
  return [];
}
function statusValues(project, file, expression, scope, depth = 0) {
  if (!expression || depth > 12) return [];
  const node = unwrapAwait(expression);
  const known = project.staticValue(file, node);
  if (typeof known === "number" && known >= 100 && known < 600) return [known];
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const name = member(node) ?? project.staticValue(file, node.argumentExpression);
    if (name === "status" || name === "statusCode") {
      const result = returnedObject(project, file, node.expression, scope);
      return unique(result.flatMap((item) => {
        const field = item.node.properties.find((p) => ts.isPropertyAssignment(p) && propertyName(p.name) === name);
        return field ? statusValues(project, item.file, field.initializer, item.scope, depth + 1) : [];
      }));
    }
    const mapped = phrases.get(names(name));
    if (mapped) return [mapped];
  }
  if (ts.isIdentifier(node)) {
    if (scope.destructured.has(node.text)) {
      const { source, key } = scope.destructured.get(node.text);
      const results = returnedObject(project, file, source, scope);
      return unique(results.flatMap((item) => {
        const attr = item.node.properties.find((p) => ts.isPropertyAssignment(p) && propertyName(p.name) === key);
        return attr ? statusValues(project, item.file, attr.initializer, item.scope, depth + 1) : [];
      }));
    }
    const bound = scope.binds.get(node.text);
    if (bound && bound !== node) return statusValues(project, file, bound, scope, depth + 1);
  }
  if (ts.isConditionalExpression(node)) return unique([...statusValues(project, file, node.whenTrue, scope, depth + 1), ...statusValues(project, file, node.whenFalse, scope, depth + 1)]);
  return [];
}
// Preserve values explicitly declared in source code without executing the API.
// Scope-aware resolution handles `const result = await service.method()` and
// `const { status, message } = await service.method()` alike.
function textValues(project, file, expression, scope, depth = 0, visited = new Set()) {
  if (!expression || depth > 14) return [];
  const node = unwrapAwait(expression);
  if (!node) return [];
  const position = `${file}:${node.pos}:${node.end}`;
  if (visited.has(position)) return [];
  const next = new Set(visited); next.add(position);
  const literal = project.staticValue(file, node);
  if (typeof literal === "string") return [literal];
  if (ts.isConditionalExpression(node)) {
    return unique([
      ...textValues(project, file, node.whenTrue, scope, depth + 1, next),
      ...textValues(project, file, node.whenFalse, scope, depth + 1, next),
    ]);
  }
  if (ts.isIdentifier(node)) {
    const destructured = scope.destructured.get(node.text);
    if (destructured) return unique(returnedObject(project, file, destructured.source, scope).flatMap((entry) => {
      const property = entry.node.properties.find((part) =>
        ts.isPropertyAssignment(part) && propertyName(part.name) === destructured.key);
      return property ? textValues(project, entry.file, property.initializer, entry.scope, depth + 1, next) : [];
    }));
    const local = scope.binds.get(node.text);
    if (local && local !== node) return textValues(project, file, local, scope, depth + 1, next);
  }
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const name = member(node) ?? (ts.isElementAccessExpression(node) ? project.staticValue(file, node.argumentExpression) : null);
    if (typeof name === "string") return unique(returnedObject(project, file, node.expression, scope).flatMap((entry) => {
      const property = entry.node.properties.find((part) =>
        ts.isPropertyAssignment(part) && propertyName(part.name) === name);
      return property ? textValues(project, entry.file, property.initializer, entry.scope, depth + 1, next) : [];
    }));
  }
  const resolved = project.resolveExpression(file, node);
  if (resolved && (resolved.node !== node || resolved.file !== file)) {
    return textValues(project, resolved.file, resolved.node, scope, depth + 1, next);
  }
  return [];
}
function knownFieldSchema(kind, values) {
  const items = unique(values.filter((value) =>
    kind === "status" ? Number.isInteger(value) && value >= 100 && value < 600 : typeof value === "string"));
  if (!items.length) return null;
  const field = { type: kind === "status" ? "integer" : "string" };
  if (items.length === 1) field.const = items[0];
  else field.enum = items;
  field.example = items[0];
  return field;
}
// Infer only columns declared on a local Sequelize model. The fields are
// partial for safety: includes, computed getters and scopes can add values.
function sequelizeDefinitionShape(project, modelFile, definition, sourceFile = modelFile, query = null) {
  const declarations = unwrap(definition.arguments[1]);
  if (!declarations || !ts.isObjectLiteralExpression(declarations)) return {};
  const modelOptions = project.staticValue(modelFile, definition.arguments[2]) ?? {};
  const exclusions = new Set(modelOptions.defaultScope?.attributes?.exclude ?? []);
  let selection = null;
  query = unwrap(query);
  if (query && ts.isObjectLiteralExpression(query)) {
    const attr = query.properties.find((part) => ts.isPropertyAssignment(part) && propertyName(part.name) === "attributes");
    if (attr) {
      const selected = project.staticValue(sourceFile, attr.initializer);
      if (Array.isArray(selected)) selection = new Set(selected);
      else if (selected && typeof selected === "object") {
        for (const field of selected.exclude ?? []) exclusions.add(field);
      }
    }
  }
  const columns = {};
  for (const declaration of declarations.properties) {
    if (!ts.isPropertyAssignment(declaration)) continue;
    const name = propertyName(declaration.name);
    if (!name || exclusions.has(name) || (selection && !selection.has(name))) continue;
    const settings = unwrap(declaration.initializer);
    if (!ts.isObjectLiteralExpression(settings)) continue;
    const field = settings.properties.find((part) => ts.isPropertyAssignment(part) && propertyName(part.name) === "type");
    if (!field) continue;
    let value = unwrap(field.initializer);
    if (ts.isCallExpression(value)) value = unwrap(value.expression);
    let datatype = member(value);
    if (datatype === "UNSIGNED" || datatype === "ZEROFILL") datatype = member(value.expression);
    const col = {
      UUID: { type: "string", format: "uuid" }, UUIDV4: { type: "string", format: "uuid" },
      STRING: { type: "string" }, TEXT: { type: "string" }, CHAR: { type: "string" },
      BOOLEAN: { type: "boolean" }, DATE: { type: "string", format: "date-time" }, DATEONLY: { type: "string", format: "date" },
      INTEGER: { type: "integer" }, BIGINT: { type: "integer" }, SMALLINT: { type: "integer" }, TINYINT: { type: "integer" },
      FLOAT: { type: "number" }, DOUBLE: { type: "number" }, REAL: { type: "number" }, DECIMAL: { type: "number" },
      JSON: {}, JSONB: {}, BLOB: { type: "string", format: "byte" },
    }[datatype];
    if (!col) continue;
    const nullable = settings.properties.find((part) => ts.isPropertyAssignment(part) && propertyName(part.name) === "allowNull");
    const primary = settings.properties.find((part) => ts.isPropertyAssignment(part) && propertyName(part.name) === "primaryKey");
    const notNull = (nullable && project.staticValue(modelFile, nullable.initializer) === false) ||
      (primary && project.staticValue(modelFile, primary.initializer) === true);
    columns[name] = notNull ? col : { anyOf: [col, { type: "null" }] };
  }
  if (modelOptions.timestamps !== false) for (const field of ["createdAt", "updatedAt"]) {
    if (!exclusions.has(field) && (!selection || selection.has(field))) columns[field] ??= { type: "string", format: "date-time" };
  }
  return Object.keys(columns).length ? { type: "object", properties: columns } : { type: "object" };
}
function sequelizeModelShape(project, file, call) {
  const target = project.resolveExpression(file, call.expression.expression);
  const definition = unwrap(target?.node);
  if (!definition || !ts.isCallExpression(definition) || member(definition.expression) !== "define") return {};
  return sequelizeDefinitionShape(project, target.file, definition, file, call.arguments[0]);
}
// Object.fromEntries may expose model fields via computed keys. Only infer
// their types when one local Sequelize definition matches all of the keys.
function modelFieldsByNames(project, names) {
  const meaningful = names.filter((key) => !["status", "createdAt", "updatedAt", "deletedAt"].includes(key));
  if (meaningful.length < 2) return {};
  if (!project._swaggerdocModelCatalog) {
    const found = [];
    for (const [file, source] of project.cache) {
      const walkModels = (node) => {
        if (ts.isCallExpression(node) && member(node.expression) === "define" &&
          ts.isObjectLiteralExpression(unwrap(node.arguments[1]))) {
          const schema = sequelizeDefinitionShape(project, file, node);
          if (schema.properties) found.push(schema.properties);
        }
        ts.forEachChild(node, walkModels);
      };
      walkModels(source.ast);
    }
    project._swaggerdocModelCatalog = found;
  }
  const matches = project._swaggerdocModelCatalog.filter((fields) => meaningful.every((key) => Object.hasOwn(fields, key)));
  if (matches.length !== 1) return {};
  return Object.fromEntries(names.filter((name) => Object.hasOwn(matches[0], name)).map((name) => [name, matches[0][name]]));
}

function shape(project, file, expression, scope, depth = 0) {
  if (!expression || depth > 15) return {};
  const node = unwrapAwait(expression);
  const literal = project.staticValue(file, node);
  if (literal === null) return { type: "null" };
  if (typeof literal === "string") return { type: "string" };
  if (typeof literal === "boolean") return { type: "boolean" };
  if (typeof literal === "number") return { type: Number.isInteger(literal) ? "integer" : "number" };
  if (ts.isObjectLiteralExpression(node)) {
    const properties = {}, required = [];
    for (const prop of node.properties) {
      if (ts.isSpreadAssignment(prop)) {
        const extra = shape(project, file, prop.expression, scope, depth + 1);
        Object.assign(properties, extra.properties ?? {}); required.push(...(extra.required ?? [])); continue;
      }
      if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) continue;
      const key = propertyName(prop.name);
      if (!key) continue;
      const expression = ts.isShorthandPropertyAssignment(prop) ? prop.name : prop.initializer;
      const inferred = shape(project, file, expression, scope, depth + 1);
      const explicit = key === "status"
        ? knownFieldSchema("status", statusValues(project, file, expression, scope))
        : key === "message" ? knownFieldSchema("message", textValues(project, file, expression, scope)) : null;
      properties[key] = explicit ?? inferred;
      required.push(key);
    }
    return { type: "object", properties, ...(required.length ? { required: unique(required) } : {}) };
  }
  if (ts.isArrayLiteralExpression(node)) return { type: "array", items: node.elements.length ? shape(project, file, node.elements[0], scope, depth + 1) : {} };
  if (ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { type: "string" };
  // A Date serializes to an ISO 8601 string when passed to res.json().
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Date") {
    return { type: "string", format: "date-time" };
  }
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const key = member(node) ?? (ts.isElementAccessExpression(node) ? project.staticValue(file, node.argumentExpression) : null);
    if (key === "length") return { type: "integer", minimum: 0 };
    const sourceSchema = shape(project, file, node.expression, scope, depth + 1);
    if (sourceSchema.type === "object" && typeof key === "string" && sourceSchema.properties?.[key]) {
      return sourceSchema.properties[key];
    }
  }
  if (ts.isBinaryExpression(node)) {
    if ([ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind)) {
      const left = shape(project, file, node.left, scope, depth + 1);
      const right = shape(project, file, node.right, scope, depth + 1);
      return Object.keys(left).length ? left : right;
    }
    if ([ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken,
      ts.SyntaxKind.SlashToken, ts.SyntaxKind.PercentToken].includes(node.operatorToken.kind)) {
      const left = shape(project, file, node.left, scope, depth + 1);
      const right = shape(project, file, node.right, scope, depth + 1);
      if (node.operatorToken.kind === ts.SyntaxKind.PlusToken && (left.type === "string" || right.type === "string")) return { type: "string" };
      if (left.type === "integer" && right.type === "integer" && node.operatorToken.kind !== ts.SyntaxKind.SlashToken) return { type: "integer" };
      return { type: "number" };
    }
    if ([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.LessThanToken].includes(node.operatorToken.kind)) return { type: "boolean" };
    if ([ts.SyntaxKind.PlusToken].includes(node.operatorToken.kind) && shape(project, file, node.left, scope, depth + 1).type === "string") return { type: "string" };
    if ([ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.SlashToken].includes(node.operatorToken.kind)) return { type: "number" };
  }
  if (ts.isPrefixUnaryExpression(node)) return node.operator === ts.SyntaxKind.ExclamationToken ? { type: "boolean" } : { type: "number" };
  if (ts.isConditionalExpression(node)) {
    const a = shape(project, file, node.whenTrue, scope, depth + 1);
    const b = shape(project, file, node.whenFalse, scope, depth + 1);
    return JSON.stringify(a) === JSON.stringify(b) ? a : { anyOf: [a, b] };
  }
  if (ts.isIdentifier(node)) {
    const incoming = scope.argumentSchemas?.get(node.text);
    if (incoming && Object.keys(incoming).length) return incoming;
    if (scope.destructured.has(node.text)) {
      const { source, key } = scope.destructured.get(node.text);
      const sourceValue = unwrapAwait(source);
      if (ts.isCallExpression(sourceValue) && member(sourceValue.expression) === "findAndCountAll") {
        if (key === "count") return { type: "integer", minimum: 0 };
        if (key === "rows") return { type: "array", items: sequelizeModelShape(project, file, sourceValue) };
      }
      const sourceShape = shape(project, file, source, scope, depth + 1);
      if (sourceShape.type === "object" && sourceShape.properties?.[key]) return sourceShape.properties[key];
      const responses = returnedObject(project, file, source, scope);
      const variants = responses.map((entry) => {
        const found = entry.node.properties.find((prop) => ts.isPropertyAssignment(prop) && propertyName(prop.name) === key);
        return found ? shape(project, entry.file, found.initializer, entry.scope, depth + 1) : null;
      }).filter(Boolean);
      if (variants.length) return variants.length === 1 ? variants[0] : { anyOf: variants };
    }
    const local = scope.binds.get(node.text);
    if (local && node !== local) return shape(project, file, local, scope, depth + 1);
  }
  if (ts.isCallExpression(node)) {
    if (ts.isIdentifier(node.expression)) {
      if (node.expression.text === "String") return { type: "string" };
      if (node.expression.text === "Number") return { type: "number" };
      if (node.expression.text === "Boolean") return { type: "boolean" };
    }
    const method = member(node.expression);
    if (method === "fromEntries" && ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "Object") {
      const entries = unwrap(node.arguments[0]);
      const properties = {};
      if (entries && ts.isArrayLiteralExpression(entries)) for (const element of entries.elements) {
        if (ts.isArrayLiteralExpression(element) && element.elements.length >= 2) {
          const key = project.staticValue(file, element.elements[0]);
          if (typeof key === "string") properties[key] = shape(project, file, element.elements[1], scope, depth + 1);
        } else if (ts.isSpreadElement(element)) {
          const values = unwrap(element.expression);
          if (!ts.isCallExpression(values) || member(values.expression) !== "map") continue;
          const names = project.staticValue(file, values.expression.expression);
          if (Array.isArray(names)) for (const name of names) if (typeof name === "string") properties[name] ??= {};
        }
      }
      const inferred = modelFieldsByNames(project, Object.keys(properties));
      return { type: "object", properties: { ...properties, ...inferred } };
    }
    if (method === "count") return { type: "integer", minimum: 0 };
    if (["findAll", "findAndCountAll"].includes(method)) {
      const item = sequelizeModelShape(project, file, node);
      return method === "findAll" ? { type: "array", items: item } : {
        type: "object", properties: { rows: { type: "array", items: item }, count: { type: "integer", minimum: 0 } },
        required: ["rows", "count"],
      };
    }
    if (method === "findByPk" || method === "findOne") return sequelizeModelShape(project, file, node);
    if (["toISOString", "toJSON"].includes(method)) return method === "toISOString" ? { type: "string", format: "date-time" } : {};
    if (["slice", "trim", "toLowerCase", "toUpperCase", "substring", "replace"].includes(method)) {
      const receiver = shape(project, file, node.expression.expression, scope, depth + 1);
      if (receiver.type === "string") return { type: "string" };
    }
    if (["max", "min", "floor", "ceil", "round", "abs"].includes(method) &&
      ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Math") {
      const argumentsSchemas = node.arguments.map((item) => shape(project, file, item, scope, depth + 1));
      return argumentsSchemas.length && argumentsSchemas.every((item) => item.type === "integer")
        ? { type: "integer" } : { type: "number" };
    }
    if (method === "map" || method === "filter") {
      const original = shape(project, file, node.expression.expression, scope, depth + 1);
      if (method === "filter") return original.type === "array" ? original : { type: "array", items: {} };
      const callback = unwrap(node.arguments[0]);
      if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
        const item = shape(project, file, callback.body, scope, depth + 1);
        return { type: "array", items: item };
      }
      return { type: "array", items: {} };
    }
    // In addition to object literals, follow direct helper returns such as
    // `return "active"` or `return Object.fromEntries(...)`.
    const target = project.resolveExpression(file, node.expression);
    if (target && functionLike(target.node)) {
      const childScope = scopeOf(target.node);
      childScope.argumentSchemas = new Map();
      for (let index = 0; index < target.node.parameters.length; index++) {
        const parameter = target.node.parameters[index].name;
        if (ts.isIdentifier(parameter) && node.arguments[index]) {
          childScope.argumentSchemas.set(parameter.text, shape(project, file, node.arguments[index], scope, depth + 1));
        }
      }
      const expressions = [];
      const visit = (child) => {
        if (child !== target.node && functionLike(child)) return;
        if (ts.isReturnStatement(child) && child.expression) expressions.push(child.expression);
        ts.forEachChild(child, visit);
      };
      visit(target.node.body ?? target.node);
      if (expressions.length) {
        const values = expressions.map((value) => shape(project, target.file, value, childScope, depth + 1));
        const meaningful = values.filter((value) => Object.keys(value).length);
        if (meaningful.length === 1) return meaningful[0];
        if (meaningful.length > 1) {
          const unique = [...new Map(meaningful.map((value) => [JSON.stringify(value), value])).values()];
          return unique.length === 1 ? unique[0] : { anyOf: unique };
        }
      }
    }
    const returns = returnedObject(project, file, node, scope);
    if (returns.length) {
      const variants = returns.map((value) => shape(project, value.file, value.node, value.scope, depth + 1));
      return variants.length === 1 ? variants[0] : { anyOf: variants };
    }
  }
  if (statusValues(project, file, node, scope).length) return { type: "integer" };
  if (ts.isPropertyAccessExpression(node) && member(node) === "status") return { type: "integer" };
  return {};
}
function fnBodies(project, file, expr, depth = 0) {
  const current = unwrapAwait(expr);
  if (!current || depth > 8) return [];
  if (functionLike(current)) return [{ file, fn: current }];
  if (ts.isCallExpression(current)) {
    const invoked = project.resolveExpression(file, current.expression);
    if (invoked && functionLike(invoked.node)) {
      const all = [{ file: invoked.file, fn: invoked.node }];
      walk(invoked.node.body, (node) => {
        if (ts.isReturnStatement(node) && node.expression) {
          if (functionLike(node.expression)) all.push({ file: invoked.file, fn: node.expression });
        }
      });
      return all;
    }
  }
  const ref = project.resolveExpression(file, current);
  if (ref && ref.node !== current) return fnBodies(project, ref.file, ref.node, depth + 1);
  return [];
}
function securityOf(project, file, fn, scope, errors) {
  if (![401, 403].some((code) => errors.has(code))) return [];
  const found = [];
  walk(fn.body ?? fn, (node) => {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const source = unwrap(node.expression);
      if (!ts.isPropertyAccessExpression(source) && !ts.isElementAccessExpression(source)) return;
      const request = unwrap(source.expression);
      if (!ts.isIdentifier(request) || request.text !== scope.req) return;
      const kind = member(source);
      if (!["headers", "cookies", "query", "signedCookies"].includes(kind)) return;
      const key = ts.isPropertyAccessExpression(node) ? node.name.text : project.staticValue(file, node.argumentExpression);
      if (typeof key === "string" && key) found.push({ in: kind === "headers" ? "header" : kind === "signedCookies" ? "cookie" : kind === "cookies" ? "cookie" : "query", name: key });
    }
    if (ts.isCallExpression(node) && ["get", "header"].includes(member(node.expression))) {
      const receiver = node.expression.expression;
      if (ts.isIdentifier(receiver) && receiver.text === scope.req) {
        const name = project.staticValue(file, node.arguments[0]);
        if (typeof name === "string") found.push({ in: "header", name });
      }
    }
  });
  return found;
}
function outputOf(project, file, fn, scope) {
  const responses = [];
  const errors = new Set();
  const errorMessages = new Map();
  const dto = [];
  const securityCandidates = [];
  const warned = new Set();
  walk(fn.body ?? fn, (node) => {
    if (ts.isThrowStatement(node) && node.expression) {
      const exception = unwrap(node.expression);
      if (ts.isNewExpression(exception) || ts.isCallExpression(exception)) {
        const possible = statusValues(project, file, exception.arguments?.[0], scope);
        const messages = textValues(project, file, exception.arguments?.[1], scope);
        for (const status of possible) if (status >= 400) {
          errors.add(status);
          if (messages.length) {
            if (!errorMessages.has(status)) errorMessages.set(status, new Set());
            for (const message of messages) errorMessages.get(status).add(message);
          }
        }
      }
    }
    if (ts.isCallExpression(node)) {
      const method = member(node.expression);
      if (ts.isIdentifier(node.expression) && project.file(file)?.imports.get(node.expression.text)?.spec === "express-rate-limit") {
        const options = unwrap(node.arguments[0]);
        if (options && ts.isObjectLiteralExpression(options)) {
          const configured = (field) => options.properties.find((part) => ts.isPropertyAssignment(part) && propertyName(part.name) === field);
          const code = configured("statusCode");
          const statusList = statusValues(project, file, code?.initializer, scope);
          const message = configured("message");
          const content = message && unwrap(message.initializer);
          const messageField = content && ts.isObjectLiteralExpression(content)
            ? content.properties.find((part) => ts.isPropertyAssignment(part) && propertyName(part.name) === "message") : null;
          const literals = textValues(project, file, messageField?.initializer, scope);
          for (const status of statusList) if (status >= 400) {
            errors.add(status);
            if (literals.length) {
              if (!errorMessages.has(status)) errorMessages.set(status, new Set());
              for (const item of literals) errorMessages.get(status).add(item);
            }
          }
        }
      }
      if (["parse", "parseAsync", "safeParse", "safeParseAsync"].includes(method) && node.arguments.length) {
        const location = expressionLocation(project, file, node.arguments[0], scope);
        if (location && ["body", "query", "params", "headers", "cookies"].includes(location.kind)) {
          const ref = project.resolveExpression(file, node.expression.expression);
          if (ref) {
            const schema = schemaFromExpression(project, ref.file, ref.node);
            if (schema) dto.push({ kind: location.kind, json: schema });
            else if (!warned.has(`${location.kind}:${file}`)) {
              warned.add(`${location.kind}:${file}`);
              project.diagnostics.push({ level: "warning", code: "UNRESOLVED_VALIDATOR", message: `Validator for req.${location.kind} could not be statically converted (${file})` });
            }
          }
        }
      }
      if (!responseRoot(node.expression, scope.res)) return;
      if (method === "sendStatus") {
        for (const status of statusValues(project, file, node.arguments[0], scope)) responses.push({ status, schema: null });
      }
      if (!["json", "send", "end", "redirect"].includes(method)) return;
      let statusExpressions = [];
      let current = unwrap(node.expression.expression);
      while (current && ts.isCallExpression(current)) {
        if (member(current.expression) === "status") statusExpressions.push(current.arguments[0]);
        current = ts.isPropertyAccessExpression(current.expression) || ts.isElementAccessExpression(current.expression) ? unwrap(current.expression.expression) : null;
      }
      const statuses = statusExpressions.length ? unique(statusExpressions.flatMap((expr) => statusValues(project, file, expr, scope))) : [method === "redirect" ? 302 : 200];
      if (!statuses.length) {
        project.diagnostics.push({ level: "warning", code: "UNKNOWN_STATUS", message: `Response status cannot be inferred (${file})` });
      }
      const body = method === "json" ? shape(project, file, node.arguments[0], scope) : method === "send" ? shape(project, file, node.arguments[0], scope) : null;
      for (const status of statuses) {
        if (status >= 400) errors.add(status);
        responses.push({ status, schema: body });
      }
    }
  });
  securityCandidates.push(...securityOf(project, file, fn, scope, errors));
  return { responses, errors, errorMessages, dto, securityCandidates };
}
function analyzeExpression(project, item, depthLimit = 15, isEndpoint = false) {
  const results = { responses: [], errors: new Set(), errorMessages: new Map(), dto: [], securityCandidates: [] };
  const processed = new Set();
  const analyzeFn = (file, fn, depth) => {
    if (depth > depthLimit || processed.size > 350) {
      project.diagnostics.push({ level: "warning", code: "CALL_DEPTH", message: `Call-graph traversal limit reached at ${file}` });
      return;
    }
    const key = `${file}:${fn.pos}:${fn.end}`;
    if (processed.has(key)) return;
    processed.add(key);
    const scope = scopeOf(fn);
    const details = outputOf(project, file, fn, scope);
    results.responses.push(...details.responses);
    for (const error of details.errors) results.errors.add(error);
    for (const [status, messages] of details.errorMessages) {
      if (!results.errorMessages.has(status)) results.errorMessages.set(status, new Set());
      for (const message of messages) results.errorMessages.get(status).add(message);
    }
    results.dto.push(...details.dto);
    results.securityCandidates.push(...details.securityCandidates);
    const calls = [];
    walk(fn.body ?? fn, (node) => {
      if (ts.isCallExpression(node)) calls.push(node);
    });
    for (const call of calls) {
      if (call.expression === fn || ts.isIdentifier(call.expression) && ["next", scope.res, scope.req].includes(call.expression.text)) continue;
      const symbol = project.resolveExpression(file, call.expression);
      if (symbol && functionLike(symbol.node)) analyzeFn(symbol.file, symbol.node, depth + 1);
    }
  };
  for (const { file, fn } of fnBodies(project, item.file, item.node)) analyzeFn(file, fn, 0);
  return results;
}
export function analyzeRoute(project, route) {
  const analyzed = route.handlers.map((item, index) => ({
    ...analyzeExpression(project, item),
    endpoint: index === route.handlers.length - 1,
    conditional: item.conditional === true,
  }));
  const errors = new Set();
  const errorMessages = new Map();
  const dto = [];
  const candidates = [];
  let successes = [];
  for (const result of analyzed) {
    for (const status of result.errors) errors.add(status);
    for (const [status, messages] of result.errorMessages) {
      if (!errorMessages.has(status)) errorMessages.set(status, new Set());
      for (const message of messages) errorMessages.get(status).add(message);
    }
    dto.push(...result.dto.map((item) => ({ ...item, conditional: result.conditional })));
    if (!result.endpoint && !result.conditional) candidates.push(...result.securityCandidates);
    else successes = result.responses.filter((item) => item.status >= 200 && item.status < 400);
  }
  const distinct = [];
  for (const item of dto) {
    const existing = distinct.find((other) => other.kind === item.kind && JSON.stringify(other.json) === JSON.stringify(item.json));
    if (!existing) distinct.push(item);
    else if (!item.conditional) existing.conditional = false;
  }
  return { errors, errorMessages, dto: distinct, securityCandidates: candidates.filter((value, index, array) => array.findIndex((x) => x.in === value.in && x.name === value.name) === index), successes };
}
