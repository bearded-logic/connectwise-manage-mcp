import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CwManageClient } from "../api-client.js";

/**
 * TechConnect additions — ConnectWise knowledge base + service classification lookups.
 * Supports the SD-3b assessment core (documented fixes, valid field values).
 */
export function registerKnowledgeTools(server: McpServer, client: CwManageClient) {
  server.tool(
    "cw_search_knowledge_base_articles",
    "Search the ConnectWise knowledge base for documented fixes and known issues. Use 'conditions' to filter by subject or keywords (e.g. \"question like '%vpn%'\" or \"solution like '%outlook%'\"). Cite the article id and title in the assessment.",
    {
      conditions: z
        .string()
        .optional()
        .describe("ConnectWise conditions query string (e.g. \"question like '%vpn%'\")"),
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z.number().optional().describe("Results per page (default: 25, max: 1000)"),
      orderBy: z.string().optional().describe("Field to order by (e.g. 'dateCreated desc')"),
    },
    async ({ conditions, page, pageSize, orderBy }) => {
      const result = await client.get("/service/knowledgeBaseArticles", {
        conditions,
        page: page ?? 1,
        pageSize: pageSize ?? 25,
        orderBy,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_list_service_sources",
    "List ticket source values in ConnectWise Manage (how tickets arrive — phone, email, portal, etc.). Use when setting or recommending a source on a ticket.",
    {
      conditions: z.string().optional().describe("ConnectWise conditions query string"),
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z.number().optional().describe("Results per page (default: 25, max: 1000)"),
    },
    async ({ conditions, page, pageSize }) => {
      const result = await client.get("/service/sources", {
        conditions,
        page: page ?? 1,
        pageSize: pageSize ?? 25,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_list_impacts",
    "List impact values in ConnectWise Manage. Use when assessing or recommending the impact level for a ticket.",
    {
      conditions: z.string().optional().describe("ConnectWise conditions query string"),
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z.number().optional().describe("Results per page (default: 25, max: 1000)"),
    },
    async ({ conditions, page, pageSize }) => {
      const result = await client.get("/service/impacts", {
        conditions,
        page: page ?? 1,
        pageSize: pageSize ?? 25,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "cw_list_severities",
    "List severity values in ConnectWise Manage. Use when assessing or recommending the severity level for a ticket.",
    {
      conditions: z.string().optional().describe("ConnectWise conditions query string"),
      page: z.number().optional().describe("Page number (default: 1)"),
      pageSize: z.number().optional().describe("Results per page (default: 25, max: 1000)"),
    },
    async ({ conditions, page, pageSize }) => {
      const result = await client.get("/service/severities", {
        conditions,
        page: page ?? 1,
        pageSize: pageSize ?? 25,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );
}
