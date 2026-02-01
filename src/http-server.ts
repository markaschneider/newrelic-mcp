#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import cors from 'cors';
import express, { type Request, type Response } from 'express';
import { NewRelicClient } from './client/newrelic-client';
import { AlertTool } from './tools/alert';
import { ApmTool } from './tools/apm';
import { EntityTool } from './tools/entity';
import { NerdGraphTool } from './tools/nerdgraph';
import { NrqlTool } from './tools/nrql';
import { RestApmTool } from './tools/rest/apm';
import { RestDeploymentsTool } from './tools/rest/deployments';
import { RestMetricsTool } from './tools/rest/metrics';
import { SyntheticsTool } from './tools/synthetics';

type Region = 'US' | 'EU';

interface SessionContext {
  apiKey: string;
  accountId?: string;
  region: Region;
  client: NewRelicClient;
}

// Session store for multi-tenant support
const sessions = new Map<string, SessionContext>();

// Session cleanup interval (clean up sessions older than 1 hour)
const SESSION_TTL_MS = 60 * 60 * 1000;
const sessionLastAccess = new Map<string, number>();

setInterval(() => {
  const now = Date.now();
  for (const [sessionId, lastAccess] of sessionLastAccess.entries()) {
    if (now - lastAccess > SESSION_TTL_MS) {
      sessions.delete(sessionId);
      sessionLastAccess.delete(sessionId);
    }
  }
}, 60 * 1000); // Check every minute

function getToolDefinitions(): Tool[] {
  // Create dummy client just for tool definitions (no credentials needed)
  const dummyClient = new NewRelicClient('', undefined);

  const nrqlTool = new NrqlTool(dummyClient);
  const apmTool = new ApmTool(dummyClient);
  const entityTool = new EntityTool(dummyClient);
  const alertTool = new AlertTool(dummyClient);
  const syntheticsTool = new SyntheticsTool(dummyClient);
  const nerdGraphTool = new NerdGraphTool(dummyClient);
  const restDeployments = new RestDeploymentsTool();
  const restApm = new RestApmTool();
  const restMetrics = new RestMetricsTool();

  return [
    nrqlTool.getToolDefinition(),
    apmTool.getListApplicationsTool(),
    entityTool.getSearchTool(),
    entityTool.getDetailsTool(),
    alertTool.getPoliciesTool(),
    alertTool.getIncidentsTool(),
    alertTool.getAcknowledgeTool(),
    syntheticsTool.getListMonitorsTool(),
    syntheticsTool.getCreateMonitorTool(),
    nerdGraphTool.getQueryTool(),
    restDeployments.getCreateTool(),
    restDeployments.getListTool(),
    restDeployments.getDeleteTool(),
    restApm.getListApplicationsTool(),
    restMetrics.getListMetricNamesTool(),
    restMetrics.getMetricDataTool(),
    restMetrics.getListApplicationHostsTool(),
    {
      name: 'get_account_details',
      description: 'Get New Relic account details',
      inputSchema: {
        type: 'object' as const,
        properties: {
          target_account_id: {
            type: 'string' as const,
            description: 'Optional account ID to get details for',
          },
        },
      },
    },
  ];
}

function createSessionFromHeaders(req: Request): SessionContext | null {
  const apiKey = req.headers['x-new-relic-api-key'] as string;
  const accountId = req.headers['x-new-relic-account-id'] as string | undefined;
  const region = ((req.headers['x-new-relic-region'] as string) || 'US').toUpperCase() as Region;

  if (!apiKey) {
    return null;
  }

  const client = new NewRelicClient(apiKey, accountId, region);
  return { apiKey, accountId, region, client };
}

async function executeTool(
  name: string,
  args: { target_account_id?: string; account_id?: string; [key: string]: unknown },
  context: SessionContext
): Promise<unknown> {
  const { client } = context;
  const accountId: string | undefined =
    args.target_account_id || args.account_id || context.accountId;

  const requiresAccountId = [
    'run_nrql_query',
    'list_apm_applications',
    'search_entities',
    'get_account_details',
    'list_alert_policies',
    'list_open_incidents',
    'list_synthetics_monitors',
    'create_browser_monitor',
  ];

  if (requiresAccountId.includes(name) && !accountId) {
    throw new Error('Account ID must be provided via header or tool argument');
  }

  switch (name) {
    case 'run_nrql_query':
      return await new NrqlTool(client).execute({
        ...args,
        target_account_id: accountId,
      });
    case 'list_apm_applications':
      return await new ApmTool(client).execute({
        ...args,
        target_account_id: accountId,
      });
    case 'create_deployment':
      return await new RestDeploymentsTool().create(
        args as Parameters<RestDeploymentsTool['create']>[0]
      );
    case 'list_deployments_rest':
      return await new RestDeploymentsTool().list(
        args as Parameters<RestDeploymentsTool['list']>[0]
      );
    case 'delete_deployment':
      return await new RestDeploymentsTool().delete(
        args as Parameters<RestDeploymentsTool['delete']>[0]
      );
    case 'list_apm_applications_rest':
      return await new RestApmTool().listApplications(
        args as Parameters<RestApmTool['listApplications']>[0]
      );
    case 'list_metric_names_for_host':
      return await new RestMetricsTool().listMetricNames(
        args as Parameters<RestMetricsTool['listMetricNames']>[0]
      );
    case 'get_metric_data_for_host':
      return await new RestMetricsTool().getMetricData(
        args as Parameters<RestMetricsTool['getMetricData']>[0]
      );
    case 'list_application_hosts':
      return await new RestMetricsTool().listApplicationHosts(
        args as Parameters<RestMetricsTool['listApplicationHosts']>[0]
      );
    case 'get_account_details':
      return await client.getAccountDetails(accountId);
    case 'list_alert_policies':
      return await new AlertTool(client).listAlertPolicies({
        ...args,
        target_account_id: accountId,
      });
    case 'list_open_incidents':
      return await new AlertTool(client).listOpenIncidents({
        ...args,
        target_account_id: accountId,
      });
    case 'acknowledge_incident': {
      const { incident_id, comment } = args as Record<string, unknown>;
      if (typeof incident_id !== 'string' || incident_id.trim() === '') {
        throw new Error('acknowledge_incident: "incident_id" (non-empty string) is required');
      }
      if (comment !== undefined && typeof comment !== 'string') {
        throw new Error('acknowledge_incident: "comment" must be a string when provided');
      }
      return await new AlertTool(client).acknowledgeIncident({
        incident_id,
        comment: comment as string | undefined,
      });
    }
    case 'search_entities': {
      const { query, entity_types } = args as Record<string, unknown>;
      if (typeof query !== 'string' || query.trim() === '') {
        throw new Error('search_entities: "query" (non-empty string) is required');
      }
      let types: string[] | undefined;
      if (entity_types !== undefined) {
        if (!Array.isArray(entity_types)) {
          throw new Error('search_entities: "entity_types" must be an array of strings');
        }
        types = (entity_types as unknown[]).filter((t): t is string => typeof t === 'string');
      }
      return await new EntityTool(client).searchEntities({
        query,
        entity_types: types,
        target_account_id: accountId,
      });
    }
    case 'get_entity_details': {
      const { entity_guid } = args as Record<string, unknown>;
      if (typeof entity_guid !== 'string' || entity_guid.trim() === '') {
        throw new Error('get_entity_details: "entity_guid" (non-empty string) is required');
      }
      return await new EntityTool(client).getEntityDetails({ entity_guid });
    }
    case 'list_synthetics_monitors':
      return await new SyntheticsTool(client).listSyntheticsMonitors({
        ...args,
        target_account_id: accountId,
      });
    case 'create_browser_monitor': {
      const { name: monitorName, url, frequency, locations } = args as Record<string, unknown>;
      if (typeof monitorName !== 'string' || monitorName.trim() === '') {
        throw new Error('create_browser_monitor: "name" (non-empty string) is required');
      }
      if (typeof url !== 'string' || url.trim() === '') {
        throw new Error('create_browser_monitor: "url" (non-empty string) is required');
      }
      if (typeof frequency !== 'number' || !Number.isFinite(frequency) || frequency <= 0) {
        throw new Error('create_browser_monitor: "frequency" (positive number) is required');
      }
      if (
        !Array.isArray(locations) ||
        (locations as unknown[]).some((l) => typeof l !== 'string')
      ) {
        throw new Error('create_browser_monitor: "locations" must be an array of strings');
      }
      return await new SyntheticsTool(client).createBrowserMonitor({
        name: monitorName,
        url,
        frequency,
        locations: locations as string[],
        target_account_id: accountId,
      });
    }
    case 'run_nerdgraph_query':
      return await new NerdGraphTool(client).execute(args);
    default:
      throw new Error(`Tool ${name} not found`);
  }
}

function createMcpServer(getSessionContext: () => SessionContext | null): Server {
  const server = new Server(
    {
      name: 'newrelic-mcp',
      version: '2.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  const tools = new Map<string, Tool>();
  for (const tool of getToolDefinitions()) {
    tools.set(tool.name, tool);
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Array.from(tools.values()),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.get(request.params.name);

    if (!tool) {
      throw new McpError(ErrorCode.MethodNotFound, `Tool ${request.params.name} not found`);
    }

    const context = getSessionContext();
    if (!context) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        'Missing New Relic credentials. Provide X-New-Relic-Api-Key header.'
      );
    }

    try {
      const result = await executeTool(
        request.params.name,
        request.params.arguments || {},
        context
      );

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Tool execution failed';
      throw new McpError(ErrorCode.InternalError, message);
    }
  });

  return server;
}

async function main(): Promise<void> {
  const app = express();
  const port = process.env.PORT || 8000;

  app.use(cors());
  app.use(express.json());

  // Health check endpoint for Aptible
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'healthy', service: 'newrelic-mcp' });
  });

  // Root endpoint with service info
  app.get('/', (_req: Request, res: Response) => {
    res.json({
      name: 'newrelic-mcp',
      version: '2.0.0',
      description: 'MCP server for New Relic observability platform integration',
      endpoints: {
        health: '/health',
        mcp: '/mcp (POST)',
      },
      headers: {
        required: ['X-New-Relic-Api-Key'],
        optional: ['X-New-Relic-Account-Id', 'X-New-Relic-Region'],
      },
    });
  });

  // Transport store for session management
  const transports = new Map<string, StreamableHTTPServerTransport>();

  // MCP endpoint
  app.post('/mcp', async (req: Request, res: Response) => {
    const sessionId = (req.headers['mcp-session-id'] as string) || randomUUID();
    let transport = transports.get(sessionId);

    // Create session context from headers
    const sessionContext = createSessionFromHeaders(req);

    if (!transport) {
      // Create new transport and server for this session
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => sessionId,
        onsessioninitialized: (id) => {
          console.log(`Session initialized: ${id}`);
        },
      });

      const server = createMcpServer(() => {
        // Update last access time
        sessionLastAccess.set(sessionId, Date.now());
        // Store/update session context
        if (sessionContext) {
          sessions.set(sessionId, sessionContext);
        }
        return sessions.get(sessionId) || sessionContext;
      });

      await server.connect(transport);
      transports.set(sessionId, transport);
    }

    // Update session context if credentials provided
    if (sessionContext) {
      sessions.set(sessionId, sessionContext);
      sessionLastAccess.set(sessionId, Date.now());
    }

    // Handle the request
    await transport.handleRequest(req, res, req.body);
  });

  // Handle GET requests for SSE streams
  app.get('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string;
    const transport = transports.get(sessionId);

    if (!transport) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    await transport.handleRequest(req, res);
  });

  // Handle DELETE for session cleanup
  app.delete('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string;
    const transport = transports.get(sessionId);

    if (transport) {
      await transport.close();
      transports.delete(sessionId);
      sessions.delete(sessionId);
      sessionLastAccess.delete(sessionId);
    }

    res.status(204).send();
  });

  app.listen(port, () => {
    console.log(`New Relic MCP HTTP Server running on port ${port}`);
    console.log(`Health check: http://localhost:${port}/health`);
    console.log(`MCP endpoint: http://localhost:${port}/mcp`);
  });
}

main().catch(console.error);
