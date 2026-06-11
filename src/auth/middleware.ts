import { createRemoteJWKSet, jwtVerify, type JWTPayload, type RemoteJWKSetOptions } from "jose";
import {
  AuthError,
  type CoworkEntraConfig,
  type CoworkIdentity,
  type EntraConfig,
  type EntraIdentity,
} from "./types.js";

// ---------------------------------------------------------------------------
// Shared JWKS helpers
// ---------------------------------------------------------------------------

type JwksClient = ReturnType<typeof createRemoteJWKSet>;

export function createJwksClient(tenantId: string): JwksClient {
  const jwksUrl = new URL(
    `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`,
  );
  const options: RemoteJWKSetOptions = { cacheMaxAge: 60 * 60 * 1000 };
  return createRemoteJWKSet(jwksUrl, options);
}

// ---------------------------------------------------------------------------
// Legacy Claude.ai / Claude Code OAuth path
// (active when MCP_OAUTH_ENABLED=true; full proxy flow with role check)
// ---------------------------------------------------------------------------

export function getEntraConfig(): EntraConfig {
  const tenantId = process.env.AZURE_TENANT_ID;
  const clientId = process.env.AZURE_CLIENT_ID;
  const audience = process.env.AZURE_AUDIENCE;
  const serverUrl = process.env.MCP_SERVER_URL;

  if (!tenantId || !clientId || !audience || !serverUrl) {
    throw new Error(
      "Missing required Entra ID environment variables: AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_AUDIENCE, MCP_SERVER_URL",
    );
  }

  return {
    tenantId,
    clientId,
    audience,
    requiredRole: process.env.AZURE_REQUIRED_ROLE ?? "CWM.Access",
    serverUrl: serverUrl.replace(/\/$/, ""),
    bearerToken: process.env.MCP_BEARER_TOKEN || undefined,
  };
}

interface EntraJwtPayload extends JWTPayload {
  upn?: string;
  unique_name?: string;
  preferred_username?: string;
  name?: string;
  roles?: string[];
  tid?: string;
  oid?: string;
}

export async function validateToken(
  token: string,
  config: EntraConfig,
  jwks: JwksClient,
): Promise<EntraIdentity> {
  const audiencesToTry = [
    config.audience,
    config.clientId,
    `api://${config.clientId}`,
  ].filter((a, i, arr) => arr.indexOf(a) === i);

  let lastError: unknown;

  for (const aud of audiencesToTry) {
    try {
      const { payload } = await jwtVerify<EntraJwtPayload>(token, jwks, {
        issuer: `https://login.microsoftonline.com/${config.tenantId}/v2.0`,
        audience: aud,
      });

      if (payload.tid && payload.tid !== config.tenantId) {
        throw new AuthError("Token tenant does not match expected tenant", 401);
      }

      const roles: string[] = payload.roles ?? [];
      if (!roles.includes(config.requiredRole)) {
        console.error(
          `[auth] Role check failed — token has roles: [${roles.join(", ")}], required: ${config.requiredRole}`,
        );
        throw new AuthError(
          `Access denied: missing required role '${config.requiredRole}'`,
          403,
        );
      }

      const upn =
        payload.upn ??
        payload.unique_name ??
        payload.preferred_username ??
        payload.sub ??
        "unknown";

      return {
        upn,
        name: payload.name,
        roles,
        oid: payload.oid ?? payload.sub ?? "",
      };
    } catch (err) {
      if (err instanceof AuthError) throw err;
      lastError = err;
    }
  }

  try {
    const parts = token.split(".");
    if (parts.length === 3) {
      const decoded = JSON.parse(
        Buffer.from(parts[1]!, "base64url").toString("utf8"),
      ) as EntraJwtPayload;
      console.error(
        `[auth] JWT validation failed. tokenAudience=${JSON.stringify(decoded.aud)} triedAudiences=${JSON.stringify(audiencesToTry)}`,
      );
    }
  } catch {
    // ignore decode errors
  }

  throw new AuthError(
    `Invalid token: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    401,
  );
}

// ---------------------------------------------------------------------------
// Cowork / Teams vault-injection Entra path
// (active when AUTH_MODE=entra; validates azp, no role check)
// ---------------------------------------------------------------------------

export function getCoworkEntraConfig(): CoworkEntraConfig {
  // Accept both ENTRA_* (new) and AZURE_* (legacy fallbacks)
  const tenantId = process.env.ENTRA_TENANT_ID ?? process.env.AZURE_TENANT_ID;
  const audienceRaw = process.env.ENTRA_AUDIENCE ?? process.env.AZURE_AUDIENCE;

  if (!tenantId || !audienceRaw) {
    throw new Error(
      "AUTH_MODE=entra requires ENTRA_TENANT_ID (or AZURE_TENANT_ID) and ENTRA_AUDIENCE (or AZURE_AUDIENCE)",
    );
  }

  const audiences = audienceRaw
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);

  // Default includes the Microsoft Enterprise Token Store client that Cowork uses to inject credentials.
  const allowedClientIds = (
    process.env.ENTRA_ALLOWED_CLIENT_IDS ?? "ab3be6b7-f5df-413d-ac2d-abf1e3fd9c0b"
  )
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  return { tenantId, audiences, allowedClientIds };
}

interface CoworkJwtPayload extends JWTPayload {
  azp?: string; // authorised party — OAuth 2.0 client that requested the token (v2)
  appid?: string; // same concept, v1 claim name
  tid?: string;
  upn?: string;
  preferred_username?: string;
}

export async function validateCoworkToken(
  token: string,
  config: CoworkEntraConfig,
  jwks: JwksClient,
): Promise<CoworkIdentity> {
  let lastError: unknown;

  for (const audience of config.audiences) {
    try {
      const { payload } = await jwtVerify<CoworkJwtPayload>(token, jwks, {
        // Accept both v2 and v1 issuers defensively
        issuer: [
          `https://login.microsoftonline.com/${config.tenantId}/v2.0`,
          `https://sts.windows.net/${config.tenantId}/`,
        ],
        audience,
        clockTolerance: 60, // 60 s skew tolerance
      });

      // Tenant check
      if (payload.tid && payload.tid !== config.tenantId) {
        throw new AuthError("Token tenant does not match expected tenant", 401);
      }

      // azp / appid allowlist — this is the authorisation gate
      const clientId = payload.azp ?? payload.appid;
      if (!clientId || !config.allowedClientIds.includes(clientId)) {
        console.error(
          `[auth] Cowork azp check failed — token azp/appid: ${clientId ?? "(none)"}, allowed: [${config.allowedClientIds.join(", ")}]`,
        );
        throw new AuthError(`Unauthorised client application: ${clientId ?? "(none)"}`, 401);
      }

      const upn = payload.upn ?? payload.preferred_username ?? payload.sub ?? "vault-client";

      console.error(`[audit] Cowork call accepted — upn=${upn} azp=${clientId} aud=${audience}`);

      return { upn, azp: clientId };
    } catch (err) {
      if (err instanceof AuthError) throw err;
      lastError = err;
    }
  }

  // Log diagnostic info without exposing token
  try {
    const parts = token.split(".");
    if (parts.length === 3) {
      const decoded = JSON.parse(
        Buffer.from(parts[1]!, "base64url").toString("utf8"),
      ) as CoworkJwtPayload;
      console.error(
        `[auth] Cowork JWT validation failed. aud=${JSON.stringify(decoded.aud)} azp=${decoded.azp ?? decoded.appid ?? "(none)"} triedAudiences=${JSON.stringify(config.audiences)}`,
      );
    }
  } catch {
    // ignore
  }

  throw new AuthError(
    `Invalid token: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    401,
  );
}
