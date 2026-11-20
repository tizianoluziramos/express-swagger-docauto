import http from "node:http";
import { syntax as ts, member, propertyName, unwrap, walk } from "./project.js";
import { schemaFromExpression } from "./schemas.js";
import { schemaAlternatives } from "./schema-variants.js";

const phrases = new Map(Object.entries(http.STATUS_CODES).map(([code, name]) => [name.toUpperCase().replace(/[^A-Z0-9]/g, ""), Number(code)]));
export const statusText = (code) => http.STATUS_CODES[code] ?? "Response";
const names = (text) => typeof text === "string" ? text.toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
const functionLike = (node) => node && (ts.isArrowFunction(node) || ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node));
const empty = () => ({});
const unique = (items) => [...new Set(items)];
const unwrapAwait = (expr) => { let node = unwrap(expr); while (node && ts.isAwaitExpression(node)) node = unwrap(node.expression); return node; };

function scopeOf(fn, parent) {
  const binds = new Map(parent?.binds);
  const destructured = new Map(parent?.destructured);
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
  return { binds, destructured, req: parameterName(0, "req"), res: parameterName(1, "res"),
    argumentValues: new Map(parent?.argumentValues), argumentExpressions: new Map(parent?.argumentExpressions) };
}
// Values belong to an invocation, not just a function declaration. Keep unknown
// members unknown while preserving known options passed alongside them.
function scopedValue(project, file, expression, scope, depth = 0) {
  const node = unwrapAwait(expression);
  if (!node || depth > 24) return undefined;
  const calc = (value) => scopedValue(project, file, value, scope, depth + 1);
  if (ts.isIdentifier(node)) {
    if (scope.argumentValues?.has(node.text)) return scope.argumentValues.get(node.text);
    const binding = scope.destructured.get(node.text);
    if (binding) return calc(binding.source)?.[binding.key];
    const local = scope.binds.get(node.text);
    if (local && local !== node) return calc(local);
  }
  if (ts.isObjectLiteralExpression(node)) {
    const value = {};
    for (const prop of node.properties) {
      if (ts.isSpreadAssignment(prop)) Object.assign(value, calc(prop.expression));
      else if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) {
        const key = propertyName(prop.name);
        if (key) value[key] = calc(ts.isPropertyAssignment(prop) ? prop.initializer : prop.name);
      }
    }
    return value;
  }
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(calc);
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const key = member(node) ?? calc(node.argumentExpression);
    const receiver = calc(node.expression);
    if (receiver !== undefined && receiver !== null) return receiver[key];
  }
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    const value = calc(node.operand);
    if (value !== undefined) return !value;
  }
  if (ts.isBinaryExpression(node)) {
    const left = calc(node.left);
    const kind = node.operatorToken.kind;
    // Three-valued logic: a known false conjunct makes the branch unreachable,
    // even when its other operand depends on a database result.
    if (kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      if (left !== undefined && !left) return left;
      const right = calc(node.right);
      return right !== undefined && !right ? right : left !== undefined ? right : undefined;
    }
    if (kind === ts.SyntaxKind.BarBarToken) return left !== undefined ? left || calc(node.right) : undefined;
    const right = calc(node.right);
    if (left !== undefined && right !== undefined) {
      if (kind === ts.SyntaxKind.GreaterThanToken) return left > right;
      if (kind === ts.SyntaxKind.LessThanToken) return left < right;
      if (kind === ts.SyntaxKind.EqualsEqualsEqualsToken) return left === right;
      if (kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) return left !== right;
    }
  }
  return project.staticValue(file, node);
}
function invocationScope(project, callerFile, fnFile, fn, args, parent, closure) {
  const scope = scopeOf(fn, closure);
  const bind = (pattern, value) => {
    if (ts.isIdentifier(pattern)) scope.argumentValues.set(pattern.text, value);
    else if (ts.isObjectBindingPattern(pattern)) for (const part of pattern.elements) {
      if (part.dotDotDotToken) continue;
      const key = propertyName(part.propertyName ?? part.name);
      let field = value?.[key];
      if (field === undefined && part.initializer && value !== undefined && value !== null && !Object.hasOwn(value, key)) {
        field = scopedValue(project, fnFile, part.initializer, scope);
      }
      bind(part.name, field);
    }
  };
  fn.parameters.forEach((parameter, index) => {
    let value = scopedValue(project, callerFile, args[index], parent);
    // A default applies to an omitted argument, not an unknown runtime value.
    if (index >= args.length && parameter.initializer) value = scopedValue(project, fnFile, parameter.initializer, scope);
    bind(parameter.name, value);
    if (ts.isIdentifier(parameter.name) && args[index]) {
      scope.argumentExpressions.set(parameter.name.text, { file: callerFile, node: args[index], scope: parent });
      if (responseRoot(args[index], parent.res, parent.binds)) scope.res = parameter.name.text;
      if (responseRoot(args[index], parent.req, parent.binds)) scope.req = parameter.name.text;
    }
  });
  return scope;
}
function functionTarget(project, file, expression, scope, depth = 0) {
  const node = unwrapAwait(expression);
  if (!node || depth > 20) return null;
  if (functionLike(node)) return { file, node, closure: scope };
  if (ts.isIdentifier(node)) {
    const argument = scope.argumentExpressions?.get(node.text);
    if (argument) return functionTarget(project, argument.file, argument.node, argument.scope, depth + 1);
    const local = scope.binds.get(node.text);
    if (local && local !== node) return functionTarget(project, file, local, scope, depth + 1);
  }
  return project.resolveExpression(file, node);
}
function walkReachable(project, file, node, scope, visitor) {
  if (!node) return;
  visitor(node);
  if (ts.isIfStatement(node)) {
    const condition = scopedValue(project, file, node.expression, scope);
    walkReachable(project, file, node.expression, scope, visitor);
    if (condition === undefined || condition) walkReachable(project, file, node.thenStatement, scope, visitor);
    if (condition === undefined || !condition) walkReachable(project, file, node.elseStatement, scope, visitor);
    return;
  }
  ts.forEachChild(node, (child) => walkReachable(project, file, child, scope, visitor));
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
function responseRoot(expression, name, bindings) {
  let current = unwrap(expression);
  const seen = new Set();
  for (let depth = 0; depth < 10; depth++) {
    if (!current) return false;
    if (ts.isIdentifier(current)) {
      if (current.text === name) return true;
      if (seen.has(current.text) || !bindings?.has(current.text)) return false;
      seen.add(current.text);
      current = unwrap(bindings.get(current.text));
      continue;
    }
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
    // Managed Sequelize transactions resolve to the callback's return value.
    // Do not assume that every third-party callback API has this behavior.
    if (member(node.expression) === "transaction" && member(node.expression.expression) === "sequelize") {
      const callback = node.arguments.find((arg) => functionLike(unwrap(arg)));
      if (callback) {
        const fn = unwrap(callback);
        const childScope = scopeOf(fn, scope);
        const out = [];
        const visit = (inner) => {
          if (functionLike(inner)) return;
          if (ts.isReturnStatement(inner) && inner.expression) out.push(...returnedObject(project, file, inner.expression, childScope, seen, depth + 1));
          ts.forEachChild(inner, visit);
        };
        if (ts.isBlock(fn.body)) visit(fn.body);
        else out.push(...returnedObject(project, file, fn.body, childScope, seen, depth + 1));
        return out;
      }
    }
    const target = functionTarget(project, file, node.expression, scope);
    if (target && functionLike(target.node)) {
      const childScope = invocationScope(project, file, target.file, target.node, node.arguments, scope, target.closure);
      const out = [];
      if (ts.isArrowFunction(target.node) && !ts.isBlock(target.node.body)) {
        return returnedObject(project, target.file, target.node.body, childScope, seen, depth + 1);
      }
      const visit = (inner) => {
        if (functionLike(inner)) return;
        if (ts.isReturnStatement(inner) && inner.expression) out.push(...returnedObject(project, target.file, inner.expression, childScope, seen, depth + 1));
        ts.forEachChild(inner, visit);
      };
      visit(target.node.body);
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
  const known = scopedValue(project, file, node, scope);
  if (typeof known === "number" && known >= 100 && known < 600) return [known];
  const declared = project.inference.literalValues(file, node)
    .filter((value) => Number.isInteger(value) && value >= 100 && value < 600);
  if (declared.length === 1) return declared;
  // JS object properties may widen a specific enum member to the whole enum.
  // Concrete source/argument evidence must win before a declared union.
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const name = member(node) ?? project.staticValue(file, node.argumentExpression);
    if (name === "status" || name === "statusCode") {
      const result = returnedObject(project, file, node.expression, scope);
      const values = unique(result.flatMap((item) => {
        const field = objectProperty(item.node, name);
        return field ? statusValues(project, item.file, field, item.scope, depth + 1) : [];
      }));
      if (values.length) return values;
    }
    const mapped = phrases.get(names(name));
    if (mapped) return [mapped];
  }
  if (ts.isIdentifier(node)) {
    const argument = scope.argumentExpressions?.get(node.text);
    if (argument) {
      const values = statusValues(project, argument.file, argument.node, argument.scope, depth + 1);
      if (values.length) return values;
    }
    if (scope.destructured.has(node.text)) {
      const { source, key } = scope.destructured.get(node.text);
      const results = returnedObject(project, file, source, scope);
      const values = unique(results.flatMap((item) => {
        const attr = objectProperty(item.node, key);
        return attr ? statusValues(project, item.file, attr, item.scope, depth + 1) : [];
      }));
      if (values.length) return values;
    }
    const bound = scope.binds.get(node.text);
    if (bound && bound !== node) return statusValues(project, file, bound, scope, depth + 1);
  }
  if (ts.isConditionalExpression(node)) return unique([...statusValues(project, file, node.whenTrue, scope, depth + 1), ...statusValues(project, file, node.whenFalse, scope, depth + 1)]);
  return unique(declared);
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
  const literal = scopedValue(project, file, node, scope);
  if (typeof literal === "string") return [literal];
  const declared = project.inference.literalValues(file, node).filter((value) => typeof value === "string");
  if (declared.length) return unique(declared);
  if (ts.isConditionalExpression(node)) {
    return unique([
      ...textValues(project, file, node.whenTrue, scope, depth + 1, next),
      ...textValues(project, file, node.whenFalse, scope, depth + 1, next),
    ]);
  }
  if (ts.isIdentifier(node)) {
    const destructured = scope.destructured.get(node.text);
    if (destructured) return unique(returnedObject(project, file, destructured.source, scope).flatMap((entry) => {
      const property = objectProperty(entry.node, destructured.key);
      return property ? textValues(project, entry.file, property, entry.scope, depth + 1, next) : [];
    }));
    const local = scope.binds.get(node.text);
    if (local && local !== node) return textValues(project, file, local, scope, depth + 1, next);
  }
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const name = member(node) ?? (ts.isElementAccessExpression(node) ? project.staticValue(file, node.argumentExpression) : null);
    if (typeof name === "string") return unique(returnedObject(project, file, node.expression, scope).flatMap((entry) => {
      const property = objectProperty(entry.node, name);
      return property ? textValues(project, entry.file, property, entry.scope, depth + 1, next) : [];
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
// Infer the columns selected by a Sequelize query, including association-created
// foreign keys. Eager-loaded associations are expanded separately and only when
// an explicit include is present in the query.
function sequelizeJsonValidationShape(project, file, settings) {
  const validation = resolveOptionExpression(project, file, objectProperty(settings, "validate"));
  if (!validation || !ts.isObjectLiteralExpression(validation.node)) return null;
  const schemas = [];
  for (const entry of validation.node.properties) {
    let validator = entry;
    let validatorFile = validation.file;
    if (ts.isPropertyAssignment(entry) || ts.isShorthandPropertyAssignment(entry)) {
      const resolved = project.resolveExpression(validatorFile,
        ts.isPropertyAssignment(entry) ? entry.initializer : entry.name);
      validator = resolved?.node ?? (ts.isPropertyAssignment(entry) ? unwrap(entry.initializer) : null);
      validatorFile = resolved?.file ?? validatorFile;
    }
    if (!functionLike(validator) || !validator.body || !ts.isBlock(validator.body)) continue;
    const input = validator.parameters[0]?.name;
    if (!input || !ts.isIdentifier(input)) continue;
    // Only unconditional, throwing parse calls establish a field constraint.
    // safeParse(), conditional checks and nested callbacks do not guarantee it.
    for (const statement of validator.body.statements) {
      if (!ts.isExpressionStatement(statement) && !ts.isReturnStatement(statement)) continue;
      const call = unwrap(statement.expression);
      if (!call || !ts.isCallExpression(call) || member(call.expression) !== "parse") continue;
      const argument = unwrap(call.arguments[0]);
      if (!argument || !ts.isIdentifier(argument) || argument.text !== input.text) continue;
      const schema = schemaFromExpression(project, validatorFile, call.expression.expression);
      if (schema && Object.keys(schema).length) schemas.push(schema);
    }
  }
  if (!schemas.length) return null;
  return schemas.length === 1 ? schemas[0] : { allOf: schemas };
}

function sequelizeDefinitionShape(project, modelFile, definition, sourceFile = modelFile, query = null) {
  const declarations = unwrap(definition.arguments[1]);
  if (!declarations || !ts.isObjectLiteralExpression(declarations)) return {};
  const modelOptions = project.staticValue(modelFile, definition.arguments[2]) ?? {};
  const exclusions = new Set(modelOptions.defaultScope?.attributes?.exclude ?? []);
  let selection = null;
  let attributes = null;
  const resolvedQuery = resolveOptionExpression(project, sourceFile, query);
  query = resolvedQuery?.node ?? unwrap(query);
  if (query && ts.isObjectLiteralExpression(query)) {
    const attr = query.properties.find((part) => ts.isPropertyAssignment(part) && propertyName(part.name) === "attributes");
    if (attr) {
      attributes = unwrap(attr.initializer);
      const selected = project.staticValue(resolvedQuery?.file ?? sourceFile, attr.initializer);
      if (Array.isArray(selected)) selection = new Set(selected);
      else if (selected && typeof selected === "object") {
        for (const field of selected.exclude ?? []) exclusions.add(field);
      }
      // Computed aliases make staticValue(array/object) unknown. Plain selected
      // names and exclusions are still recoverable independently.
      if (ts.isArrayLiteralExpression(attributes)) selection = new Set(attributes.elements
        .map((part) => project.staticValue(resolvedQuery?.file ?? sourceFile, part)).filter((part) => typeof part === "string"));
      if (ts.isObjectLiteralExpression(attributes)) {
        const excluded = project.staticValue(resolvedQuery?.file ?? sourceFile, objectProperty(attributes, "exclude"));
        for (const field of Array.isArray(excluded) ? excluded : []) exclusions.add(field);
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
    const originalType = unwrap(field.initializer);
    let value = originalType;
    if (ts.isCallExpression(value)) value = unwrap(value.expression);
    let datatype = member(value);
    if (datatype === "UNSIGNED" || datatype === "ZEROFILL") datatype = member(value.expression);
    let col = {
      UUID: { type: "string", format: "uuid" }, UUIDV4: { type: "string", format: "uuid" },
      STRING: { type: "string" }, TEXT: { type: "string" }, CHAR: { type: "string" },
      ENUM: { type: "string" },
      BOOLEAN: { type: "boolean" }, DATE: { type: "string", format: "date-time" }, DATEONLY: { type: "string", format: "date" },
      INTEGER: { type: "integer" }, BIGINT: { type: "integer" }, SMALLINT: { type: "integer" }, TINYINT: { type: "integer" },
      FLOAT: { type: "number" }, DOUBLE: { type: "number" }, REAL: { type: "number" }, DECIMAL: { type: "number" },
      JSON: { type: ["object", "array", "string", "number", "boolean", "null"] },
      JSONB: { type: ["object", "array", "string", "number", "boolean", "null"] },
      BLOB: { type: "string", format: "byte" },
    }[datatype];
    if (!col) continue;
    if (datatype === "JSON" || datatype === "JSONB") {
      col = sequelizeJsonValidationShape(project, modelFile, settings) ?? col;
    }
    if (ts.isCallExpression(originalType)) {
      if (["STRING", "CHAR"].includes(datatype)) {
        const length = project.staticValue(modelFile, originalType.arguments[0]);
        if (Number.isSafeInteger(length) && length > 0) col.maxLength = length;
      } else if (datatype === "ENUM") {
        const args = originalType.arguments.map((part) => project.staticValue(modelFile, part));
        const values = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
        if (values.length && values.every((item) => typeof item === "string")) col.enum = values;
      }
    }
    const nullable = settings.properties.find((part) => ts.isPropertyAssignment(part) && propertyName(part.name) === "allowNull");
    const primary = settings.properties.find((part) => ts.isPropertyAssignment(part) && propertyName(part.name) === "primaryKey");
    const notNull = (nullable && project.staticValue(modelFile, nullable.initializer) === false) ||
      (primary && project.staticValue(modelFile, primary.initializer) === true);
    columns[name] = notNull ? col : { anyOf: [col, { type: "null" }] };
  }
  if (modelOptions.timestamps !== false) for (const field of ["createdAt", "updatedAt"]) {
    if (!exclusions.has(field) && (!selection || selection.has(field))) columns[field] ??= { type: "string", format: "date-time" };
  }
  const identity = modelIdentity({ file: modelFile, node: definition });
  for (const fk of foreignKeysFor(project, identity)) {
    if (columns[fk.name] || exclusions.has(fk.name) || (selection && !selection.has(fk.name))) continue;
    columns[fk.name] = fk.required ? fk.schema : { anyOf: [fk.schema, { type: "null" }] };
  }
  const aliases = attributes && (ts.isArrayLiteralExpression(attributes) ? attributes :
    ts.isObjectLiteralExpression(attributes) ? unwrap(objectProperty(attributes, "include")) : null);
  if (aliases && ts.isArrayLiteralExpression(aliases)) for (const alias of aliases.elements) {
    if (!ts.isArrayLiteralExpression(alias) || alias.elements.length !== 2) continue;
    const queryFile = resolvedQuery?.file ?? sourceFile;
    const name = project.staticValue(queryFile, alias.elements[1]);
    if (typeof name !== "string") continue;
    const expression = unwrap(alias.elements[0]);
    let inferred = {};
    if (ts.isCallExpression(expression) && (member(expression.expression) === "col" ||
      ts.isIdentifier(expression.expression) && expression.expression.text === "col")) {
      const imported = ts.isIdentifier(expression.expression) ? project.file(queryFile)?.imports.get(expression.expression.text) :
        project.file(queryFile)?.imports.get(expression.expression.expression?.text);
      const path = project.staticValue(queryFile, expression.arguments[0]);
      if (imported?.spec === "sequelize" && typeof path === "string") {
        const fragments = path.split(".");
        const field = fragments.pop();
        let key = identity;
        let target = null;
        let include = query && objectProperty(query, "include");
        let nullable = false;
        const { graph, models } = associationsFor(project);
        for (const fragment of fragments) {
          const relation = graph.get(key)?.find((entry) => entry.alias === fragment);
          target = relation && models.get(relation.targetKey);
          if (!target) break;
          const selection = collectIncludeNodes(project, queryFile, include)
            .map((entry) => ({ ...entry, hit: includedAssociation(project, key, entry.file, entry.node) }))
            .find((entry) => entry.hit?.relation.alias === fragment);
          nullable ||= !selection || !requiredInclude(project, selection.file, selection.hit.options);
          include = selection?.hit.options && objectProperty(selection.hit.options, "include");
          key = relation.targetKey;
        }
        inferred = fragments.length && target
          ? sequelizeDefinitionShape(project, target.file, target.node).properties?.[field] ?? {}
          : !fragments.length ? columns[field] ?? {} : {};
        if (nullable && Object.keys(inferred).length && !inferred.anyOf?.some((part) => part.type === "null")) {
          inferred = { anyOf: [inferred, { type: "null" }] };
        }
      }
    }
    columns[name] = inferred;
  }
  return { type: "object", properties: columns,
    ...(Object.keys(columns).length ? { required: Object.keys(columns) } : {}) };
}
// Cache wrappers are transparent to Sequelize consumers. Only unwrap an
// `init(model)` call when its receiver originates from a known cache package;
// a different library's `init` may not preserve the model's shape.
const sequelizeCachePackages = new Set(["sequelize-simple-cache-redis", "sequelize-simple-cache"]);
function isSequelizeCache(project, file, receiver) {
  const cache = project.resolveExpression(file, receiver);
  const instance = unwrap(cache?.node);
  if (!instance || !ts.isNewExpression(instance)) return false;
  const constructor = unwrap(instance.expression);
  if (!ts.isIdentifier(constructor)) return false;
  const imported = project.file(cache.file)?.imports.get(constructor.text);
  return imported && sequelizeCachePackages.has(imported.spec);
}
function sequelizeDefinition(project, file, expression, visited = new Set()) {
  if (!expression || visited.size > 20) return null;
  const target = project.resolveExpression(file, expression);
  if (!target) return null;
  const node = unwrap(target.node);
  const key = `${target.file}:${node.pos}:${node.end}`;
  if (visited.has(key)) return null;
  visited.add(key);
  if (!ts.isCallExpression(node)) return null;
  if (member(node.expression) === "define") return { file: target.file, node };
  if (member(node.expression) === "init" && node.arguments.length &&
      isSequelizeCache(project, target.file, node.expression.expression)) {
    return sequelizeDefinition(project, target.file, node.arguments[0], visited);
  }
  return null;
}
// Canonical model identity survives imports, re-exports, aliases and recognized
// cache.init(Model) wrappers. No module or Redis connection is executed.
const modelIdentity = (model) => model && `${model.file}:${model.node.pos}:${model.node.end}`;
const associationMethods = new Set(["belongsTo", "hasOne", "hasMany", "belongsToMany"]);
const pluralRelations = new Set(["hasMany", "belongsToMany"]);

function associationsFor(project) {
  if (project._swaggerdocAssociations) return project._swaggerdocAssociations;
  const graph = new Map();
  const models = new Map();
  // Store the graph early to avoid re-entrant catalog building.
  project._swaggerdocAssociations = { graph, models };
  for (const [file, source] of project.cache) {
    walk(source.ast, (node) => {
      if (!ts.isCallExpression(node) || !associationMethods.has(member(node.expression)) ||
          !ts.isPropertyAccessExpression(node.expression) || !node.arguments.length) return;
      const owner = sequelizeDefinition(project, file, node.expression.expression);
      const target = sequelizeDefinition(project, file, node.arguments[0]);
      if (!owner || !target) return;
      const ownerKey = modelIdentity(owner);
      const targetKey = modelIdentity(target);
      models.set(ownerKey, owner);
      models.set(targetKey, target);
      const kind = member(node.expression);
      const opts = project.staticValue(file, node.arguments[1]) ?? {};
      const name = project.staticValue(target.file, target.node.arguments[0]);
      const alias = typeof opts.as === "string" ? opts.as :
        typeof name === "string" ? kind === "hasMany" || kind === "belongsToMany" ? `${name}s` : name : null;
      const configuredKey = typeof opts.foreignKey === "string" ? opts.foreignKey : opts.foreignKey?.name;
      const fk = typeof configuredKey === "string" ? configuredKey : null;
      const association = { ownerKey, targetKey, kind, alias, foreignKey: fk, foreignKeyOptions: opts.foreignKey };
      if (!graph.has(ownerKey)) graph.set(ownerKey, []);
      if (!graph.get(ownerKey).some((prev) => prev.kind === kind && prev.targetKey === targetKey && prev.alias === alias)) {
        graph.get(ownerKey).push(association);
      }
    });
  }
  return project._swaggerdocAssociations;
}
function primaryKeyShape(project, model) {
  const props = unwrap(model.node.arguments[1]);
  if (!props || !ts.isObjectLiteralExpression(props)) return { type: "string", format: "uuid" };
  const fields = sequelizeDefinitionShapeBare(project, model.file, model.node);
  for (const field of props.properties) {
    if (!ts.isPropertyAssignment(field)) continue;
    const settings = unwrap(field.initializer);
    if (!settings || !ts.isObjectLiteralExpression(settings)) continue;
    const primary = settings.properties.find((p) => ts.isPropertyAssignment(p) && propertyName(p.name) === "primaryKey");
    if (primary && project.staticValue(model.file, primary.initializer) === true) {
      const schema = fields[propertyName(field.name)];
      if (schema) return schema.anyOf?.find((v) => v.type !== "null") ?? schema;
    }
  }
  return { type: "integer" }; // Sequelize's implicit `id` primary key.
}
function sequelizeDefinitionShapeBare(project, file, definition) {
  // Avoid recursing through the associations catalog when reading a PK type.
  const declarations = unwrap(definition.arguments[1]);
  if (!declarations || !ts.isObjectLiteralExpression(declarations)) return {};
  const fields = {};
  for (const field of declarations.properties) {
    if (!ts.isPropertyAssignment(field)) continue;
    const name = propertyName(field.name);
    const options = unwrap(field.initializer);
    if (!name || !ts.isObjectLiteralExpression(options)) continue;
    const type = options.properties.find((p) => ts.isPropertyAssignment(p) && propertyName(p.name) === "type");
    if (!type) continue;
    let node = unwrap(type.initializer);
    if (ts.isCallExpression(node)) node = unwrap(node.expression);
    const datatype = member(node);
    fields[name] = ({ UUID: { type: "string", format: "uuid" }, UUIDV4: { type: "string", format: "uuid" },
      INTEGER: { type: "integer" }, BIGINT: { type: "integer" }, STRING: { type: "string" } })[datatype] ?? { type: "string" };
  }
  return fields;
}
function foreignKeysFor(project, key) {
  const { graph, models } = associationsFor(project);
  const columns = [];
  for (const [owner, relations] of graph) for (const relation of relations) {
    let appliesTo = null;
    let reference = null;
    if (relation.kind === "belongsTo" && owner === key) {
      appliesTo = relation.foreignKey;
      reference = models.get(relation.targetKey);
    } else if (["hasOne", "hasMany"].includes(relation.kind) && relation.targetKey === key) {
      appliesTo = relation.foreignKey;
      reference = models.get(owner);
    }
    if (!appliesTo || !reference) continue;
    const options = relation.foreignKeyOptions;
    columns.push({ name: appliesTo, schema: primaryKeyShape(project, reference),
      required: typeof options === "object" && options !== null && options.allowNull === false });
  }
  return columns;
}
function objectProperty(node, name) {
  const prop = node?.properties?.find((prop) =>
    (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) && propertyName(prop.name) === name);
  return prop && (ts.isShorthandPropertyAssignment(prop) ? prop.name : prop.initializer);
}
// Follow constant, imported and helper-returned query/include expressions,
// but never execute project code. An expression can come from another file.
function resolveOptionExpression(project, file, expression, seen = new Set(), depth = 0) {
  if (!expression || depth > 24) return null;
  const node = unwrapAwait(expression);
  if (!node) return null;
  const key = `${file}:${node.pos}:${node.end}`;
  if (seen.has(key)) return null;
  const next = new Set(seen); next.add(key);
  if (ts.isCallExpression(node)) {
    const resolved = project.resolveExpression(file, node.expression);
    const fn = resolved?.node;
    if (fn && functionLike(fn)) {
      if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) {
        return resolveOptionExpression(project, resolved.file, fn.body, next, depth + 1);
      }
      const returns = [];
      for (const statement of fn.body?.statements ?? []) {
        if (ts.isReturnStatement(statement) && statement.expression) returns.push(statement.expression);
        // A callback nested within the function does not become its return.
        if (ts.isIfStatement(statement)) for (const branch of [statement.thenStatement, statement.elseStatement]) {
          if (branch && ts.isReturnStatement(branch) && branch.expression) returns.push(branch.expression);
        }
      }
      if (returns.length === 1) {
        const result = unwrap(returns[0]);
        if (ts.isIdentifier(result)) {
          for (const statement of fn.body?.statements ?? []) {
            if (!ts.isVariableStatement(statement)) continue;
            for (const declaration of statement.declarationList.declarations) {
              if (ts.isIdentifier(declaration.name) && declaration.name.text === result.text && declaration.initializer) {
                return resolveOptionExpression(project, resolved.file, declaration.initializer, next, depth + 1);
              }
            }
          }
        }
        return resolveOptionExpression(project, resolved.file, result, next, depth + 1);
      }
    }
  }
  if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const resolved = project.resolveExpression(file, node);
    if (resolved && (resolved.file !== file || resolved.node !== node)) {
      return resolveOptionExpression(project, resolved.file, resolved.node, next, depth + 1);
    }
  }
  return { file, node };
}
function collectIncludeNodes(project, file, expression, seen = new Set(), depth = 0) {
  if (!expression || depth > 18) return [];
  // Sequelize also accepts `include: [Role]` without a model/as wrapper.
  // Preserve the original import expression rather than reducing it to
  // its sequelize.define(...) declaration in this particular syntax.
  if (sequelizeDefinition(project, file, expression)) {
    return [{ file, node: unwrap(expression) }];
  }
  const resolved = resolveOptionExpression(project, file, expression);
  if (!resolved) return [];
  const node = unwrap(resolved.node);
  const key = `${resolved.file}:${node.pos}:${node.end}`;
  if (seen.has(key)) return [];
  const next = new Set(seen); next.add(key);
  if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap((part) =>
    collectIncludeNodes(project, resolved.file, ts.isSpreadElement(part) ? part.expression : part, next, depth + 1));
  if (ts.isConditionalExpression(node)) return [
    ...collectIncludeNodes(project, resolved.file, node.whenTrue, next, depth + 1),
    ...collectIncludeNodes(project, resolved.file, node.whenFalse, next, depth + 1),
  ];
  if (ts.isObjectLiteralExpression(node) || ts.isStringLiteralLike(node) ||
      ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) return [{ file: resolved.file, node }];
  return [];
}
function includedAssociation(project, parentKey, file, includeNode) {
  const { graph, models } = associationsFor(project);
  const available = graph.get(parentKey) ?? [];
  if (!available.length) return null;
  const object = ts.isObjectLiteralExpression(includeNode) ? includeNode : null;
  const as = object ? project.staticValue(file, objectProperty(object, "as")) : null;
  const associationArg = object ? objectProperty(object, "association") : includeNode;
  const aliasValue = associationArg && ts.isPropertyAccessExpression(associationArg) ? member(associationArg) :
    project.staticValue(file, associationArg);
  const alias = typeof as === "string" ? as : typeof aliasValue === "string" ? aliasValue : null;
  const modelArg = object ? objectProperty(object, "model") : includeNode;
  const model = sequelizeDefinition(project, file, modelArg);
  const targetKey = modelIdentity(model);
  const matches = available.filter((relation) => (!alias || relation.alias === alias) &&
    (!targetKey || relation.targetKey === targetKey));
  // Unrecognized target/alias should never silently turn into a different relation.
  if (!alias && !targetKey || matches.length !== 1) return null;
  return { relation: matches[0], model: models.get(matches[0].targetKey), options: object };
}
function requiredInclude(project, file, options) {
  if (!options) return false;
  const required = project.staticValue(file, objectProperty(options, "required"));
  return required === true || required !== false && Boolean(objectProperty(options, "where"));
}
function addEagerLoadedAssociations(project, sourceFile, model, schema, include, depth = 0, chain = new Set()) {
  if (!include || depth >= 10) return schema;
  const parentKey = modelIdentity(model);
  if (!parentKey) return schema;
  const properties = { ...(schema.properties ?? {}) };
  const required = new Set(schema.required ?? []);
  for (const { file, node } of collectIncludeNodes(project, sourceFile, include)) {
    const hit = includedAssociation(project, parentKey, file, node);
    if (!hit) continue;
    const { relation, model: target, options } = hit;
    if (!target || !relation.alias) continue;
    // An include used only for a JOIN/flattened column is not serialized.
    const selected = options && project.staticValue(file, objectProperty(options, "attributes"));
    if (Array.isArray(selected) && selected.length === 0) continue;
    // Explicit includes form an acyclic selection tree in normal queries;
    // guard unusual cyclic/self-referential selections anyway.
    const edge = `${parentKey}:${relation.alias}`;
    if (chain.has(edge)) continue;
    const nested = options && objectProperty(options, "include");
    const next = new Set(chain); next.add(edge);
    let child = sequelizeDefinitionShape(project, target.file, target.node, file, options);
    child = addEagerLoadedAssociations(project, file, target, child, nested, depth + 1, next);
    let property = pluralRelations.has(relation.kind) ? { type: "array", items: child } : child;
    const mandatory = requiredInclude(project, file, options);
    if (!pluralRelations.has(relation.kind) && !mandatory) property = { anyOf: [property, { type: "null" }] };
    properties[relation.alias] = property;
    required.add(relation.alias);
  }
  return { ...schema, ...(Object.keys(properties).length ? { type: "object", properties } : {}),
    ...(required.size ? { required: [...required] } : {}) };
}
function sequelizeModelShape(project, file, call) {
  const source = call.expression.expression;
  const model = sequelizeDefinition(project, file, source);
  if (!model) return {};
  const queryArgument = member(call.expression) === "findByPk" ? call.arguments[1] : call.arguments[0];
  const query = resolveOptionExpression(project, file, queryArgument);
  const queryFile = query?.file ?? file;
  const queryNode = query?.node;
  const base = sequelizeDefinitionShape(project, model.file, model.node, queryFile, queryNode);
  return addEagerLoadedAssociations(project, queryFile, model, base,
    queryNode && ts.isObjectLiteralExpression(queryNode) ? objectProperty(queryNode, "include") : null);
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

// TypeScript owns type structure. The flow pass supplies invocation-specific
// values and fills gaps left by any/unknown or dynamic, untyped APIs.
function preferType(project, typed, flow, active = new Set()) {
  if (!typed || !Object.keys(typed).length) return flow ?? {};
  if (!flow || !Object.keys(flow).length) return typed;
  if (typed.$ref) {
    if (active.has(typed.$ref)) return typed;
    const target = project.inference.types.schemas[typed.$ref.split("/").at(-1)];
    if (!target) return typed;
    const next = new Set(active); next.add(typed.$ref);
    const merged = preferType(project, target, flow, next);
    return JSON.stringify(merged) === JSON.stringify(target) ? typed : merged;
  }
  if (typed.type === "object" && flow.type === "object") {
    const properties = { ...typed.properties };
    for (const [key, value] of Object.entries(properties)) {
      properties[key] = preferType(project, value, flow.properties?.[key], active);
      if (["status", "statusCode", "message"].includes(key) && flow.properties?.[key]?.example !== undefined) {
        // These are explicit source values, not guesses from SDK metadata.
        const { description, deprecated } = properties[key];
        properties[key] = {
          ...(description ? { description } : {}),
          ...(deprecated ? { deprecated } : {}),
          ...flow.properties[key],
        };
      }
    }
    return { ...typed, properties };
  }
  if (typed.type === "array" && flow.type === "array" && !typed.prefixItems) {
    return { ...typed, items: preferType(project, typed.items, flow.items, active) };
  }
  return typed;
}
function shape(project, file, expression, scope, depth = 0, awaited = false) {
  if (!expression || depth > 15) return {};
  const { schema: declared, issues } = project.inference.infer(file, expression, awaited);
  const node = unwrapAwait(expression);
  if (declared && !issues.length && ts.isCallExpression(node)) {
    const target = functionTarget(project, file, node.expression, scope);
    if (!target || !functionLike(target.node)) return declared;
  }
  const flow = flowShape(project, file, expression, scope, depth);
  return preferType(project, declared, flow);
}
function flowShape(project, file, expression, scope, depth = 0) {
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
      const explicit = key === "status" || key === "statusCode"
        ? knownFieldSchema("status", statusValues(project, file, expression, scope))
        : key === "message" ? knownFieldSchema("message", textValues(project, file, expression, scope)) : null;
      properties[key] = explicit ?? inferred;
      required.push(key);
    }
    return { type: "object", properties, ...(required.length ? { required: unique(required) } : {}) };
  }
  if (ts.isArrayLiteralExpression(node)) {
    const variants = node.elements.map((item) => {
      const value = shape(project, file, ts.isSpreadElement(item) ? item.expression : item, scope, depth + 1);
      return ts.isSpreadElement(item) ? value.items ?? {} : value;
    });
    const items = [...new Map(variants.map((value) => [JSON.stringify(value), value])).values()];
    return { type: "array", items: items.length === 1 ? items[0] : items.length ? { anyOf: items } : {}, ...(!items.length ? { maxItems: 0 } : {}) };
  }
  if (ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { type: "string" };
  // A Date serializes to an ISO 8601 string when passed to res.json().
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Date") {
    return { type: "string", format: "date-time" };
  }
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const key = member(node) ?? (ts.isElementAccessExpression(node) ? project.staticValue(file, node.argumentExpression) : null);
    const sourceSchema = shape(project, file, node.expression, scope, depth + 1);
    if (key === "length" && ["array", "string"].includes(sourceSchema.type)) return { type: "integer", minimum: 0 };
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
      return left.type === "number" || left.type === "integer"
        ? right.type === "number" || right.type === "integer" ? { type: "number" } : {}
        : {};
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
    const argument = scope.argumentExpressions?.get(node.text);
    if (argument) return shape(project, argument.file, argument.node, argument.scope, depth + 1);
    const incomingValue = scope.argumentValues?.get(node.text);
    if (typeof incomingValue === "string") return { type: "string" };
    if (typeof incomingValue === "number") return { type: Number.isInteger(incomingValue) ? "integer" : "number" };
    if (typeof incomingValue === "boolean") return { type: "boolean" };
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
    const isModelQuery = ["count", "findAll", "findAndCountAll", "findByPk", "findOne"].includes(method) &&
      sequelizeDefinition(project, file, node.expression.expression);
    if (method === "count" && isModelQuery) return { type: "integer", minimum: 0 };
    if (["findAll", "findAndCountAll"].includes(method) && isModelQuery) {
      const item = sequelizeModelShape(project, file, node);
      return method === "findAll" ? { type: "array", items: item } : {
        type: "object", properties: { rows: { type: "array", items: item }, count: { type: "integer", minimum: 0 } },
        required: ["rows", "count"],
      };
    }
    if ((method === "findByPk" || method === "findOne") && isModelQuery) return sequelizeModelShape(project, file, node);
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
      if (original.type !== "array") return {};
      if (method === "filter") return original.type === "array" ? original : { type: "array", items: {} };
      const callback = unwrap(node.arguments[0]);
      if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
        const callbackScope = scopeOf(callback, scope);
        callbackScope.argumentSchemas = new Map(scope.argumentSchemas ?? []);
        const parameter = callback.parameters[0]?.name;
        const bindSchema = (name, schema) => {
          if (!name) return;
          if (ts.isIdentifier(name)) callbackScope.argumentSchemas.set(name.text, schema);
          if (ts.isObjectBindingPattern(name)) for (const entry of name.elements) {
            const key = propertyName(entry.propertyName ?? entry.name);
            bindSchema(entry.name, schema.properties?.[key] ?? {});
          }
        };
        bindSchema(parameter, original.items ?? {});
        if (!ts.isBlock(callback.body)) return { type: "array", items: shape(project, file, callback.body, callbackScope, depth + 1) };
        const variants = [];
        const visit = (child) => {
          if (functionLike(child)) return;
          if (ts.isReturnStatement(child) && child.expression) variants.push(shape(project, file, child.expression, callbackScope, depth + 1));
          ts.forEachChild(child, visit);
        };
        visit(callback.body);
        return { type: "array", items: variants.length === 1 ? variants[0] : variants.length ? { anyOf: variants } : {} };
      }
      return { type: "array", items: {} };
    }
    // In addition to object literals, follow direct helper returns such as
    // `return "active"` or `return Object.fromEntries(...)`.
    const target = functionTarget(project, file, node.expression, scope);
    if (target && functionLike(target.node)) {
      const childScope = invocationScope(project, file, target.file, target.node, node.arguments, scope, target.closure);
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
      if (ts.isArrowFunction(target.node) && !ts.isBlock(target.node.body)) expressions.push(target.node.body);
      else visit(target.node.body ?? target.node);
      if (expressions.length) {
        const values = expressions.map((value) => shape(project, target.file, value, childScope, depth + 1, true));
        if (values.length === 1 && Object.keys(values[0]).length) return values[0];
        if (values.length > 1) {
          return schemaAlternatives(values);
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
  return {};
}
function fnBodies(project, file, expr, depth = 0) {
  const current = unwrapAwait(expr);
  if (!current || depth > 8) return [];
  if (functionLike(current)) return [{ file, fn: current }];
  if (ts.isCallExpression(current)) {
    const invoked = project.resolveExpression(file, current.expression);
    if (invoked && functionLike(invoked.node)) {
      const scope = invocationScope(project, file, invoked.file, invoked.node, current.arguments, scopeOf(invoked.node));
      const all = [];
      walk(invoked.node.body, (node) => {
        if (ts.isReturnStatement(node) && node.expression) {
          const returned = unwrap(node.expression);
          let fn = functionLike(returned) ? returned : null;
          if (ts.isIdentifier(returned)) walk(invoked.node.body, (candidate) => {
            if (ts.isFunctionDeclaration(candidate) && candidate.name?.text === returned.text) fn = candidate;
          });
          if (fn) {
            const child = scopeOf(fn, scope);
            all.push({ file: invoked.file, fn, scope: child });
          }
        }
      });
      return all.length ? all : [{ file: invoked.file, fn: invoked.node, scope }];
    }
  }
  const ref = project.resolveExpression(file, current);
  if (ref && ref.node !== current) return fnBodies(project, ref.file, ref.node, depth + 1);
  return [];
}
function securityOf(project, file, fn, scope, errors) {
  if (![401, 403].some((code) => errors.has(code))) return [];
  const found = [];
  walkReachable(project, file, fn.body ?? fn, scope, (node) => {
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
  const thrownErrors = new Set();
  const errorMessages = new Map();
  const dto = [];
  const securityCandidates = [];
  const warned = new Set();
  walkReachable(project, file, fn.body ?? fn, scope, (node) => {
    if (ts.isThrowStatement(node) && node.expression) {
      const exception = unwrap(node.expression);
      if (ts.isNewExpression(exception) || ts.isCallExpression(exception)) {
        const possible = statusValues(project, file, exception.arguments?.[0], scope);
        const messages = textValues(project, file, exception.arguments?.[1], scope);
        for (const status of possible) if (status >= 400) {
          errors.add(status);
          thrownErrors.add(status);
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
      if (!responseRoot(node.expression, scope.res, scope.binds)) return;
      if (method === "sendStatus") {
        for (const status of statusValues(project, file, node.arguments[0], scope)) {
          responses.push({ status, mediaType: "text/plain", schema: { type: "string", const: statusText(status) } });
        }
      }
      if (!["json", "send", "end", "redirect"].includes(method)) return;
      let statusExpressions = [];
      let current = unwrap(node.expression.expression);
      while (current && ts.isCallExpression(current)) {
        if (member(current.expression) === "status") statusExpressions.push(current.arguments[0]);
        current = ts.isPropertyAccessExpression(current.expression) || ts.isElementAccessExpression(current.expression) ? unwrap(current.expression.expression) : null;
      }
      if (method === "redirect" && node.arguments.length > 1) statusExpressions = [node.arguments[0]];
      const statuses = statusExpressions.length ? unique(statusExpressions.flatMap((expr) => statusValues(project, file, expr, scope))) : [method === "redirect" ? 302 : 200];
      if (!statuses.length) {
        project.diagnostics.push({ level: "warning", code: "UNKNOWN_STATUS", message: `Response status cannot be inferred (${file})` });
      }
      const body = method === "json" ? shape(project, file, node.arguments[0], scope) : method === "send" ? shape(project, file, node.arguments[0], scope) : null;
      let mediaType = method === "send" && body?.type === "string" ? "text/html" : "application/json";
      let chain = unwrap(node.expression.expression);
      while (chain && ts.isCallExpression(chain)) {
        const name = member(chain.expression);
        let configured;
        if (["type", "contentType"].includes(name)) configured = project.staticValue(file, chain.arguments[0]);
        if (["set", "header"].includes(name) && String(project.staticValue(file, chain.arguments[0])).toLowerCase() === "content-type") configured = project.staticValue(file, chain.arguments[1]);
        if (typeof configured === "string") {
          mediaType = ({ json: "application/json", html: "text/html", text: "text/plain", txt: "text/plain", xml: "application/xml" })[configured] ?? configured;
          break;
        }
        chain = chain.expression.expression && unwrap(chain.expression.expression);
      }
      const location = method === "redirect" ? project.staticValue(file, node.arguments.at(-1)) : undefined;
      for (const status of statuses) {
        if (status >= 400) errors.add(status);
        responses.push({ status, schema: body, mediaType, expression: node.arguments[0], file,
          ...(method === "redirect" ? { headers: { Location: { schema: { type: "string", ...(typeof location === "string" ? { const: location } : {}) } } } } : {}) });
      }
    }
  });
  securityCandidates.push(...securityOf(project, file, fn, scope, errors));
  return { responses, errors, thrownErrors, errorMessages, dto, securityCandidates };
}
function analyzeExpression(project, item, depthLimit = 15, isEndpoint = false) {
  const results = { responses: [], errors: new Set(), thrownErrors: new Set(), errorMessages: new Map(), dto: [], securityCandidates: [] };
  const processed = new Set();
  const analyzeFn = (file, fn, depth, scope = scopeOf(fn)) => {
    if (depth > depthLimit || processed.size > 350) {
      project.diagnostics.push({ level: "warning", code: "CALL_DEPTH", message: `Call-graph traversal limit reached at ${file}` });
      return;
    }
    const argumentsKey = [...(scope.argumentExpressions ?? [])].map(([name, value]) =>
      `${name}:${value.file}:${value.node.pos}:${value.node.end}`);
    const key = `${file}:${fn.pos}:${fn.end}:${JSON.stringify([...(scope.argumentValues ?? [])])}:${argumentsKey.join("|")}`;
    if (processed.has(key)) return;
    processed.add(key);
    const details = outputOf(project, file, fn, scope);
    results.responses.push(...details.responses);
    for (const error of details.errors) results.errors.add(error);
    for (const error of details.thrownErrors) results.thrownErrors.add(error);
    for (const [status, messages] of details.errorMessages) {
      if (!results.errorMessages.has(status)) results.errorMessages.set(status, new Set());
      for (const message of messages) results.errorMessages.get(status).add(message);
    }
    results.dto.push(...details.dto);
    results.securityCandidates.push(...details.securityCandidates);
    const calls = [];
    walkReachable(project, file, fn.body ?? fn, scope, (node) => {
      if (ts.isCallExpression(node)) calls.push(node);
    });
    for (const call of calls) {
      if (call.expression === fn || ts.isIdentifier(call.expression) && ["next", scope.res, scope.req].includes(call.expression.text)) continue;
      const symbol = functionTarget(project, file, call.expression, scope);
      if (symbol && functionLike(symbol.node)) {
        analyzeFn(symbol.file, symbol.node, depth + 1,
          invocationScope(project, file, symbol.file, symbol.node, call.arguments, scope, symbol.closure));
      }
    }
  };
  for (const { file, fn, scope } of fnBodies(project, item.file, item.node)) analyzeFn(file, fn, 0, scope);
  return results;
}
export function analyzeRoute(project, route) {
  const analyzed = route.handlers.map((item, index) => ({
    ...analyzeExpression(project, item),
    endpoint: index === route.handlers.length - 1,
    conditional: item.conditional === true,
  }));
  const errors = new Set();
  const thrownErrors = new Set();
  const errorMessages = new Map();
  const dto = [];
  const candidates = [];
  const responses = [];
  let successes = [];
  for (const result of analyzed) {
    responses.push(...result.responses);
    for (const status of result.errors) errors.add(status);
    for (const status of result.thrownErrors) thrownErrors.add(status);
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
  return { errors, thrownErrors, errorMessages, dto: distinct, securityCandidates: candidates.filter((value, index, array) => array.findIndex((x) => x.in === value.in && x.name === value.name) === index), successes, responses };
}
