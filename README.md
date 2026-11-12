# express-swagger-docauto

Automatically generate OpenAPI documentation for Express applications.

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