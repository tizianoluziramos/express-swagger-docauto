import path from "node:path";
import ts from "typescript";
import { TypeSchemas } from "./types.js";
import { SerializationInference } from "./serialization.js";

const unresolvedTypeDiagnostics = new Set([2304, 2305, 2306, 2307, 2314, 2315, 2339, 2503, 2552, 2589, 2694, 2709, 2724, 2792, 2835, 7016]);

// One compiler universe per generation. Neither module resolution nor type
// discovery loads project code, compiler plugins or dependency entry points.
export class TypeInference {
  constructor(root, files, diagnostics, entry, pkg = {}) {
    this.root = root;
    this.diagnostics = diagnostics;
    this.expressions = new Map();
    this.awaitedExpressions = new Map();
    this.nodes = new Map();
    this.literals = new Map();
    this.legacyAlias = typeof pkg.imports?.["#/*"] === "string" ? pkg.imports["#/*"] : "./src/*";
    const tsconfig = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json");
    const jsconfig = ts.findConfigFile(root, ts.sys.fileExists, "jsconfig.json");
    const config = [tsconfig, jsconfig].filter(Boolean)
      .sort((a, b) => path.dirname(b).length - path.dirname(a).length)[0];
    let parsed;
    const report = (issue) => diagnostics.push({
      level: "warning", code: "TYPESCRIPT_CONFIG",
      message: `${config ?? root}: TS${issue.code}: ${ts.flattenDiagnosticMessageText(issue.messageText, "\n")}`,
    });
    this.reportConfig = report;
    if (config) {
      const content = ts.readConfigFile(config, ts.sys.readFile);
      if (content.error) report(content.error);
      else {
        parsed = ts.parseJsonConfigFileContent(content.config, ts.sys, path.dirname(config), { allowJs: true }, config);
        // An empty include is not an inference failure: the entry may be JS.
        for (const issue of parsed.errors) if (issue.code !== 18003) report(issue);
      }
    }
    const configured = Object.fromEntries(Object.entries(parsed?.options ?? {}).filter(([, value]) => value !== undefined));
    const defaultModule = configured.moduleResolution === ts.ModuleResolutionKind.Node16 ? ts.ModuleKind.Node16
      : configured.moduleResolution === ts.ModuleResolutionKind.Bundler ? ts.ModuleKind.ESNext
        : [ts.ModuleResolutionKind.Node10, ts.ModuleResolutionKind.Classic].includes(configured.moduleResolution)
          ? ts.ModuleKind.CommonJS : ts.ModuleKind.NodeNext;
    this.options = {
      target: ts.ScriptTarget.ESNext,
      module: defaultModule,
      strictNullChecks: true,
      checkJs: true,
      maxNodeModuleJsDepth: 100,
      ...configured,
      // Include JS alongside TS even in projects which only emit TS.
      allowJs: true, noEmit: true, skipLibCheck: true,
    };
    if (this.options.moduleResolution === undefined) {
      this.options.moduleResolution = this.options.module === ts.ModuleKind.NodeNext ? ts.ModuleResolutionKind.NodeNext
        : this.options.module === ts.ModuleKind.Node16 ? ts.ModuleResolutionKind.Node16
          : this.options.module === ts.ModuleKind.CommonJS ? ts.ModuleResolutionKind.Node10
            : ts.ModuleResolutionKind.Bundler;
    }
    this.files = [...new Set([...(parsed?.fileNames ?? files), ...(entry ? [path.resolve(root, entry)] : [])])];
    this.projectReferences = parsed?.projectReferences;
  }
  initialize() {
    if (this.program) return;
    this.host = ts.createCompilerHost(this.options, true);
    this.moduleCache = ts.createModuleResolutionCache(this.root, this.host.getCanonicalFileName, this.options);
    this.host.resolveModuleNameLiterals = (literals, from, redirect, options, source) =>
      literals.map((literal) => this.resolveModule(literal.text, from, options, redirect,
        source ? ts.getModeForUsageLocation(source, literal, options) : undefined));
    this.program = ts.createProgram({
      rootNames: this.files, options: this.options, host: this.host, projectReferences: this.projectReferences,
    });
    for (const issue of this.program.getOptionsDiagnostics()) this.reportConfig(issue);
    this.checker = this.program.getTypeChecker();
    this.types = new TypeSchemas(this.checker);
    this.serialization = new SerializationInference(this);
  }
  source(file) {
    this.initialize();
    return this.program.getSourceFile(file);
  }
  resolveModule(spec, from, options, redirect, mode) {
    const result = ts.resolveModuleName(spec, from, options, this.host, this.moduleCache, redirect, mode);
    if (result.resolvedModule || !spec.startsWith("#/")) return result;
    const relative = path.relative(this.root, from);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ||
      from.replaceAll("\\", "/").includes("/node_modules/")) return result;
    // Preserve the package's established #/* alias even in compiler modes
    // which reject this spelling. Only translate the local specifier; let
    // TypeScript resolve files, declarations, extensions and module modes.
    const target = path.resolve(this.root, this.legacyAlias.replace("*", spec.slice(2)));
    const targetRelative = path.relative(this.root, target);
    if (targetRelative === ".." || targetRelative.startsWith(`..${path.sep}`) || path.isAbsolute(targetRelative)) return result;
    const fallback = ts.resolveModuleName(target, from, options, this.host, this.moduleCache, redirect, mode);
    return fallback.resolvedModule ? fallback : result;
  }
  resolve(from, spec, usage) {
    this.initialize();
    const source = this.source(from);
    const mode = usage && source ? ts.getModeForUsageLocation(source, usage, this.options)
      : source ? ts.getImpliedNodeFormatForFile(from, undefined, this.host, this.options) : undefined;
    return this.resolveModule(spec, from, this.options, undefined, mode)
      .resolvedModule?.resolvedFileName ?? null;
  }
  node(file, expression) {
    if (!expression) return null;
    const source = this.source(file);
    if (!source) return null;
    if (expression.getSourceFile() === source) return expression;
    const key = `${file}:${expression.pos}:${expression.end}:${expression.kind}`;
    if (this.nodes.has(key)) return this.nodes.get(key);
    let target = null;
    const find = (node) => {
      if (node.pos === expression.pos && node.end === expression.end && node.kind === expression.kind) target = node;
      else if (node.pos <= expression.pos && node.end >= expression.end) ts.forEachChild(node, find);
    };
    find(source);
    this.nodes.set(key, target);
    return target;
  }
  infer(file, expression, awaited = false) {
    const node = this.node(file, expression);
    if (!node) return { schema: null, issues: [{ path: "$", reason: "Expression is not part of the TypeScript Program" }] };
    const cache = awaited ? this.awaitedExpressions : this.expressions;
    if (cache.has(node)) return cache.get(node);
    let type = this.checker.getTypeAtLocation(node);
    const signature = ts.isCallExpression(node) ? this.checker.getResolvedSignature(node) : null;
    // Preserve narrowing and optional-call undefined branches. The resolved
    // signature is only a fallback, not a replacement for the expression type.
    const returnsType = signature && this.checker.getReturnTypeOfSignature(signature);
    if ((!type || type.flags & ts.TypeFlags.Any) && returnsType && !(returnsType.flags & ts.TypeFlags.Any)) type = returnsType;
    if (ts.isAwaitExpression(node)) type = this.checker.getAwaitedType(this.checker.getTypeAtLocation(node.expression)) ?? type;
    else if (awaited) type = this.checker.getAwaitedType(type) ?? type;
    // Await expressions and implicit async return adoption only.
    // Promise-valued object properties are NOT awaited by JSON.stringify().
    let schema = this.types.convert(type);
    let issues = this.types.issues(type);
    if (!schema && type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
      const recovered = this.serialization.infer(node);
      if (recovered) { schema = recovered.schema; issues = recovered.issues; }
    }
    const returns = signature?.getJsDocTags().find((tag) => tag.name === "returns" || tag.name === "return");
    const description = ts.displayPartsToString(returns?.text);
    const result = { schema: schema && description ? { ...schema, description } : schema,
      issues };
    cache.set(node, result);
    return result;
  }
  literalValues(file, expression) {
    const node = this.node(file, expression);
    if (!node) return [];
    if (this.literals.has(node)) return this.literals.get(node);
    const type = this.checker.getTypeAtLocation(node);
    const values = (type.isUnion() ? type.types : [type])
      .filter((part) => part.flags & (ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral))
      .map((part) => part.value);
    this.literals.set(node, values);
    return values;
  }
  explain(file, expression, field) {
    const { issues } = this.infer(file, expression);
    const issue = issues.find((item) => item.path === field) ?? issues.find((item) => field.startsWith(item.path));
    // Query diagnostics only for incomplete responses, not the entire project.
    if (!this.semanticDiagnostics) this.semanticDiagnostics = new Map();
    const spans = new Set();
    const follow = (node) => {
      if (!node || spans.has(node) || spans.size >= 40 || node.getSourceFile().isDeclarationFile) return;
      spans.add(node);
      const identifiers = (child) => {
        if (ts.isIdentifier(child)) {
          const symbol = this.checker.getSymbolAtLocation(child);
          const declarations = [...(symbol?.declarations ?? []),
            ...(symbol?.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(symbol).declarations ?? [] : [])];
          for (let declaration of declarations) {
            // A missing module's diagnostic is located on its import string,
            // not on the response or the local alias which uses it.
            let parent = declaration;
            while (parent && !ts.isSourceFile(parent)) {
              if (ts.isImportDeclaration(parent) || ts.isImportEqualsDeclaration(parent)) { declaration = parent; break; }
              parent = parent.parent;
            }
            if (ts.isVariableDeclaration(declaration)) follow(declaration.initializer);
            else if (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) follow(declaration.body);
            else if (ts.isImportDeclaration(declaration) || ts.isImportEqualsDeclaration(declaration)) follow(declaration);
          }
        }
        ts.forEachChild(child, identifiers);
      };
      identifiers(node);
    };
    const origin = this.node(file, expression);
    follow(origin);
    const related = [];
    for (const span of spans) {
      const source = span.getSourceFile();
      if (!this.semanticDiagnostics.has(source)) this.semanticDiagnostics.set(source, this.program.getSemanticDiagnostics(source));
      for (const diagnostic of this.semanticDiagnostics.get(source)) {
        // A type mismatch in a distant configuration module does not explain
        // an opaque response value. Only resolution failures propagate here;
        // diagnostics on the response expression itself remain relevant.
        if ((span === origin || unresolvedTypeDiagnostics.has(diagnostic.code)) &&
          diagnostic.start >= span.pos && diagnostic.start <= span.end && !related.includes(diagnostic)) related.push(diagnostic);
      }
      if (related.length >= 3) break;
    }
    const reason = issue?.reason ?? "Static flow and TypeScript provide no serializable type for this value";
    return reason + (related.length ? `; ${related.slice(0, 3).map((item) =>
      `TS${item.code}: ${ts.flattenDiagnosticMessageText(item.messageText, " ")}`).join("; ")}` : "");
  }
  declaration(file, expression) {
    const node = this.node(file, expression);
    if (!node) return null;
    let symbol = this.checker.getSymbolAtLocation(ts.isPropertyAccessExpression(node) ? node.name : node);
    if (symbol?.flags & ts.SymbolFlags.Alias) symbol = this.checker.getAliasedSymbol(symbol);
    let declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    if (!declaration || declaration.getSourceFile().isDeclarationFile) return null;
    if (ts.isPropertyAccessExpression(declaration) || ts.isElementAccessExpression(declaration)) {
      const assignment = declaration.parent;
      if (ts.isBinaryExpression(assignment) && assignment.left === declaration &&
        assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken) declaration = assignment.right;
    } else if (ts.isBinaryExpression(declaration) && declaration.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      declaration = declaration.right;
    } else if (ts.isPropertyAssignment(declaration)) declaration = declaration.initializer;
    else if ((ts.isVariableDeclaration(declaration) || ts.isPropertyDeclaration(declaration)) && declaration.initializer) {
      declaration = declaration.initializer;
    }
    return declaration;
  }
}
