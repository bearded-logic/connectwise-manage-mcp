import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CwManageClient } from "../api-client.js";

export function registerAgreementTools(server: McpServer, client: CwManageClient) {
  server.tool(
    "cw_search_agreements",
    "Search finance agreements (recurring revenue contracts) in ConnectWise Manage. Use 'conditions' for CW query syntax (e.g. \"cancelledFlag = false\", \"company/name = 'Acme'\").",
    {
      conditions: z.string().optional().describe("ConnectWise conditions query string"),
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z.number().optional().describe("Results per page (default: 25, max: 1000)"),
      orderBy: z.string().optional().describe("Field to order by"),
    },
    async ({ conditions, page, pageSize, orderBy }) => {
      const result = await client.get("/finance/agreements", {
        conditions,
        page: page ?? 1,
        pageSize: pageSize ?? 25,
        orderBy,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_get_agreement",
    "Get a specific finance agreement by ID.",
    {
      id: z.number().describe("Agreement ID"),
    },
    async ({ id }) => {
      const result = await client.get(`/finance/agreements/${id}`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_get_agreement_additions",
    "Get additions (line items) for a specific agreement.",
    {
      agreementId: z.number().describe("Agreement ID"),
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z.number().optional().describe("Results per page (default: 25, max: 1000)"),
    },
    async ({ agreementId, page, pageSize }) => {
      const result = await client.get(`/finance/agreements/${agreementId}/additions`, {
        page: page ?? 1,
        pageSize: pageSize ?? 25,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  // ── TC additions ──────────────────────────────────────────────────────────

  server.tool(
    "cw_get_agreement_recap",
    "Get the financial/hours recap for a specific agreement — returns remainingAmount, usedAmount, startingAmount, availableAmount and overrunAmount. For time-based agreements (applicationUnits = 'Hours') these values are in hours; for amount-based agreements they are in dollars. Use this to answer 'how many hours remaining' or 'what is the balance' questions.",
    {
      id: z.number().describe("Agreement ID"),
    },
    async ({ id }) => {
      const result = await client.get(`/finance/agreementrecap/${id}`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_search_agreement_recaps",
    "Search agreement recaps across all agreements. Returns remainingAmount, usedAmount, startingAmount per agreement. Use conditions to filter by company (e.g. \"companyName like '%Acme%'\") or agreement name.",
    {
      conditions: z.string().optional().describe("ConnectWise conditions query string"),
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z.number().optional().describe("Results per page (default: 25, max: 1000)"),
      orderBy: z.string().optional().describe("Field to order by"),
    },
    async ({ conditions, page, pageSize, orderBy }) => {
      const result = await client.get("/finance/agreementrecap", {
        conditions,
        page: page ?? 1,
        pageSize: pageSize ?? 25,
        orderBy,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_search_invoices",
    "Search invoices in ConnectWise Manage.",
    {
      conditions: z.string().optional().describe("ConnectWise conditions query string (e.g. \"company/name = 'Acme'\")"),
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z.number().optional().describe("Results per page (default: 25, max: 1000)"),
      orderBy: z.string().optional().describe("Field to order by (e.g. 'id desc')"),
    },
    async ({ conditions, page, pageSize, orderBy }) => {
      const result = await client.get("/finance/invoices", {
        conditions,
        page: page ?? 1,
        pageSize: pageSize ?? 25,
        orderBy,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_get_invoice",
    "Get a specific invoice by ID.",
    {
      id: z.number().describe("Invoice ID"),
    },
    async ({ id }) => {
      const result = await client.get(`/finance/invoices/${id}`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );
}
