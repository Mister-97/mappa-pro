// ═══════════════════════════════════════
// FLOWDESK AUTH + OAUTH WIRING
// ═══════════════════════════════════════

const API = '';

function getToken() { return localStorage.getItem('fd_token'); }
function setToken(t) { localStorage.setItem('fd_token', t); }
function clearToken() { localStorage.removeItem('fd_token'); }

async function apiFetch(path, opts = {}) {
  const token = getToken();
  const res = await fetch(API + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(opts.headers || {})
    }
  });
  if (res.status === 401) { clearToken(); showLoginModal(); throw new Error('Unauthenticated'); }
  return res.json();
}

async function startOAuth() {
  if (!getToken()) { showLoginModal(); return; }
  const label = (document.getElementById('connectLabel')?.value || '').trim() || 'Unnamed Model';
  closeModal('connectModal');
  toast('Redirecting to Fanvue OAuth…');
  try {
    const data = await apiFetch('/api/oauth/connect?label=' + encodeURIComponent(label));
    if (data.authUrl) window.location.href = data.authUrl;
    else toast('Error: ' + (data.error || 'Could not start OAuth'));
  } catch(e) { if (e.message !== 'Unauthenticated') toast('Error: ' + e.message); }
}

function showLoginModal() { document.getElementById('loginModal').classList.add('open'); }
function hideLoginModal() { document.getElementById('loginModal').classList.remove('open'); }

async function doLogin() {
  const email = document.getElementById('loginEmail').value.trim();
  const pass  = document.getElementById('loginPass').value;
  const btn   = document.getElementById('loginBtn');
  const err   = document.getElementById('loginErr');
  if (!email || !pass) { err.textContent = 'Email and password required'; return; }
  btn.disabled = true; btn.textContent = 'Signing in…';
  err.textContent = '';
  try {
    const data = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: pass })
    }).then(r => r.json());
    if (data.token) { setToken(data.token); hideLoginModal(); toast('Signed in ✓'); }
    else { err.textContent = data.error || 'Login failed'; }
  } catch(e) { err.textContent = 'Network error'; }
  btn.disabled = false; btn.textContent = 'Sign in';
}

// Handle OAuth callback params on page load
(function handleOAuthCallback() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('oauth_success')) {
    const account = params.get('account') || 'account';
    toast('✅ Connected @' + account + ' successfully!');
    history.replaceState({}, '', window.location.pathname);
  } else if (params.get('oauth_error')) {
    toast('❌ OAuth error: ' + params.get('oauth_error'));
    history.replaceState({}, '', window.location.pathname);
  }
})();
