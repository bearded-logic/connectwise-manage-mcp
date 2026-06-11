export type McpAuthMode = "entra" | "apikey" | "none";

export interface EntraConfig {
  tenantId: string;
  clientId: string;
  audience: string; // api://<clientId>
  requiredRole: string; // e.g. "CWM.Access"
  serverUrl: string; // https://mcp.yourdomain.com (no trailing slash)
  bearerToken?: string; // static token for Claude Code CLI fallback
}

// Cowork / vault-injection Entra config — no role check, azp allowlist instead.
export interface CoworkEntraConfig {
  tenantId: string;
  audiences: string[]; // from ENTRA_AUDIENCE (comma-separated)
  allowedClientIds: string[]; // from ENTRA_ALLOWED_CLIENT_IDS; must include vault client
}

export interface EntraIdentity {
  upn: string;
  name?: string;
  roles: string[];
  oid: string;
}

export interface CoworkIdentity {
  upn: string;
  azp: string; // authorised client app that presented the token
}

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 401 | 403,
  ) {
    super(message);
    this.name = "AuthError";
  }
}
