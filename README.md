# express-swagger-docauto

Automatically generate OpenAPI documentation for Express with Sequelize applications.

## Installation

```bash
pnpm add express-swagger-docauto swagger-ui-express
```

## Usage

Add `swaggerdoc()` to each route you want to document:

```js
import { swaggerdoc, installSwaggerdoc } from "express-swagger-docauto";

router.post("/login", swaggerdoc({ summary: "Authenticate user" }), login);

await installSwaggerdoc(app, { title: "My API" });
```

Swagger UI: `/api/v1/docs`.

## Inference and limitations

The generator follows local service calls, callback-based service wrappers,
managed Sequelize transactions, middleware options, and selected Sequelize
columns and associations. Installed dependency declarations can resolve
primitive return types, including awaited promises, without executing the app.

Static analysis cannot guarantee every runtime response. Dynamic code, external
service failures, and missing dependency types may require explicit contracts.
Unresolved response fields produce `UNRESOLVED_RESPONSE_SCHEMA` warnings.
Use strict mode to reject documents with inference warnings:

```bash
pnpm exec swaggerdoc-auto --root . --entry src/app.js --strict --out openapi.json
```

No warnings means no detected gaps, not proof that every runtime case is covered.
