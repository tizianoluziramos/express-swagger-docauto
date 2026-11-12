import path from "node:path";
import { syntax as ts, member, joinedRoute, unwrap } from "./project.js";

const verbs = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace", "all"]);
const isFunction = (node) => node && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node));

function callsInStatements(statements, project, file) {
  const calls = [];
  const seenFunctions = new Set();
  const descend = (body) => {
    for (const statement of body) {
      if (ts.isExpressionStatement(statement)) {
        const expression = unwrap(statement.expression);
        if (ts.isCallExpression(expression)) {
          calls.push(expression);
          if (ts.isIdentifier(expression.expression)) {
            const resolved = project.resolveExpression(file, expression.expression);
            if (resolved && isFunction(resolved.node) && !seenFunctions.has(resolved.node)) {
              seenFunctions.add(resolved.node);
              if (resolved.node.body && ts.isBlock(resolved.node.body)) descend(resolved.node.body.statements);
            }
          }
        }
      } else if (ts.isIfStatement(statement)) {
        const read = (target) => ts.isBlock(target) ? descend(target.statements) : descend([target]);
        read(statement.thenStatement);
        if (statement.elseStatement) read(statement.elseStatement);
      } else if (ts.isBlock(statement)) descend(statement.statements);
      else if (ts.isTryStatement(statement)) {
        descend(statement.tryBlock.statements);
        if (statement.catchClause) descend(statement.catchClause.block.statements);
        if (statement.finallyBlock) descend(statement.finallyBlock.statements);
      }
    }
  };
  descend(statements);
  return calls;
}

function flatten(file, args, project, diagnostics, depth = 0, conditional = false) {
  if (depth > 12) return [];
  const result = [];
  for (let arg of args) {
    arg = unwrap(arg);
    if (ts.isSpreadElement(arg)) { result.push(...flatten(file, [arg.expression], project, diagnostics, depth + 1, conditional)); continue; }
    if (ts.isArrayLiteralExpression(arg)) { result.push(...flatten(file, arg.elements, project, diagnostics, depth + 1, conditional)); continue; }
    if (ts.isIdentifier(arg)) {
      const resolved = project.resolveExpression(file, arg);
      if (resolved && resolved.node !== arg && ts.isArrayLiteralExpression(resolved.node)) {
        result.push(...flatten(resolved.file, [resolved.node], project, diagnostics, depth + 1, conditional)); continue;
      }
    }
    if (ts.isConditionalExpression(arg)) {
      const value = project.staticValue(file, arg.condition);
      if (value === true || value === false) result.push(...flatten(file, [value ? arg.whenTrue : arg.whenFalse], project, diagnostics, depth + 1, conditional));
      else {
        // Do not treat a config-dependent middleware as guaranteed to run.
        // Explore both branches, recording that their handlers are optional.
        result.push(...flatten(file, [arg.whenTrue, arg.whenFalse], project, diagnostics, depth + 1, true));
      }
      continue;
    }
    result.push({ file, node: arg, conditional });
  }
  return result;
}

function callChain(call) {
  const chain = [];
  let current = call;
  while (ts.isCallExpression(current) && (ts.isPropertyAccessExpression(current.expression) || ts.isElementAccessExpression(current.expression))) {
    chain.unshift(current);
    const receiver = unwrap(current.expression.expression);
    if (!ts.isCallExpression(receiver)) break;
    current = receiver;
  }
  return chain;
}

function registrations(call, project, file) {
  const items = [];
  let fluentRoute = null;
  let chainOwner = null;
  for (const current of callChain(call)) {
    const action = member(current.expression);
    const receiver = unwrap(current.expression.expression);
    if (ts.isIdentifier(receiver)) chainOwner = receiver.text;
    else if (!ts.isCallExpression(receiver)) chainOwner = null;
    if (!verbs.has(action) && action !== "route" && action !== "use") {
      chainOwner = null;
      fluentRoute = null;
      continue;
    }
    if (action === "route" && chainOwner) {
      fluentRoute = { owner: chainOwner, route: project.staticValue(file, current.arguments[0]) };
      continue;
    }
    if (fluentRoute && verbs.has(action)) {
      items.push({ type: "route", owner: fluentRoute.owner, method: action, route: fluentRoute.route, args: [...current.arguments], call: current });
      continue;
    }
    if (chainOwner && verbs.has(action)) {
      const resolved = ts.isIdentifier(receiver) ? project.resolveExpression(file, receiver) : null;
      const aliasedRoute = resolved?.node && ts.isCallExpression(resolved.node) && member(resolved.node.expression) === "route" ? resolved.node : null;
      const routedOwner = aliasedRoute ? unwrap(aliasedRoute.expression.expression) : null;
      if (aliasedRoute && ts.isIdentifier(routedOwner)) {
        items.push({ type: "route", owner: routedOwner.text, method: action, route: project.staticValue(resolved.file, aliasedRoute.arguments[0]), args: [...current.arguments], call: current });
      } else {
        items.push({ type: "route", owner: chainOwner, method: action, route: project.staticValue(file, current.arguments[0]), args: [...current.arguments.slice(1)], call: current });
      }
    } else if (chainOwner && action === "use") {
      items.push({ type: "use", owner: chainOwner, args: [...current.arguments], call: current });
    }
  }
  return items;
}

function routerNameOf(expression, file, project) {
  const resolved = project.resolveExpression(file, expression);
  if (!resolved) return null;
  const model = project.file(resolved.file);
  if (!model) return null;
  for (const [name, declaration] of model.bindings) {
    if (declaration === resolved.node) return { file: resolved.file, owner: name };
  }
  return null;
}

function hasRegistrations(project, file, owner) {
  if (!owner) return false;
  const model = project.file(file);
  if (!model) return false;
  return callsInStatements(model.ast.statements, project, file).some((call) =>
    registrations(call, project, file).some((item) => item.owner === owner));
}

function isSwaggerdocImport(imported) {
  return imported && (
    imported.spec === "express-swagger-docauto" ||
    imported.spec.startsWith("express-swagger-docauto/")
  );
}

function isSwaggerdocCall(project, file, expression, seen = new Set()) {
  const invoked = unwrap(expression);
  const model = project.file(file);
  if (!model || !invoked) return false;

  if (ts.isIdentifier(invoked)) {
    const imported = model.imports.get(invoked.text);
    if (imported) return isSwaggerdocImport(imported) && imported.name === "swaggerdoc";

    // Permit a local alias such as `const describe = swaggerdoc` without
    // treating unrelated functions named swaggerdoc as annotations.
    if (seen.has(invoked.text) || seen.size >= 12) return false;
    const initializer = model.bindings.get(invoked.text);
    if (!initializer || initializer === invoked) return false;
    seen.add(invoked.text);
    return isSwaggerdocCall(project, file, initializer, seen);
  }

  if (ts.isPropertyAccessExpression(invoked) || ts.isElementAccessExpression(invoked)) {
    if (member(invoked) !== "swaggerdoc") return false;
    const receiver = unwrap(invoked.expression);
    if (!ts.isIdentifier(receiver)) return false;
    const imported = model.imports.get(receiver.text);
    // `import * as doc from ...` and CommonJS `require(...)` namespaces.
    return isSwaggerdocImport(imported) && ["*", "default"].includes(imported.name);
  }

  return false;
}

function annotation(project, item) {
  const { file, node } = item;
  if (!ts.isCallExpression(node) || !isSwaggerdocCall(project, file, node.expression)) return null;
  const details = project.staticValue(file, node.arguments[0]);
  return typeof details?.summary === "string" && details.summary.trim()
    ? { summary: details.summary }
    : {};
}

function location(project, file, call) {
  const source = project.file(file).ast;
  const position = source.getLineAndCharacterOfPosition(call.getStart(source));
  return `${path.relative(project.root, file)}:${position.line + 1}`;
}

function registrationList(project, file) {
  const model = project.file(file);
  if (!model) return [];
  return callsInStatements(model.ast.statements, project, file).flatMap((call) => registrations(call, project, file));
}

function entryOwners(project, file, registrationsList, diagnostics) {
  const owners = new Set(registrationsList.map((item) => item.owner));
  const mounted = new Set();
  for (const item of registrationsList.filter((item) => item.type === "use")) {
    const rawPath = project.staticValue(file, item.args[0]);
    const hasPath = typeof rawPath === "string" || (Array.isArray(rawPath) && rawPath.every((v) => typeof v === "string"));
    for (const node of flatten(file, hasPath ? item.args.slice(1) : item.args, project, diagnostics)) {
      const target = routerNameOf(node.node, node.file, project);
      if (target?.file === file && hasRegistrations(project, file, target.owner)) mounted.add(target.owner);
    }
  }
  const roots = [...owners].filter((owner) => !mounted.has(owner));
  const exported = project.exported(file, "default");
  if (exported) {
    const model = project.file(file);
    const declared = [...model.bindings].find(([, value]) => value === exported.node)?.[0];
    if (declared && roots.includes(declared)) return [declared];
  }
  if (roots.length) return roots;
  if (owners.size) diagnostics.push({ level: "warning", code: "ROUTER_CYCLE", message: `No unmounted entry router found in ${path.relative(project.root, file)}` });
  return [...owners];
}

export function discoverRoutes(project, entry, diagnostics) {
  const operations = [];
  const visited = new Set();
  const registered = new Map();
  const list = (file) => {
    if (!registered.has(file)) registered.set(file, registrationList(project, file));
    return registered.get(file);
  };
  const visit = (file, base = "", inherited = [], ownerFilter, depth = 0) => {
    if (depth > 50) { diagnostics.push({ level: "warning", code: "ROUTER_DEPTH", message: `Router nesting exceeds safe depth at ${file}` }); return; }
    const key = `${file}:${ownerFilter}`;
    if (visited.has(key)) { diagnostics.push({ level: "warning", code: "ROUTER_CYCLE", message: `Repeated router mount: ${key}` }); return; }
    visited.add(key);
    const model = project.file(file);
    if (!model) { diagnostics.push({ level: "warning", code: "MISSING_MODULE", message: `Cannot resolve ${file}` }); visited.delete(key); return; }
    const globals = [];
    for (const item of list(file)) {
      if (item.owner !== ownerFilter) continue;
      if (item.type === "use") {
        const rawPath = project.staticValue(file, item.args[0]);
        const segments = typeof rawPath === "string" ? [rawPath] : Array.isArray(rawPath) && rawPath.every((v) => typeof v === "string") ? rawPath : [""];
        const middleware = typeof rawPath === "string" || (Array.isArray(rawPath) && rawPath.every((v) => typeof v === "string")) ? item.args.slice(1) : item.args;
        for (const segment of segments) {
          for (const arg of flatten(file, middleware, project, diagnostics)) {
            const target = routerNameOf(arg.node, arg.file, project);
            if (target && (target.file !== file || target.owner !== item.owner) && hasRegistrations(project, target.file, target.owner)) {
              visit(target.file, joinedRoute(base, segment), [...inherited, ...globals], target.owner, depth + 1);
            } else if (!annotation(project, arg)) {
              globals.push({ ...arg, mount: segment ? joinedRoute(base, segment) : null });
            }
          }
        }
        continue;
      }
      const route = item.route;
      if (typeof route !== "string" && !(Array.isArray(route) && route.every((v) => typeof v === "string"))) {
        diagnostics.push({ level: "warning", code: "DYNAMIC_ROUTE", message: `Dynamic Express route cannot be determined at ${location(project, file, item.call)}` });
        continue;
      }
      const args = flatten(file, item.args, project, diagnostics);
      const title = args.map((arg) => annotation(project, arg)).find((found) => found !== null);
      const handlers = args.filter((arg) => annotation(project, arg) === null);
      const last = handlers.at(-1);
      for (const fragment of (Array.isArray(route) ? route : [route])) {
        const fullPath = joinedRoute(base, fragment);
        const scoped = [...inherited, ...globals].filter((middleware) => !middleware.mount || fullPath === middleware.mount || fullPath.startsWith(`${middleware.mount}/`));
        operations.push({ method: item.method, path: fullPath, summary: title?.summary, handlers: [...scoped, ...handlers], last, file, location: location(project, file, item.call) });
      }
    }
    visited.delete(key);
  };
  const entryFile = path.resolve(project.root, entry);
  const roots = entryOwners(project, entryFile, list(entryFile), diagnostics);
  for (const owner of roots) visit(entryFile, "", [], owner);
  return operations;
}
