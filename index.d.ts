export interface SwaggerdocOptions {
  summary?: string;
}

export interface OpenApiDiagnostic {
  level: string;
  code: string;
  message: string;
}

export interface OpenApiDocument {
  openapi: string;
  info: {
    title: string;
    version: string;
  };
  servers: Array<{ url: string }>;
  paths: Record<string, Record<string, unknown>>;
  components?: {
    securitySchemes: Record<string, unknown>;
  };
}

export interface OpenApiResult {
  document: OpenApiDocument;
  diagnostics: OpenApiDiagnostic[];
  stats: {
    scannedFiles: number;
    routes: number;
    inferredInputs: number;
  };
}

export interface GenerateOpenApiOptions {
  root?: string;
  entry?: string;
  title?: string;
  version?: string;
  strict?: boolean;
  loadSchemas?: boolean;
}

export interface InstallSwaggerdocOptions extends Omit<GenerateOpenApiOptions, "loadSchemas"> {
  docsPath?: string;
  ui?: boolean;
  logDiagnostics?: boolean;
}

export interface ExpressAppLike {
  get(path: string, ...handlers: any[]): unknown;
  use(path: string, ...handlers: any[]): unknown;
}

export declare function swaggerdoc(options?: SwaggerdocOptions): (
  req: unknown,
  res: unknown,
  next: () => void,
) => void;

export declare function generateOpenApi(
  options?: GenerateOpenApiOptions,
): Promise<OpenApiResult>;

export declare function installSwaggerdoc(
  app: ExpressAppLike,
  options?: InstallSwaggerdocOptions,
): Promise<OpenApiResult>;
