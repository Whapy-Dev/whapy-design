const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const SCREENSHOTS_DIR = path.join(__dirname, '..', 'data', 'screenshots');
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
        '--system-prompt', SYSTEM_PROMPT,
        '--max-turns', '25',
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

        // Extract screenshots
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
