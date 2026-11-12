import path from "node:path";
import { createRequire } from "node:module";
import { generateOpenApi } from "./src/generator.js";

const annotation = Symbol.for("express-swaggerdoc-auto.annotation");
export function swaggerdoc({ summary } = {}) {
  if (summary !== undefined && (typeof summary !== "string" || !summary.trim())) throw new TypeError("swaggerdoc summary must be a non-empty string");
  function annotationMiddleware(_req, _res, next) { next(); }
  Object.defineProperty(annotationMiddleware, annotation, { value: Object.freeze({ summary }) });
  return annotationMiddleware;
}
export { generateOpenApi };
export async function installSwaggerdoc(app, {
  root = process.cwd(), entry = "src/app.js", docsPath = "/api/v1/docs",
  title, version, strict = false, ui = true, logDiagnostics = true,
} = {}) {
  const result = await generateOpenApi({ root, entry, title, version, strict });
  if (logDiagnostics) for (const issue of result.diagnostics) console.warn(`[swaggerdoc-auto:${issue.code}] ${issue.message}`);
  const url = docsPath.replace(/\/$/, "") || "/docs";
  app.get(`${url}/openapi.json`, (_req, res) => res.json(result.document));
  if (ui) {
    const requireFromProject = createRequire(path.join(path.resolve(root), "package.json"));
    let uiModule;
    try { uiModule = requireFromProject("swagger-ui-express"); }
    catch (cause) { throw new Error("Install swagger-ui-express to serve Swagger UI", { cause }); }
    app.use(url, uiModule.serve, uiModule.setup(result.document));
  }
  return result;
}
