const Anthropic = require('@anthropic-ai/sdk');
const pencilClient = require('./pencil-client');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const SCREENSHOTS_DIR = path.join(__dirname, '..', 'data', 'screenshots');

const SYSTEM_PROMPT = `You are Whapy Design Studio's AI design assistant. You help users create beautiful designs by using the Pencil design tools available to you.

When a user describes what they want to design:
1. First, get the design guidelines relevant to their request using get_guidelines
2. Open a new document or work with an existing one
3. Use batch_design to create the design elements
4. Take a screenshot of the result using get_screenshot to show the user

Always respond in the same language the user writes in.
Be creative and produce high-quality, professional designs.
After creating a design, always take a screenshot to show the result.`;

class ClaudeAgent {
  constructor() {
    this.anthropic = new Anthropic();
    this.conversations = new Map(); // sessionId -> messages[]
  }

  async initialize() {
    await pencilClient.connect();
  }

  _getTools() {
    const pencilTools = pencilClient.getToolDefinitions();
    return pencilTools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema || { type: 'object', properties: {} }
    }));
  }

  async chat(sessionId, userMessage) {
    if (!this.conversations.has(sessionId)) {
      this.conversations.set(sessionId, []);
    }

    const messages = this.conversations.get(sessionId);
    messages.push({ role: 'user', content: userMessage });

    const tools = this._getTools();
    const results = [];
    let continueLoop = true;

    while (continueLoop) {
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8096,
        system: SYSTEM_PROMPT,
        tools,
        messages
      });

      // Collect assistant message
      messages.push({ role: 'assistant', content: response.content });

      // Process content blocks
      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
      const textBlocks = response.content.filter(b => b.type === 'text');

      for (const block of textBlocks) {
        results.push({ type: 'text', content: block.text });
      }

      if (response.stop_reason === 'tool_use' && toolUseBlocks.length > 0) {
        // Execute tool calls
        const toolResults = [];

        for (const toolUse of toolUseBlocks) {
          console.log(`[Agent] Calling tool: ${toolUse.name}`);
          try {
            const toolResult = await pencilClient.callTool(toolUse.name, toolUse.input);

            // Check if result contains image data (screenshots)
            let resultContent = toolResult.content || [];
            let screenshotId = null;

            for (const item of resultContent) {
              if (item.type === 'image') {
                // Save screenshot
                screenshotId = uuidv4();
                const ext = item.mimeType?.includes('png') ? 'png' : 'jpg';
                const filename = `${screenshotId}.${ext}`;
                const filepath = path.join(SCREENSHOTS_DIR, filename);
                const imageBuffer = Buffer.from(item.data, 'base64');
                fs.writeFileSync(filepath, imageBuffer);

                results.push({
                  type: 'screenshot',
                  id: screenshotId,
                  filename,
                  url: `/api/screenshot/${screenshotId}.${ext}`
                });
              }
            }

            // Build tool result for Claude
            const textContent = resultContent
              .filter(i => i.type === 'text')
              .map(i => i.text)
              .join('\n');

            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: screenshotId
                ? `Screenshot saved as ${screenshotId}. ${textContent}`
                : (textContent || JSON.stringify(toolResult))
            });
          } catch (err) {
            console.error(`[Agent] Tool error:`, err.message);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: `Error: ${err.message}`,
              is_error: true
            });
          }
        }

        messages.push({ role: 'user', content: toolResults });
      } else {
        continueLoop = false;
      }
    }

    return results;
  }

  clearConversation(sessionId) {
    this.conversations.delete(sessionId);
  }
}

module.exports = new ClaudeAgent();
