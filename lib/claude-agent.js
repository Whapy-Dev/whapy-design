const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const SCREENSHOTS_DIR = path.join(__dirname, '..', 'data', 'screenshots');

// Run claude inside the pencil-viewer container where Pencil MCP is configured
const DOCKER_CONTAINER = process.env.PENCIL_CONTAINER || 'pencil-viewer';

const SYSTEM_PROMPT = `You are Whapy Design Studio's AI design assistant. You help users create beautiful designs using the Pencil design tools available to you.

When a user describes what they want to design:
1. First, get the design guidelines relevant to their request using get_guidelines
2. Get style guide tags and then a style guide for inspiration
3. Open a new document using open_document with "new"
4. Use batch_design to create the design elements
5. Take a screenshot of the result using get_screenshot to show the user

Always respond in the same language the user writes in.
Be creative and produce high-quality, professional designs.
After creating a design, always take a screenshot to show the result.
When you return the screenshot, include the base64 image data in your response wrapped in <screenshot> tags like: <screenshot>BASE64_DATA</screenshot>`;

class ClaudeAgent {
  constructor() {
    this.conversations = new Map();
  }

  async initialize() {
    // Verify claude CLI is available inside the container
    return new Promise((resolve, reject) => {
      const proc = spawn('docker', [
        'exec', DOCKER_CONTAINER, 'claude', '--version'
      ], { stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      proc.stdout.on('data', d => output += d);
      proc.stderr.on('data', d => output += d);
      proc.on('close', code => {
        if (code === 0) {
          console.log(`[Agent] Claude CLI in container: ${output.trim()}`);
          resolve();
        } else {
          reject(new Error(`Claude CLI not found in container ${DOCKER_CONTAINER}`));
        }
      });
      proc.on('error', () => reject(new Error('Docker not found')));
    });
  }

  async chat(sessionId, userMessage) {
    if (!this.conversations.has(sessionId)) {
      this.conversations.set(sessionId, []);
    }
    const history = this.conversations.get(sessionId);
    history.push({ role: 'user', content: userMessage });

    let fullPrompt = userMessage;
    if (history.length > 2) {
      const contextMessages = history.slice(-10);
      fullPrompt = contextMessages
        .map(m => `${m.role === 'user' ? 'Usuario' : 'Asistente'}: ${m.content}`)
        .join('\n\n') + '\n\nResponde al último mensaje del usuario.';
    }

    return new Promise((resolve, reject) => {
      const results = [];
      let output = '';
      let errorOutput = '';

      // Run claude inside the pencil-viewer container
      const proc = spawn('docker', [
        'exec', DOCKER_CONTAINER,
        'claude', '--print',
        '--system-prompt', SYSTEM_PROMPT,
        '--max-turns', '25',
        fullPrompt
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 300000
      });

      proc.stdout.on('data', (data) => {
        output += data.toString();
      });

      proc.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      proc.on('close', (code) => {
        if (code !== 0 && !output) {
          console.error('[Agent] Claude CLI error:', errorOutput);
          reject(new Error('Failed to generate design. Please try again.'));
          return;
        }

        // Extract screenshots from output (base64 image data)
        const screenshotRegex = /<screenshot>([\s\S]*?)<\/screenshot>/g;
        let match;
        let textOutput = output;

        while ((match = screenshotRegex.exec(output)) !== null) {
          const base64Data = match[1].trim();
          const screenshotId = uuidv4();
          const filename = `${screenshotId}.png`;
          const filepath = path.join(SCREENSHOTS_DIR, filename);

          try {
            fs.writeFileSync(filepath, Buffer.from(base64Data, 'base64'));
            results.push({
              type: 'screenshot',
              id: screenshotId,
              filename,
              url: `/api/screenshot/${filename}`
            });
          } catch (err) {
            console.error('[Agent] Failed to save screenshot:', err.message);
          }

          textOutput = textOutput.replace(match[0], '');
        }

        textOutput = textOutput.trim();
        if (textOutput) {
          results.push({ type: 'text', content: textOutput });
          history.push({ role: 'assistant', content: textOutput });
        }

        resolve(results);
      });

      proc.on('error', (err) => {
        reject(new Error(`Docker exec error: ${err.message}`));
      });
    });
  }

  clearConversation(sessionId) {
    this.conversations.delete(sessionId);
  }
}

module.exports = new ClaudeAgent();
