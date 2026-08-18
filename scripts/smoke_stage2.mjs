const base = 'http://127.0.0.1:4174';

async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }
  });
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  if (!response.ok) throw new Error(`${path} HTTP ${response.status}: ${text.slice(0, 500)}`);
  return data;
}

const folderPath = process.argv[2] || 'D:/seedance 2.0/3C/02_知识库/产品库/image to video/Back of product';
const scan = await request('/api/assets/scan', {
  method: 'POST',
  body: JSON.stringify({ folderPath, force: true })
});
if (!scan.count) throw new Error('No assets scanned.');

let state = await request('/api/state');
if (!state.assets.length || !state.cards.length) throw new Error('State did not return assets/cards.');
const card = state.cards[0];
const asset = state.assets[0];
await request(`/api/cards/${card.id}`, {
  method: 'PATCH',
  body: JSON.stringify({
    assetIds: [asset.id],
    prompt: `使用 @${asset.alias} 作为外观参考，生成真实产品展示视频。`,
    duration: 15,
    filename: 'stage2_smoke_test',
    retryLimit: 0
  })
});
state = await request('/api/state');
const validation = state.validation.find(item => item.id === card.id);
if (!validation?.valid) throw new Error(`Card validation failed: ${JSON.stringify(validation)}`);
console.log(JSON.stringify({ ok: true, assetCount: state.assets.length, cardId: card.id, assetAlias: asset.alias, validation }, null, 2));
