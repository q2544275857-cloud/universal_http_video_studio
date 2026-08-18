const response = await fetch('http://127.0.0.1:4174/api/cookies/import', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: 'vault-smoke',
    content: 'sessionid=STAGE2_FAKE_SECRET; csrftoken=STAGE2_FAKE_CSRF'
  })
});
const data = await response.json();
if (!response.ok || !data.ok) throw new Error(JSON.stringify(data));
const state = await fetch('http://127.0.0.1:4174/api/state').then(res => res.json());
const cookie = state.cookies.find(item => item.id === data.cookie.id);
if (!cookie || cookie.cookie_count !== 2 || 'encrypted_secret' in cookie) throw new Error('Cookie public projection failed.');
console.log(JSON.stringify({ ok: true, cookie }, null, 2));
