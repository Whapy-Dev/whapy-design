const express = require('express');
const session = require('express-session');
const path = require('path');
const { authenticate, requireAuth } = require('./lib/auth');
const claudeAgent = require('./lib/claude-agent');

const app = express();
const PORT = process.env.PORT || 3030;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'whapy-design-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, // Set true behind HTTPS proxy
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Request logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth Routes ──

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  const user = authenticate(email, password);
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  req.session.user = user;
  res.json({ success: true, user: { name: user.name, email: user.email } });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/me', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.json({ user: req.session.user });
});

// ── Chat Routes ──

// Start a chat job (returns immediately with jobId)
app.post('/api/chat', requireAuth, (req, res) => {
  const { message } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Message is required' });
  }

  const sessionId = req.session.id;
  const jobId = claudeAgent.startJob(sessionId, message);
  res.json({ jobId });
});

// Poll for job result
app.get('/api/chat/status/:jobId', requireAuth, (req, res) => {
  const job = claudeAgent.getJobStatus(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  res.json(job);
});

app.post('/api/chat/clear', requireAuth, (req, res) => {
  claudeAgent.clearConversation(req.session.id);
  res.json({ success: true });
});

// ── Screenshot Route ──

app.get('/api/screenshot/:filename', requireAuth, (req, res) => {
  const filename = path.basename(req.params.filename); // prevent path traversal
  const filepath = path.join(__dirname, 'data', 'screenshots', filename);
  res.sendFile(filepath, err => {
    if (err) res.status(404).json({ error: 'Screenshot not found' });
  });
});

// ── SPA Fallback ──

app.get('/chat', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ──

async function start() {
  try {
    await claudeAgent.initialize();
    console.log('[Server] Claude agent initialized with Pencil MCP');
  } catch (err) {
    console.warn('[Server] Claude CLI not available:', err.message);
    console.warn('[Server] Starting anyway (claude CLI needed for chat to work)');
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] Whapy Design Studio running on http://0.0.0.0:${PORT}`);
  });
}

start();
