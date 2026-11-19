import path from "node:path";
import { Project } from "./project.js";
import { discoverRoutes } from "./routes.js";
import { analyzeRoute, statusText } from "./analyze.js";
import { syntax as ts, member, propertyName, walk } from "./project.js";

const supportedMethods = ["get", "post", "put", "patch", "delete", "head", "options", "trace"];
const normalize = (route) => route.replace(/:([A-Za-z_$][\w$]*)/g, "{$1}").replace(/\(\?\)/g, "");
const pathFields = (route) => [...route.matchAll(/:([A-Za-z_$][\w$]*)/g)].map((match) => match[1]);
const tagsOf = (route) => {
  const fragments = route.path.split("/").filter(Boolean).filter((s) => !s.startsWith(":"));
  const tag = fragments[0] === "api" && fragments.length > 2 ? fragments[2] : fragments[0] === "v1" && fragments.length > 1 ? fragments[1] : fragments.at(-2) ?? fragments.at(-1) ?? "API";
  return tag.split("-").map((token) => token.charAt(0).toUpperCase() + token.slice(1)).join(" ");
};
const operationId = (method, path) => `${method}_${path.replace(/[^\w]+/g, "_").replace(/^_|_$/g, "")}`;
function mergeSchema(values) {
  if (values.length === 1) return values[0];
  if (!values.length) return {};
  return { allOf: values };
}
function parameterSchema(value, location) {
  const schema = structuredClone(value);
  const parsed = schema["x-swaggerdoc-post-parse-schema"];
  // HTTP query parameters are textual on the wire. OpenAPI numeric parameters
  // describe their deserialized value and work naturally in Swagger UI.
  if (location === "query" && parsed?.type === "integer" && Array.isArray(schema.anyOf) &&
    schema.anyOf.some((item) => item.type === "number" || item.type === "integer") &&
    schema.anyOf.some((item) => item.type === "string" && item.pattern === "^\\d+$")) {
    const { default: defaultValue, description } = schema;
    return {
      ...parsed,
      ...(defaultValue !== undefined ? { default: defaultValue } : {}),
      ...(description ? { description } : {}),
    };
  }
  return schema;
}
const passwordField = /^(?:password|(?:current|new|old|confirm|repeat|verify)[_-]?password|password[_-]?(?:confirmation|confirm|repeat))$/i;
function protectPasswordExamples(schema, seen = new WeakSet()) {
  if (!schema || typeof schema !== "object" || seen.has(schema)) return schema;
  seen.add(schema);
  for (const [name, field] of Object.entries(schema.properties ?? {})) {
    if (passwordField.test(name) && field && typeof field === "object") {
      if (field.type === "string") field.format ??= "password";
      for (const variant of [...(field.anyOf ?? []), ...(field.oneOf ?? [])]) {
        if (variant?.type === "string") variant.format ??= "password";
      }
      field.writeOnly = true;
      if (!["example", "examples", "default", "const"].some((key) => Object.hasOwn(field, key))) {
        field.example = "";
        field.examples = [""];
      }
    }
    protectPasswordExamples(field, seen);
  }
  for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
    for (const variant of schema[key] ?? []) protectPasswordExamples(variant, seen);
  }
  protectPasswordExamples(schema.items, seen);
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    protectPasswordExamples(schema.additionalProperties, seen);
  }
  return schema;
}
function asParameters(schema, location) {
  if (!schema || schema.type !== "object") return [];
  return Object.entries(schema.properties ?? {}).map(([name, value]) => ({
    name, in: location, required: location === "path" || (schema.required ?? []).includes(name), schema: parameterSchema(value, location),
  }));
}
function discoverGlobalErrorHandling(project, entry) {
  const sourceFile = path.resolve(project.root, entry);
  const source = project.file(sourceFile);
  const handling = { zodBadRequest: false, zodMessage: null, internalMessage: null, errorSchema: null, dynamicStatus: false };
  if (!source) return handling;
  walk(source.ast, (node) => {
    if (!ts.isCallExpression(node) || member(node.expression) !== "use") return;
    for (const argument of node.arguments) {
      const handler = project.resolveExpression(sourceFile, argument);
      const fn = handler?.node;
      if (!fn || !Array.isArray(fn.parameters) || fn.parameters.length !== 4 || !fn.body) continue;
      const content = fn.body.getText();
      if (content.includes("ZodError") && content.includes("BAD_REQUEST")) handling.zodBadRequest = true;
      if (content.includes('"Validation failed"')) handling.zodMessage = "Validation failed";
      if (content.includes('"Internal Server Error"')) handling.internalMessage = "Internal Server Error";
      const bindings = new Map();
      walk(fn.body, (inner) => {
        if (ts.isVariableDeclaration(inner) && ts.isIdentifier(inner.name) && inner.initializer) bindings.set(inner.name.text, inner.initializer);
      });
      const dependsOnErrorStatus = (value, seen = new Set()) => {
        if (!value || seen.has(value)) return false;
        seen.add(value);
        if (ts.isIdentifier(value) && bindings.has(value.text)) return dependsOnErrorStatus(bindings.get(value.text), seen);
        if ((ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) &&
          ts.isIdentifier(value.expression) && value.expression.text === fn.parameters[0].name.getText() &&
          ["status", "statusCode"].includes(member(value))) return true;
        let found = false;
        ts.forEachChild(value, (child) => { if (dependsOnErrorStatus(child, seen)) found = true; });
        return found;
      };
      walk(fn.body, (inner) => {
        if (ts.isCallExpression(inner) && member(inner.expression) === "status" && dependsOnErrorStatus(inner.arguments[0])) handling.dynamicStatus = true;
        if (!ts.isCallExpression(inner) || member(inner.expression) !== "json") return;
        const body = inner.arguments[0];
        if (!body || !ts.isObjectLiteralExpression(body)) return;
        const keys = body.properties.filter((property) => ts.isPropertyAssignment(property) ||
          ts.isShorthandPropertyAssignment(property)).map((property) => propertyName(property.name));
        if (keys.includes("status") && keys.includes("message")) {
          handling.errorSchema = {
            type: "object",
            properties: { status: { type: "integer" }, message: { type: "string" } },
            required: ["status", "message"],
          };
        }
      });
    }
  });
  return handling;
}
function documentedResponses(known, errors, method, errorSchema, errorMessages, errorHandling) {
  const output = {};
  const groups = new Map();
  for (const item of known) {
    if (!groups.has(item.status)) groups.set(item.status, []);
    groups.get(item.status).push(item);
  }
  for (const [status, variants] of groups) {
    const content = {};
    const headers = {};
    for (const variant of variants) {
      for (const [name, value] of Object.entries(variant.headers ?? {})) {
        if (!headers[name]) headers[name] = value;
        else if (JSON.stringify(headers[name].schema) !== JSON.stringify(value.schema)) {
          headers[name] = { schema: { anyOf: [headers[name].schema, value.schema] } };
        }
      }
      if (!variant.schema) continue;
      const mediaType = variant.mediaType ?? "application/json";
      (content[mediaType] ??= []).push(variant.schema);
    }
    for (const [mediaType, values] of Object.entries(content)) {
      const schemas = [...new Map(values.map((value) => [JSON.stringify(value), value])).values()];
      content[mediaType] = { schema: schemas.length === 1 ? schemas[0] : { anyOf: schemas } };
    }
    output[String(status)] = {
      description: statusText(status),
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(!(status < 200 || [204, 205, 304].includes(status) || method === "head") && Object.keys(content).length ? { content } : {}),
    };
  }
  if (!groups.size) output.default = { description: "Response could not be determined statically" };
  for (const status of [...errors].sort((a, b) => a - b)) {
    if (status < 400 || status >= 600) continue;
    const messageOptions = new Set(errorMessages.get(status) ?? []);
    if (status === 400 && errorHandling.zodBadRequest && errorHandling.zodMessage) messageOptions.add(errorHandling.zodMessage);
    if (status >= 500 && errorHandling.internalMessage) {
      messageOptions.clear();
      messageOptions.add(errorHandling.internalMessage);
    }
    const messages = [...messageOptions];
    const schema = errorSchema ? structuredClone(errorSchema) : null;
    if (schema) {
      schema.properties.status = { type: "integer", const: status, example: status };
      if (messages.length) {
        // Not every exception path is statically enumerable; examples remain
        // truthful without asserting an exhaustively constrained enum.
        schema.properties.message = {
          type: "string", example: messages[0],
          ...(messages.length > 1 ? { examples: messages } : {}),
        };
      }
    }
    const response = output[String(status)];
    if (response && errorHandling.thrownErrors.has(status) && schema) {
      response.content ??= {};
      const previous = response.content["application/json"]?.schema;
      response.content["application/json"] = { schema: previous && JSON.stringify(previous) !== JSON.stringify(schema)
        ? { anyOf: [previous, schema] } : schema };
    }
    output[String(status)] ??= {
      description: statusText(status),
      ...(schema ? { content: { "application/json": { schema } } } : {}),
    };
  }
  if (groups.size && errorSchema && errorHandling.dynamicStatus) {
    output.default = {
      description: "Other error statuses forwarded to the application's error middleware, including dependency failures.",
      content: { "application/json": { schema: structuredClone(errorSchema) } },
    };
  }
  return output;
}
function operationFor(route, report, schemeRegistry, errorHandling) {
  const key = normalize(route.path);
  const operation = { tags: [tagsOf(route)], operationId: operationId(route.method, key) };
  if (route.summary) operation.summary = route.summary;
  const params = new Map();
  for (const kind of ["query", "params", "headers", "cookies"]) {
    const mapped = { query: "query", params: "path", headers: "header", cookies: "cookie" }[kind];
    for (const item of report.dto.filter((dto) => dto.kind === kind)) {
      for (const param of asParameters(item.json, mapped)) {
        const key = `${param.in}:${param.name}`;
        const previous = params.get(key);
        const required = mapped === "path" || (!item.conditional && param.required);
        params.set(key, { ...param, required: Boolean(previous?.required || required) });
      }
    }
  }
  for (const name of pathFields(route.path)) {
    if (!params.has(`path:${name}`)) params.set(`path:${name}`, { name, in: "path", required: true, schema: { type: "string" } });
  }
  if (params.size) operation.parameters = [...params.values()];
  const bodies = report.dto.filter((item) => item.kind === "body");
  const mandatory = bodies.filter((item) => !item.conditional);
  const included = mandatory.length ? mandatory : bodies;
  if (included.length) operation.requestBody = {
    required: mandatory.length > 0,
    content: { "application/json": { schema: protectPasswordExamples(mergeSchema(included.map((item) => item.json))) } },
  };
  const requirements = {};
  for (const candidate of report.securityCandidates) {
    const identifier = `Credential_${candidate.in}_${candidate.name.replace(/[^\w]/g, "_")}`;
    schemeRegistry[identifier] ??= { type: "apiKey", in: candidate.in, name: candidate.name };
    requirements[identifier] = [];
  }
  if (Object.keys(requirements).length) operation.security = [requirements];
  const errors = new Set(report.errors);
  if (report.dto.length && errorHandling.zodBadRequest) errors.add(400);
  operation.responses = documentedResponses(report.responses, errors, route.method, errorHandling.errorSchema, report.errorMessages,
    { ...errorHandling, thrownErrors: new Set([...report.thrownErrors, ...(report.dto.length && errorHandling.zodBadRequest ? [400] : [])]),
      zodBadRequest: errorHandling.zodBadRequest && report.dto.length > 0 });
  return operation;
}
function unknownResponseFields(schema, field = "$", components = {}, seen = new Set()) {
  if (!schema || typeof schema !== "object") return [];
  if (!Object.keys(schema).some((key) => !["description", "deprecated", "title", "example", "examples"].includes(key))) return [field];
  if (schema.$ref?.startsWith("#/components/schemas/")) {
    if (seen.has(schema.$ref)) return [];
    const next = new Set(seen); next.add(schema.$ref);
    const target = components[schema.$ref.slice("#/components/schemas/".length)];
    return target ? unknownResponseFields(target, field, components, next) : [field];
  }
  const unknown = [];
  for (const [key, value] of Object.entries(schema.properties ?? {})) unknown.push(...unknownResponseFields(value, `${field}.${key}`, components, seen));
  if (schema.items && schema.maxItems !== 0) unknown.push(...unknownResponseFields(schema.items, `${field}[]`, components, seen));
  for (const [index, value] of (schema.prefixItems ?? []).entries()) unknown.push(...unknownResponseFields(value, `${field}[${index}]`, components, seen));
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    unknown.push(...unknownResponseFields(schema.additionalProperties, `${field}.*`, components, seen));
  }
  for (const kind of ["anyOf", "oneOf", "allOf"]) for (const part of schema[kind] ?? []) {
    unknown.push(...unknownResponseFields(part, field, components, seen));
  }
  return [...new Set(unknown)];
}
export async function generateOpenApi({
  root = process.cwd(), entry = "src/app.js", title, version, strict = false, loadSchemas = true,
} = {}) {
  const diagnostics = [];
  const project = new Project(root, diagnostics);
  const routes = discoverRoutes(project, entry, diagnostics);
  if (!routes.length) diagnostics.push({ level: "warning", code: "NO_ROUTES", message: `No statically discoverable Express routes from ${entry}` });
  const errorHandling = discoverGlobalErrorHandling(project, entry);
  const document = {
    openapi: "3.1.0",
    info: { title: title ?? project.pkg.name ?? "Express API", version: version ?? project.pkg.version ?? "1.0.0" },
    servers: [{ url: "/" }], paths: {}, components: { securitySchemes: {} },
  };
  for (const route of routes) {
    const report = analyzeRoute(project, route);
    const key = normalize(route.path);
    for (const response of report.responses.filter((item) => route.method !== "head" && item.status >= 200 && ![204, 205, 304].includes(item.status))) for (const field of unknownResponseFields(response.schema, "$", project.externalTypeSchemas?.schemas)) {
      diagnostics.push({ level: "warning", code: "UNRESOLVED_RESPONSE_SCHEMA",
        message: `Response ${response.status} of ${route.method.toUpperCase()} ${key} has an unknown schema at ${field} (${route.location})` });
    }
    if (!document.paths[key]) document.paths[key] = {};
    const methods = route.method === "all" ? supportedMethods : [route.method];
    for (const method of methods) {
      if (document.paths[key][method]) diagnostics.push({ level: "warning", code: "DUPLICATE_ROUTE", message: `Route ${method.toUpperCase()} ${key} registered more than once (${route.location})` });
      document.paths[key][method] = operationFor({ ...route, method }, report, document.components.securitySchemes, errorHandling);
    }
    if (!report.successes.length) diagnostics.push({ level: "warning", code: "UNKNOWN_RESPONSE", message: `Response of ${route.method.toUpperCase()} ${key} cannot be fully inferred` });
  }
  if (!Object.keys(document.components.securitySchemes).length) delete document.components.securitySchemes;
  if (Object.keys(project.externalTypeSchemas?.schemas ?? {}).length) document.components.schemas = project.externalTypeSchemas.schemas;
  if (!Object.keys(document.components).length) delete document.components;
  if (strict && diagnostics.some((issue) => issue.level === "warning" || issue.level === "error")) {
    const sample = diagnostics.slice(0, 10).map((item) => `[${item.code}] ${item.message}`).join("\n");
    throw new Error(`Source documentation inference is incomplete:\n${sample}`);
  }
  return { document, diagnostics, stats: { scannedFiles: project.cache.size, routes: routes.length, inferredInputs: Object.values(document.paths).flatMap((v) => Object.values(v)).filter((op) => Boolean(op.requestBody)).length } };
}
