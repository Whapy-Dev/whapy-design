const fs = require('fs');
const path = require('path');

const USERS_FILE = path.join(__dirname, '..', 'data', 'users.json');

function loadUsers() {
  const data = fs.readFileSync(USERS_FILE, 'utf8');
  return JSON.parse(data);
}

function authenticate(email, password) {
  const users = loadUsers();
  const user = users.find(u => u.email === email && u.password === password);
  if (!user) return null;
  return { id: user.id, email: user.email, name: user.name };
}

function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

module.exports = { authenticate, requireAuth };
