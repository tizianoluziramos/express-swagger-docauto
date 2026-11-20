# express-swagger-docauto

Automatically generate OpenAPI 3.1 documentation for Express applications without manual schemas or annotations.

## Installation

```bash
pnpm add express-swagger-docauto swagger-ui-express
```

## Usage

```js
import { swaggerdoc, installSwaggerdoc } from "express-swagger-docauto";

router.post("/login", swaggerdoc({ summary: "Authenticate user" }), login);

await installSwaggerdoc(app, { title: "My API" });
```

Swagger UI: `/api/v1/docs`

## Features

- Automatic route, request and response detection.
- Type inference using the TypeScript compiler and dependency declarations.
- JavaScript, TypeScript and mixed-project support.
- Automatic resolution of imports, aliases and generics.
- Support for async functions, middleware and services.
- Sequelize models, associations and Zod validation.
- JSON serialization and cache roundtrip inference.
- Automatic HTTP status codes and error responses.
- Reusable OpenAPI schemas and recursive types.
- Diagnostics for unresolved types.

## CLI

```bash
pnpm exec swaggerdoc-auto --root . --entry src/app.js --strict --out openapi.json
```

## Development

```bash
npm test
npm run build
```