import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import ts from "typescript";

const extensions = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx"]);
const ignored = new Set(["node_modules", ".git", ".next", "dist", "build", "coverage", "vendor", ".turbo", ".yarn", "__tests__", "test", "tests"]);
export const syntax = ts;
export const is = ts;
export const propertyName = (node) => node && (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) ? node.text : null;
export const member = (node) => node && (ts.isPropertyAccessExpression(node) ? node.name.text : ts.isElementAccessExpression(node) ? propertyName(node.argumentExpression) : null);
export const unwrap = (node) => {
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node))) node = node.expression;
  return node;
};
export function walk(node, visitor) {
  if (!node) return;
  visitor(node);
  ts.forEachChild(node, (child) => walk(child, visitor));
}
function allFiles(directory, out = [], depth = 0) {
  if (depth > 30 || !fs.existsSync(directory)) return out;
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    if (item.isSymbolicLink()) continue;
    if (item.isDirectory()) {
      if (!ignored.has(item.name)) allFiles(path.join(directory, item.name), out, depth + 1);
    } else if (item.isFile() && extensions.has(path.extname(item.name))) out.push(path.join(directory, item.name));
  }
  return out;
}
const scriptKind = (name) => name.endsWith(".tsx") ? ts.ScriptKind.TSX : name.endsWith(".ts") || name.endsWith(".mts") || name.endsWith(".cts") ? ts.ScriptKind.TS : name.endsWith(".jsx") ? ts.ScriptKind.JSX : ts.ScriptKind.JS;

export class Project {
  constructor(root, diagnostics = []) {
    this.root = path.resolve(root);
    this.diagnostics = diagnostics;
    this.cache = new Map();
    const environmentFile = path.join(this.root, ".env");
    this.localEnv = {};
    if (fs.existsSync(environmentFile)) {
      try { this.localEnv = parseEnv(fs.readFileSync(environmentFile, "utf8")); }
      catch (error) { this.diagnostics.push({ level: "warning", code: "INVALID_ENV_FILE", message: `Cannot parse .env: ${error.message}` }); }
    }
    const packageFile = path.join(this.root, "package.json");
    this.pkg = fs.existsSync(packageFile) ? JSON.parse(fs.readFileSync(packageFile, "utf8")) : {};
    const configFile = ts.findConfigFile(this.root, ts.sys.fileExists, "tsconfig.json");
    this.compilerOptions = {};
    if (configFile) {
      const content = ts.readConfigFile(configFile, ts.sys.readFile);
      if (!content.error) this.compilerOptions = ts.parseJsonConfigFileContent(content.config, ts.sys, path.dirname(configFile)).options;
    }
    for (const filename of allFiles(this.root)) this.file(filename);
  }
  file(name) {
    const file = path.resolve(name);
    if (this.cache.has(file)) return this.cache.get(file);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile() || !this.isLocal(file)) return null;
    const contents = fs.readFileSync(file, "utf8");
    const ast = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true, scriptKind(file));
    const model = { file, ast, imports: new Map(), bindings: new Map(), exports: new Map(), statements: [] };
    this.cache.set(file, model);
    for (const statement of ast.statements) {
      if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression) && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const left = statement.expression.left;
        if (ts.isPropertyAccessExpression(left) && left.expression.getText(ast) === "module" && left.name.text === "exports") model.exports.set("default", statement.expression.right);
        else if (ts.isPropertyAccessExpression(left) && left.expression.getText(ast) === "exports") model.exports.set(left.name.text, statement.expression.right);
        else if (ts.isPropertyAccessExpression(left) && left.expression.getText(ast) === "module.exports") model.exports.set(left.name.text, statement.expression.right);
      }
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const spec = statement.moduleSpecifier.text;
        const target = this.resolveImport(file, spec);
        const clause = statement.importClause;
        if (clause?.name) model.imports.set(clause.name.text, { file: target, name: "default", spec });
        if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) model.imports.set(clause.namedBindings.name.text, { file: target, name: "*", spec });
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const binding of clause.namedBindings.elements) {
          model.imports.set(binding.name.text, { file: target, name: (binding.propertyName ?? binding.name).text, spec });
        }
      }
      if (ts.isImportEqualsDeclaration(statement)) continue;
      if (ts.isExportDeclaration(statement)) {
        const target = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? this.resolveImport(file, statement.moduleSpecifier.text) : file;
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          for (const item of statement.exportClause.elements) model.exports.set(item.name.text, { file: target, name: (item.propertyName ?? item.name).text });
        } else if (target) model.exports.set("*", { file: target, name: "*" });
      }
      if (ts.isExportAssignment(statement)) model.exports.set("default", statement.expression);
      if (ts.isFunctionDeclaration(statement) && statement.name) {
        model.bindings.set(statement.name.text, statement);
        if (this.isExported(statement)) model.exports.set(statement.name.text, statement);
        if (this.isDefault(statement)) model.exports.set("default", statement);
      }
      if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
        const init = declaration.initializer;
        if (init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === "require" && init.arguments.length && ts.isStringLiteralLike(init.arguments[0])) {
          const spec = init.arguments[0].text;
          const target = this.resolveImport(file, spec);
          if (ts.isIdentifier(declaration.name)) model.imports.set(declaration.name.text, { file: target, name: "default", spec });
          else if (ts.isObjectBindingPattern(declaration.name)) for (const element of declaration.name.elements) {
            const name = ts.isIdentifier(element.name) ? element.name.text : null;
            const original = propertyName(element.propertyName ?? element.name);
            if (name && original) model.imports.set(name, { file: target, name: original, spec });
          }
        }
        if (ts.isIdentifier(declaration.name)) {
          model.bindings.set(declaration.name.text, declaration.initializer ?? declaration);
          if (this.isExported(statement)) model.exports.set(declaration.name.text, declaration.initializer ?? declaration);
        }
      }
    }
    if (ast.parseDiagnostics.length) {
      this.diagnostics.push({ level: "warning", code: "SYNTAX", message: `${path.relative(this.root, file)}: ${ts.flattenDiagnosticMessageText(ast.parseDiagnostics[0].messageText, " ")}` });
    }
    return model;
  }
  isExported(node) { return Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)); }
  isDefault(node) { return Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)); }
  isLocal(file) { return !(path.relative(this.root, file).startsWith(`..${path.sep}`) || path.relative(this.root, file) === ".."); }
  resolveImport(from, spec) {
    if (typeof spec !== "string") return null;
    let target;
    if (spec.startsWith(".")) target = path.resolve(path.dirname(from), spec);
    else if (spec.startsWith("#/")) {
      const map = this.pkg.imports?.["#/*"];
      target = path.resolve(this.root, typeof map === "string" ? map.replace("*", spec.slice(2)) : `src/${spec.slice(2)}`);
    } else if (spec.startsWith("#")) {
      const mapped = this.pkg.imports?.[spec];
      if (typeof mapped === "string") target = path.resolve(this.root, mapped);
    } else if (this.compilerOptions.baseUrl || this.compilerOptions.paths) {
      const result = ts.resolveModuleName(spec, from, { ...this.compilerOptions, allowJs: true }, ts.sys).resolvedModule?.resolvedFileName;
      if (result && this.isLocal(result) && !result.includes(`${path.sep}node_modules${path.sep}`)) target = result;
    }
    if (!target) return null;
    const stem = target.replace(/\.(js|mjs|cjs|ts|tsx|jsx|mts|cts)$/, "");
    const candidates = [target, ...[".js", ".ts", ".mjs", ".mts", ".cjs", ".cts", ".jsx", ".tsx"].map((ext) => stem + ext), ...[".js", ".ts", ".mjs", ".mts", ".cjs"].map((ext) => path.join(target, `index${ext}`))];
    const file = candidates.find((candidate) => this.isLocal(candidate) && fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    return file ?? null;
  }
  resolveExpression(file, expression, seen = new Set()) {
    let node = unwrap(expression);
    const model = this.file(file);
    if (!model || !node) return null;
    const key = `${file}:${node.pos}:${node.end}`;
    if (seen.has(key) || seen.size > 80) return { file, node };
    seen.add(key);
    if (ts.isIdentifier(node)) {
      const imp = model.imports.get(node.text);
      if (imp?.file && imp.name !== "*") return this.exported(imp.file, imp.name, seen);
      const bound = model.bindings.get(node.text);
      if (bound && bound !== node) return this.resolveExpression(file, bound, seen);
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const lhs = unwrap(node.expression);
      if (ts.isIdentifier(lhs)) {
        const imp = model.imports.get(lhs.text);
        if (imp?.file && imp.name === "*") return this.exported(imp.file, member(node), seen);
        const bound = model.bindings.get(lhs.text);
        if (bound && ts.isObjectLiteralExpression(bound)) {
          const prop = bound.properties.find((entry) => ts.isPropertyAssignment(entry) && propertyName(entry.name) === member(node));
          if (prop) return this.resolveExpression(file, prop.initializer, seen);
        }
      }
    }
    return { file, node };
  }
  exported(file, exportedName, seen = new Set()) {
    const token = `export:${file}:${exportedName}`;
    if (seen.has(token)) return null;
    seen.add(token);
    const model = this.file(file);
    if (!model) return null;
    const exportValue = model.exports.get(exportedName);
    if (exportValue?.file && exportValue.name) {
      if (exportValue.file === file) {
        if (model.bindings.has(exportValue.name)) return this.resolveExpression(file, model.bindings.get(exportValue.name), seen);
        // `import { User } from "..."; export { User }` is a re-export.
        const imported = model.imports.get(exportValue.name);
        if (imported?.file && imported.name !== "*") return this.exported(imported.file, imported.name, seen);
      }
      return this.exported(exportValue.file, exportValue.name, seen);
    }
    if (exportValue) return this.resolveExpression(file, exportValue, seen);
    if (exportedName === "default" && model.bindings.has("default")) return this.resolveExpression(file, model.bindings.get("default"), seen);
    const wildcard = model.exports.get("*");
    if (wildcard?.file) return this.exported(wildcard.file, exportedName, seen);
    return null;
  }
  externalCallSchema(file, call) {
    let root = unwrap(call.expression);
    while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) root = unwrap(root.expression);
    if (!ts.isIdentifier(root)) return null;
    const imported = this.file(file)?.imports.get(root.text);
    if (!imported || imported.file || imported.spec.startsWith(".")) return null;
    // Read installed declarations, never import/execute the dependency or app.
    // This is lazy: most schemas are resolved using our much cheaper AST pass.
    if (!this.typeProgram) {
      this.typeProgram = ts.createProgram([...this.cache.keys()], {
        ...this.compilerOptions, allowJs: true, checkJs: false, noEmit: true,
        skipLibCheck: true, strictNullChecks: true, types: [],
        module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
      });
      this.typeChecker = this.typeProgram.getTypeChecker();
    }
    const source = this.typeProgram.getSourceFile(file);
    if (!source) return null;
    let target = null;
    const find = (node) => {
      if (node.pos === call.pos && node.end === call.end && ts.isCallExpression(node)) target = node;
      else if (node.pos <= call.pos && node.end >= call.end) ts.forEachChild(node, find);
    };
    find(source);
    if (!target) return null;
    const checker = this.typeChecker;
    const convert = (type, depth = 0) => {
      if (!type || depth > 8 || type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) return null;
      if (type.flags & ts.TypeFlags.StringLike) return { type: "string" };
      if (type.flags & ts.TypeFlags.NumberLike) return { type: "number" };
      if (type.flags & ts.TypeFlags.BooleanLike) return { type: "boolean" };
      if (type.flags & ts.TypeFlags.Null) return { type: "null" };
      if (type.isUnion()) {
        const values = type.types.map((part) => convert(part, depth + 1));
        // A partially unknown union cannot safely be narrowed.
        if (values.some((part) => !part)) return null;
        const unique = [...new Map(values.map((value) => [JSON.stringify(value), value])).values()];
        return unique.length === 1 ? unique[0] : { anyOf: unique };
      }
      if (checker.isArrayType(type)) {
        const item = convert(checker.getTypeArguments(type)[0], depth + 1);
        return item ? { type: "array", items: item } : null;
      }
      return null;
    };
    return convert(checker.getAwaitedType(checker.getTypeAtLocation(target)));
  }
  knownMissingEnvironment(file, expression, depth = 0) {
    if (!expression || depth > 18) return false;
    const node = unwrap(expression);
    if (ts.isIdentifier(node)) {
      const resolved = this.resolveExpression(file, node);
      return resolved && resolved.node !== node ? this.knownMissingEnvironment(resolved.file, resolved.node, depth + 1) : false;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const receiver = unwrap(node.expression);
      if (ts.isPropertyAccessExpression(receiver) && ts.isIdentifier(receiver.expression) && receiver.expression.text === "process" && receiver.name.text === "env") {
        const key = ts.isPropertyAccessExpression(node) ? node.name.text : this.staticValue(file, node.argumentExpression, depth + 1);
        return typeof key === "string" && process.env[key] === undefined && this.localEnv[key] === undefined;
      }
    }
    return false;
  }
  staticValue(file, node, depth = 0) {
    if (!node || depth > 18) return undefined;
    node = unwrap(node);
    if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isPrefixUnaryExpression(node)) {
      const value = this.staticValue(file, node.operand, depth + 1);
      if (node.operator === ts.SyntaxKind.MinusToken) return typeof value === "number" ? -value : undefined;
      if (node.operator === ts.SyntaxKind.ExclamationToken) return value === undefined ? undefined : !value;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const receiver = unwrap(node.expression);
      if (ts.isPropertyAccessExpression(receiver) && ts.isIdentifier(receiver.expression) && receiver.expression.text === "process" && receiver.name.text === "env") {
        const key = ts.isPropertyAccessExpression(node) ? node.name.text : this.staticValue(file, node.argumentExpression, depth + 1);
        if (typeof key === "string") return process.env[key] ?? this.localEnv[key];
      }
    }
    if (ts.isConditionalExpression(node)) {
      const condition = this.staticValue(file, node.condition, depth + 1);
      if (condition !== undefined) return this.staticValue(file, condition ? node.whenTrue : node.whenFalse, depth + 1);
    }
    if (ts.isTemplateExpression(node)) {
      let out = node.head.text;
      for (const span of node.templateSpans) {
        const value = this.staticValue(file, span.expression, depth + 1);
        if (["string", "number"].includes(typeof value)) out += value + span.literal.text;
        else return undefined;
      }
      return out;
    }
    if (ts.isBinaryExpression(node)) {
      const kind = node.operatorToken.kind;
      const left = this.staticValue(file, node.left, depth + 1);
      if (left === undefined && !this.knownMissingEnvironment(file, node.left, depth + 1)) return undefined;
      if (kind === ts.SyntaxKind.BarBarToken) return left ? left : this.staticValue(file, node.right, depth + 1);
      if (kind === ts.SyntaxKind.QuestionQuestionToken) return left == null ? this.staticValue(file, node.right, depth + 1) : left;
      if (kind === ts.SyntaxKind.AmpersandAmpersandToken) return left ? this.staticValue(file, node.right, depth + 1) : left;
      const right = this.staticValue(file, node.right, depth + 1);
      if (kind === ts.SyntaxKind.PlusToken && ["string", "number"].includes(typeof left) && ["string", "number"].includes(typeof right)) return left + right;
      if (kind === ts.SyntaxKind.EqualsEqualsEqualsToken && left !== undefined && right !== undefined) return left === right;
      if (kind === ts.SyntaxKind.ExclamationEqualsEqualsToken && left !== undefined && right !== undefined) return left !== right;
    }
    if (ts.isArrayLiteralExpression(node)) {
      const out = [];
      for (const element of node.elements) {
        if (ts.isSpreadElement(element)) {
          const value = this.staticValue(file, element.expression, depth + 1);
          if (!Array.isArray(value)) return undefined;
          out.push(...value);
        } else { const value = this.staticValue(file, element, depth + 1); if (value === undefined) return undefined; out.push(value); }
      }
      return out;
    }
    if (ts.isObjectLiteralExpression(node)) {
      const out = {};
      for (const prop of node.properties) {
        if (ts.isSpreadAssignment(prop)) {
          const value = this.staticValue(file, prop.expression, depth + 1);
          if (!value || typeof value !== "object") return undefined;
          Object.assign(out, value);
        } else if (ts.isPropertyAssignment(prop)) {
          const key = propertyName(prop.name) ?? (ts.isComputedPropertyName(prop.name) ? this.staticValue(file, prop.name.expression, depth + 1) : null);
          const value = this.staticValue(file, prop.initializer, depth + 1);
          if (key === null || value === undefined) return undefined;
          out[key] = value;
        } else if (ts.isShorthandPropertyAssignment(prop)) {
          const value = this.staticValue(file, prop.name, depth + 1);
          if (value === undefined) return undefined; out[prop.name.text] = value;
        }
      }
      return out;
    }
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const resolved = this.resolveExpression(file, node);
      if (resolved && resolved.node !== node) return this.staticValue(resolved.file, resolved.node, depth + 1);
    }
    return undefined;
  }
}
export function joinedRoute(base, segment) {
  const path = `${base ?? ""}/${segment ?? ""}`.replace(/\/+/g, "/");
  return path.length > 1 ? path.replace(/\/$/, "") : "/";
}
