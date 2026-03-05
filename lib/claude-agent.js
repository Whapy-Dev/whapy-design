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
    this.jobs = new Map(); // jobId -> { status, results, error }
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

  // Start a job asynchronously, return jobId immediately
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

    // Run in background
    this._runClaude(jobId, fullPrompt, history);

    return jobId;
  }

  async _runClaude(jobId, fullPrompt, history) {
    try {
      let output = '';
      let errorOutput = '';

      const proc = spawn('docker', [
        'exec', DOCKER_CONTAINER,
        'claude', '--print',
        '--output-format', 'json',
        '--system-prompt', SYSTEM_PROMPT,
        '--max-turns', '50',
        fullPrompt
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 600000 // 10 min
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

        try {
          // Parse JSON output from claude --output-format json
          const jsonData = JSON.parse(output);

          // jsonData can be a single message or array
          const messages = Array.isArray(jsonData) ? jsonData : [jsonData];

          for (const msg of messages) {
            // Handle text content
            if (msg.type === 'text' && msg.text) {
              results.push({ type: 'text', content: msg.text });
            }

            // Handle result blocks that contain tool results with images
            if (msg.type === 'result') {
              // The result text
              if (msg.result) {
                results.push({ type: 'text', content: msg.result });
              }
            }

            // Handle content array (messages API format)
            if (msg.content && Array.isArray(msg.content)) {
              for (const block of msg.content) {
                if (block.type === 'text' && block.text) {
                  results.push({ type: 'text', content: block.text });
                }
                if (block.type === 'image') {
                  const screenshotId = uuidv4();
                  const filename = `${screenshotId}.png`;
                  const filepath = path.join(SCREENSHOTS_DIR, filename);
                  const imgData = block.source?.data || block.data;
                  if (imgData) {
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
          }
        } catch (parseErr) {
          // If not valid JSON, treat as plain text
          console.log('[Agent] Output is not JSON, treating as text');
          if (output.trim()) {
            results.push({ type: 'text', content: output.trim() });
          }
        }

        if (results.length > 0) {
          const textResults = results.filter(r => r.type === 'text').map(r => r.content).join(' ');
          if (textResults) {
            history.push({ role: 'assistant', content: textResults });
          }
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

    // Clean up completed jobs after retrieval
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
