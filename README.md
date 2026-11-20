# express-swagger-docauto

Automatically generate OpenAPI 3.1 documentation for Express applications.

## Installation

```bash
pnpm add express-swagger-docauto swagger-ui-express
```

## Usage

Routes and response types are discovered without annotations or manual schemas.
Use `swaggerdoc()` only when you want to add a summary:

```js
import { swaggerdoc, installSwaggerdoc } from "express-swagger-docauto";

router.post("/login", swaggerdoc({ summary: "Authenticate user" }), login);

await installSwaggerdoc(app, { title: "My API" });
```

Swagger UI: `/api/v1/docs`.

## Inference and limitations

The generator follows local service calls, callback-based service wrappers,
managed Sequelize transactions, middleware options, and selected Sequelize
columns and associations. A centralized TypeScript `Program` and `TypeChecker`
are shared throughout each generation, including expression, type, module and
schema caches. Compiler types are the primary source of response structure;
the existing flow analysis supplies invocation-specific values and fills
unknown portions when source evidence is available.

TypeScript resolves installed dependency declarations (`.d.ts`, `.d.mts`,
`.d.cts`) and JavaScript/JSDoc without executing the app, SDKs or compiler plugins.
No dependency-specific response adapters are required. JavaScript, TypeScript
and mixed projects are supported, including projects with no compiler config.
The nearest `tsconfig.json` or `jsconfig.json`, inherited options, `paths`,
`baseUrl`, `types`, `typeRoots`, and ESM/CommonJS package exports/imports are
used. JavaScript analysis is enabled with `allowJs`; `checkJs` defaults to true
unless configured otherwise. Analysis never emits files. Configured nullability
is respected; with `strictNullChecks: false`, TypeScript may erase nullable
alternatives before they can be documented.

Existing `#/…` aliases backed by `"imports": { "#/*": "./src/*" }` are
preserved in both route discovery and the compiler, including custom target
directories. No alias or source changes are needed in consuming projects.

Return schemas include awaited promises, object properties, optional fields,
literal and nullable unions, intersections, generic results, arrays, readonly
arrays, tuples, mapped/conditional types resolved by the compiler, and index
signatures. Recursive types use component references; equivalent named object
schemas are reused and unused components are omitted.
JSDoc descriptions, `@returns` descriptions and `@deprecated` metadata are
preserved where available. JSON serialization omits methods and undefined object
properties; declared `toJSON()` return types and dates describe serialized values.
Only actual awaits and implicit async return adoption unwrap promises:
promise-valued object properties are not treated as their eventual results.
Missing types remain unresolved rather than being replaced with invented fields.

### JSON and cache roundtrips

The generator can recover `JSON.parse()` result schemas from a traceable
`JSON.stringify()` producer, including the common cache-hit/cache-miss pattern:

```js
const cached = await storage.retrieve(key);
if (cached !== null) return JSON.parse(cached);
const value = await sdk.fetch();
await storage.persist(key, JSON.stringify(value));
return value;
```

No backend annotations or package-specific adapters are needed. The analyzer
matches stable client bindings and keys using compiler symbols, follows local
aliases and trivial serializer helpers, and combines the types of all matching
project-local writers. Client method names are not hardcoded. Known distinct
key namespaces are separated; possibly overlapping writes with unknown producers,
reassigned values, custom replacers/revivers and provenance cycles remain
unresolved rather than being silently ignored. Untraceable JSON stays generic.

Recovered schemas carry `x-swaggerdoc-serialization` with source locations,
`scope: "project-local-writers"` for storage, and `runtimeValidated: false`.
This describes the expected local serialization contract, not a guarantee about
stale data, external writers, storage implementation behavior or cache integrity.
The analyzer does not execute serializers or connect to storage. Applications
which need runtime guarantees must still validate deserialized input.

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
Concrete statuses found in services and helper arguments take precedence over
widened enum types; a returned enum member does not imply every HTTP status.

Static analysis cannot guarantee every runtime response. Dynamic code, external
service failures, inaccurate dependency declarations, custom serialization,
opaque external middleware and missing dependency types may require explicit contracts.
`any`, `unknown`, unresolved generics and unsupported JSON values retain valid
generic schemas rather than guessed fields. Partially known objects retain
their known properties. Unresolved response fields produce
`UNRESOLVED_RESPONSE_SCHEMA` warnings with the field path, unresolved type and
relevant TypeScript errors when available. Invalid compiler configurations
produce `TYPESCRIPT_CONFIG` diagnostics.
Use strict mode to reject documents with inference warnings:

```bash
pnpm exec swaggerdoc-auto --root . --entry src/app.js --strict --out openapi.json
```

No warnings means no detected gaps, not proof that every runtime case is covered.

## Development

```bash
npm test
npm run build
```

Tests install isolated fixture packages with declarations and JSDoc, including
entry points that throw if executed. They cover compiler resolution, mixed
projects, generics, overloads, recursion, serialization, HTTP response handling,
schema structure/reference validation, and existing inference regressions.
