// ── State ──
let sending = false;

// ── DOM refs ──
const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');
const typingIndicator = document.getElementById('typingIndicator');
const welcomeSection = document.getElementById('welcomeSection');
const statusText = document.getElementById('statusText');

// ── Check auth ──
fetch('/api/me').then(r => {
  if (!r.ok) window.location.href = '/';
});

// ── Auto-resize textarea ──
chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
});

// ── Enter to send ──
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// ── Send suggestion ──
function sendSuggestion(el) {
  chatInput.value = el.textContent;
  sendMessage();
}

// ── Send message ──
async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text || sending) return;

  sending = true;
  sendBtn.disabled = true;
  chatInput.value = '';
  chatInput.style.height = 'auto';

  if (welcomeSection) {
    welcomeSection.style.display = 'none';
  }

  addMessage(text, 'out');
  showTyping(true);
  statusText.textContent = 'Diseñando...';

  try {
    // Start the job
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text })
    });

    if (res.status === 401) {
      window.location.href = '/';
      return;
    }

    const data = await res.json();

    if (data.error) {
      addMessage(data.error, 'in');
      showTyping(false);
      statusText.textContent = 'Online';
      sending = false;
      sendBtn.disabled = false;
      return;
    }

    // Poll for result
    const jobId = data.jobId;
    pollJob(jobId);

  } catch (err) {
    addMessage('Error de conexión. Intenta de nuevo.', 'in');
    showTyping(false);
    statusText.textContent = 'Online';
    sending = false;
    sendBtn.disabled = false;
  }
}

// ── Poll for job completion ──
async function pollJob(jobId) {
  const POLL_INTERVAL = 3000; // 3 seconds
  const MAX_POLLS = 200; // 10 minutes max
  let polls = 0;

  const poll = async () => {
    polls++;
    if (polls > MAX_POLLS) {
      addMessage('La generación tardó demasiado. Intenta con algo más simple.', 'in');
      finishSending();
      return;
    }

    try {
      const res = await fetch(`/api/chat/status/${jobId}`);

      if (res.status === 401) {
        window.location.href = '/';
        return;
      }

      const job = await res.json();

      if (job.status === 'processing') {
        // Update status with elapsed time
        const elapsed = Math.floor(polls * POLL_INTERVAL / 1000);
        statusText.textContent = `Diseñando... (${elapsed}s)`;
        setTimeout(poll, POLL_INTERVAL);
        return;
      }

      if (job.status === 'error') {
        addMessage(job.error || 'Error al generar el diseño.', 'in');
        finishSending();
        return;
      }

      if (job.status === 'done' && job.results) {
        for (const result of job.results) {
          if (result.type === 'text' && result.content) {
            addMessage(result.content, 'in');
          } else if (result.type === 'screenshot') {
            addScreenshot(result.url, result.id);
          }
        }
        finishSending();
      }
    } catch (err) {
      // Network error, retry
      setTimeout(poll, POLL_INTERVAL);
    }
  };

  poll();
}

function finishSending() {
  showTyping(false);
  statusText.textContent = 'Online';
  sending = false;
  sendBtn.disabled = false;
  chatInput.focus();
}

// ── Add message bubble ──
function addMessage(text, direction) {
  const div = document.createElement('div');
  div.className = `message message-${direction}`;

  const content = document.createElement('div');
  content.textContent = text;
  div.appendChild(content);

  const time = document.createElement('div');
  time.className = 'message-time';
  time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  div.appendChild(time);

  chatMessages.insertBefore(div, typingIndicator);
  scrollToBottom();
}

// ── Add screenshot ──
function addScreenshot(url, id) {
  const div = document.createElement('div');
  div.className = 'message message-in';

  const screenshotDiv = document.createElement('div');
  screenshotDiv.className = 'message-screenshot';

  const img = document.createElement('img');
  img.src = url;
  img.alt = 'Design screenshot';
  img.loading = 'lazy';
  img.onclick = () => openLightbox(url);
  screenshotDiv.appendChild(img);

  const actions = document.createElement('div');
  actions.className = 'screenshot-actions';

  const downloadBtn = document.createElement('button');
  downloadBtn.className = 'btn-small';
  downloadBtn.textContent = 'Descargar';
  downloadBtn.onclick = () => downloadScreenshot(url);
  actions.appendChild(downloadBtn);

  div.appendChild(screenshotDiv);
  div.appendChild(actions);

  const time = document.createElement('div');
  time.className = 'message-time';
  time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  div.appendChild(time);

  chatMessages.insertBefore(div, typingIndicator);
  scrollToBottom();
}

// ── Typing indicator ──
function showTyping(show) {
  typingIndicator.classList.toggle('active', show);
  if (show) scrollToBottom();
}

// ── Scroll ──
function scrollToBottom() {
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ── Lightbox ──
function openLightbox(url) {
  document.getElementById('lightboxImg').src = url;
  document.getElementById('lightbox').classList.add('active');
}

function closeLightbox() {
  document.getElementById('lightbox').classList.remove('active');
}

// ── Download ──
function downloadScreenshot(url) {
  const a = document.createElement('a');
  a.href = url;
  a.download = 'whapy-design.png';
  a.click();
}

// ── Clear chat ──
async function clearChat() {
  try {
    await fetch('/api/chat/clear', { method: 'POST' });
  } catch (_) {}
  const messages = chatMessages.querySelectorAll('.message');
  messages.forEach(m => m.remove());
  if (welcomeSection) {
    welcomeSection.style.display = '';
  }
}

// ── Logout ──
async function logout() {
  try {
    await fetch('/api/logout', { method: 'POST' });
  } catch (_) {}
  window.location.href = '/';
}
