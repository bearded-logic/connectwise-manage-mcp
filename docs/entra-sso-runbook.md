# Runbook — Entra ID SSO auth for ConnectWise MCP (AUTH_MODE=entra)

This runbook covers the full cutover from static API key auth (`AUTH_MODE=apikey`) to
Microsoft Entra ID SSO (`AUTH_MODE=entra`) for the ConnectWise MCP server hosted on
Azure Container Apps (`ca-tc-mcp-connectwise`, `rg-tc-mcp-prod`).

**Why:** Microsoft 365 Copilot Cowork MCP plugins do not support `ApiKeyPluginVault`
authentication. Supported auth methods are OAuth/Entra SSO, or none. Entra SSO lets
Cowork's enterprise token store inject a signed JWT for each call — no shared static
key, per-call audit trail.

**Rollback:** set `AUTH_MODE=apikey` and `MCP_API_KEY` on the Container App — instant,
no redeploy required.

---

## Prerequisites

- Access to [Teams Developer Portal](https://dev.teams.microsoft.com/tools) in the TC tenant
- Access to [Entra admin center](https://entra.microsoft.com/) — Application Administrator or higher
- The existing Entra app registration that secures the MCP server (used by `MCP_OAUTH_ENABLED` path)
- `az` CLI with Global / Application Administrator rights
- The Container App `ca-tc-mcp-connectwise` already running `AUTH_MODE=apikey`

---

## Step 1 — Teams Developer Portal: SSO client registration

1. Open [Teams Developer Portal → Tools → Microsoft Entra SSO client ID registration](https://dev.teams.microsoft.com/tools/oauth-configuration)
2. Click **New client registration** (or **Register client** if first time)
3. Fill in:

   | Field | Value |
   |---|---|
   | Registration name | `ConnectWise MCP — TechConnect Cowork` |
   | Base URL | `https://ca-tc-mcp-connectwise.salmonsea-b49eab05.australiaeast.azurecontainerapps.io/mcp` |
   | Restrict usage by org | **Home tenant** |
   | Restrict usage by app | **Any Teams app** (change to the specific app GUID once published) |

4. Click **Save**
5. Record the two generated values:
   - **SSO registration ID** — paste into the plugin manifest (`auth.reference_id`)
   - **Application ID URI** — needed in Step 2 and Step 3

---

## Step 2 — Entra admin center: update the app registration

Open [Entra admin center → App registrations → (your MCP app)](https://entra.microsoft.com/)

### 2a. Add the Application ID URI

- Go to **Expose an API**
- If no App ID URI is set yet, click **Set** and enter the Application ID URI from Step 1
- If one already exists, click **Add an application ID URI** and add the new one
  (multiple URIs are supported; use the manifest editor if the UI only shows one)

### 2b. Add the Teams redirect URI

- Go to **Authentication**
- Under **Web → Redirect URIs**, click **Add URI**
- Enter: `https://teams.microsoft.com/api/platform/v1.0/oAuthConsentRedirect`
- Click **Save**

### 2c. Pre-authorise the Microsoft Enterprise Token Store

This is the client that Cowork uses to inject credentials into your MCP calls.

- Go to **Expose an API → Authorised client applications**
- Click **Add a client application**
- **Client ID**: `ab3be6b7-f5df-413d-ac2d-abf1e3fd9c0b`
- Tick all scopes
- Click **Authorise**

Alternatively, use the helper script (review before running):

```bash
TENANT_ID=<your-tenant-id> \
APP_OBJECT_ID=<object-id-of-app-registration> \
APP_ID_URI=<application-id-uri-from-step-1> \
bash setup-entra-app.sh
```

---

## Step 3 — Container App: set environment variables

```bash
az containerapp update \
  --name ca-tc-mcp-connectwise \
  --resource-group rg-tc-mcp-prod \
  --set-env-vars \
    AUTH_MODE=entra \
    "ENTRA_TENANT_ID=<your-tenant-id>" \
    "ENTRA_AUDIENCE=<application-id-uri-from-step-1>" \
    "ENTRA_ALLOWED_CLIENT_IDS=ab3be6b7-f5df-413d-ac2d-abf1e3fd9c0b"
```

**Do not remove `MCP_API_KEY` yet** — keep it in place for rollback. The `AUTH_MODE=entra`
setting will ignore it, but having it available means you can roll back with a single env
var change.

---

## Step 4 — Plugin manifest: update auth block

In `agents/sd-3b-sidekick/cowork-connector/manifest.json`, replace:

```json
"authorization": {
  "type": "ApiKeyPluginVault",
  "referenceId": "..."
}
```

with:

```json
"authorization": {
  "type": "OAuthPluginVault",
  "referenceId": "<SSO-registration-ID-from-step-1>"
}
```

Repackage the ZIP and re-upload to M365 Admin Center (Settings → Integrated Apps →
find the app → Update):

```powershell
cd agents/sd-3b-sidekick/cowork-connector
Compress-Archive -Path manifest.json, color.png, outline.png, skills `
  -DestinationPath tc-connectwise-mcp.zip -Force
```

---

## Step 5 — Verify

1. Watch Container App logs:

   ```bash
   az containerapp logs show \
     -n ca-tc-mcp-connectwise \
     -g rg-tc-mcp-prod \
     --tail 50 --follow
   ```

2. In Cowork, ask: **"What open tickets do we have in ConnectWise?"**

3. Confirm you see a log line like:
   ```
   [audit] Cowork call accepted — upn=vault-client azp=ab3be6b7-... aud=api://...
   ```

4. Confirm Cowork returns ticket data.

---

## Environment variables reference

| Variable | Required for `entra` | Description |
|---|---|---|
| `AUTH_MODE` | ✅ | Set to `entra`. Default: `apikey` |
| `ENTRA_TENANT_ID` | ✅ | Your Entra tenant GUID. Alias: `AZURE_TENANT_ID` |
| `ENTRA_AUDIENCE` | ✅ | Application ID URI (comma-separated list supported). Alias: `AZURE_AUDIENCE` |
| `ENTRA_ALLOWED_CLIENT_IDS` | — | Comma-separated list of allowed `azp`/`appid` values. Default: `ab3be6b7-f5df-413d-ac2d-abf1e3fd9c0b` |
| `MCP_API_KEY` | — | Keep set for rollback. Ignored when `AUTH_MODE=entra` |
| `MCP_OAUTH_ENABLED` | — | Separate Claude.ai full OAuth proxy path. Independent of `AUTH_MODE` |

---

## Rollback

To revert to API key auth without a redeploy:

```bash
az containerapp update \
  --name ca-tc-mcp-connectwise \
  --resource-group rg-tc-mcp-prod \
  --set-env-vars AUTH_MODE=apikey
```

Then revert the manifest `authorization.type` back to `ApiKeyPluginVault` and re-upload.

---

## CW_CREDENTIAL_MODE (renamed from AUTH_MODE=env/gateway)

The old `AUTH_MODE=env|gateway` controlled how ConnectWise API credentials were sourced.
That concept is now named `CW_CREDENTIAL_MODE`. The server still reads `AUTH_MODE=env` or
`AUTH_MODE=gateway` as a legacy fallback, but new deployments should use `CW_CREDENTIAL_MODE`.

| Old env var | New env var | Values |
|---|---|---|
| `AUTH_MODE=env` | `CW_CREDENTIAL_MODE=env` | CW creds from process env (default) |
| `AUTH_MODE=gateway` | `CW_CREDENTIAL_MODE=gateway` | CW creds from per-request headers |
