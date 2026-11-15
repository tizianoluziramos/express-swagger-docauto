import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { generateOpenApi } from "../src/generator.js";

async function generate(t, files, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "swaggerdoc-inference-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries({ "package.json": '{"type":"module"}', ...files })) {
    const target = path.join(root, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return generateOpenApi({ root, entry: "app.js", ...options });
}
const body = (operation, status = 200) => operation.responses[status].content["application/json"].schema;
const messages = (operation, status) => {
  const field = body(operation, status).properties.message;
  return field.examples ?? [field.example];
};
const errorHandler = `
function errors(err, req, res, next) {
  // ZodError BAD_REQUEST
  const message = "Validation failed";
  res.status(err.status).json({ status: err.status, message });
}
app.use(errors);
`;

test("propagates service options, defaults and invocation-specific error messages", async (t) => {
  const { document } = await generate(t, {
    "app.js": `
      import express from "express";
      import * as service from "./service.js";
      const app = express();
      app.get("/contact", async (req, res) => {
        await service.contact();
        res.json({ ok: true });
      });
      app.get("/default", async (req, res) => {
        await service.send();
        res.json({ ok: true });
      });
      app.get("/both", async (req, res) => {
        await service.send({}, { errorMessage: "First failure" });
        await service.send({}, { errorMessage: "Second failure" });
        res.json({ ok: true });
      });
      ${errorHandler}
    `,
    "service.js": `
      import { StatusCodes } from "http-status-codes";
      export async function contact() {
        await send({}, { key: unknownRuntimeValue(), errorMessage: "Contact failed" });
      }
      export async function send(message, { errorMessage = "Default failure" } = {}) {
        if (externalFailure) throw new HttpError(StatusCodes.BAD_REQUEST, errorMessage);
      }
    `,
  });
  assert.deepEqual(messages(document.paths["/contact"].get, 400), ["Contact failed"]);
  assert.deepEqual(messages(document.paths["/default"].get, 400), ["Default failure"]);
  assert.deepEqual(messages(document.paths["/both"].get, 400), ["First failure", "Second failure"]);
});

test("honors middleware factory options without dropping unknown runtime branches", async (t) => {
  const { document } = await generate(t, {
    "app.js": `
      import express from "express";
      import { authorize } from "./authorize.js";
      const app = express();
      app.get("/public-email", authorize({ emailVerified: false }), (req, res) => res.json({ ok: true }));
      app.get("/verified", authorize(), (req, res) => res.json({ ok: true }));
      app.get("/admin", authorize({ roles: ["admin"] }), (req, res) => res.json({ ok: true }));
      app.get("/dynamic", authorize(runtimeOptions), (req, res) => res.json({ ok: true }));
      ${errorHandler}
    `,
    "authorize.js": `
      import { StatusCodes } from "http-status-codes";
      export function authorize({ roles = [], emailVerified = true } = {}) {
        async function middleware(req, res, next) {
          if (!req.cookies.token) throw new HttpError(StatusCodes.UNAUTHORIZED, "Login required");
          if (emailVerified && !req.user.verified) throw new HttpError(StatusCodes.FORBIDDEN, "Verify email");
          if (roles.length > 0 && !roles.includes(req.user.role)) throw new HttpError(StatusCodes.FORBIDDEN, "Permissions");
          next();
        }
        return middleware;
      }
    `,
  });
  assert.ok(document.paths["/public-email"].get.responses[401]);
  assert.equal(document.paths["/public-email"].get.responses[403], undefined);
  assert.deepEqual(messages(document.paths["/verified"].get, 403), ["Verify email"]);
  assert.deepEqual(messages(document.paths["/admin"].get, 403), ["Verify email", "Permissions"]);
  assert.deepEqual(messages(document.paths["/dynamic"].get, 403), ["Verify email", "Permissions"]);
});

test("infers flattened Sequelize columns and omits JOIN-only includes", async (t) => {
  const { document } = await generate(t, {
    "app.js": `
      import express from "express";
      import { User, Role } from "./models.js";
      import { col } from "sequelize";
      const app = express();
      app.get("/users", async (req, res) => {
        const users = await User.findAll({
          attributes: { exclude: ["password"], include: [[col("role.name"), "roleName"]] },
          include: [{ model: Role, as: "role", attributes: [] }]
        });
        res.json({ statusCode: 200, data: users });
      });
      app.get("/names", async (req, res) => res.json(await User.findAll({
        attributes: ["userId", [col("role.name"), "roleName"]],
        include: [{ model: Role, as: "role", attributes: [] }]
      })));
    `,
    "models.js": `
      import { DataTypes } from "sequelize";
      const sequelize = unknownDatabase;
      export const User = sequelize.define("user", {
        userId: { type: DataTypes.UUID, primaryKey: true },
        password: { type: DataTypes.STRING, allowNull: false }
      }, { timestamps: false });
      export const Role = sequelize.define("role", {
        roleId: { type: DataTypes.UUID, primaryKey: true },
        name: { type: DataTypes.STRING(20), allowNull: false }
      }, { timestamps: false });
      User.belongsTo(Role, { as: "role", foreignKey: "roleId" });
    `,
  });
  const response = body(document.paths["/users"].get);
  assert.equal(response.properties.statusCode.const, 200);
  const item = response.properties.data.items;
  assert.deepEqual(item.properties.roleName, { anyOf: [{ type: "string", maxLength: 20 }, { type: "null" }] });
  assert.equal(item.properties.role, undefined);
  assert.equal(item.properties.password, undefined);
  assert.ok(item.required.includes("userId"));
  assert.deepEqual(Object.keys(body(document.paths["/names"].get).items.properties).sort(), ["roleName", "userId"]);
});

test("reads external Promise return types without executing the dependency", async (t) => {
  const { document, diagnostics } = await generate(t, {
    "app.js": `
      import express from "express";
      import { getSignedUrl } from "external-sdk";
      const app = express();
      app.get("/image", async (req, res) => {
        const signedUrl = await getSignedUrl();
        res.json({ signedUrl });
      });
    `,
    "node_modules/external-sdk/package.json": '{"name":"external-sdk","type":"module","types":"index.d.ts"}',
    "node_modules/external-sdk/index.d.ts": "export declare function getSignedUrl(): Promise<string>;",
    "node_modules/external-sdk/index.js": 'throw new Error("Must never execute");',
  });
  assert.deepEqual(body(document.paths["/image"].get).properties.signedUrl, { type: "string" });
  assert.deepEqual(diagnostics, []);
});

test("warns about unknown response fields and rejects them in strict mode", async (t) => {
  const files = {
    "app.js": `
      import express from "express";
      const app = express();
      app.get("/unknown", (req, res) => res.json({ data: externalResult() }));
    `,
  };
  const result = await generate(t, files);
  assert.ok(result.diagnostics.some((issue) => issue.code === "UNRESOLVED_RESPONSE_SCHEMA" && issue.message.includes("$.data")));
  await assert.rejects(generate(t, files, { strict: true }), /UNRESOLVED_RESPONSE_SCHEMA/);
});

test("follows concise arrow helpers and preserves parameterized status/messages", async (t) => {
  const { document } = await generate(t, {
    "app.js": `
      import express from "express";
      const app = express();
      const result = (statusCode, message) => ({ statusCode, message });
      app.get("/result", (req, res) => {
        const value = result(201, "Created through helper");
        res.status(value.statusCode).json(value);
      });
    `,
  });
  const schema = body(document.paths["/result"].get, 201);
  assert.equal(schema.properties.statusCode.const, 201);
  assert.equal(schema.properties.message.const, "Created through helper");
});

test("follows higher-order services and managed transaction callback returns", async (t) => {
  const { document, diagnostics } = await generate(t, {
    "app.js": `
      import express from "express";
      import { create, revoke } from "./service.js";
      const app = express();
      app.post("/keys", async (req, res) => {
        const result = await create(req.user.id);
        res.status(result.status).json(result);
      });
      app.delete("/keys", async (req, res) => {
        const result = await revoke(req.user.id);
        res.status(result.status).json(result);
      });
    `,
    "service.js": `
      import { StatusCodes } from "http-status-codes";
      async function withOwner(userId, operation) {
        return User.sequelize.transaction(async (transaction) => {
          return operation(transaction, new Date());
        });
      }
      async function issue() {
        return { status: StatusCodes.CREATED, message: "Created", data: { credential: "secret" } };
      }
      export async function create(userId) {
        return withOwner(userId, async (transaction, now) => issue());
      }
      export async function revoke(userId) {
        return withOwner(userId, async (transaction, now) => {
          return { status: StatusCodes.OK, message: "Revoked" };
        });
      }
    `,
  });
  assert.equal(body(document.paths["/keys"].post, 201).properties.message.const, "Created");
  assert.equal(body(document.paths["/keys"].delete).properties.message.const, "Revoked");
  assert.deepEqual(diagnostics, []);
});
