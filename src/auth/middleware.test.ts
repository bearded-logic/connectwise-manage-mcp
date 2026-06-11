import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash, timingSafeEqual } from "node:crypto";
import { AuthError, type EntraConfig, type CoworkEntraConfig } from "./types.js";
import { validateToken, validateCoworkToken, getCoworkEntraConfig } from "./middleware.js";

// ---------------------------------------------------------------------------
// Mock jose so tests don't hit real Azure AD
// ---------------------------------------------------------------------------

vi.mock("jose", async () => {
  const actual = await vi.importActual<typeof import("jose")>("jose");
  return {
    ...actual,
    createRemoteJWKSet: vi.fn(() => vi.fn()),
    jwtVerify: vi.fn(),
  };
});

import { jwtVerify } from "jose";

// ---------------------------------------------------------------------------
// Shared test config
// ---------------------------------------------------------------------------

const config: EntraConfig = {
  tenantId: "test-tenant-id",
  clientId: "test-client-id",
  audience: "api://test-client-id",
  requiredRole: "CWM.Access",
  serverUrl: "https://mcp.example.com",
};

const coworkConfig: CoworkEntraConfig = {
  tenantId: "test-tenant-id",
  audiences: ["api://test-audience", "test-client-id"],
  allowedClientIds: ["ab3be6b7-f5df-413d-ac2d-abf1e3fd9c0b", "allowed-client-id"],
};

const mockJwks = vi.fn() as unknown as ReturnType<typeof import("jose").createRemoteJWKSet>;

function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    tid: "test-tenant-id",
    aud: "api://test-audience",
    iss: "https://login.microsoftonline.com/test-tenant-id/v2.0",
    azp: "ab3be6b7-f5df-413d-ac2d-abf1e3fd9c0b",
    sub: "vault-client",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    nbf: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// validateToken (legacy Claude.ai / Claude Code path)
// ---------------------------------------------------------------------------

describe("validateToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns EntraIdentity for a valid token with correct role", async () => {
    vi.mocked(jwtVerify).mockResolvedValueOnce({
      payload: {
        tid: "test-tenant-id",
        roles: ["CWM.Access"],
        upn: "user@example.com",
        name: "Test User",
        oid: "test-oid",
        aud: "api://test-client-id",
        iss: `https://login.microsoftonline.com/test-tenant-id/v2.0`,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
        nbf: Math.floor(Date.now() / 1000),
        sub: "test-sub",
      },
      protectedHeader: { alg: "RS256" },
      key: {} as any,
    } as any);

    const identity = await validateToken("valid-token", config, mockJwks);

    expect(identity.upn).toBe("user@example.com");
    expect(identity.name).toBe("Test User");
    expect(identity.roles).toContain("CWM.Access");
    expect(identity.oid).toBe("test-oid");
  });

  it("throws AuthError(401) when tenant id does not match", async () => {
    vi.mocked(jwtVerify).mockResolvedValueOnce({
      payload: {
        tid: "wrong-tenant-id",
        roles: ["CWM.Access"],
        upn: "user@example.com",
        oid: "test-oid",
        aud: "api://test-client-id",
        iss: `https://login.microsoftonline.com/test-tenant-id/v2.0`,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
        nbf: Math.floor(Date.now() / 1000),
        sub: "test-sub",
      },
      protectedHeader: { alg: "RS256" },
      key: {} as any,
    } as any);

    await expect(validateToken("valid-token", config, mockJwks)).rejects.toMatchObject({
      statusCode: 401,
      message: expect.stringContaining("tenant"),
    });
  });

  it("throws AuthError(403) when required role is missing", async () => {
    vi.mocked(jwtVerify).mockResolvedValueOnce({
      payload: {
        tid: "test-tenant-id",
        roles: ["SomeOtherRole"],
        upn: "user@example.com",
        oid: "test-oid",
        aud: "api://test-client-id",
        iss: `https://login.microsoftonline.com/test-tenant-id/v2.0`,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
        nbf: Math.floor(Date.now() / 1000),
        sub: "test-sub",
      },
      protectedHeader: { alg: "RS256" },
      key: {} as any,
    } as any);

    const error = await validateToken("valid-token", config, mockJwks).catch((e) => e);
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).statusCode).toBe(403);
    expect(error.message).toContain("CWM.Access");
  });

  it("throws AuthError(401) when all audiences fail validation", async () => {
    vi.mocked(jwtVerify).mockRejectedValue(new Error("JWTClaimValidationFailed"));

    const error = await validateToken("bad-token", config, mockJwks).catch((e) => e);
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).statusCode).toBe(401);
  });

  it("propagates AuthError immediately without retrying other audiences", async () => {
    vi.mocked(jwtVerify).mockResolvedValueOnce({
      payload: {
        tid: "test-tenant-id",
        roles: [],
        oid: "oid",
        aud: "api://test-client-id",
        iss: `https://login.microsoftonline.com/test-tenant-id/v2.0`,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
        nbf: Math.floor(Date.now() / 1000),
        sub: "sub",
      },
      protectedHeader: { alg: "RS256" },
      key: {} as any,
    } as any);

    const error = await validateToken("bad-role-token", config, mockJwks).catch((e) => e);
    expect(error).toBeInstanceOf(AuthError);
    expect(vi.mocked(jwtVerify)).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// validateCoworkToken (AUTH_MODE=entra — Cowork vault-injection path)
// ---------------------------------------------------------------------------

describe("validateCoworkToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts a valid token with allowed azp and matching audience", async () => {
    vi.mocked(jwtVerify).mockResolvedValueOnce({
      payload: makePayload({ upn: "cowork@example.com" }),
      protectedHeader: { alg: "RS256" },
      key: {} as any,
    } as any);

    const identity = await validateCoworkToken("good-token", coworkConfig, mockJwks);
    expect(identity.azp).toBe("ab3be6b7-f5df-413d-ac2d-abf1e3fd9c0b");
    expect(identity.upn).toBe("cowork@example.com");
  });

  it("accepts a v1 token using appid claim instead of azp", async () => {
    vi.mocked(jwtVerify).mockResolvedValueOnce({
      payload: makePayload({ azp: undefined, appid: "ab3be6b7-f5df-413d-ac2d-abf1e3fd9c0b" }),
      protectedHeader: { alg: "RS256" },
      key: {} as any,
    } as any);

    const identity = await validateCoworkToken("v1-token", coworkConfig, mockJwks);
    expect(identity.azp).toBe("ab3be6b7-f5df-413d-ac2d-abf1e3fd9c0b");
  });

  it("throws AuthError(401) when azp is not in allowedClientIds", async () => {
    vi.mocked(jwtVerify).mockResolvedValueOnce({
      payload: makePayload({ azp: "some-unknown-client" }),
      protectedHeader: { alg: "RS256" },
      key: {} as any,
    } as any);

    const error = await validateCoworkToken("bad-client-token", coworkConfig, mockJwks).catch((e) => e);
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).statusCode).toBe(401);
    expect(error.message).toContain("Unauthorised client application");
  });

  it("throws AuthError(401) when azp and appid are both absent", async () => {
    vi.mocked(jwtVerify).mockResolvedValueOnce({
      payload: makePayload({ azp: undefined }),
      protectedHeader: { alg: "RS256" },
      key: {} as any,
    } as any);

    const error = await validateCoworkToken("no-azp-token", coworkConfig, mockJwks).catch((e) => e);
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).statusCode).toBe(401);
  });

  it("throws AuthError(401) when tenant id does not match", async () => {
    vi.mocked(jwtVerify).mockResolvedValueOnce({
      payload: makePayload({ tid: "wrong-tenant" }),
      protectedHeader: { alg: "RS256" },
      key: {} as any,
    } as any);

    const error = await validateCoworkToken("bad-tenant-token", coworkConfig, mockJwks).catch((e) => e);
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).statusCode).toBe(401);
    expect(error.message).toContain("tenant");
  });

  it("throws AuthError(401) when jwtVerify rejects all audiences (expired/invalid/wrong audience)", async () => {
    vi.mocked(jwtVerify).mockRejectedValue(new Error("JWTExpired"));

    const error = await validateCoworkToken("expired-token", coworkConfig, mockJwks).catch((e) => e);
    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).statusCode).toBe(401);
    expect(error.message).toContain("JWTExpired");
  });

  it("propagates AuthError immediately without retrying remaining audiences", async () => {
    vi.mocked(jwtVerify).mockResolvedValueOnce({
      payload: makePayload({ azp: "some-unknown-client" }),
      protectedHeader: { alg: "RS256" },
      key: {} as any,
    } as any);

    await validateCoworkToken("bad-client-token", coworkConfig, mockJwks).catch(() => {});
    // Only the first audience should be tried before the AuthError short-circuits
    expect(vi.mocked(jwtVerify)).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// getCoworkEntraConfig — startup validation
// ---------------------------------------------------------------------------

describe("getCoworkEntraConfig", () => {
  const origEnv = process.env;

  beforeEach(() => {
    process.env = { ...origEnv };
    delete process.env.ENTRA_TENANT_ID;
    delete process.env.ENTRA_AUDIENCE;
    delete process.env.AZURE_TENANT_ID;
    delete process.env.AZURE_AUDIENCE;
    delete process.env.ENTRA_ALLOWED_CLIENT_IDS;
  });

  afterEach(() => {
    process.env = origEnv;
  });

  it("returns config when ENTRA_* vars are set", () => {
    process.env.ENTRA_TENANT_ID = "my-tenant";
    process.env.ENTRA_AUDIENCE = "api://my-app";

    const cfg = getCoworkEntraConfig();
    expect(cfg.tenantId).toBe("my-tenant");
    expect(cfg.audiences).toEqual(["api://my-app"]);
    expect(cfg.allowedClientIds).toContain("ab3be6b7-f5df-413d-ac2d-abf1e3fd9c0b");
  });

  it("falls back to AZURE_* vars when ENTRA_* are absent", () => {
    process.env.AZURE_TENANT_ID = "azure-tenant";
    process.env.AZURE_AUDIENCE = "api://azure-app";

    const cfg = getCoworkEntraConfig();
    expect(cfg.tenantId).toBe("azure-tenant");
  });

  it("supports comma-separated audiences", () => {
    process.env.ENTRA_TENANT_ID = "my-tenant";
    process.env.ENTRA_AUDIENCE = "api://app-one, api://app-two";

    const cfg = getCoworkEntraConfig();
    expect(cfg.audiences).toEqual(["api://app-one", "api://app-two"]);
  });

  it("supports comma-separated ENTRA_ALLOWED_CLIENT_IDS", () => {
    process.env.ENTRA_TENANT_ID = "my-tenant";
    process.env.ENTRA_AUDIENCE = "api://my-app";
    process.env.ENTRA_ALLOWED_CLIENT_IDS = "client-a, client-b";

    const cfg = getCoworkEntraConfig();
    expect(cfg.allowedClientIds).toEqual(["client-a", "client-b"]);
  });

  it("throws when ENTRA_TENANT_ID is missing", () => {
    process.env.ENTRA_AUDIENCE = "api://my-app";

    expect(() => getCoworkEntraConfig()).toThrow(/ENTRA_TENANT_ID/);
  });

  it("throws when ENTRA_AUDIENCE is missing", () => {
    process.env.ENTRA_TENANT_ID = "my-tenant";

    expect(() => getCoworkEntraConfig()).toThrow(/ENTRA_AUDIENCE/);
  });
});

// ---------------------------------------------------------------------------
// Static bearer token comparison (timing-safe, SHA-256)
// ---------------------------------------------------------------------------

describe("static bearer token comparison", () => {
  function compareTokens(incoming: string, stored: string): boolean {
    return timingSafeEqual(
      createHash("sha256").update(incoming).digest(),
      createHash("sha256").update(stored).digest(),
    );
  }

  it("returns true for matching tokens", () => {
    expect(compareTokens("secret-token", "secret-token")).toBe(true);
  });

  it("returns false for wrong token", () => {
    expect(compareTokens("wrong-token", "secret-token")).toBe(false);
  });

  it("returns false for same-length wrong token (no length oracle)", () => {
    const stored = "abcdefghij";
    const wrong = "xxxxxxxxxx";
    expect(compareTokens(wrong, stored)).toBe(false);
  });

  it("returns false for shorter token without throwing", () => {
    expect(compareTokens("short", "much-longer-secret-token")).toBe(false);
  });

  it("returns false for empty string vs stored token", () => {
    expect(compareTokens("", "secret-token")).toBe(false);
  });
});
