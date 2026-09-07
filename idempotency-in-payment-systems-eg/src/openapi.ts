/**
 * OpenAPI 3.0 description of the payment service.
 * Served as JSON at /openapi.json and rendered by Swagger UI at /docs.
 */

export const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "Idempotent Payment Service",
    version: "1.0.0",
    description:
      "A payment service demonstrating idempotency under concurrent load. " +
      "Every transfer carries an idempotency key (the `requestId` path segment). " +
      "Concurrent or retried requests with the same key execute the bank call " +
      "(`doTransfer`) exactly once and every caller receives the identical " +
      "`TransferResult`. Reusing a live key with a *different* request body is " +
      "rejected with HTTP 422. Entries expire after a TTL and are swept by a " +
      "background eviction job.",
  },
  tags: [
    { name: "payments", description: "Idempotent transfer operations" },
    { name: "operations", description: "Health and observability" },
    { name: "docs", description: "API documentation" },
  ],
  paths: {
    "/payments/{requestId}": {
      post: {
        tags: ["payments"],
        summary: "Execute an idempotent transfer",
        description:
          "Executes the transfer exactly once per live idempotency key. " +
          "Concurrent duplicate requests coalesce onto the same in-flight " +
          "computation and receive the identical response. A retry with the " +
          "same key within the TTL is served from cache without re-executing.",
        parameters: [
          {
            name: "requestId",
            in: "path",
            required: true,
            description: "The idempotency key for this transfer.",
            schema: { type: "string" },
            example: "order-123",
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/TransferRequest" },
            },
          },
        },
        responses: {
          "200": {
            description:
              "Transfer executed (or replayed from cache — the response is identical either way).",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/TransferResult" },
              },
            },
          },
          "400": {
            description: "Body is not valid JSON or is missing required fields.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
          "422": {
            description:
              "Either the idempotency key was already used with a different request body " +
              "(fingerprint mismatch), or the underlying transfer failed. On failure the " +
              "cache entry is removed, so the same key can be retried.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
      get: {
        tags: ["payments"],
        summary: "Inspect the cached entry for an idempotency key",
        description:
          "Returns the cached response (and its fingerprint) for a key, if a live entry exists.",
        parameters: [
          {
            name: "requestId",
            in: "path",
            required: true,
            description: "The idempotency key to look up.",
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "The cached entry for this key.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CachedEntry" },
              },
            },
          },
          "404": {
            description: "No cached entry exists for this key.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
      },
    },
    "/stats": {
      get: {
        tags: ["operations"],
        summary: "Service counters",
        description:
          "Cumulative counters: how many requests arrived, how many bank calls actually " +
          "ran, how many were coalesced onto an existing entry, fingerprint rejections, " +
          "failures, and evictions.",
        responses: {
          "200": {
            description: "Current counters.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Stats" },
              },
            },
          },
        },
      },
    },
    "/health": {
      get: {
        tags: ["operations"],
        summary: "Liveness probe",
        responses: {
          "200": {
            description: "The service is up.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { status: { type: "string", example: "ok" } },
                },
              },
            },
          },
        },
      },
    },
    "/openapi.json": {
      get: {
        tags: ["docs"],
        summary: "This document, as raw OpenAPI JSON",
        responses: {
          "200": { description: "The OpenAPI specification." },
        },
      },
    },
    "/docs": {
      get: {
        tags: ["docs"],
        summary: "Interactive API documentation (Swagger UI)",
        description: "Human-readable docs rendered from /openapi.json.",
        responses: {
          "200": { description: "Swagger UI HTML page." },
        },
      },
    },
  },
  components: {
    schemas: {
      TransferRequest: {
        type: "object",
        required: ["fromAccount", "toAccount", "amount"],
        description:
          "The transfer instruction. Fingerprinted by the service: reusing an " +
          "idempotency key with a different body is rejected with 422.",
        properties: {
          fromAccount: { type: "string", example: "alice" },
          toAccount: { type: "string", example: "bob" },
          amount: {
            type: "number",
            format: "double",
            description: "Must be > 0.",
            example: 42.5,
          },
        },
      },
      TransferResult: {
        type: "object",
        required: ["transferId", "request", "processedAt"],
        description:
          "The result of a transfer. Identical for every caller that used the " +
          "same idempotency key with the same body.",
        properties: {
          transferId: {
            type: "string",
            description: "Unique identifier of the executed transfer.",
            example: "9b2f6a1e-4c3d-4e8f-9a7b-1c2d3e4f5a6b",
          },
          request: { $ref: "#/components/schemas/TransferRequest" },
          processedAt: { type: "string", format: "date-time" },
        },
      },
      CachedEntry: {
        type: "object",
        required: ["createdAt", "fingerprint", "response"],
        properties: {
          createdAt: {
            type: "string",
            format: "date-time",
            description: "When the cache entry was created (TTL is measured from this).",
          },
          fingerprint: {
            type: "string",
            description: "Fingerprint of the request body this entry was created with.",
          },
          response: { $ref: "#/components/schemas/TransferResult" },
        },
      },
      Stats: {
        type: "object",
        required: [
          "requests",
          "executed",
          "coalesced",
          "rejected",
          "failures",
          "evictions",
          "cacheSize",
        ],
        properties: {
          requests: { type: "integer", description: "Total transfer() calls." },
          executed: {
            type: "integer",
            description: "Times doTransfer (the bank call) actually ran.",
          },
          coalesced: {
            type: "integer",
            description: "Requests served from an in-flight or completed entry.",
          },
          rejected: { type: "integer", description: "Fingerprint mismatches (422)." },
          failures: { type: "integer", description: "Bank calls that threw." },
          evictions: { type: "integer", description: "Entries removed by the TTL sweeper." },
          cacheSize: { type: "integer", description: "Live entries currently cached." },
        },
      },
      ErrorResponse: {
        type: "object",
        required: ["error"],
        properties: {
          error: { type: "string", example: "Invalid amount: 0" },
        },
      },
    },
  },
} as const;
