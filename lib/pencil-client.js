const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const path = require('path');
const fs = require('fs');

class PencilClient {
  constructor() {
    this.client = null;
    this.connected = false;
    this.availableTools = [];
  }

  async connect() {
    if (this.connected) return;

    const pencilPath = process.env.PENCIL_MCP_PATH || 'pencil-mcp';

    const transport = new StdioClientTransport({
      command: pencilPath,
      args: [],
      env: { ...process.env }
    });

    this.client = new Client({
      name: 'whapy-design-studio',
      version: '1.0.0'
    });

    await this.client.connect(transport);
    this.connected = true;

    // Discover available tools
    const { tools } = await this.client.listTools();
    this.availableTools = tools;
    console.log(`[PencilClient] Connected. ${tools.length} tools available.`);
  }

  async callTool(name, args) {
    if (!this.connected) {
      await this.connect();
    }

    try {
      const result = await this.client.callTool({ name, arguments: args });
      return result;
    } catch (err) {
      console.error(`[PencilClient] Error calling ${name}:`, err.message);
      throw err;
    }
  }

  getToolDefinitions() {
    return this.availableTools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema
    }));
  }

  async disconnect() {
    if (this.client) {
      await this.client.close();
      this.connected = false;
    }
  }
}

module.exports = new PencilClient();
