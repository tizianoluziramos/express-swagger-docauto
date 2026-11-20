import path from "node:path";
import ts from "typescript";
import { schemaAlternatives, serializationAnnotation } from "./schema-variants.js";

const unwrap = (expression) => {
  while (expression && (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) || ts.isNonNullExpression(expression) || ts.isAwaitExpression(expression))) {
    expression = expression.expression;
  }
  return expression;
};
const memberName = (node) => ts.isPropertyAccessExpression(node) ? node.name.text
  : ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : null;

// This is provenance analysis, not a storage/SDK adapter. TypeScript still
// resolves symbols, aliases, signatures and every payload type. A matched
// storage contract describes project-local writers, NOT runtime validation.
export class SerializationInference {
  constructor(inference) {
    this.inference = inference;
    this.checker = inference.checker;
    this.cache = new Map();
    this.active = new Set();
    this.mutated = new Set();
    this.calls = [];
    this.writers = new Map();
  }
  symbol(node) {
    let symbol = this.checker.getSymbolAtLocation(node);
    if (symbol?.flags & ts.SymbolFlags.Alias) symbol = this.checker.getAliasedSymbol(symbol);
    return symbol;
  }
  local(source) {
    const relative = path.relative(this.inference.root, source.fileName);
    return !source.isDeclarationFile && relative !== ".." && !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative) && !relative.replaceAll("\\", "/").split("/").includes("node_modules");
  }
  index() {
    if (this.indexed) return;
    this.indexed = true;
    const mark = (node) => {
      node = unwrap(node);
      if (!node) return;
      if (ts.isShorthandPropertyAssignment(node)) {
        const value = this.checker.getShorthandAssignmentValueSymbol(node);
        if (value) this.mutated.add(value);
        return;
      }
      const symbol = this.symbol(ts.isPropertyAccessExpression(node) ? node.name : node);
      if (symbol) this.mutated.add(symbol);
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) mark(node.expression);
      else if (ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node)) ts.forEachChild(node, mark);
      else if (ts.isPropertyAssignment(node)) mark(node.initializer);
      else if (ts.isSpreadAssignment(node) || ts.isSpreadElement(node)) mark(node.expression);
    };
    const visit = (node) => {
      if (ts.isCallExpression(node)) this.calls.push(node);
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) mark(node.left);
      if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) mark(node.operand);
      if (ts.isDeleteExpression(node)) mark(node.expression);
      ts.forEachChild(node, visit);
    };
    for (const source of this.inference.program.getSourceFiles()) if (this.local(source)) visit(source);
    // Build after the mutation pass so reassigned aliases cannot acquire a
    // stable identity just because their write appeared later in a source file.
    for (const call of this.calls) {
      const callee = unwrap(call.expression);
      if (!(ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) ||
        call.arguments.length < 2) continue;
      const receiver = this.identity(callee.expression);
      if (!receiver) continue;
      const entry = { call, key: this.key(call.arguments[0]), value: call.arguments[1] };
      const writers = this.writers.get(receiver) ?? [];
      writers.push(entry);
      this.writers.set(receiver, writers);
    }
  }
  resolve(expression, bindings = new Map(), seen = new Set()) {
    let node = unwrap(expression);
    if (!node || seen.has(node) || seen.size > 40) return null;
    const next = new Set(seen); next.add(node);
    if (ts.isIdentifier(node)) {
      const symbol = this.symbol(node);
      if (!symbol || this.mutated.has(symbol)) return null;
      const argument = bindings.get(symbol);
      if (argument) return this.resolve(argument.node, argument.bindings, next);
      const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
        return this.resolve(declaration.initializer, bindings, next);
      }
    }
    return { node, bindings };
  }
  identity(expression, seen = new Set()) {
    const node = unwrap(expression);
    if (!node || seen.has(node) || seen.size > 40) return null;
    const next = new Set(seen); next.add(node);
    if (ts.isIdentifier(node)) {
      const symbol = this.symbol(node);
      if (!symbol || this.mutated.has(symbol)) return null;
      const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
      if (!declaration) return null;
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        const value = unwrap(declaration.initializer);
        if (ts.isIdentifier(value) || ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
          return this.identity(value, next);
        }
      }
      return `symbol:${declaration.getSourceFile().fileName}:${declaration.pos}`;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const name = memberName(node);
      const symbol = this.symbol(ts.isPropertyAccessExpression(node) ? node.name : node.argumentExpression);
      if (symbol && this.mutated.has(symbol)) return null;
      const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
      // `import * as config; config.store` and `import { store }` refer to
      // the same exported binding, unlike two instance properties named store.
      if (declaration && ts.isVariableDeclaration(declaration)) {
        if (declaration.initializer) {
          const value = unwrap(declaration.initializer);
          if (ts.isIdentifier(value) || ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
            return this.identity(value, next);
          }
        }
        return `symbol:${declaration.getSourceFile().fileName}:${declaration.pos}`;
      }
      const base = this.identity(node.expression, next);
      return base && name ? `${base}.${JSON.stringify(name)}` : null;
    }
    return null;
  }
  key(expression) {
    const chunks = (expression, seen = new Set()) => {
      const node = unwrap(expression);
      if (!node || seen.has(node) || seen.size > 40) return null;
      const next = new Set(seen); next.add(node);
      if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return [node.text];
      if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const symbol = this.symbol(ts.isPropertyAccessExpression(node) ? node.name
          : ts.isElementAccessExpression(node) ? node.argumentExpression : node);
        if (!symbol || this.mutated.has(symbol)) return null;
        const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
        if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
          const value = chunks(declaration.initializer, next);
          if (value) return value;
        }
      }
      const type = this.checker.getTypeAtLocation(node);
      if (type.isStringLiteral() || type.isNumberLiteral()) return [String(type.value)];
      if (ts.isTemplateExpression(node)) {
        const out = [node.head.text];
        for (const span of node.templateSpans) {
          const value = chunks(span.expression, next);
          if (!value) return null;
          out.push(...value, span.literal.text);
        }
        return out;
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
        this.checker.getTypeAtLocation(node).flags & ts.TypeFlags.StringLike) {
        const left = chunks(node.left, next), right = chunks(node.right, next);
        return left && right ? [...left, ...right] : null;
      }
      const identity = this.identity(node);
      return identity ? [{ symbol: identity }] : null;
    };
    const parts = chunks(expression);
    if (!parts) return null;
    const normalized = [];
    for (const part of parts) {
      if (typeof part === "string" && typeof normalized.at(-1) === "string") normalized[normalized.length - 1] += part;
      else if (part !== "") normalized.push(part);
    }
    const literal = normalized.every((part) => typeof part === "string");
    return {
      id: JSON.stringify(normalized),
      literal: literal ? normalized.join("") : null,
      prefix: typeof normalized[0] === "string" ? normalized[0] : "",
      suffix: typeof normalized.at(-1) === "string" ? normalized.at(-1) : "",
    };
  }
  overlaps(left, right) {
    if (!left || !right) return true;
    if (left.literal !== null && right.literal !== null) return left.literal === right.literal;
    if (left.prefix && right.prefix && !left.prefix.startsWith(right.prefix) && !right.prefix.startsWith(left.prefix)) return false;
    if (left.suffix && right.suffix && !left.suffix.endsWith(right.suffix) && !right.suffix.endsWith(left.suffix)) return false;
    return true;
  }
  jsonCall(expression, operation) {
    const node = unwrap(expression);
    if (!node || !ts.isCallExpression(node)) return false;
    const resolved = this.resolve(node.expression);
    const callee = resolved?.node;
    if (!callee || !(ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) ||
      memberName(callee) !== operation || !this.identity(callee.expression)) return false;
    const symbol = this.symbol(ts.isPropertyAccessExpression(callee) ? callee.name : callee.argumentExpression);
    return symbol && !this.mutated.has(symbol) && symbol.declarations?.some((declaration) =>
      this.inference.program.isSourceFileDefaultLibrary(declaration.getSourceFile()));
  }
  unchangedTransform(call) {
    const modifier = call.arguments[1];
    return !modifier || modifier.kind === ts.SyntaxKind.NullKeyword ||
      Boolean(this.checker.getTypeAtLocation(modifier).flags & ts.TypeFlags.Undefined);
  }
  producer(expression, bindings = new Map(), seen = new Set()) {
    if (!expression) return null;
    const type = this.checker.getTypeAtLocation(expression);
    if (this.checker.getAwaitedType(type) !== type) return null;
    const resolved = this.resolve(expression, bindings);
    if (!resolved || seen.has(resolved.node) || seen.size > 20) return null;
    const { node, bindings: context } = resolved;
    const next = new Set(seen); next.add(node);
    if (this.jsonCall(node, "stringify")) {
      if (!node.arguments[0] || !this.unchangedTransform(node)) return null;
      // Keep awaits and flow-narrowed local variables intact when asking the
      // checker for a payload type. Only substitute parameters of trivial
      // serializer helpers, whose actual arguments belong to the caller.
      let argument = node.arguments[0], argumentsContext = context;
      const bound = new Set();
      while (ts.isIdentifier(unwrap(argument))) {
        const symbol = this.symbol(unwrap(argument));
        const value = argumentsContext.get(symbol);
        if (!value || bound.has(symbol)) break;
        bound.add(symbol);
        argument = value.node;
        argumentsContext = value.bindings;
      }
      return { expression: argument, bindings: argumentsContext };
    }
    if (!ts.isCallExpression(node)) return null;
    const target = this.resolve(node.expression, context)?.node;
    const declaration = target && ts.isFunctionLike(target) ? target
      : this.checker.getResolvedSignature(node)?.declaration;
    if (!declaration?.body || !this.local(declaration.getSourceFile())) return null;
    let returned = declaration.body;
    if (ts.isBlock(returned)) {
      if (returned.statements.length !== 1 || !ts.isReturnStatement(returned.statements[0])) return null;
      returned = returned.statements[0].expression;
    }
    const child = new Map(context);
    for (let index = 0; index < declaration.parameters.length; index++) {
      const parameter = declaration.parameters[index];
      if (!ts.isIdentifier(parameter.name) || !node.arguments[index]) return null;
      child.set(this.symbol(parameter.name), { node: node.arguments[index], bindings: context });
    }
    return this.producer(returned, child, next);
  }
  location(node) {
    const source = node.getSourceFile();
    return { file: path.relative(this.inference.root, source.fileName).replaceAll("\\", "/"),
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 };
  }
  infer(expression) {
    const node = unwrap(expression);
    if (!node || !ts.isCallExpression(node)) return null;
    if (this.cache.has(node)) return this.cache.get(node);
    if (this.active.has(node)) return null;
    this.index();
    if (!this.jsonCall(node, "parse") || !node.arguments[0] || !this.unchangedTransform(node)) return null;
    this.active.add(node);
    let result = null;
    try {
      const direct = this.producer(node.arguments[0]);
      let sources, kind, writes = [];
      if (direct) {
        sources = [direct];
        kind = "json-roundtrip";
      } else {
        const read = this.resolve(node.arguments[0])?.node;
        if (!read || !ts.isCallExpression(read) || read.arguments.length !== 1) return null;
        const callee = unwrap(read.expression);
        if (!(ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))) return null;
        const type = this.checker.getAwaitedType(this.checker.getTypeAtLocation(read));
        const parts = type?.isUnion() ? type.types : type ? [type] : [];
        if (!parts.some((part) => part.flags & ts.TypeFlags.StringLike) || parts.some((part) =>
          !(part.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.Null | ts.TypeFlags.Undefined)))) return null;
        const receiver = this.identity(callee.expression), key = this.key(read.arguments[0]);
        if (!receiver || !key) return null;
        const candidates = this.writers.get(receiver) ?? [];
        if (!candidates.some((writer) => writer.key?.id === key.id)) return null;
        writes = candidates.filter((writer) => this.overlaps(key, writer.key));
        sources = writes.map((writer) => this.producer(writer.value));
        // Do not discard conflicting, opaque, or possibly overlapping writes.
        if (!sources.length || sources.some((source) => !source)) return null;
        kind = "storage-roundtrip";
      }
      const inferred = sources.map((source) => this.inference.infer(
        source.expression.getSourceFile().fileName, source.expression,
      ));
      if (inferred.some((source) => !source.schema)) return null;
      const schema = schemaAlternatives(inferred.map((source) => source.schema));
      schema[serializationAnnotation] = {
        kind,
        ...(kind === "storage-roundtrip" ? { scope: "project-local-writers" } : {}),
        reads: [this.location(node)],
        ...(writes.length ? { writes: writes.map((writer) => this.location(writer.call)) } : {}),
        runtimeValidated: false,
      };
      result = { schema, issues: inferred.flatMap((source) => source.issues) };
      return result;
    } finally {
      this.active.delete(node);
      this.cache.set(node, result);
    }
  }
}
