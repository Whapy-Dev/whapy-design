const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const SCREENSHOTS_DIR = path.join(__dirname, '..', 'data', 'screenshots');
const DOCKER_CONTAINER = process.env.PENCIL_CONTAINER || 'pencil-viewer';

const SYSTEM_PROMPT = `You are Whapy Design Studio's AI design assistant. Create designs using the Pencil tools.

Steps:
1. Open a new document with open_document("new")
2. Use get_guidelines for the relevant topic
3. Use batch_design to create elements (be efficient, use maximum operations per call)
4. Use get_screenshot to capture the result

Respond in the user's language. Be concise. Focus on creating the design, not explaining steps.`;

class ClaudeAgent {
  constructor() {
    this.conversations = new Map();
    this.jobs = new Map();
  }

  async initialize() {
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

  startJob(sessionId, userMessage) {
    const jobId = uuidv4();

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

    this.jobs.set(jobId, { status: 'processing', results: null, error: null });
    this._runClaude(jobId, fullPrompt, history);
    return jobId;
  }

  async _runClaude(jobId, fullPrompt, history) {
    try {
      let output = '';
      let errorOutput = '';

      // Use stream-json to capture tool results including images
      const proc = spawn('docker', [
        'exec', DOCKER_CONTAINER,
        'claude', '--print',
        '--output-format', 'stream-json',
        '--system-prompt', SYSTEM_PROMPT,
        '--max-turns', '50',
        fullPrompt
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 600000
      });

      proc.stdout.on('data', (data) => {
        output += data.toString();
      });

      proc.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      proc.on('close', (code) => {
        const results = [];

        if (code !== 0 && !output) {
          console.error('[Agent] Claude CLI error:', errorOutput);
          this.jobs.set(jobId, {
            status: 'error',
            results: null,
            error: 'Failed to generate design. Please try again.'
          });
          return;
        }

        // Parse stream-json: each line is a separate JSON object
        const lines = output.split('\n').filter(l => l.trim());
        let finalText = '';

        for (const line of lines) {
          try {
            const msg = JSON.parse(line);

            // Final result message
            if (msg.type === 'result') {
              if (msg.result) {
                finalText = msg.result;
              }
            }

            // Assistant message with content blocks
            if (msg.type === 'assistant' && msg.message?.content) {
              for (const block of msg.message.content) {
                if (block.type === 'image') {
                  const imgData = block.source?.data || block.data;
                  if (imgData) {
                    const screenshotId = uuidv4();
                    const filename = `${screenshotId}.png`;
                    const filepath = path.join(SCREENSHOTS_DIR, filename);
                    fs.writeFileSync(filepath, Buffer.from(imgData, 'base64'));
                    results.push({
                      type: 'screenshot',
                      id: screenshotId,
                      filename,
                      url: `/api/screenshot/${filename}`
                    });
                  }
                }
              }
            }

            // Tool result that might contain images
            if (msg.type === 'tool_result' || msg.type === 'tool_use_result') {
              const content = msg.content || msg.result?.content || [];
              const contentArr = Array.isArray(content) ? content : [content];
              for (const item of contentArr) {
                if (item && item.type === 'image') {
                  const imgData = item.source?.data || item.data;
                  if (imgData) {
                    const screenshotId = uuidv4();
                    const filename = `${screenshotId}.png`;
                    const filepath = path.join(SCREENSHOTS_DIR, filename);
                    fs.writeFileSync(filepath, Buffer.from(imgData, 'base64'));
                    results.push({
                      type: 'screenshot',
                      id: screenshotId,
                      filename,
                      url: `/api/screenshot/${filename}`
                    });
                  }
                }
              }
            }
          } catch (parseErr) {
            // Skip non-JSON lines
          }
        }

        // Add the final text
        if (finalText) {
          results.push({ type: 'text', content: finalText });
          history.push({ role: 'assistant', content: finalText });
        }

        this.jobs.set(jobId, { status: 'done', results, error: null });
        console.log(`[Agent] Job ${jobId} completed with ${results.length} results`);
      });

      proc.on('error', (err) => {
        this.jobs.set(jobId, {
          status: 'error',
          results: null,
          error: `Docker exec error: ${err.message}`
        });
      });
    } catch (err) {
      this.jobs.set(jobId, {
        status: 'error',
        results: null,
        error: err.message
      });
    }
  }

  getJobStatus(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return null;

    if (job.status === 'done' || job.status === 'error') {
      this.jobs.delete(jobId);
    }

    return job;
  }

  clearConversation(sessionId) {
    this.conversations.delete(sessionId);
  }
}

module.exports = new ClaudeAgent();
