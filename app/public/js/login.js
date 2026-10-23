const form = document.querySelector('#login-form');
const message = document.querySelector('#login-message');
form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  message.className = 'form-message';
  message.textContent = 'Signing in…';
  try {
    const response = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: form.username.value, password: form.password.value }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to sign in.');
    location.assign(data.redirect);
  } catch (error) {
    message.className = 'form-message error';
    message.textContent = error.message || 'Unable to sign in.';
  } finally { button.disabled = false; }
});
