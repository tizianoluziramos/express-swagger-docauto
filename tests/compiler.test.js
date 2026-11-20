import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { generateOpenApi } from "../src/generator.js";
import { Project } from "../src/project.js";

async function fixture(t, files, entry = "app.js") {
  const temporary = path.join(os.tmpdir(), "opencode");
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(path.join(temporary, "swaggerdoc-compiler-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries({ "package.json": '{"type":"module"}', ...files })) {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  const result = await generateOpenApi({ root, entry });
  validateDocument(result.document);
  return { ...result, root };
}
const response = (document, route, code = 200, media = "application/json") =>
  document.paths[route].get.responses[code].content[media].schema;
function deref(document, schema) {
  return schema.$ref ? document.components.schemas[schema.$ref.split("/").at(-1)] : schema;
}
// Validate the generated 3.1 schema vocabulary and every local reference, using
// no network requests or extra production dependencies.
function validateDocument(document) {
  assert.equal(document.openapi, "3.1.0");
  const visit = (schema) => {
    if (typeof schema === "boolean") return;
    assert.ok(schema && typeof schema === "object" && !Array.isArray(schema));
    if (schema.$ref) {
      assert.match(schema.$ref, /^#\/components\/schemas\/[\w.-]+$/);
      assert.ok(document.components.schemas[schema.$ref.split("/").at(-1)]);
    }
    if (schema.type) for (const type of Array.isArray(schema.type) ? schema.type : [schema.type]) {
      assert.ok(["object", "array", "string", "number", "integer", "boolean", "null"].includes(type));
    }
    if (schema.required) {
      assert.equal(new Set(schema.required).size, schema.required.length);
      for (const key of schema.required) assert.ok(Object.hasOwn(schema.properties, key));
    }
    if (schema.minItems !== undefined && schema.maxItems !== undefined) assert.ok(schema.minItems <= schema.maxItems);
    for (const part of Object.values(schema.properties ?? {})) visit(part);
    for (const key of ["items", "additionalProperties", "not"]) if (schema[key] !== undefined) visit(schema[key]);
    for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) if (schema[key]) {
      assert.ok(schema[key].length);
      for (const part of schema[key]) visit(part);
    }
  };
  for (const schema of Object.values(document.components?.schemas ?? {})) visit(schema);
  for (const methods of Object.values(document.paths)) for (const operation of Object.values(methods)) {
    for (const [code, value] of Object.entries(operation.responses)) {
      assert.match(code, /^(?:default|[1-5]\d\d)$/);
      assert.equal(typeof value.description, "string");
      for (const content of Object.values(value.content ?? {})) visit(content.schema);
    }
  }
}
const sdk = {
  "node_modules/data-kit/package.json": '{"name":"data-kit","type":"module","types":"index.d.ts"}',
  "node_modules/data-kit/index.js": 'throw new Error("Dependency must not execute");',
  "node_modules/data-kit/index.d.ts": `
    export interface User { id: string; nickname?: string; score: number | null; active: boolean }
    export interface Page<T> { entries: T[]; cursor?: string; metadata: Record<string, number> }
    export declare class Client<T> { constructor(seed: T); fetch(): Promise<Page<T>> }
    export declare function fetch(): Promise<Page<User>>;
    export declare function choose(input: "user"): User;
    export declare function choose(input: "count"): number;
    export declare function box<T>(value: T): { value: T };
  `,
};
const responseCodes = {
  "node_modules/response-codes/package.json": '{"name":"response-codes","types":"index.d.ts"}',
  "node_modules/response-codes/index.d.ts": `
    export enum Code { CONTINUE = 100, OK = 200, CREATED = 201, ACCEPTED = 202, NOT_FOUND = 404, INTERNAL_SERVER_ERROR = 500 }
  `,
};

test("keeps concrete service statuses instead of expanding a widened dependency enum", async (t) => {
  const { document, diagnostics } = await fixture(t, {
    ...responseCodes,
    "app.js": `
      import express from "express";
      import { get, create, accepted } from "./service.js";
      const app = express();
      app.get("/enum", async (req, res) => {
        const result = await get();
        res.status(result.status).json(result);
      });
      app.get("/destructured", async (req, res) => {
        const { status, ...body } = await create();
        res.status(status).json(body);
      });
      app.get("/helper", async (req, res) => {
        const result = await accepted();
        res.status(result.status).json(result);
      });
    `,
    "service.js": `
      import { Code } from "response-codes";
      export async function get() { return { status: Code.OK, message: "Loaded", data: ["item"] }; }
      export async function create() { return { status: Code.CREATED, message: "Created" }; }
      const envelope = (status, message) => ({ status, message });
      export async function accepted() { return envelope(Code.ACCEPTED, "Accepted"); }
    `,
  });
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(Object.keys(document.paths["/enum"].get.responses), ["200"]);
  assert.deepEqual(Object.keys(document.paths["/destructured"].get.responses), ["201"]);
  assert.deepEqual(Object.keys(document.paths["/helper"].get.responses), ["202"]);
  assert.equal(response(document, "/enum").properties.status.const, 200);
  assert.equal(response(document, "/enum").properties.status.anyOf, undefined);
  assert.equal(response(document, "/enum").properties.message.const, "Loaded");
});

test("shares legacy #/* package aliases between the compiler and the route/service flow", async (t) => {
  const { document, diagnostics, root } = await fixture(t, {
    ...sdk, ...responseCodes,
    "package.json": '{"type":"module","imports":{"#/*":"./source/*"}}',
    "app.js": `
      import express from "express";
      import router from "#/routes.js";
      const app = express();
      app.use("/api", router);
    `,
    "source/routes.js": `
      import { Router } from "express";
      import { handle } from "#/controllers.js";
      const router = Router();
      router.get("/items", handle);
      export default router;
    `,
    "source/controllers.js": `
      import { load } from "#/services.js";
      export async function handle(req, res) {
        const result = await load();
        return res.status(result.status).json(result);
      }
    `,
    "source/services.js": `
      import { Code } from "response-codes";
      import client from "#/config/client.js";
      export async function load() {
        return { status: Code.OK, message: "Loaded", data: await client.fetch() };
      }
    `,
    "source/config/client.js": `
      import { Client, choose } from "data-kit";
      export default new Client(choose("user"));
    `,
  });
  assert.deepEqual(diagnostics, []);
  assert.equal(document.paths["/api/items"].get.responses[201], undefined);
  const page = deref(document, response(document, "/api/items").properties.data);
  assert.equal(deref(document, page.properties.entries.items).properties.id.type, "string");
  const project = new Project(root, [], "app.js");
  const service = project.inference.source(path.join(root, "source/services.js"));
  assert.ok(!project.inference.program.getSemanticDiagnostics(service).some((issue) => issue.code === 2307));
});

test("retains typed cache-miss results alongside opaque JSON.parse cache hits across #/ services", async (t) => {
  const { document, diagnostics } = await fixture(t, {
    ...sdk, ...responseCodes,
    "package.json": '{"type":"module","imports":{"#/*":"./src/*"}}',
    "app.js": `
      import express from "express";
      import { handle } from "#/controller.js";
      const app = express();
      app.get("/cached", handle);
    `,
    "src/controller.js": `
      import { get } from "#/service.js";
      export async function handle(req, res) {
        const result = await get();
        return res.status(result.status).json(result);
      }
    `,
    "src/service.js": `
      import { Code } from "response-codes";
      import { load } from "#/cached-service.js";
      export async function get() {
        return { status: Code.OK, message: "Loaded", data: await load() };
      }
    `,
    "src/cached-service.js": `
      import { fetch } from "data-kit";
      import { cache } from "#/cache.js";
      export async function load() {
        const cached = await cache.read();
        if (cached !== null) return JSON.parse(cached);
        return fetch();
      }
    `,
    "src/cache.js": `
      import { create } from "cache-kit";
      export const cache = create({ enabled: "unrelated configuration type error" });
    `,
    "node_modules/cache-kit/package.json": '{"name":"cache-kit","types":"index.d.ts"}',
    "node_modules/cache-kit/index.d.ts": 'export declare function create(options: { enabled: boolean }): { read(): Promise<string | null> };',
  });
  assert.deepEqual(Object.keys(document.paths["/cached"].get.responses), ["200"]);
  const data = response(document, "/cached").properties.data;
  assert.ok(data.anyOf.some((schema) => Object.keys(schema).length === 0));
  const page = deref(document, data.anyOf.find((schema) => Object.keys(schema).length));
  assert.equal(deref(document, page.properties.entries.items).properties.id.type, "string");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, "UNRESOLVED_RESPONSE_SCHEMA");
  assert.ok(diagnostics[0].message.includes("$.data"));
  assert.ok(!/TS2307|TS2322/.test(diagnostics[0].message));
});

const storageKit = {
  "node_modules/storage-kit/package.json": '{"name":"storage-kit","types":"index.d.ts"}',
  "node_modules/storage-kit/index.d.ts": `
    export interface Storage {
      retrieve(key: string): Promise<string | null>;
      persist(key: string, text: string, options?: { ttl: number }): Promise<void>;
    }
    export declare function create(): Storage;
    export declare const store: Storage;
  `,
  "node_modules/storage-kit/index.js": 'throw new Error("Storage must never execute");',
};

test("infers generic JSON storage roundtrips through aliases and preserves producer provenance", async (t) => {
  const { document, diagnostics } = await fixture(t, {
    ...sdk, ...storageKit, ...responseCodes,
    "package.json": '{"type":"module","imports":{"#/*":"./src/*"}}',
    "app.js": `
      import express from "express";
      import { handle } from "#/controller.js";
      const app = express();
      app.get("/roundtrip", handle);
    `,
    "src/controller.js": `
      import { load } from "#/service.js";
      import { Code } from "response-codes";
      export async function handle(req, res) {
        res.status(Code.OK).json({ data: await load(req.params.id) });
      }
    `,
    "src/client.js": 'export { store as client } from "storage-kit";',
    "src/service.js": `
      import { fetch } from "data-kit";
      import { client } from "#/client.js";
      const storage = client;
      export async function load(id) {
        const key = \`records:\${id}\`;
        const cached = await storage.retrieve(key);
        if (cached !== null) return JSON.parse(cached);
        const value = await fetch();
        try { await storage.persist(key, JSON.stringify(value), { ttl: 60 }); } catch {}
        return value;
      }
    `,
  });
  assert.deepEqual(diagnostics, []);
  const data = response(document, "/roundtrip").properties.data;
  const page = deref(document, data);
  assert.equal(deref(document, page.properties.entries.items).properties.id.type, "string");
  assert.equal(data.anyOf, undefined);
  assert.equal(data["x-swaggerdoc-serialization"].kind, "storage-roundtrip");
  assert.equal(data["x-swaggerdoc-serialization"].runtimeValidated, false);
  assert.equal(data["x-swaggerdoc-serialization"].writes[0].file, "src/service.js");
});

test("follows direct JSON roundtrips, serializer helpers and parse/stringify aliases", async (t) => {
  const { document, diagnostics } = await fixture(t, {
    ...sdk, ...storageKit,
    "app.js": `
      import express from "express";
      import { choose } from "data-kit";
      import { store } from "storage-kit";
      import { encode } from "./encode.js";
      const app = express();
      const stringify = JSON.stringify;
      const parse = JSON.parse;
      app.get("/direct", (req, res) => res.json(parse(stringify(choose("user")))));
      app.get("/helper", (req, res) => res.json(JSON.parse(encode(choose("user")))));
      app.get("/storage-helper", async (req, res) => {
        const key = "serialized:helper";
        const cached = await store.retrieve(key);
        if (cached !== null) return res.json(parse(cached));
        const value = choose("user");
        await store.persist(key, encode(value));
        res.json(value);
      });
    `,
    "encode.js": "export const encode = value => JSON.stringify(value);",
  });
  assert.deepEqual(diagnostics, []);
  for (const route of ["/direct", "/helper", "/storage-helper"]) {
    const schema = response(document, route);
    const alternatives = schema.anyOf ?? [schema];
    assert.ok(alternatives.every((part) => deref(document, part).properties.id.type === "string"));
  }
});

test("combines all known writers and separates non-overlapping keys and different client instances", async (t) => {
  const { document, diagnostics } = await fixture(t, {
    ...sdk, ...storageKit,
    "app.js": `
      import express from "express";
      import { choose } from "data-kit";
      import { create } from "storage-kit";
      const app = express();
      const shared = create(), other = create();
      async function saveUser() { await shared.persist("same", JSON.stringify(choose("user"))); }
      async function saveCount() { await shared.persist("same", JSON.stringify(choose("count"))); }
      async function unrelated() {
        await shared.persist("other", untypedText());
        await other.persist("same", untypedText());
      }
      app.get("/writers", async (req, res) => res.json(JSON.parse(await shared.retrieve("same"))));
    `,
  });
  assert.deepEqual(diagnostics, []);
  const schema = response(document, "/writers");
  assert.equal(schema.anyOf.length, 2);
  assert.ok(schema.anyOf.some((part) => part.type === "number"));
  assert.ok(schema.anyOf.some((part) => deref(document, part).properties?.id.type === "string"));
  assert.equal(schema["x-swaggerdoc-serialization"].writes.length, 2);
});

test("matches writers across files with stable imported clients and keys", async (t) => {
  const { document, diagnostics } = await fixture(t, {
    ...sdk, ...storageKit,
    "app.js": `
      import express from "express";
      import * as connection from "./connection.js";
      import "./producer.js";
      const app = express();
      app.get("/files", async (req, res) => res.json(JSON.parse(await connection.store.retrieve(connection.key))));
    `,
    "connection.js": 'export { store } from "storage-kit"; export const key = "shared:items";',
    "producer.js": `
      import { store, key } from "./connection.js";
      import { fetch } from "data-kit";
      export async function save() {
        const value = await fetch();
        const serialized = JSON.stringify(value);
        await store.persist(key, serialized);
      }
    `,
  });
  assert.deepEqual(diagnostics, []);
  const schema = response(document, "/files");
  assert.ok(deref(document, schema).properties.entries);
  assert.equal(schema["x-swaggerdoc-serialization"].writes[0].file, "producer.js");
});

test("does not infer JSON contracts from unmatched, conflicting, mutable or transformed values", async (t) => {
  const { document, diagnostics } = await fixture(t, {
    ...sdk, ...storageKit,
    "app.js": `
      import express from "express";
      import { choose } from "data-kit";
      import { create } from "storage-kit";
      const app = express();
      const wrongKey = create(), wrongClient = create(), opaque = create(), mutable = create();
      const replacer = create(), reviver = create(), cycle = create(), dynamic = create();
      const unknownPayload = create(), overlap = create(), shadowStore = create(), destructured = create();
      app.get("/key", async (req, res) => {
        await wrongKey.persist("b", JSON.stringify(choose("user")));
        res.json(JSON.parse(await wrongKey.retrieve("a")));
      });
      app.get("/client", async (req, res) => {
        await wrongClient.persist("a", JSON.stringify(choose("user")));
        res.json(JSON.parse(await create().retrieve("a")));
      });
      app.get("/opaque", async (req, res) => {
        await opaque.persist("a", JSON.stringify(choose("user")));
        await opaque.persist("a", untypedText());
        res.json(JSON.parse(await opaque.retrieve("a")));
      });
      app.get("/mutable", async (req, res) => {
        let key = "a";
        const text = await mutable.retrieve(key);
        key = "b";
        await mutable.persist(key, JSON.stringify(choose("user")));
        res.json(JSON.parse(text));
      });
      app.get("/replacer", async (req, res) => {
        await replacer.persist("a", JSON.stringify(choose("user"), ["id"]));
        res.json(JSON.parse(await replacer.retrieve("a")));
      });
      app.get("/reviver", async (req, res) => {
        await reviver.persist("a", JSON.stringify(choose("user")));
        res.json(JSON.parse(await reviver.retrieve("a"), (key, value) => transform(value)));
      });
      app.get("/cycle", async (req, res) => {
        const text = await cycle.retrieve("a");
        await cycle.persist("a", JSON.stringify(JSON.parse(text)));
        res.json(JSON.parse(text));
      });
      app.get("/dynamic", async (req, res) => {
        const key = computeKey();
        await dynamic.persist(computeKey(), JSON.stringify(choose("user")));
        res.json(JSON.parse(await dynamic.retrieve(key)));
      });
      app.get("/unknown-payload", async (req, res) => {
        await unknownPayload.persist("a", JSON.stringify(untypedValue()));
        res.json(JSON.parse(await unknownPayload.retrieve("a")));
      });
      async function unknownWriter(key) { await overlap.persist(key, untypedText()); }
      app.get("/overlap", async (req, res) => {
        await overlap.persist("a", JSON.stringify(choose("user")));
        res.json(JSON.parse(await overlap.retrieve("a")));
      });
      app.get("/shadow", async (req, res) => {
        const JSON = { parse: text => untypedValue(), stringify: value => "not-json" };
        await shadowStore.persist("a", JSON.stringify(choose("user")));
        res.json(JSON.parse(await shadowStore.retrieve("a")));
      });
      app.get("/destructured-mutation", async (req, res) => {
        let text = await destructured.retrieve("a");
        ({ text } = untypedValue());
        await destructured.persist("a", JSON.stringify(choose("user")));
        res.json(JSON.parse(text));
      });
    `,
  });
  for (const route of ["/key", "/client", "/opaque", "/mutable", "/replacer", "/reviver",
    "/cycle", "/dynamic", "/unknown-payload", "/overlap", "/shadow", "/destructured-mutation"]) {
    const schema = response(document, route);
    assert.ok(!schema["x-swaggerdoc-serialization"], route);
    assert.ok(diagnostics.some((issue) => issue.code === "UNRESOLVED_RESPONSE_SCHEMA" &&
      issue.message.includes(`GET ${route} `)), route);
  }
});

test("retains JSON serialization semantics and unknown fields inside recovered producer types", async (t) => {
  const { document, diagnostics } = await fixture(t, {
    ...sdk, ...storageKit,
    "app.js": `
      import express from "express";
      import { fetch } from "data-kit";
      import { store } from "storage-kit";
      import { partial } from "partial-kit";
      const app = express();
      app.get("/wire", async (req, res) => res.json(JSON.parse(JSON.stringify({
        when: new Date(), absent: undefined, method: () => "not serialized", page: await fetch()
      }))));
      app.get("/partial-roundtrip", async (req, res) => {
        await store.persist("partial", JSON.stringify(partial()));
        res.json(JSON.parse(await store.retrieve("partial")));
      });
    `,
    "node_modules/partial-kit/package.json": '{"name":"partial-kit","types":"index.d.ts"}',
    "node_modules/partial-kit/index.d.ts": 'export declare function partial(): { known: string; dynamic: any };',
  });
  const wire = response(document, "/wire");
  assert.deepEqual(wire.properties.when, { type: "string", format: "date-time" });
  assert.equal(wire.properties.absent, undefined);
  assert.equal(wire.properties.method, undefined);
  assert.ok(deref(document, wire.properties.page).properties.entries);
  const partial = response(document, "/partial-roundtrip");
  assert.equal(partial.properties.known.type, "string");
  assert.deepEqual(partial.properties.dynamic, {});
  assert.equal(diagnostics.length, 1);
  assert.ok(diagnostics[0].message.includes("$.dynamic"));
});

test("recovers CommonJS JSON storage with .d.cts types without running the package", async (t) => {
  const { document, diagnostics } = await fixture(t, {
    "package.json": '{"type":"commonjs"}',
    "app.cjs": `
      const sdk = require("native-kit");
      const app = framework();
      const store = sdk.state;
      app.get("/commonjs-roundtrip", async (req, res) => {
        const key = "typed:cjs";
        const cached = await store.load(key);
        if (cached !== null) return res.json(JSON.parse(cached));
        const value = await sdk.records();
        await store.save(key, JSON.stringify(value));
        res.json(value);
      });
    `,
    "node_modules/native-kit/package.json": '{"name":"native-kit","types":"index.d.cts","main":"index.cjs"}',
    "node_modules/native-kit/index.d.cts": `
      export declare function records(): Promise<ReadonlyArray<{ id: string; nested: { active: boolean } }>>;
      export declare const state: {
        load(key: string): Promise<string | null>;
        save(key: string, text: string): Promise<void>;
      };
    `,
    "node_modules/native-kit/index.cjs": 'throw new Error("Never execute CJS storage or SDK");',
  }, "app.cjs");
  assert.deepEqual(diagnostics, []);
  const schema = response(document, "/commonjs-roundtrip");
  assert.equal(schema.anyOf, undefined);
  assert.equal(schema.type, "array");
  assert.equal(schema.items.properties.id.type, "string");
  assert.equal(schema.items.properties.nested.properties.active.type, "boolean");
  assert.equal(schema["x-swaggerdoc-serialization"].runtimeValidated, false);
});

test("matches template/concatenated keys and excludes unrelated dynamic namespaces", async (t) => {
  const { document, diagnostics } = await fixture(t, {
    ...sdk, ...storageKit,
    "app.js": `
      import express from "express";
      import { fetch } from "data-kit";
      import { store } from "storage-kit";
      const app = express();
      async function other(id) { await store.persist(\`unrelated:\${id}\`, opaqueText()); }
      app.get("/keys", async (req, res) => {
        const id = req.params.id;
        const key = \`items:\${id}\`;
        const text = await store.retrieve(key);
        await store.persist("items:" + id, JSON.stringify(await fetch()));
        res.json(JSON.parse(text));
      });
    `,
  });
  assert.deepEqual(diagnostics, []);
  assert.ok(deref(document, response(document, "/keys")).properties.entries);
});

test("does not treat a reassigned global JSON object as the standard serializer", async (t) => {
  const { document, diagnostics } = await fixture(t, {
    ...sdk, ...storageKit,
    "app.js": `
      import { store } from "storage-kit";
      import { fetch } from "data-kit";
      const app = framework();
      app.get("/reassigned-json", async (req, res) => {
        JSON = unknownJSON;
        await store.persist("a", JSON.stringify(await fetch()));
        res.json(JSON.parse(await store.retrieve("a")));
      });
    `,
  });
  assert.ok(!response(document, "/reassigned-json")["x-swaggerdoc-serialization"]);
  assert.ok(diagnostics.some((issue) => issue.code === "UNRESOLVED_RESPONSE_SCHEMA"));
});

test("compiler propagates generic SDK classes, overloads and promises across TS/JS barrels and controllers", async (t) => {
  const { document, diagnostics, root } = await fixture(t, {
    ...sdk,
    "tsconfig.json": '{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext","strict":true,"baseUrl":".","paths":{"@services/*":["services/*.ts"]}}}',
    "app.ts": `
      import express from "express";
      import { handler } from "./controller.js";
      const app = express();
      app.get("/users", handler);
    `,
    "controller.ts": `
      import { load } from "@services/index";
      export async function handler(req: any, res: any) {
        const result = await load();
        return res.status(201).json(result);
      }
    `,
    "services/index.ts": 'export { load } from "./users.js";',
    "services/users.js": `
      import { fetch, Client, choose, box } from "data-kit";
      export async function load() {
        const client = new Client(choose("user"));
        return { page: await fetch(), constructed: await client.fetch(),
          boxed: box(choose("user")), count: choose("count") };
      }
    `,
  }, "app.ts");
  assert.deepEqual(diagnostics, []);
  const schema = response(document, "/users", 201);
  const page = deref(document, schema.properties.page);
  const user = deref(document, page.properties.entries.items);
  assert.deepEqual(user.properties.id, { type: "string" });
  assert.deepEqual(user.properties.active, { type: "boolean" });
  assert.ok(!user.required.includes("nickname"));
  assert.ok(user.properties.score.anyOf.some((part) => part.type === "null"));
  assert.deepEqual(deref(document, page.properties.metadata).additionalProperties, { type: "number" });
  assert.equal(schema.properties.count.type, "number");
  assert.deepEqual(deref(document, schema.properties.constructed), page);
  assert.deepEqual(deref(document, schema.properties.boxed).properties.value, page.properties.entries.items);
  const project = new Project(root);
  const first = project.inference.program;
  const source = project.file(path.join(root, "services/users.js"));
  const declaration = source.ast.statements.find((node) => node.name?.text === "load");
  project.inference.infer(source.file, declaration);
  assert.equal(project.inference.program, first);
  assert.equal(project.inference.checker, first.getTypeChecker());
});

test("resolves conditional ESM .d.mts and CommonJS .d.cts exports with the compiler", async (t) => {
  const { document, diagnostics } = await fixture(t, {
    "app.mts": `
      import express from "express";
      import { read } from "dual-kit";
      import { legacy } from "./legacy.cjs";
      const app = express();
      app.get("/esm", async (req, res) => res.json(await read()));
      app.get("/cjs", legacy);
    `,
    "legacy.cts": `
      import kit = require("dual-kit");
      export async function legacy(req: any, res: any) { res.json(await kit.read()); }
    `,
    "node_modules/dual-kit/package.json": JSON.stringify({
      name: "dual-kit", type: "module",
      exports: { ".": {
        import: { types: "./index.d.mts", default: "./index.mjs" },
        require: { types: "./index.d.cts", default: "./index.cjs" },
      } },
    }),
    "node_modules/dual-kit/index.d.mts": 'export declare function read(): Promise<{ mode: "esm"; names: readonly string[] }>;',
    "node_modules/dual-kit/index.d.cts": 'export declare function read(): Promise<{ mode: "cjs"; count: number }>;',
    "node_modules/dual-kit/index.mjs": 'throw new Error("Never run ESM");',
    "node_modules/dual-kit/index.cjs": 'throw new Error("Never run CJS");',
  }, "app.mts");
  assert.deepEqual(diagnostics, []);
  assert.equal(response(document, "/esm").properties.mode.const, "esm");
  assert.deepEqual(response(document, "/esm").properties.names, { type: "array", items: { type: "string" } });
  assert.equal(response(document, "/cjs").properties.mode.const, "cjs");
  assert.equal(response(document, "/cjs").properties.count.type, "number");
});

test("reads dependency JSDoc and CommonJS exports in JavaScript projects without tsconfig", async (t) => {
  const { document, diagnostics } = await fixture(t, {
    "package.json": '{"type":"commonjs"}',
    "app.cjs": `
      const express = require("express");
      const { load } = require("js-kit");
      const app = express();
      app.get("/js", async (req, res) => res.json(await load()));
    `,
    "node_modules/js-kit/package.json": '{"name":"js-kit","main":"index.cjs"}',
    "node_modules/js-kit/index.cjs": `
      throw new Error("Never execute JSDoc dependency");
      /**
       * @typedef {Object} Item
       * @property {string} key Stable key.
       * @property {number} [size] Optional size.
       */
      /** @returns {Promise<{ items: Item[], ready: boolean }>} Loaded items. */
      exports.load = async function () { return runtimeData; };
    `,
  }, "app.cjs");
  assert.deepEqual(diagnostics, []);
  const schema = response(document, "/js");
  const item = deref(document, schema.properties.items.items);
  assert.equal(item.properties.key.type, "string");
  assert.equal(item.properties.key.description, "Stable key.");
  assert.ok(!item.required.includes("size"));
  assert.equal(schema.properties.ready.type, "boolean");
});

test("follows namespace CommonJS controllers and declared .d.cts dependency methods", async (t) => {
  const { document, diagnostics } = await fixture(t, {
    "package.json": '{"type":"commonjs"}',
    "app.cjs": `
      const express = require("express");
      const controller = require("./controller.cjs");
      const app = express();
      app.get("/commonjs", controller.handle);
    `,
    "controller.cjs": `
      const kit = require("cjs-kit");
      exports.handle = async function (req, res) { return res.json(await kit.read()); };
    `,
    "node_modules/cjs-kit/package.json": '{"name":"cjs-kit","main":"index.cjs","types":"index.d.cts"}',
    "node_modules/cjs-kit/index.d.cts": 'export declare function read(): Promise<{ key: string; values: number[] }>;',
    "node_modules/cjs-kit/index.cjs": 'throw new Error("Never run CommonJS dependency");',
  }, "app.cjs");
  assert.deepEqual(diagnostics, []);
  const schema = response(document, "/commonjs");
  assert.equal(schema.properties.key.type, "string");
  assert.equal(schema.properties.values.items.type, "number");
});

test("honors jsconfig inheritance, paths and package imports without modifying sources", async (t) => {
  const { document, diagnostics } = await fixture(t, {
    ...sdk,
    "package.json": '{"type":"module","imports":{"#service":"./service.js"}}',
    "base.json": '{"compilerOptions":{"module":"ESNext","moduleResolution":"Bundler","baseUrl":".","paths":{"@kit":["node_modules/data-kit/index.d.ts"]},"checkJs":true}}',
    "jsconfig.json": '{"extends":"./base.json","include":["*.js"]}',
    "app.js": `
      import express from "express";
      import { data } from "#service";
      const app = express();
      app.get("/alias", async (req, res) => res.json(await data()));
    `,
    "service.js": 'import { choose } from "@kit"; export const data = async () => choose("user");',
  });
  assert.deepEqual(diagnostics, []);
  assert.equal(deref(document, response(document, "/alias")).properties.id.type, "string");
});

test("recursive, mutually recursive and equivalent schemas reuse valid components", async (t) => {
  const { document, diagnostics } = await fixture(t, {
    "app.ts": `
      import express from "express";
      import { tree, same, pair } from "tree-kit";
      const app = express();
      app.get("/tree", (req, res) => res.json(tree()));
      app.get("/same", (req, res) => res.json(same()));
      app.get("/pair", (req, res) => res.json(pair()));
    `,
    "node_modules/tree-kit/package.json": '{"name":"tree-kit","types":"index.d.ts"}',
    "node_modules/tree-kit/index.d.ts": `
      export interface Tree { name: string; children: Tree[]; parent?: Tree | null }
      export interface A { b?: B; id: number }
      export interface B { a?: A; label: string }
      export interface First { id: number; label: string }
      export interface Second { label: string; id: number }
      export declare function tree(): Tree;
      export declare function same(): { first: First; second: Second };
      export declare function pair(): A;
    `,
  }, "app.ts");
  assert.deepEqual(diagnostics, []);
  const tree = response(document, "/tree");
  assert.ok(tree.$ref);
  assert.equal(deref(document, tree).properties.children.items.$ref, tree.$ref);
  const same = response(document, "/same");
  assert.deepEqual(same.properties.first, same.properties.second);
  const a = response(document, "/pair");
  const b = deref(document, deref(document, a).properties.b);
  assert.equal(b.properties.a.$ref, a.$ref);
});

test("represents enums, discriminated unions, intersections, records, tuples and serialization", async (t) => {
  const { document, diagnostics } = await fixture(t, {
    "app.ts": `
      import express from "express";
      import { value } from "shapes-kit";
      const app = express();
      app.get("/shapes", (req, res) => res.json(value()));
    `,
    "node_modules/shapes-kit/package.json": '{"name":"shapes-kit","types":"index.d.ts"}',
    "node_modules/shapes-kit/index.d.ts": `
      export enum Mode { Off = "off", On = "on" }
      export interface Public { visible: string; hidden(): void; absent: undefined }
      export declare class Serialized { private secret; toJSON(): { wire: string } }
      export declare function value(): {
        mode: Mode;
        result: { kind: "ok"; data: string } | { kind: "error"; error: number };
        merged: { id: string } & { count: number };
        record: Record<"left" | "right", boolean>;
        dictionary: Record<string, number>;
        tuple: readonly [string, number?, ...boolean[]];
        fixed: [string, number];
        nullable: string | null;
        when: Date;
        public: Public;
        serialized: Serialized;
        list: (string | undefined)[];
        optionalFunction: string | (() => void);
        optionalSymbol: string | symbol;
      };
    `,
  }, "app.ts");
  assert.deepEqual(diagnostics, []);
  const fields = response(document, "/shapes").properties;
  assert.ok(fields.mode.anyOf.every((part) => ["off", "on"].includes(part.const)));
  assert.equal(fields.result.anyOf.length, 2);
  assert.equal(fields.merged.allOf.length, 2);
  assert.deepEqual(Object.keys(deref(document, fields.record).properties).sort(), ["left", "right"]);
  assert.deepEqual(deref(document, fields.dictionary).additionalProperties, { type: "number" });
  assert.deepEqual(fields.tuple.prefixItems[0], { type: "string" });
  assert.equal(fields.tuple.minItems, 1);
  assert.equal(fields.tuple.items.type, "boolean");
  assert.equal(fields.fixed.maxItems, 2);
  assert.equal(fields.fixed.items, false);
  assert.deepEqual(fields.when, { type: "string", format: "date-time" });
  assert.deepEqual(Object.keys(deref(document, fields.public).properties), ["visible"]);
  assert.deepEqual(deref(document, fields.serialized).properties.wire, { type: "string" });
  assert.ok(fields.list.items.anyOf.some((part) => part.type === "null"));
  assert.equal(fields.optionalFunction.type, "string");
  assert.equal(fields.optionalSymbol.type, "string");
  assert.ok(!response(document, "/shapes").required.includes("optionalFunction"));
  assert.ok(!response(document, "/shapes").required.includes("optionalSymbol"));
});

test("keeps unknown fields generic with specific diagnostics and preserves control-flow narrowing", async (t) => {
  const { document, diagnostics } = await fixture(t, {
    "app.ts": `
      import express from "express";
      import { partial, lookup } from "partial-kit";
      const app = express();
      app.get("/partial", (req, res) => res.status(202).json(partial()));
      app.get("/narrow", (req, res) => {
        const result = lookup();
        if (result.kind === "ok") return res.status(201).json(result);
        return res.status(404).json(result);
      });
      app.get("/missing", (req, res) => res.json({ known: 1, value: missingFunction() }));
    `,
    "node_modules/partial-kit/package.json": '{"name":"partial-kit","types":"index.d.ts"}',
    "node_modules/partial-kit/index.d.ts": `
      export declare function partial(): { id: string; dynamic: any; opaque: unknown; nested: { value: any } };
      export declare function lookup(): { kind: "ok"; user: { id: string } } | { kind: "missing"; reason: string };
    `,
  }, "app.ts");
  const schema = response(document, "/partial", 202);
  assert.equal(schema.properties.id.type, "string");
  assert.deepEqual(schema.properties.dynamic, {});
  assert.deepEqual(schema.properties.opaque, {});
  const unresolved = diagnostics.filter((issue) => issue.code === "UNRESOLVED_RESPONSE_SCHEMA");
  assert.ok(unresolved.some((issue) => issue.message.includes("$.opaque") && issue.message.includes("'unknown'")));
  assert.ok(unresolved.some((issue) => issue.message.includes("$.nested.value") && issue.message.includes("'any'")));
  assert.ok(unresolved.some((issue) => issue.message.includes("TS2304") && issue.message.includes("missingFunction")));
  assert.equal(response(document, "/narrow", 201).properties.kind.const, "ok");
  assert.equal(response(document, "/narrow", 404).properties.kind.const, "missing");
  assert.equal(response(document, "/narrow", 201).properties.reason, undefined);
});

test("does not await Promise-valued properties or infer SDK shapes from method names", async (t) => {
  const { document } = await fixture(t, {
    ...sdk,
    "app.js": `
      import express from "express";
      import { fetch } from "data-kit";
      import { dynamic } from "dynamic-kit";
      const app = express();
      app.get("/promise", (req, res) => res.json({ pending: fetch() }));
      app.get("/await", async (req, res) => res.json({ result: await fetch() }));
      app.get("/dynamic", (req, res) => res.json({ items: dynamic.map(), length: dynamic.length, status: dynamic.status }));
    `,
    "node_modules/dynamic-kit/package.json": '{"name":"dynamic-kit","types":"index.d.ts"}',
    "node_modules/dynamic-kit/index.d.ts": 'export declare const dynamic: any;',
  });
  const pending = deref(document, response(document, "/promise").properties.pending);
  assert.equal(pending.properties.entries, undefined);
  assert.ok(deref(document, response(document, "/await").properties.result).properties.entries);
  assert.deepEqual(response(document, "/dynamic").properties.items, {});
  assert.deepEqual(response(document, "/dynamic").properties.length, {});
  assert.deepEqual(response(document, "/dynamic").properties.status, {});
});

test("supports mapped/conditional generic returns, inherited methods and implicit async promise adoption", async (t) => {
  const { document, diagnostics } = await fixture(t, {
    "app.ts": `
      import express from "express";
      import { Client, select, identity, envelope } from "generic-kit";
      const app = express();
      async function service() { return identity(Promise.resolve(select(["id"] as const))); }
      app.get("/generic", async (req, res) => res.json({
        selected: await service(), inherited: await new Client().inherited(),
        conditional: envelope("test"), mapped: envelope(123)
      }));
    `,
    "node_modules/generic-kit/package.json": '{"name":"generic-kit","types":"index.d.ts"}',
    "node_modules/generic-kit/index.d.ts": `
      export interface Entity { id: string; label: string; enabled: boolean }
      export declare function select<K extends keyof Entity>(keys: readonly K[]): Promise<Pick<Entity, K>>;
      export declare function identity<T>(value: T): Promise<Awaited<T>>;
      export declare class Base<T> { inherited(): Promise<T> }
      export declare class Client extends Base<Entity> {}
      export declare function envelope<T>(input: T): T extends string ? { text: string } : { value: T };
    `,
  }, "app.ts");
  assert.deepEqual(diagnostics, []);
  const fields = response(document, "/generic").properties;
  assert.deepEqual(Object.keys(deref(document, fields.selected).properties), ["id"]);
  assert.equal(deref(document, fields.inherited).properties.enabled.type, "boolean");
  assert.equal(fields.conditional.properties.text.type, "string");
  assert.equal(fields.mapped.properties.value.type, "number");
});

test("respects CommonJS compiler options, typeRoots, checkJs=false and configured excludes", async (t) => {
  const { document, diagnostics, root } = await fixture(t, {
    "package.json": '{"type":"commonjs"}',
    "tsconfig.json": '{"compilerOptions":{"module":"CommonJS","moduleResolution":"Node10","checkJs":false,"typeRoots":["./custom-types"],"types":["env"]},"include":["app.js"],"exclude":["excluded.js"]}',
    "custom-types/env/index.d.ts": 'declare const environment: { name: string; port: number };',
    "excluded.js": 'const environment = { wrong: true };',
    "app.js": `
      const express = require("express");
      const app = express();
      app.get("/config", (req, res) => res.json(environment));
    `,
  });
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(Object.keys(response(document, "/config").properties).sort(), ["name", "port"]);
  const project = new Project(root, [], "app.js");
  assert.equal(project.inference.options.module, 1);
  assert.equal(project.inference.options.checkJs, false);
  assert.equal(project.inference.program.getSourceFile(path.join(root, "excluded.js")), undefined);
});

test("reports invalid compiler configurations while continuing conservative inference", async (t) => {
  const { document, diagnostics } = await fixture(t, {
    "tsconfig.json": '{"extends":"./does-not-exist.json","compilerOptions":{"module":"not-a-module"}}',
    "app.js": 'const app = framework(); app.get("/config-error", (req, res) => res.json({ known: "value" }));',
  });
  assert.equal(response(document, "/config-error").properties.known.type, "string");
  assert.ok(diagnostics.some((issue) => issue.code === "TYPESCRIPT_CONFIG" && issue.message.includes("does-not-exist")));
});

test("explains missing dependency declarations and unknown index signatures without inventing fields", async (t) => {
  const { document, diagnostics } = await fixture(t, {
    "app.js": `
      import express from "express";
      import { read } from "missing-kit";
      import { opaque } from "opaque-kit";
      const app = express();
      app.get("/missing-types", (req, res) => res.json({ data: read() }));
      app.get("/opaque", (req, res) => res.json(opaque()));
    `,
    "node_modules/opaque-kit/package.json": '{"name":"opaque-kit","types":"index.d.ts"}',
    "node_modules/opaque-kit/index.d.ts": 'export declare function opaque(): { known: string; values: Record<string, unknown> };',
  });
  assert.deepEqual(response(document, "/missing-types").properties.data, {});
  assert.ok(diagnostics.some((issue) => issue.message.includes("missing-kit") && issue.message.includes("TS2307")));
  assert.ok(diagnostics.some((issue) => issue.message.includes("$.values.*") && issue.message.includes("'unknown'")));
  assert.equal(response(document, "/opaque").properties.known.type, "string");
});

test("uses declared literal HTTP statuses only where the application actually sends them", async (t) => {
  const { document, diagnostics } = await fixture(t, {
    "app.js": `
      import express from "express";
      import { result } from "status-kit";
      const app = express();
      app.get("/declared-status", (req, res) => { const value = result(); res.status(value.statusCode).json(value); });
      app.get("/default-status", (req, res) => res.json(result()));
    `,
    "node_modules/status-kit/package.json": '{"name":"status-kit","types":"index.d.ts"}',
    "node_modules/status-kit/index.d.ts": 'export declare function result(): { statusCode: 201 | 202; message: "ready"; data: string };',
  });
  assert.deepEqual(diagnostics, []);
  assert.ok(document.paths["/declared-status"].get.responses[201]);
  assert.ok(document.paths["/declared-status"].get.responses[202]);
  assert.deepEqual(Object.keys(document.paths["/default-status"].get.responses), ["200"]);
});

test("propagates SDK values through generic response helpers, aliases and class controllers", async (t) => {
  const { document, diagnostics } = await fixture(t, {
    ...sdk,
    "app.js": `
      import express from "express";
      import { Controller } from "./controller.js";
      const app = express();
      const controller = new Controller();
      app.get("/forward", controller.handle);
    `,
    "controller.js": `
      import { fetch } from "data-kit";
      import { forward } from "./reply.js";
      export class Controller {
        async handle(req, res) {
          const reply = res;
          forward(reply, await fetch());
        }
      }
    `,
    "reply.js": 'export function forward(response, value) { return response.status(201).json(value); }',
  });
  assert.deepEqual(diagnostics, []);
  const page = deref(document, response(document, "/forward", 201));
  assert.equal(deref(document, page.properties.entries.items).properties.id.type, "string");
});

test("uses compiler symbols for multi-star reexports and class field handlers", async (t) => {
  const { document, diagnostics } = await fixture(t, {
    ...sdk,
    "app.ts": `
      import express from "express";
      import { handle, controller } from "./barrel.js";
      const app = express();
      app.get("/stars", handle);
      app.get("/field", controller.handle);
    `,
    "barrel.ts": 'export * from "./controller.js"; export * from "./other.js";',
    "other.ts": "export const unrelated = 1;",
    "controller.ts": `
      import { choose } from "data-kit";
      export const handle = (req: any, res: any) => res.json(choose("user"));
      class Controller { handle = (req: any, res: any) => res.json(choose("count")); }
      export const controller = new Controller();
    `,
  }, "app.ts");
  assert.deepEqual(diagnostics, []);
  assert.equal(deref(document, response(document, "/stars")).properties.id.type, "string");
  assert.equal(response(document, "/field").type, "number");
});

test("retains send, content types, bodyless codes and sendStatus while inferring SDK types", async (t) => {
  const { document, diagnostics } = await fixture(t, {
    ...sdk,
    "app.js": `
      import express from "express";
      import { choose } from "data-kit";
      const app = express();
      app.get("/send", (req, res) => res.status(201).send(choose("user")));
      app.get("/text", (req, res) => res.type("text").send(choose("user").id));
      app.get("/empty", (req, res) => res.status(204).json(choose("user")));
      app.get("/status", (req, res) => res.sendStatus(202));
    `,
  });
  assert.deepEqual(diagnostics, []);
  assert.equal(deref(document, response(document, "/send", 201)).properties.id.type, "string");
  assert.equal(response(document, "/text", 200, "text/plain").type, "string");
  assert.equal(document.paths["/empty"].get.responses[204].content, undefined);
  assert.equal(response(document, "/status", 202, "text/plain").const, "Accepted");
});
