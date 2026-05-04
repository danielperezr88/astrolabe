/**
 * Tests for Manifest Contract Extraction.
 *
 * Tests OpenAPI/Swagger, docker-compose, and .proto parsing
 * using string content (no files on disk required).
 */
import { describe, it, expect } from 'vitest';
import {
  extractOpenApiContracts,
  extractDockerComposeContracts,
  extractProtoContracts,
} from '../../src/mcp/manifest-extractor.js';

// ── OpenAPI / Swagger ──────────────────────────────────────────────────────

describe('Manifest Extractor — OpenAPI', () => {
  it('extracts endpoints from a YAML OpenAPI spec', () => {
    const content = `
openapi: "3.0.0"
info:
  title: "Petstore"
  version: "1.0.0"
paths:
  /pets:
    get:
      summary: "List pets"
    post:
      summary: "Create pet"
  /pets/{id}:
    get:
      summary: "Get pet"
    delete:
      summary: "Delete pet"
`;
    const results = extractOpenApiContracts(content, 'openapi.yaml');
    expect(results).toHaveLength(1);
    expect(results[0]!.type).toBe('openapi');
    expect(results[0]!.name).toBe('Petstore');
    expect(results[0]!.endpoints).toHaveLength(4);

    const methods = results[0]!.endpoints!.map((e) => e.method);
    expect(methods).toContain('GET');
    expect(methods).toContain('POST');
    expect(methods).toContain('DELETE');
  });

  it('extracts endpoints from a JSON Swagger spec', () => {
    const content = JSON.stringify({
      swagger: '2.0',
      info: { title: 'User API', version: '1.0' },
      paths: {
        '/api/users': { get: { description: 'list' }, post: { description: 'create' } },
        '/api/users/{id}': { get: { description: 'get' }, put: { description: 'update' } },
      },
    });
    const results = extractOpenApiContracts(content, 'swagger.json');
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('User API');
    expect(results[0]!.endpoints).toHaveLength(4);

    const paths = results[0]!.endpoints!.map((e) => e.path);
    expect(paths).toContain('/api/users');
    expect(paths).toContain('/api/users/{id}');
  });

  it('returns empty for content with no paths', () => {
    const content = `
openapi: "3.0.0"
info:
  title: "Empty"
  version: "1.0"
`;
    const results = extractOpenApiContracts(content, 'openapi.yaml');
    expect(results).toHaveLength(0);
  });

  it('handles malformed content gracefully', () => {
    const results = extractOpenApiContracts('not valid yaml {{{}}}', 'bad.yaml');
    expect(results).toHaveLength(0);
  });
});

// ── docker-compose ─────────────────────────────────────────────────────────

describe('Manifest Extractor — docker-compose', () => {
  it('extracts service names from a docker-compose file', () => {
    const content = `
version: "3.8"
services:
  web:
    image: nginx
    ports:
      - "80:80"
  api:
    image: node:18
    depends_on:
      - db
  db:
    image: postgres:15
    volumes:
      - pgdata:/var/lib/postgresql/data
volumes:
  pgdata:
`;
    const results = extractDockerComposeContracts(content, 'docker-compose.yaml');
    expect(results).toHaveLength(1);
    expect(results[0]!.type).toBe('docker-compose');
    expect(results[0]!.services).toContain('web');
    expect(results[0]!.services).toContain('api');
    expect(results[0]!.services).toContain('db');
    expect(results[0]!.services!.length).toBe(3);
  });

  it('extracts services with hyphenated names', () => {
    const content = `
services:
  my-api-gateway:
    image: gateway:latest
  auth-service:
    image: auth:latest
`;
    const results = extractDockerComposeContracts(content, 'docker-compose.yml');
    expect(results).toHaveLength(1);
    expect(results[0]!.services).toContain('my-api-gateway');
    expect(results[0]!.services).toContain('auth-service');
  });

  it('returns empty for content with no services', () => {
    const content = `
version: "3.8"
networks:
  frontend:
`;
    const results = extractDockerComposeContracts(content, 'docker-compose.yaml');
    expect(results).toHaveLength(0);
  });

  it('handles malformed YAML gracefully', () => {
    const results = extractDockerComposeContracts('{{{{not yaml}}}}', 'docker-compose.yaml');
    expect(results).toHaveLength(0);
  });
});

// ── .proto ──────────────────────────────────────────────────────────────────

describe('Manifest Extractor — Proto', () => {
  it('extracts service and rpc methods from a .proto file', () => {
    const content = `
syntax = "proto3";

package users.v1;

service UserService {
  rpc GetUser(GetUserRequest) returns (GetUserResponse);
  rpc CreateUser(CreateUserRequest) returns (CreateUserResponse);
  rpc DeleteUser(DeleteUserRequest) returns (DeleteUserResponse);
}
`;
    const results = extractProtoContracts(content, 'user.proto');
    expect(results).toHaveLength(1);
    expect(results[0]!.type).toBe('proto');
    expect(results[0]!.name).toBe('UserService');
    expect(results[0]!.package).toBe('users.v1');
    expect(results[0]!.endpoints).toHaveLength(3);

    const methodNames = results[0]!.endpoints!.map((e) => e.method);
    expect(methodNames).toContain('GetUser');
    expect(methodNames).toContain('CreateUser');
    expect(methodNames).toContain('DeleteUser');
  });

  it('extracts multiple services from one file', () => {
    const content = `
package catalog;

service ProductService {
  rpc ListProducts(ListReq) returns (ListResp);
}

service OrderService {
  rpc PlaceOrder(OrderReq) returns (OrderResp);
}
`;
    const results = extractProtoContracts(content, 'catalog.proto');
    expect(results).toHaveLength(2);
    expect(results[0]!.name).toBe('ProductService');
    expect(results[1]!.name).toBe('OrderService');
    expect(results[0]!.package).toBe('catalog');
    expect(results[1]!.package).toBe('catalog');
  });

  it('handles proto files without a package declaration', () => {
    const content = `
syntax = "proto3";

service HealthService {
  rpc Check(HealthCheckRequest) returns (HealthCheckResponse);
}
`;
    const results = extractProtoContracts(content, 'health.proto');
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('HealthService');
    expect(results[0]!.package).toBeUndefined();
    expect(results[0]!.endpoints).toHaveLength(1);
  });

  it('handles malformed proto content gracefully', () => {
    const results = extractProtoContracts('not a proto file { {{{', 'bad.proto');
    expect(results).toHaveLength(0);
  });

  it('generates correct gRPC path for endpoints', () => {
    const content = `
package myapp;

service Greeter {
  rpc SayHello(HelloRequest) returns (HelloReply);
}
`;
    const results = extractProtoContracts(content, 'greeter.proto');
    expect(results).toHaveLength(1);
    expect(results[0]!.endpoints).toHaveLength(1);
    expect(results[0]!.endpoints![0]!.path).toBe('/myapp/Greeter/SayHello');
  });
});

// ── Edge cases ─────────────────────────────────────────────────────────────

describe('Manifest Extractor — Edge cases', () => {
  it('extracts OpenAPI title from info section', () => {
    const content = `
openapi: "3.0"
info:
  title: "My Cool API"
paths:
  /test:
    get:
      summary: "test"
`;
    const results = extractOpenApiContracts(content, 'openapi.yaml');
    expect(results[0]!.name).toBe('My Cool API');
  });

  it('falls back to filename when no title in OpenAPI', () => {
    const content = `
openapi: "3.0"
paths:
  /test:
    get:
      summary: "test"
`;
    const results = extractOpenApiContracts(content, 'my-api/openapi.yaml');
    expect(results[0]!.name).toBe('openapi.yaml');
  });
});
