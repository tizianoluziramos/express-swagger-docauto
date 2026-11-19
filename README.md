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
columns and associations. A lazy TypeScript checker reads installed dependency
declarations and available JavaScript/JSDoc without executing the app or SDK.
It follows clients constructed in local configuration modules and re-exports,
including project aliases and conditional package exports.

Return schemas include awaited promises, object properties, optional fields,
literal and nullable unions, intersections, generic results, arrays, readonly
arrays, tuples and index signatures. Recursive types use component references.
JSDoc descriptions, `@returns` descriptions and `@deprecated` metadata are
preserved where available. JSON serialization omits methods and undefined object
properties; declared `toJSON()` return types and dates describe serialized values.
Missing types remain unresolved rather than being replaced with invented fields.

Sequelize JSON and JSONB fields inherit their structure from unconditional
Zod `schema.parse(value)` calls in attribute validators, including eager-loaded
associations. No separate response DTO or handwritten OpenAPI schema is needed.
Conditional validation and `safeParse()` calls do not establish a field schema.
Without a validator, JSON/JSONB is documented as any JSON value, not as an
unknown field or an assumed object. Seed records are examples, not exhaustive
constraints on persisted data.

Explicit responses from controllers and local middleware are retained, including
error bodies. Alternatives sharing a status and media type use `anyOf`, since
their schemas may overlap. String `send()`, `sendStatus()`, JSON, chained content
types and redirect locations are distinguished; bodyless statuses omit content.
When the discovered global JSON error handler forwards dynamic exception
statuses, a `default` error response covers otherwise unenumerated statuses.
An upstream status or JSDoc `@throws` tag alone is not evidence that an endpoint
returns that HTTP status: the application's exception handling determines it.

Static analysis cannot guarantee every runtime response. Dynamic code, external
service failures, inaccurate dependency declarations, custom serialization,
opaque external middleware and missing dependency types may require explicit contracts.
Unresolved response fields produce `UNRESOLVED_RESPONSE_SCHEMA` warnings.
Use strict mode to reject documents with inference warnings:

```bash
pnpm exec swaggerdoc-auto --root . --entry src/app.js --strict --out openapi.json
```

No warnings means no detected gaps, not proof that every runtime case is covered.
