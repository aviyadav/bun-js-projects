import {
  PaymentService,
  FingerprintMismatchError,
  type TransferRequest,
} from "./PaymentService";
import { openApiSpec } from "./openapi";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function isValidBody(body: unknown): body is TransferRequest {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.fromAccount === "string" &&
    typeof b.toAccount === "string" &&
    typeof b.amount === "number" &&
    Number.isFinite(b.amount)
  );
}

export interface StartServerOptions {
  port?: number;
  /** Reuse an existing service (tests inject one with a fast clock here). */
  service?: PaymentService;
}

/** Swagger UI page that renders /openapi.json. Assets load from unpkg CDN. */
const swaggerUiHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Idempotent Payment Service — API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    window.onload = () => {
      window.ui = SwaggerUIBundle({
        url: "/openapi.json",
        dom_id: "#swagger-ui",
        deepLinking: true,
        docExpansion: "list",
      });
    };
  </script>
</body>
</html>`;

export function startServer(opts: StartServerOptions = {}) {
  const service =
    opts.service ??
    new PaymentService({
      ttlMs: 60_000, // cache live responses for 1 minute
      paymentLatencyMs: 500, // simulated bank latency - duplicates pile up here
    });

  const server = Bun.serve({
    port: opts.port ?? Number(process.env.PORT ?? 3000),
    hostname: "0.0.0.0",
    routes: {
      "/health": {
        GET: () => json({ status: "ok" }),
      },

      "/stats": {
        GET: () =>
          json({
            ...service.stats,
            cacheSize: (service as unknown as { storage: Map<string, unknown> })
              .storage.size,
          }),
      },

      "/openapi.json": {
        GET: () => json(openApiSpec),
      },

      "/docs": {
        GET: () =>
          new Response(swaggerUiHtml, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          }),
      },

      /**
       * Idempotent payment endpoint.
       * The idempotency key is the requestId path segment, so any number
       * of concurrent POSTs with the same key execute the transfer once
       * and every caller gets the identical response.
       */
      "/payments/:requestId": {
        POST: async (req) => {
          const requestId = req.params.requestId;
          let body: unknown;
          try {
            body = await req.json();
          } catch {
            return json({ error: "Body must be valid JSON" }, 400);
          }
          if (!isValidBody(body)) {
            return json(
              {
                error:
                  "Body must be { fromAccount: string, toAccount: string, amount: number }",
              },
              400,
            );
          }
          try {
            const response = await service.transfer(requestId, body);
            return json(response);
          } catch (e) {
            if (e instanceof FingerprintMismatchError) {
              return json({ error: e.message }, 422);
            }
            return json({ error: e instanceof Error ? e.message : String(e) }, 422);
          }
        },

        /** Inspect the cached entry for a requestId (demo/debug aid). */
        GET: (req) => {
          const entry = service.peek(req.params.requestId);
          if (!entry) return json({ error: "No cached entry for this requestId" }, 404);
          return json(entry);
        },
      },
    },
  });

  return { server, service };
}

if (import.meta.main) {
  const { server, service } = startServer();

  console.log(`Payment server listening on http://localhost:${server.port}`);
  console.log(`API docs (Swagger UI): http://localhost:${server.port}/docs`);
  console.log(`Try:
  curl -X POST http://localhost:${server.port}/payments/order-123 \\
    -H "Content-Type: application/json" \\
    -d '{"fromAccount":"alice","toAccount":"bob","amount":42.50}'
  curl http://localhost:${server.port}/payments/order-123
  curl http://localhost:${server.port}/stats`);

  process.on("SIGINT", () => {
    service.shutdown();
    server.stop();
    process.exit(0);
  });
}
