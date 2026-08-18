import { applyPromptMention, promptMentionContext } from './promptMentions.js';

const state = {
  app: null,
  settings: {},
  provider: {},
  folder: null,
  cookies: [],
  assets: [],
  referenceMedia: [],
  cards: [],
  tasks: [],
  results: [],
  promptHistory: [],
  lifecycle: { running: false, cycleRunning: false, counts: [] },
  monitorTab: 'tasks',
  assetLibraryTab: 'image',
  mediaDialogTab: 'video',
  activePickerCardId: null,
  activeMediaPickerCardId: null,
  activeMediaSegment: null,
  mediaPickerSelection: new Set(),
  activePromptEditorCardId: null,
  activeTaskPromptId: null,
  pickerSelection: new Set(),
  saveTimers: new Map(),
  referenceLibraryRenderKeys: { video: '', audio: '' },
  loadingState: false
};

const MEDIA_LIBRARY_RENDER_LIMIT = 60;

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
const DELETABLE_TASK_STATUSES = new Set(['completed', 'submit_failed', 'remote_failed', 'download_failed']);

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    const error = new Error(data.error || data.message || `HTTP ${response.status}`);
    error.status = response.status;
    error.code = data.code;
    error.details = data.details;
    throw error;
  }
  return data;
}

function toast(message, timeout = 3200) {
  const node = $('toast');
  node.textContent = message;
  node.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.add('hidden'), timeout);
}

function showError(error) {
  const banner = $('errorBanner');
  const detail = Array.isArray(error?.details)
    ? `\n${error.details.map(item => `${item.title || item.id}: ${(item.errors || []).join('；')}`).join('\n')}`
    : '';
  banner.textContent = `${error.message || error}${detail}`;
  banner.classList.remove('hidden');
}

function clearError() {
  $('errorBanner').classList.add('hidden');
  $('errorBanner').textContent = '';
}

function assetById(id) {
  return state.assets.find(asset => asset.id === id);
}

function referenceMediaById(id) {
  return state.referenceMedia.find(media => media.id === id);
}

function formatMediaDuration(seconds) {
  const value = Math.max(0, Number(seconds || 0));
  const minutes = Math.floor(value / 60);
  const remain = value - minutes * 60;
  return minutes ? `${minutes}:${remain.toFixed(1).padStart(4, '0')}` : `${value.toFixed(1)}s`;
}

function detectPromptDuration(prompt) {
  const value = String(prompt || '');
  for (const pattern of [
    /生成一段(?:独立的)?\s*(\d{1,2})\s*秒/i,
    /(?:目标|视频时长|时长)\s*(?:为|[:：])?\s*(\d{1,2})\s*秒/i
  ]) {
    const duration = Number(value.match(pattern)?.[1] || 0);
    if (Number.isInteger(duration) && duration >= 4 && duration <= 15) return duration;
  }
  return null;
}

function splitBulkPromptsForPreview(input) {
  const raw = String(input || '').replace(/\r\n/g, '\n').trim();
  if (!raw) return [];
  const splitPlain = value => {
    const text = String(value || '').trim();
    const starts = [];
    const pattern = /^\s*(?=生成一段(?:独立的)?\s*\d{1,2}\s*秒)/gmi;
    let match;
    while ((match = pattern.exec(text))) {
      starts.push(match.index);
      pattern.lastIndex = Math.max(pattern.lastIndex, match.index + 1);
    }
    if (!starts.length) return [text];
    return starts.map((start, index) => text.slice(start, starts[index + 1] ?? text.length).trim()).filter(Boolean);
  };
  const fenced = [...raw.matchAll(/```(?:text|txt)?\s*\n([\s\S]*?)```/gi)].flatMap(match => splitPlain(match[1]));
  const values = fenced.length ? fenced : splitPlain(raw);
  return values.filter(prompt => detectPromptDuration(prompt) != null || /^\s*生成一段/i.test(prompt));
}

function uniqueIds(values) {
  return [...new Set((values || []).map(String).filter(Boolean))];
}

function detectAutoAssetIds(prompt) {
  const value = String(prompt || '').replace(/\\@/g, '__ESCAPED_AT__');
  const assets = [...state.assets].sort((a, b) => b.alias.length - a.alias.length);
  const matches = [];
  let cursor = 0;
  while (cursor < value.length) {
    const position = value.indexOf('@', cursor);
    if (position < 0) break;
    const matched = assets.find(asset => value.startsWith(`@${asset.alias}`, position));
    if (matched) {
      matches.push(matched.id);
      cursor = position + matched.alias.length + 1;
    } else {
      cursor = position + 1;
    }
  }
  return uniqueIds(matches);
}

function syncCardReferences(card) {
  card.autoAssetIds = detectAutoAssetIds(card.prompt);
  card.assetIds = uniqueIds([...(card.manualAssetIds || []), ...card.autoAssetIds]);
}

function activeCookie() {
  return state.cookies.find(cookie => cookie.id === state.settings.activeCookieId) || state.cookies[0] || null;
}

function normalizeClientMediaRefs(values) {
  return (Array.isArray(values) ? values : []).map(ref => ({
    mediaId: String(ref.mediaId || ''),
    clipId: String(ref.clipId || ''),
    startSeconds: Number(ref.startSeconds || 0),
    durationSeconds: Number(ref.durationSeconds || 0)
  })).filter(ref => ref.mediaId);
}

function mergeClientMediaRefs(...groups) {
  const map = new Map();
  groups.forEach(group => normalizeClientMediaRefs(group).forEach(ref => {
    if (!map.has(ref.mediaId)) map.set(ref.mediaId, ref);
  }));
  return [...map.values()];
}

function normalizeCard(row) {
  return {
    id: row.id,
    title: row.title,
    position: Number(row.position),
    assetIds: Array.isArray(row.asset_ids) ? row.asset_ids : [],
    manualAssetIds: Array.isArray(row.manual_asset_ids) ? row.manual_asset_ids : (Array.isArray(row.asset_ids) ? row.asset_ids : []),
    autoAssetIds: Array.isArray(row.auto_asset_ids) ? row.auto_asset_ids : [],
    mediaRefs: normalizeClientMediaRefs(row.media_refs),
    manualMediaRefs: normalizeClientMediaRefs(row.manual_media_refs),
    autoMediaRefs: normalizeClientMediaRefs(row.auto_media_refs),
    prompt: row.prompt_raw || '',
    duration: Number(row.duration_seconds || 15),
    filename: row.output_filename || '',
    retryLimit: Number(row.retry_limit || 0),
    generationCount: Number(row.generation_count || 1)
  };
}

function validateCard(card) {
  const errors = [];
  const assets = card.assetIds.map(assetById).filter(Boolean);
  const mediaRows = (card.mediaRefs || []).map(ref => ({ ref, media: referenceMediaById(ref.mediaId) }));
  const videoRows = mediaRows.filter(item => item.media?.media_type === 'video');
  const audioRows = mediaRows.filter(item => item.media?.media_type === 'audio');

  if (card.assetIds.length < 1) errors.push('至少需要 1 张参考图片');
  if (card.assetIds.length > 9) errors.push('参考图最多 9 张');
  if (videoRows.length > 3) errors.push('参考视频最多 3 个');
  if (audioRows.length > 3) errors.push('参考音频最多 3 个');
  if (card.assetIds.length + videoRows.length + audioRows.length > 12) errors.push('图片 + 视频 + 音频总文件数最多 12 个');
  if (assets.length !== card.assetIds.length) errors.push('存在失效参考图');
  if (mediaRows.some(item => !item.media)) errors.push('存在失效音视频参考');

  let totalVideoSeconds = 0;
  const referenceDurationLimit = Math.min(15, Number(card.duration || 15));
  videoRows.forEach(item => {
    const sourceDuration = Number(item.media?.duration_seconds || 0);
    const effectiveDuration = item.ref.clipId ? Number(item.ref.durationSeconds || 0) : sourceDuration;
    if (sourceDuration > referenceDurationLimit + 0.001 && !item.ref.clipId) errors.push(`${item.media.file_name} 原视频 ${sourceDuration.toFixed(1)}s，超过当前输出时长 ${referenceDurationLimit}s，必须先完成片段审核`);
    if (!(effectiveDuration > 0) || effectiveDuration > referenceDurationLimit + 0.001) errors.push(`${item.media.file_name} 的参考片段必须大于 0 秒且不超过当前输出时长 ${referenceDurationLimit}s`);
    totalVideoSeconds += Math.max(0, effectiveDuration);
  });
  if (totalVideoSeconds > referenceDurationLimit + 0.001) errors.push(`参考视频总时长 ${totalVideoSeconds.toFixed(1)}s，超过当前输出时长 ${referenceDurationLimit}s`);

  let totalAudioSeconds = 0;
  audioRows.forEach(item => {
    const sourceDuration = Number(item.media?.duration_seconds || 0);
    const effectiveDuration = item.ref.clipId ? Number(item.ref.durationSeconds || 0) : sourceDuration;
    if (sourceDuration > referenceDurationLimit + 0.001 && !item.ref.clipId) errors.push(`${item.media.file_name} 音频 ${sourceDuration.toFixed(1)}s，超过当前输出时长 ${referenceDurationLimit}s，必须先裁剪`);
    if (!(effectiveDuration > 0) || effectiveDuration > referenceDurationLimit + 0.001) errors.push(`${item.media.file_name} 的音频参考必须大于 0 秒且不超过当前输出时长 ${referenceDurationLimit}s`);
    totalAudioSeconds += Math.max(0, effectiveDuration);
  });
  if (totalAudioSeconds > referenceDurationLimit + 0.001) errors.push(`参考音频总时长 ${totalAudioSeconds.toFixed(1)}s，超过当前输出时长 ${referenceDurationLimit}s`);

  if (videoRows.length && !state.provider?.capabilities?.videoReference) errors.push('当前 Provider 尚未启用视频参考远端提交');
  if (audioRows.length && !state.provider?.capabilities?.audioReference) errors.push('当前 Provider 尚未启用音频参考远端提交');
  if (!card.prompt.trim()) errors.push('提示词不能为空');
  if (!Number.isInteger(Number(card.duration)) || card.duration < 4 || card.duration > 15) errors.push('输出时长必须为 4–15 秒整数');
  if (!Number.isInteger(Number(card.retryLimit)) || card.retryLimit < 0 || card.retryLimit > 5) errors.push('重提次数必须为 0–5 整数');
  if (!Number.isInteger(Number(card.generationCount)) || card.generationCount < 1 || card.generationCount > 99) errors.push('生成条数必须为 1–99 整数');
  if (/[\\/:*?"<>|]/.test(card.filename)) errors.push('文件名包含非法字符');
  return {
    errors,
    assets,
    review: {
      imageCount: card.assetIds.length,
      videoCount: videoRows.length,
      audioCount: audioRows.length,
      totalFiles: card.assetIds.length + videoRows.length + audioRows.length,
      totalVideoSeconds,
      totalAudioSeconds
    }
  };
}

async function loadState({ quiet = false } = {}) {
  if (state.loadingState) return;
  state.loadingState = true;
  try {
    const data = await api('/api/state');
    Object.assign(state, data, { cards: data.cards.map(normalizeCard), loadingState: true });
    render();
  } catch (error) {
    if (!quiet) showError(error);
  } finally {
    state.loadingState = false;
  }
}

function render() {
  renderHeader();
  renderAssets();
  renderReferenceLibraries();
  renderCards();
  renderTasks();
  renderResults();
}

function renderHeader() {
  const provider = state.provider || {};
  $('providerBadge').textContent = provider.ready
    ? `Provider 就绪 · 模板 ${provider.templateCapturedAt?.slice(0, 10) || '未知'}`
    : `Provider 未就绪 · ${provider.reason || ''}`;

  const cookie = activeCookie();
  $('cookieStatus').textContent = cookie ? `${cookie.name} · ${cookie.status} · ${cookie.cookie_count} cookies` : '尚未上传';
  $('cookieValidateButton').disabled = !cookie;
  $('outputFolderStatus').textContent = state.settings.outputDirectory || '尚未选择';
  if (document.activeElement !== $('submitConcurrency')) $('submitConcurrency').value = Number(state.settings.submitConcurrency || 5);
  if ($('globalGenerationCount') && document.activeElement !== $('globalGenerationCount') && state.cards.length) {
    const counts = [...new Set(state.cards.map(card => Number(card.generationCount || 1)))];
    if (counts.length === 1) $('globalGenerationCount').value = counts[0];
  }
  $('folderStatus').textContent = state.folder ? `${state.folder.folder_path} · 递归扫描` : '尚未选择图片文件夹';
  if ($('videoFolderStatus')) $('videoFolderStatus').textContent = state.settings.referenceVideoFolder ? `${state.settings.referenceVideoFolder} · 递归扫描 · 仅载入 ≤20s` : '尚未选择视频主文件夹';
  if ($('audioFolderStatus')) $('audioFolderStatus').textContent = state.settings.referenceAudioFolder || '尚未选择音频文件夹';
  $('assetCount').textContent = state.assets.length;
  if ($('videoCount')) $('videoCount').textContent = state.referenceMedia.filter(media => media.media_type === 'video').length;
  if ($('audioCount')) $('audioCount').textContent = state.referenceMedia.filter(media => media.media_type === 'audio').length;
  $('taskCount').textContent = state.tasks.length;
  $('completedCount').textContent = state.tasks.filter(task => task.status === 'completed').length;
  if ($('clearFinishedTasksButton')) $('clearFinishedTasksButton').disabled = !state.tasks.some(task => DELETABLE_TASK_STATUSES.has(task.status));
  $('taskTabCount').textContent = state.tasks.length;
  $('resultTabCount').textContent = state.results?.length || 0;
  const lifecycleCounts = Object.fromEntries((state.lifecycle?.counts || []).map(item => [item.status, Number(item.count)]));
  const activeLifecycle = ['submitted','polling','video_ready','downloading','download_retry']
    .reduce((sum, key) => sum + Number(lifecycleCounts[key] || 0), 0);
  $('lifecycleStatus').textContent = state.lifecycle?.running
    ? `${state.lifecycle.cycleRunning ? '正在检查' : '持续运行'} · ${activeLifecycle} 个处理中`
    : '生命周期调度器已停止';
  const valid = state.cards.filter(card => validateCard(card).errors.length === 0).length;
  $('validCount').textContent = valid;
  $('submitButton').disabled = !(provider.ready && cookie?.status === 'valid' && state.settings.outputDirectory && valid > 0);
}

function renderAssets() {
  const query = $('assetSearch').value.trim().toLowerCase();
  const assets = state.assets.filter(asset => !query || `${asset.alias} ${asset.file_name} ${asset.relative_path}`.toLowerCase().includes(query));
  const list = $('assetList');
  if (!assets.length) {
    list.className = 'asset-grid empty';
    list.textContent = state.assets.length ? '没有匹配素材' : '暂无图片';
    return;
  }
  list.className = 'asset-grid';
  list.innerHTML = assets.map(asset => `
    <article class="asset" data-id="${asset.id}">
      <img src="/api/assets/${asset.id}/file" alt="${esc(asset.alias)}" loading="lazy" />
      <button class="asset-remove" title="从当前素材库移除">×</button>
      <div class="asset-body">
        <input class="asset-alias" value="${esc(asset.alias)}" />
        <div class="asset-meta"><span>${asset.width || '?'}×${asset.height || '?'}</span><span>${Math.round(asset.byte_size / 1024)} KB</span></div>
        <div class="asset-path" title="${esc(asset.relative_path)}">${esc(asset.relative_path)}</div>
      </div>
    </article>`).join('');

  list.querySelectorAll('.asset').forEach(node => {
    const id = node.dataset.id;
    node.querySelector('.asset-alias').addEventListener('change', async event => {
      try {
        await api(`/api/assets/${id}`, { method: 'PATCH', body: JSON.stringify({ alias: event.target.value }) });
        await loadState({ quiet: true });
      } catch (error) { showError(error); }
    });
    node.querySelector('.asset-remove').addEventListener('click', async () => {
      if (!confirm('仅从当前素材库移除，不删除磁盘源文件。继续？')) return;
      try {
        await api(`/api/assets/${id}`, { method: 'DELETE' });
        await loadState({ quiet: true });
      } catch (error) { showError(error); }
    });
  });
}

function bindLazyVideoPreviews(root) {
  root?.querySelectorAll('video[data-src]').forEach(video => {
    const load = () => {
      if (video.src || !video.dataset.src) return;
      video.src = video.dataset.src;
      video.load();
    };
    video.addEventListener('pointerenter', load, { once:true });
    video.addEventListener('focus', load, { once:true });
  });
}

function renderReferenceLibraries() {
  for (const mediaType of ['video', 'audio']) {
    if (state.assetLibraryTab !== mediaType) continue;
    const search = $(`${mediaType}LibrarySearch`);
    const list = $(`${mediaType}LibraryList`);
    if (!search || !list) continue;
    const query = search.value.trim().toLowerCase();
    const rows = state.referenceMedia.filter(media => media.media_type === mediaType)
      .filter(media => !query || `${media.alias} ${media.file_name} ${media.source_path}`.toLowerCase().includes(query));
    const renderKey = `${query}\u0000${rows.map(media => `${media.id}:${media.updated_at || ''}`).join('|')}`;
    if (state.referenceLibraryRenderKeys[mediaType] === renderKey) continue;
    state.referenceLibraryRenderKeys[mediaType] = renderKey;
    if (!rows.length) {
      list.className = 'reference-library-grid empty';
      list.textContent = state.referenceMedia.some(media => media.media_type === mediaType)
        ? '没有匹配素材'
        : mediaType === 'video' ? '暂无视频' : '暂无音频';
      continue;
    }
    const visibleRows = rows.slice(0, MEDIA_LIBRARY_RENDER_LIMIT);
    list.className = 'reference-library-grid';
    list.innerHTML = visibleRows.map(media => {
      const preview = mediaType === 'video'
        ? `<video data-src="/api/reference-media/${media.id}/file" muted preload="none" playsinline></video>`
        : '<div class="reference-audio-preview">♫</div>';
      const review = mediaType === 'video' && Number(media.duration_seconds || 0) > 15
        ? '<span class="library-review-badge">使用前需裁剪审核</span>'
        : '';
      return `<article class="reference-library-item" data-id="${media.id}">
        ${preview}
        <button class="reference-remove" title="从素材库移除">×</button>
        <div class="reference-library-body">
          <input class="reference-alias" value="${esc(media.alias)}" />
          <div class="reference-meta"><span>${formatMediaDuration(media.duration_seconds)}</span><span>${(Number(media.byte_size || 0) / 1024 / 1024).toFixed(1)} MB</span></div>
          ${review}
          <div class="reference-path" title="${esc(media.source_path)}">${esc(media.file_name)}</div>
        </div>
      </article>`;
    }).join('') + (rows.length > visibleRows.length
      ? `<div class="library-limit-note">当前显示前 ${visibleRows.length} / ${rows.length} 条，使用上方搜索可定位其余素材。</div>`
      : '');
    bindLazyVideoPreviews(list);
    list.querySelectorAll('.reference-library-item').forEach(node => {
      const id = node.dataset.id;
      node.querySelector('.reference-alias').addEventListener('change', async event => {
        try {
          await api(`/api/reference-media/${id}`, { method:'PATCH', body:JSON.stringify({ alias:event.target.value }) });
          state.referenceLibraryRenderKeys[mediaType] = '';
          await loadState({ quiet:true });
        } catch (error) { showError(error); }
      });
      node.querySelector('.reference-remove').addEventListener('click', async () => {
        if (!confirm('仅从素材库移除，不删除磁盘源文件。继续？')) return;
        try {
          await api(`/api/reference-media/${id}`, { method:'DELETE' });
          state.referenceLibraryRenderKeys[mediaType] = '';
          await loadState({ quiet:true });
        } catch (error) { showError(error); }
      });
    });
  }
}

function switchAssetLibraryTab(tab) {
  state.assetLibraryTab = ['image','video','audio'].includes(tab) ? tab : 'image';
  document.querySelectorAll('.asset-library-tab').forEach(button => button.classList.toggle('active', button.dataset.tab === state.assetLibraryTab));
  document.querySelectorAll('.asset-library-view').forEach(view => view.classList.toggle('active', view.dataset.tab === state.assetLibraryTab));
  if (state.assetLibraryTab === 'video' || state.assetLibraryTab === 'audio') renderReferenceLibraries();
}

function renderCards() {
  const list = $('cardList');
  list.innerHTML = '';
  if (!state.cards.length) {
    list.innerHTML = '<div class="empty card-empty">已提交的有效卡片已移入任务中心。点击“新增提示词卡”继续创建。</div>';
    return;
  }
  state.cards.sort((a, b) => a.position - b.position).forEach(card => list.appendChild(buildCard(card)));
}

function selectedAssetChips(card) {
  const autoIds = new Set(card.autoAssetIds || []);
  return card.assetIds.map(id => {
    const asset = assetById(id);
    return asset ? `<div class="selected-chip"><img src="/api/assets/${id}/file"><b>${autoIds.has(id) ? '自动' : '手动'}</b><small title="${esc(asset.alias)}">${esc(asset.alias)}</small></div>` : '';
  }).join('');
}

function selectedMediaChips(card) {
  const autoIds = new Set((card.autoMediaRefs || []).map(ref => ref.mediaId));
  const durationLimit = Math.min(15, Number(card.duration || 15));
  return (card.mediaRefs || []).map(ref => {
    const media = referenceMediaById(ref.mediaId);
    if (!media) return '';
    const sourceDuration = Number(media.duration_seconds || 0);
    const needsClip = sourceDuration > durationLimit + 0.001 && !ref.clipId;
    const automatic = autoIds.has(media.id);
    const clipText = ref.clipId
      ? `${Number(ref.startSeconds || 0).toFixed(1)}–${(Number(ref.startSeconds || 0) + Number(ref.durationSeconds || 0)).toFixed(1)}s`
      : needsClip
        ? `需裁剪至 ≤${durationLimit}s`
        : `完整 ${formatMediaDuration(sourceDuration)}`;
    const preview = media.media_type === 'video'
      ? `<video data-src="/api/reference-media/${media.id}/file" muted preload="none" playsinline></video>`
      : `<div class="media-audio-icon">♫</div>`;
    return `<div class="selected-media-chip ${needsClip ? 'needs-clip' : ''}" data-media-id="${media.id}">
      ${preview}
      <div class="selected-media-info"><b>${automatic ? '自动 · ' : ''}${media.media_type === 'video' ? '视频' : '音频'}</b><small title="${esc(media.file_name)}">@${esc(media.file_name)}</small><em>${esc(clipText)}</em></div>
      ${media.media_type === 'video' ? '<button type="button" class="edit-media-segment">片段审核</button>' : ''}
      ${automatic && !ref.clipId ? '' : '<button type="button" class="remove-media-ref" title="从本卡移除">×</button>'}
    </div>`;
  }).join('');
}

function buildCard(card) {
  const result = validateCard(card);
  const node = document.createElement('article');
  node.className = `prompt-card ${result.errors.length ? 'invalid' : 'valid'}`;
  node.dataset.id = card.id;
  const selected = selectedAssetChips(card);
  const selectedMedia = selectedMediaChips(card);
  const review = result.review;
  const referenceRuleErrors = result.errors.filter(error => !error.startsWith('当前 Provider'))
    .filter(error => /参考|图片|视频|音频|片段|总文件数/.test(error));
  const reviewPass = referenceRuleErrors.length === 0;
  const reviewHtml = `<div class="reference-audit ${reviewPass ? 'pass' : 'fail'}">
    <div><strong>参考审核：${reviewPass ? '通过' : '未通过'}</strong><span>提交前强制校验</span></div>
    <small>图片 ${review.imageCount}/9 · 视频 ${review.videoCount}/3 · 音频 ${review.audioCount}/3 · 总文件 ${review.totalFiles}/12 · 视频 ${review.totalVideoSeconds.toFixed(1)}/${Math.min(15, Number(card.duration || 15))}s · 音频 ${Number(review.totalAudioSeconds || 0).toFixed(1)}/${Math.min(15, Number(card.duration || 15))}s</small>
  </div>`;
  node.innerHTML = `
    <div class="card-head">
      <div><strong>${esc(card.title)}</strong><span class="status ${result.errors.length ? 'bad' : 'good'}">${result.errors.length ? '需要补充' : '可提交'}</span></div>
      <div class="card-actions"><button class="duplicate">复制</button><button class="delete">删除</button></div>
    </div>
    <div class="card-body">
      <div class="field">
        <label>参考图片 <span>必须至少 1 张 · 最多 9 张</span></label>
        <div class="selected-assets">${selected}</div>
        <button class="choose-assets">从图片库选择</button>
      </div>
      <div class="field media-reference-field">
        <label>视频 / 音频参考 <span>视频 ≤3 · 音频 ≤3 · 全部文件合计 ≤12</span></label>
        <div class="selected-media">${selectedMedia || '<span class="hint">尚未添加视频或音频参考</span>'}</div>
        <button class="choose-media" type="button">从视频库 / 音频库选择</button>
      </div>
      ${reviewHtml}
      <div class="field prompt-field-fixed">
        <label>提示词 <span>${card.prompt.length.toLocaleString()} 字符 · 输入 @ 仅从本卡附件选择</span></label>
        <div class="prompt-preview-wrap">
          <pre class="prompt-preview">${esc(card.prompt || '尚未填写提示词')}</pre>
          <button class="edit-prompt primary" type="button">单独编辑提示词</button>
        </div>
      </div>
      <div class="params">
        <div class="field"><label>输出时长 <span>4–15s</span></label><input class="duration" type="number" min="4" max="15" step="1" value="${card.duration}"></div>
        <div class="field"><label>视频文件名 <span>可选</span></label><input class="filename" type="text" value="${esc(card.filename)}" placeholder="留空自动生成"></div>
        <div class="field"><label>失败重提 <span>0–5</span></label><input class="retry" type="number" min="0" max="5" step="1" value="${card.retryLimit}"></div>
        <div class="field"><label>生成条数 <span>1–99，默认 1</span></label><input class="generation-count" type="number" min="1" max="99" step="1" value="${card.generationCount}"></div>
      </div>
      <div class="error">${esc(result.errors.join('；'))}</div>
    </div>`;

  node.querySelector('.choose-assets').addEventListener('click', () => openAssetDialog(card.id));
  node.querySelector('.choose-media').addEventListener('click', () => openMediaDialog(card.id));
  bindLazyVideoPreviews(node);
  node.querySelectorAll('.edit-media-segment').forEach(button => button.addEventListener('click', event => {
    const mediaId = event.currentTarget.closest('.selected-media-chip')?.dataset.mediaId;
    if (mediaId) openMediaSegmentEditor(card.id, mediaId);
  }));
  node.querySelectorAll('.remove-media-ref').forEach(button => button.addEventListener('click', async event => {
    const mediaId = event.currentTarget.closest('.selected-media-chip')?.dataset.mediaId;
    if (!mediaId) return;
    card.mediaRefs = (card.mediaRefs || []).filter(ref => ref.mediaId !== mediaId);
    try { await saveCard(card); await loadState({ quiet:true }); }
    catch (error) { showError(error); }
  }));
  node.querySelector('.duplicate').addEventListener('click', async () => {
    try { await api('/api/cards', { method:'POST', body:JSON.stringify({ sourceId: card.id }) }); await loadState({ quiet:true }); }
    catch (error) { showError(error); }
  });
  node.querySelector('.delete').addEventListener('click', async () => {
    if (!confirm(`从输入区删除 ${card.title}？\n历史任务、提示词快照和已生成视频不会删除。`)) return;
    try {
      const result = await api(`/api/cards/${card.id}`, { method:'DELETE' });
      await loadState({ quiet:true });
      toast(result.taskCount ? `已从输入区删除，${result.taskCount} 条历史任务已保留。` : '已从输入区删除。');
    }
    catch (error) { showError(error); }
  });

  node.querySelector('.edit-prompt').addEventListener('click', () => openPromptEditor(card.id));
  node.querySelector('.duration').addEventListener('input', event => { card.duration = Number(event.target.value); updateCardVisual(node, card); scheduleCardSave(card); });
  node.querySelector('.filename').addEventListener('input', event => { card.filename = event.target.value.replace(/\.mp4$/i, ''); updateCardVisual(node, card); scheduleCardSave(card); });
  node.querySelector('.retry').addEventListener('input', event => { card.retryLimit = Number(event.target.value); updateCardVisual(node, card); scheduleCardSave(card); });
  node.querySelector('.generation-count').addEventListener('input', event => { card.generationCount = Number(event.target.value); updateCardVisual(node, card); scheduleCardSave(card); });
  return node;
}

function updateCardVisual(node, card) {
  const result = validateCard(card);
  node.classList.toggle('invalid', result.errors.length > 0);
  node.classList.toggle('valid', result.errors.length === 0);
  const status = node.querySelector('.status');
  status.textContent = result.errors.length ? '需要补充' : '可提交';
  status.className = `status ${result.errors.length ? 'bad' : 'good'}`;
  node.querySelector('.error').textContent = result.errors.join('；');
  renderHeader();
}

function manualMediaRefsForSave(card) {
  const autoIds = new Set((card.autoMediaRefs || []).map(ref => ref.mediaId));
  return normalizeClientMediaRefs(card.mediaRefs || []).filter(ref => !autoIds.has(ref.mediaId) || Boolean(ref.clipId));
}

async function saveCard(card) {
  clearTimeout(state.saveTimers.get(card.id));
  state.saveTimers.delete(card.id);
  card.manualMediaRefs = manualMediaRefsForSave(card);
  return api(`/api/cards/${card.id}`, {
    method:'PATCH',
    body:JSON.stringify({ manualAssetIds:card.manualAssetIds, manualMediaRefs:card.manualMediaRefs, prompt:card.prompt, duration:card.duration, filename:card.filename, retryLimit:card.retryLimit, generationCount:card.generationCount })
  });
}

function scheduleCardSave(card) {
  clearTimeout(state.saveTimers.get(card.id));
  state.saveTimers.set(card.id, setTimeout(async () => {
    try { await saveCard(card); }
    catch (error) { showError(error); }
  }, 450));
}

async function flushCardSaves() {
  await Promise.all(state.cards.map(card => saveCard(card)));
}

function activePromptEditorCard() {
  return state.cards.find(card => card.id === state.activePromptEditorCardId) || null;
}

function renderPromptEditorAttachments(card) {
  const container = $('promptEditorAttachments');
  const assets = (card?.assetIds || []).map(assetById).filter(Boolean);
  const mediaItems = (card?.mediaRefs || []).map(ref => referenceMediaById(ref.mediaId)).filter(Boolean);
  const imageHtml = assets.map(asset => `<div class="prompt-editor-attachment"><img src="/api/assets/${asset.id}/file"><span title="${esc(asset.alias)}">@${esc(asset.alias)}</span></div>`).join('');
  const mediaHtml = mediaItems.map(media => `<div class="prompt-editor-attachment media"><div class="prompt-editor-media-icon">${media.media_type === 'video' ? '▶' : '♫'}</div><span title="${esc(media.alias)}">@${esc(media.alias)}</span></div>`).join('');
  container.innerHTML = imageHtml || mediaHtml ? `${imageHtml}${mediaHtml}` : '<span class="hint">当前卡片没有参考附件</span>';
}

function hidePromptEditorMentionMenu() {
  $('promptEditorMentionMenu').classList.add('hidden');
}

function refreshPromptEditorMentionMenu() {
  const card = activePromptEditorCard();
  const input = $('promptEditorTextarea');
  const menu = $('promptEditorMentionMenu');
  const context = promptMentionContext(input.value, input.selectionStart);
  if (!card || !context) return hidePromptEditorMentionMenu();
  const allowedIds = new Set(card.assetIds || []);
  const imageMatches = state.assets
    .filter(asset => allowedIds.has(asset.id))
    .filter(asset => !context.queryLower || `${asset.alias} ${asset.file_name}`.toLowerCase().includes(context.queryLower))
    .map(asset => ({ kind: 'image', id: asset.id, alias: asset.alias, fileName: asset.file_name }));
  const mediaIds = new Set((card.mediaRefs || []).map(ref => ref.mediaId));
  const mediaMatches = state.referenceMedia
    .filter(media => mediaIds.has(media.id))
    .filter(media => !context.queryLower || `${media.alias} ${media.file_name}`.toLowerCase().includes(context.queryLower))
    .map(media => ({ kind: media.media_type, id: media.id, alias: media.alias, fileName: media.file_name }));
  const matches = [...imageMatches, ...mediaMatches].slice(0, 30);
  if (!matches.length) {
    menu.innerHTML = '<div class="mention-empty">当前卡片附件中没有匹配素材，请先关闭编辑器并添加参考素材。</div>';
    menu.classList.remove('hidden');
    return;
  }
  menu.innerHTML = matches.map(item => `
    <button type="button" data-id="${item.id}" data-kind="${item.kind}" class="mention-option">
      ${item.kind === 'image' ? `<img src="/api/assets/${item.id}/file" loading="lazy">` : `<div class="mention-media-icon">${item.kind === 'video' ? '▶' : '♫'}</div>`}
      <span><b>@${esc(item.alias)}</b><small>${item.kind === 'image' ? '图片' : item.kind === 'video' ? '视频' : '音频'}附件</small></span>
    </button>`).join('');
  menu.classList.remove('hidden');
  menu.querySelectorAll('.mention-option').forEach(button => button.addEventListener('mousedown', event => event.preventDefault()));
  menu.querySelectorAll('.mention-option').forEach(button => button.addEventListener('click', () => {
    const item = button.dataset.kind === 'image' ? assetById(button.dataset.id) : referenceMediaById(button.dataset.id);
    const currentContext = promptMentionContext(input.value, input.selectionStart);
    if (!item || !currentContext) return;
    const applied = applyPromptMention(input.value, currentContext, item.alias);
    input.value = applied.value;
    input.setSelectionRange(applied.caret, applied.caret);
    $('promptEditorCount').textContent = `${input.value.length.toLocaleString()} 字符`;
    hidePromptEditorMentionMenu();
    input.focus();
  }));
}

function openPromptEditor(cardId) {
  const card = state.cards.find(item => item.id === cardId);
  if (!card) return;
  state.activePromptEditorCardId = cardId;
  $('promptEditorTitle').textContent = `编辑 ${card.title}`;
  $('promptEditorTextarea').value = card.prompt;
  $('promptEditorCount').textContent = `${card.prompt.length.toLocaleString()} 字符`;
  renderPromptEditorAttachments(card);
  hidePromptEditorMentionMenu();
  $('promptEditorDialog').showModal();
  setTimeout(() => $('promptEditorTextarea').focus(), 50);
}

async function savePromptEditor() {
  const card = activePromptEditorCard();
  if (!card) return;
  card.prompt = $('promptEditorTextarea').value;
  const detectedDuration = detectPromptDuration(card.prompt);
  if (detectedDuration != null) card.duration = detectedDuration;
  syncCardReferences(card);
  try {
    await saveCard(card);
    $('promptEditorDialog').close();
    state.activePromptEditorCardId = null;
    await loadState({ quiet:true });
    toast(detectedDuration != null ? `提示词已保存，时长自动识别为 ${detectedDuration}s。` : '提示词已保存。');
  } catch (error) {
    showError(error);
  }
}

function updateBulkPromptPreview() {
  const prompts = splitBulkPromptsForPreview($('bulkPromptTextarea').value);
  if (!prompts.length) {
    $('bulkPromptPreview').textContent = '等待识别提示词';
    return;
  }
  const durations = prompts.map(detectPromptDuration).filter(value => value != null);
  const distribution = [...new Set(durations)].sort((a, b) => a - b)
    .map(duration => `${duration}s×${durations.filter(value => value === duration).length}`)
    .join(' · ');
  $('bulkPromptPreview').textContent = `识别 ${prompts.length} 条 · 时长 ${distribution || '未识别'}`;
}

function openBulkPromptDialog() {
  clearError();
  $('bulkPromptTextarea').value = '';
  $('bulkGenerationCount').value = Number($('globalGenerationCount')?.value || 2);
  updateBulkPromptPreview();
  $('bulkPromptDialog').showModal();
  setTimeout(() => $('bulkPromptTextarea').focus(), 50);
}

async function importBulkPrompts() {
  const text = $('bulkPromptTextarea').value;
  const generationCount = Number($('bulkGenerationCount').value);
  const prompts = splitBulkPromptsForPreview(text);
  if (!prompts.length) return toast('没有识别到可拆解的提示词。');
  if (!Number.isInteger(generationCount) || generationCount < 1 || generationCount > 99) return toast('每条生成数量必须是 1–99。');
  const button = $('importBulkPromptButton');
  button.disabled = true;
  button.textContent = '正在拆解…';
  try {
    const result = await api('/api/cards/bulk', {
      method:'POST',
      body:JSON.stringify({ text, generationCount })
    });
    $('bulkPromptDialog').close();
    $('globalGenerationCount').value = generationCount;
    await loadState({ quiet:true });
    const durationSummary = [...new Set(result.durations || [])].sort((a, b) => a - b).join('/');
    toast(`已拆解 ${result.createdCount} 条提示词，每条生成 ${generationCount} 个版本${durationSummary ? ` · 时长 ${durationSummary}s` : ''}。`, 5200);
  } catch (error) {
    showError(error);
  } finally {
    button.disabled = false;
    button.textContent = '拆解并创建卡片';
  }
}

async function applyGlobalGenerationCount() {
  const generationCount = Number($('globalGenerationCount').value);
  if (!Number.isInteger(generationCount) || generationCount < 1 || generationCount > 99) return toast('生成数量必须是 1–99。');
  try {
    const result = await api('/api/cards/apply-generation-count', {
      method:'POST',
      body:JSON.stringify({ generationCount })
    });
    await loadState({ quiet:true });
    toast(`已将 ${result.updated} 张当前提示词卡的生成数量统一设为 ${generationCount}。`);
  } catch (error) {
    showError(error);
  }
}

function bulkFilenamePreviewValue() {
  const rawPrefix = String($('bulkRenamePrefix')?.value || '').trim().replace(/\.mp4$/i, '').replace(/\s+/g, '_');
  const start = Number($('bulkRenameStart')?.value || 1);
  const padding = Number($('bulkRenamePadding')?.value || 3);
  if (!rawPrefix || !Number.isInteger(start) || !Number.isInteger(padding)) return '';
  const separator = /[_-]$/.test(rawPrefix) ? '' : '_';
  return `${rawPrefix}${separator}${String(Math.max(0, start)).padStart(Math.max(1, Math.min(6, padding)), '0')}`;
}

function updateBulkRenamePreview() {
  const example = bulkFilenamePreviewValue();
  $('bulkRenamePreview').textContent = example ? `首个文件名：${example}.mp4` : '请输入有效的文件名前缀和序号。';
}

function openBulkRenameDialog() {
  clearError();
  if (!$('bulkRenamePrefix').value.trim()) $('bulkRenamePrefix').value = 'video';
  $('bulkRenameStart').value = '1';
  $('bulkRenamePadding').value = '3';
  updateBulkRenamePreview();
  $('bulkRenameDialog').showModal();
  setTimeout(() => $('bulkRenamePrefix').focus(), 50);
}

async function applyBulkRename() {
  const prefix = $('bulkRenamePrefix').value;
  const startNumber = Number($('bulkRenameStart').value);
  const padding = Number($('bulkRenamePadding').value);
  if (!prefix.trim()) return toast('批量命名前缀不能为空。');
  const button = $('applyBulkRenameButton');
  button.disabled = true;
  try {
    const result = await api('/api/cards/apply-filenames', {
      method:'POST',
      body:JSON.stringify({ prefix, startNumber, padding })
    });
    $('bulkRenameDialog').close();
    await loadState({ quiet:true });
    toast(`已批量命名 ${result.updated} 张提示词卡。`);
  } catch (error) {
    showError(error);
  } finally {
    button.disabled = false;
  }
}

function localDateInputValue(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function localDateUtcRange(dateText) {
  const match = String(dateText || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const start = new Date(year, month - 1, day, 0, 0, 0, 0);
  const end = new Date(year, month - 1, day + 1, 0, 0, 0, 0);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return { startIso:start.toISOString(), endIso:end.toISOString() };
}

function markdownInline(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|').trim();
}

function buildFailedPromptsMarkdown(dateText, records) {
  const lines = [
    `# 失败提示词导出｜${dateText}`,
    '',
    `失败任务数：${records.length}`,
    ''
  ];
  records.forEach((item, index) => {
    const time = item.failureTime ? new Date(item.failureTime).toLocaleString() : '';
    lines.push(`## ${String(index + 1).padStart(3, '0')}｜${markdownInline(item.filename || item.id)}`);
    lines.push('');
    lines.push(`- 状态：${markdownInline(item.status)}`);
    lines.push(`- 失败时间：${markdownInline(time)}`);
    lines.push(`- 输出时长：${Number(item.duration || 0)}s`);
    if (item.remoteTaskId) lines.push(`- Remote taskId：${markdownInline(item.remoteTaskId)}`);
    if (item.errorCode) lines.push(`- 错误码：${markdownInline(item.errorCode)}`);
    if (item.errorMessage) lines.push(`- 错误信息：${markdownInline(item.errorMessage)}`);
    lines.push('');
    lines.push('### 参考素材');
    lines.push('');
    if (item.images?.length) lines.push(`- 图片：${item.images.map(ref => `@${markdownInline(ref.name)}`).join('；')}`);
    if (item.media?.length) lines.push(`- 音视频：${item.media.map(ref => `${markdownInline(ref.type)} @${markdownInline(ref.name)}${ref.clipId ? ` [${Number(ref.startSeconds || 0).toFixed(1)}s + ${Number(ref.durationSeconds || 0).toFixed(1)}s]` : ''}`).join('；')}`);
    if (!item.images?.length && !item.media?.length) lines.push('- 无参考素材快照');
    lines.push('');
    lines.push('### 原始提示词');
    lines.push('');
    lines.push('~~~~text');
    lines.push(String(item.prompt || '').trim());
    lines.push('~~~~');
    lines.push('');
    lines.push('---');
    lines.push('');
  });
  return lines.join('\n');
}

function downloadTextFile(filename, content, mime = 'text/markdown;charset=utf-8') {
  const blob = new Blob([`\uFEFF${content}`], { type:mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function buildPromptsByDateMarkdown(records) {
  const lines = [];
  records.forEach((item, index) => {
    if (index) lines.push('', '---', '');
    lines.push(`## ${String(item.filename || '').trim()}`);
    lines.push('');
    lines.push('~~~~text');
    lines.push(String(item.prompt || '').trim());
    lines.push('~~~~');
  });
  return lines.join('\n');
}

function openPromptsByDateDialog() {
  clearError();
  $('promptExportDate').value = localDateInputValue();
  $('exportPromptsByDateDialog').showModal();
}

async function exportPromptsByDate() {
  const dateText = $('promptExportDate').value;
  const range = localDateUtcRange(dateText);
  if (!range) return toast('请选择有效日期。');
  const button = $('confirmExportPromptsByDateButton');
  button.disabled = true;
  button.textContent = '正在导出…';
  try {
    const result = await api('/api/tasks/export-prompts-by-date', {
      method:'POST',
      body:JSON.stringify(range)
    });
    if (!result.records?.length) return toast(`${dateText} 没有已完成视频。`);
    downloadTextFile(`prompts_${dateText}.md`, buildPromptsByDateMarkdown(result.records));
    $('exportPromptsByDateDialog').close();
    toast(`已导出 ${result.count} 条视频提示词。`);
  } catch (error) {
    showError(error);
  } finally {
    button.disabled = false;
    button.textContent = '导出 Markdown';
  }
}

function openFailedPromptExportDialog() {
  clearError();
  $('failedPromptExportDate').value = localDateInputValue();
  $('exportFailedPromptsDialog').showModal();
}

async function exportFailedPromptsByDate() {
  const dateText = $('failedPromptExportDate').value;
  const range = localDateUtcRange(dateText);
  if (!range) return toast('请选择有效日期。');
  const button = $('confirmExportFailedPromptsButton');
  button.disabled = true;
  button.textContent = '正在导出…';
  try {
    const result = await api('/api/tasks/export-failed-prompts', {
      method:'POST',
      body:JSON.stringify(range)
    });
    if (!result.records?.length) return toast(`${dateText} 没有失败任务。`);
    const markdown = buildFailedPromptsMarkdown(dateText, result.records);
    downloadTextFile(`failed_prompts_${dateText}.md`, markdown);
    $('exportFailedPromptsDialog').close();
    toast(`已导出 ${result.count} 条失败任务提示词。`);
  } catch (error) {
    showError(error);
  } finally {
    button.disabled = false;
    button.textContent = '导出 Markdown';
  }
}

function openAssetDialog(cardId) {
  state.activePickerCardId = cardId;
  const card = state.cards.find(item => item.id === cardId);
  state.pickerSelection = new Set(card.manualAssetIds || []);
  $('dialogSearch').value = '';
  renderDialogAssets();
  $('assetDialog').showModal();
}

function renderDialogAssets() {
  const query = $('dialogSearch').value.trim().toLowerCase();
  const card = state.cards.find(item => item.id === state.activePickerCardId);
  const autoIds = new Set(card?.autoAssetIds || []);
  const assets = state.assets.filter(asset => !query || `${asset.alias} ${asset.relative_path}`.toLowerCase().includes(query));
  $('dialogAssetList').innerHTML = assets.map(asset => {
    const manual = state.pickerSelection.has(asset.id);
    const automatic = autoIds.has(asset.id);
    return `<button type="button" class="dialog-asset ${manual ? 'selected' : ''} ${automatic ? 'auto-selected' : ''}" data-id="${asset.id}">
      <img src="/api/assets/${asset.id}/file" loading="lazy"><span>${esc(asset.alias)}${automatic ? '<small>提示词自动引用</small>' : ''}</span>
    </button>`;
  }).join('') || '<div class="hint">没有匹配素材</div>';
  const totalIds = uniqueIds([...state.pickerSelection, ...autoIds]);
  const mediaCount = Number(card?.mediaRefs?.length || 0);
  const effectiveImageMax = Math.max(1, Math.min(9, 12 - mediaCount));
  $('dialogSelectionCount').textContent = `图片 ${totalIds.length}/${effectiveImageMax} · 手动 ${state.pickerSelection.size} · 自动 ${autoIds.size} · 全部文件 ${(totalIds.length + mediaCount)}/12`;
  $('dialogAssetList').querySelectorAll('.dialog-asset').forEach(button => button.addEventListener('click', () => {
    const id = button.dataset.id;
    if (state.pickerSelection.has(id)) {
      state.pickerSelection.delete(id);
    } else {
      const nextTotal = uniqueIds([...state.pickerSelection, id, ...autoIds]).length;
      if (nextTotal > 9) return toast('参考图片最多 9 张。');
      if (nextTotal + mediaCount > 12) return toast('图片 + 视频 + 音频总文件数最多 12 个。');
      state.pickerSelection.add(id);
    }
    renderDialogAssets();
  }));
}

async function confirmAssetSelection(event) {
  event.preventDefault();
  const card = state.cards.find(item => item.id === state.activePickerCardId);
  if (!card) return;
  card.manualAssetIds = [...state.pickerSelection];
  syncCardReferences(card);
  try {
    await api(`/api/cards/${card.id}`, { method:'PATCH', body:JSON.stringify({ manualAssetIds:card.manualAssetIds, prompt:card.prompt }) });
    $('assetDialog').close();
    await loadState({ quiet:true });
  } catch (error) { showError(error); }
}

function mediaSelectionCounts(selection = state.mediaPickerSelection) {
  const rows = [...selection].map(referenceMediaById).filter(Boolean);
  return {
    video: rows.filter(media => media.media_type === 'video').length,
    audio: rows.filter(media => media.media_type === 'audio').length,
    total: rows.length
  };
}

function setMediaDialogTab(tab) {
  state.mediaDialogTab = tab === 'audio' ? 'audio' : 'video';
  document.querySelectorAll('.media-dialog-tab').forEach(button => button.classList.toggle('active', button.dataset.tab === state.mediaDialogTab));
  $('mediaSearch').placeholder = state.mediaDialogTab === 'video' ? '搜索视频素材' : '搜索音频素材';
  $('importMediaButton').textContent = state.mediaDialogTab === 'video' ? '选择视频文件夹' : '选择音频文件夹';
  renderMediaDialogList();
}

function openMediaDialog(cardId) {
  const card = state.cards.find(item => item.id === cardId);
  if (!card) return;
  state.activeMediaPickerCardId = cardId;
  state.mediaPickerSelection = new Set((card.mediaRefs || []).map(ref => ref.mediaId));
  $('mediaSearch').value = '';
  setMediaDialogTab('video');
  $('mediaDialog').showModal();
}

function renderMediaDialogList() {
  const query = $('mediaSearch').value.trim().toLowerCase();
  const rows = state.referenceMedia
    .filter(media => media.media_type === state.mediaDialogTab)
    .filter(media => !query || `${media.alias} ${media.file_name} ${media.source_path}`.toLowerCase().includes(query));
  const visibleRows = rows.slice(0, MEDIA_LIBRARY_RENDER_LIMIT);
  $('mediaDialogList').innerHTML = visibleRows.map(media => {
    const selected = state.mediaPickerSelection.has(media.id);
    const preview = media.media_type === 'video'
      ? `<video data-src="/api/reference-media/${media.id}/file" muted preload="none" playsinline></video>`
      : '<div class="media-dialog-audio">♫</div>';
    const review = media.media_type === 'video' && Number(media.duration_seconds || 0) > 15
      ? '<small class="media-review-note">源视频 >15s · 选中后必须片段审核</small>'
      : '';
    return `<button type="button" class="media-dialog-item ${selected ? 'selected' : ''}" data-id="${media.id}">
      ${preview}
      <span><b>${esc(media.alias)}</b><small>${media.media_type === 'video' ? '视频' : '音频'} · ${formatMediaDuration(media.duration_seconds)}</small>${review}<em title="${esc(media.source_path)}">${esc(media.file_name)}</em></span>
    </button>`;
  }).join('') + (rows.length > visibleRows.length
    ? `<div class="library-limit-note">当前显示前 ${visibleRows.length} / ${rows.length} 条，使用搜索可定位其余素材。</div>`
    : '') || `<div class="empty">${state.mediaDialogTab === 'video' ? '视频库暂无素材' : '音频库暂无素材'}</div>`;
  bindLazyVideoPreviews($('mediaDialogList'));

  const counts = mediaSelectionCounts();
  const card = state.cards.find(item => item.id === state.activeMediaPickerCardId);
  const totalFiles = Number(card?.assetIds?.length || 0) + counts.total;
  $('mediaDialogCount').textContent = `视频 ${counts.video}/3 · 音频 ${counts.audio}/3 · 总文件 ${totalFiles}/12`;

  $('mediaDialogList').querySelectorAll('.media-dialog-item').forEach(button => button.addEventListener('click', () => {
    const id = button.dataset.id;
    const media = referenceMediaById(id);
    if (!media) return;
    if (state.mediaPickerSelection.has(id)) {
      state.mediaPickerSelection.delete(id);
      return renderMediaDialogList();
    }
    const next = new Set(state.mediaPickerSelection);
    next.add(id);
    const nextCounts = mediaSelectionCounts(next);
    const imageCount = Number(card?.assetIds?.length || 0);
    if (nextCounts.video > 3) return toast('参考视频最多 3 个。');
    if (nextCounts.audio > 3) return toast('参考音频最多 3 个。');
    if (imageCount + nextCounts.total > 12) return toast('图片 + 视频 + 音频总文件数最多 12 个。');
    state.mediaPickerSelection = next;
    renderMediaDialogList();
  }));
}

async function importMediaFiles(mediaType = state.mediaDialogTab, { selectForCard = true } = {}) {
  const type = mediaType === 'audio' ? 'audio' : 'video';
  try {
    const picked = await api('/api/dialog/select-media-folder', {
      method:'POST',
      body:JSON.stringify({ initialPath: type === 'video' ? (state.settings.referenceVideoFolder || '') : (state.settings.referenceAudioFolder || ''), mediaType:type })
    });
    if (picked.canceled || !picked.folderPath) return;
    const result = await api('/api/reference-media/import', { method:'POST', body:JSON.stringify({ folderPath:picked.folderPath, mediaType:type }) });
    state.referenceMedia = result.media || [];

    if (selectForCard && state.activeMediaPickerCardId) {
      const card = state.cards.find(item => item.id === state.activeMediaPickerCardId);
      for (const media of result.imported || []) {
        if (media.media_type !== type) continue;
        const next = new Set(state.mediaPickerSelection);
        next.add(media.id);
        const counts = mediaSelectionCounts(next);
        if (counts.video > 3 || counts.audio > 3 || Number(card?.assetIds?.length || 0) + counts.total > 12) continue;
        state.mediaPickerSelection = next;
      }
      setMediaDialogTab(type);
    }
    renderReferenceLibraries();
    const rejected = Number(result.rejected?.length || 0);
    const skipped = Number(result.skipped?.length || 0);
    if (type === 'video') state.settings.referenceVideoFolder = picked.folderPath;
    if (type === 'audio') state.settings.referenceAudioFolder = picked.folderPath;
    toast(`已从文件夹导入 ${result.imported?.length || 0} 个${type === 'video' ? '视频' : '音频'}${skipped ? `，跳过 ${skipped} 个超过 20 秒的视频` : ''}${rejected ? `，${rejected} 个失败` : ''}。`, 5200);
  } catch (error) { showError(error); }
}

async function confirmMediaSelection() {
  const card = state.cards.find(item => item.id === state.activeMediaPickerCardId);
  if (!card) return;
  const counts = mediaSelectionCounts();
  const totalFiles = Number(card.assetIds?.length || 0) + counts.total;
  if (counts.video > 3) return toast('参考视频最多 3 个。');
  if (counts.audio > 3) return toast('参考音频最多 3 个。');
  if (totalFiles > 12) return toast('图片 + 视频 + 音频总文件数最多 12 个。');

  const oldRefs = new Map((card.mediaRefs || []).map(ref => [ref.mediaId, ref]));
  card.mediaRefs = [...state.mediaPickerSelection].map(mediaId => {
    const existing = oldRefs.get(mediaId);
    if (existing) return existing;
    const media = referenceMediaById(mediaId);
    return {
      mediaId,
      clipId: '',
      startSeconds: 0,
      durationSeconds: media?.media_type === 'video' ? Math.min(15, Number(media.duration_seconds || 15)) : 0
    };
  });
  try {
    await saveCard(card);
    $('mediaDialog').close();
    state.activeMediaPickerCardId = null;
    await loadState({ quiet:true });
    const refreshed = state.cards.find(item => item.id === card.id);
    const videoRefs = (refreshed?.mediaRefs || []).filter(ref => referenceMediaById(ref.mediaId)?.media_type === 'video');
    const pending = videoRefs.find(ref => {
      const media = referenceMediaById(ref.mediaId);
      return Number(media?.duration_seconds || 0) > 15 && !ref.clipId;
    });
    const totalVideoSeconds = videoRefs.reduce((sum, ref) => {
      const media = referenceMediaById(ref.mediaId);
      return sum + (ref.clipId ? Number(ref.durationSeconds || 0) : Number(media?.duration_seconds || 0));
    }, 0);
    if (pending) {
      toast('该源视频超过 15 秒，必须先完成片段审核。');
      openMediaSegmentEditor(card.id, pending.mediaId);
    } else if (totalVideoSeconds > 15.001 && videoRefs.length) {
      toast(`当前视频总参考时长 ${totalVideoSeconds.toFixed(1)}s，必须裁剪到 ≤15s 后才能提交。`, 5200);
      openMediaSegmentEditor(card.id, videoRefs[0].mediaId);
    }
  } catch (error) { showError(error); }
}

function segmentValues() {
  const media = state.activeMediaSegment?.media;
  const total = Number(media?.duration_seconds || 0);
  const start = Number($('mediaSegmentStartInput').value);
  const end = Number($('mediaSegmentEndInput').value);
  const duration = end - start;
  const errors = [];
  if (!Number.isFinite(start) || !Number.isFinite(end)) errors.push('请输入有效的开始秒数和结束秒数');
  if (Number.isFinite(start) && (start < 0 || start >= total)) errors.push('开始秒数超出视频范围');
  if (Number.isFinite(end) && (end <= 0 || end > total + 0.001)) errors.push('结束秒数超出视频范围');
  if (Number.isFinite(duration) && duration <= 0) errors.push('结束秒数必须大于开始秒数');
  if (Number.isFinite(duration) && duration > 15.001) errors.push('单个参考片段不能超过 15 秒');
  return { start, end, duration, total, errors };
}

function updateMediaSegmentSummary() {
  const values = segmentValues();
  if (Number.isFinite(values.start)) {
    $('mediaSegmentStartLabel').textContent = `${values.start.toFixed(1)}s`;
    $('mediaSegmentStartRange').value = String(Math.max(0, Math.min(values.total, values.start)));
  }
  if (Number.isFinite(values.end)) {
    $('mediaSegmentEndLabel').textContent = `${values.end.toFixed(1)}s`;
    $('mediaSegmentEndRange').value = String(Math.max(0, Math.min(values.total, values.end)));
  }
  const summary = $('mediaSegmentSummary');
  if (values.errors.length) {
    summary.classList.add('invalid');
    summary.textContent = `${values.errors.join('；')}。原始时长 ${formatMediaDuration(values.total)}`;
  } else {
    summary.classList.remove('invalid');
    summary.textContent = `选择 ${values.start.toFixed(1)}s → ${values.end.toFixed(1)}s，共 ${values.duration.toFixed(1)}s；原始时长 ${formatMediaDuration(values.total)}`;
  }
}

function normalizeMediaSegmentInputs() {
  const media = state.activeMediaSegment?.media;
  const total = Number(media?.duration_seconds || 0);
  let start = Number($('mediaSegmentStartInput').value);
  let end = Number($('mediaSegmentEndInput').value);
  if (!Number.isFinite(start)) start = 0;
  start = Math.max(0, Math.min(start, Math.max(0, total - 0.1)));
  if (!Number.isFinite(end)) end = Math.min(total, start + 15);
  end = Math.max(start + 0.1, Math.min(end, total));
  if (end - start > 15) end = Math.min(total, start + 15);
  $('mediaSegmentStartInput').value = start.toFixed(1);
  $('mediaSegmentEndInput').value = end.toFixed(1);
  $('mediaSegmentStartRange').value = start.toFixed(1);
  $('mediaSegmentEndRange').value = end.toFixed(1);
  updateMediaSegmentSummary();
}

function openMediaSegmentEditor(cardId, mediaId) {
  const card = state.cards.find(item => item.id === cardId);
  const media = referenceMediaById(mediaId);
  if (!card || !media || media.media_type !== 'video') return;
  const ref = (card.mediaRefs || []).find(item => item.mediaId === mediaId) || {
    mediaId,
    clipId:'',
    startSeconds:0,
    durationSeconds:Math.min(15, Number(media.duration_seconds || 15))
  };
  state.activeMediaSegment = { cardId, mediaId, media, ref };
  $('mediaSegmentTitle').textContent = `审核 ${media.file_name} 的参考片段`;
  $('mediaSegmentDescription').textContent = `原视频 ${formatMediaDuration(media.duration_seconds)}。请直接填写“开始秒数 → 结束秒数”。单个片段最长 15 秒，且同一任务全部视频片段总时长必须 ≤15 秒。`;
  $('mediaSegmentVideo').classList.remove('hidden');
  $('mediaSegmentAudio').classList.add('hidden');
  $('mediaSegmentVideo').src = `/api/reference-media/${media.id}/file`;
  const total = Number(media.duration_seconds || 0);
  const start = Math.min(Number(ref.startSeconds || 0), Math.max(0, total - 0.1));
  const duration = ref.clipId ? Number(ref.durationSeconds || 0) : Math.min(15, total - start);
  const end = Math.min(total, start + Math.max(0.1, duration));
  $('mediaSegmentStartRange').max = total.toFixed(1);
  $('mediaSegmentEndRange').max = total.toFixed(1);
  $('mediaSegmentStartInput').max = total.toFixed(1);
  $('mediaSegmentEndInput').max = total.toFixed(1);
  $('mediaSegmentStartInput').value = start.toFixed(1);
  $('mediaSegmentEndInput').value = end.toFixed(1);
  $('mediaSegmentStartRange').value = start.toFixed(1);
  $('mediaSegmentEndRange').value = end.toFixed(1);
  updateMediaSegmentSummary();
  $('mediaSegmentDialog').showModal();
}

async function previewMediaSegment() {
  const active = state.activeMediaSegment;
  if (!active) return;
  const values = segmentValues();
  if (values.errors.length) return toast(values.errors[0]);
  const player = $('mediaSegmentVideo');
  player.currentTime = values.start;
  try { await player.play(); } catch {}
  const watcher = () => {
    if (player.currentTime >= values.end || player.paused) {
      player.pause();
      player.removeEventListener('timeupdate', watcher);
    }
  };
  player.addEventListener('timeupdate', watcher);
}

async function saveMediaSegment() {
  const active = state.activeMediaSegment;
  if (!active) return;
  const values = segmentValues();
  if (values.errors.length) return toast(values.errors.join('；'), 5000);
  const button = $('saveMediaSegmentButton');
  button.disabled = true;
  button.textContent = '正在裁剪…';
  try {
    const result = await api(`/api/reference-media/${active.mediaId}/clip`, {
      method:'POST',
      body:JSON.stringify({ startSeconds:values.start, durationSeconds:values.duration })
    });
    const card = state.cards.find(item => item.id === active.cardId);
    if (!card) return;
    const refs = [...(card.mediaRefs || [])];
    const index = refs.findIndex(ref => ref.mediaId === active.mediaId);
    const nextRef = {
      mediaId:active.mediaId,
      clipId:result.clip.id,
      startSeconds:values.start,
      durationSeconds:values.duration
    };
    if (index >= 0) refs[index] = nextRef; else refs.push(nextRef);
    card.mediaRefs = refs;
    await saveCard(card);
    $('mediaSegmentDialog').close();
    state.activeMediaSegment = null;
    await loadState({ quiet:true });
    const refreshed = state.cards.find(item => item.id === active.cardId);
    const audit = refreshed ? validateCard(refreshed).review : null;
    toast(`片段审核已保存：${values.start.toFixed(1)}–${values.end.toFixed(1)}s${audit ? ` · 视频总时长 ${audit.totalVideoSeconds.toFixed(1)}/15s` : ''}`, 5200);
  } catch (error) { showError(error); }
  finally {
    button.disabled = false;
    button.textContent = '保存参考片段';
  }
}

function taskStatus(task) {
  if (task.status === 'polling' && task.error_code) return ['轮询异常','failed'];
  const statuses = {
    queued:['排队中',''], uploading_media:['上传图片','running'], submitting:['提交中','running'],
    retry_wait:['等待重提','running'], submitted:['已提交','submitted'], polling:['轮询中','running'],
    video_ready:['视频链接就绪','ready'], downloading:['下载中','running'], download_retry:['等待重下','running'],
    completed:['已完成','complete'], submit_failed:['提交失败','failed'], remote_failed:['生成失败','failed'],
    download_failed:['下载失败','failed']
  };
  return statuses[task.status] || [task.status,''];
}

function formatTaskClock(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = number => String(number).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatElapsedMs(ms) {
  const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
  if (minutes) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

function taskElapsed(task) {
  const start = Date.parse(task.first_submitted_at || task.submitted_at || task.created_at || '');
  if (!Number.isFinite(start)) return '—';
  const endValue = task.completed_at || task.failed_at || null;
  const end = endValue ? Date.parse(endValue) : Date.now();
  return formatElapsedMs((Number.isFinite(end) ? end : Date.now()) - start);
}

function taskTimeSummary(task) {
  const parts = [`创建 ${formatTaskClock(task.created_at)}`];
  if (task.first_submitted_at || task.submitted_at) parts.push(`首提 ${formatTaskClock(task.first_submitted_at || task.submitted_at)}`);
  if (task.failed_at) parts.push(`失败 ${formatTaskClock(task.failed_at)}`);
  else if (task.completed_at) parts.push(`完成 ${formatTaskClock(task.completed_at)}`);
  parts.push(`耗时 ${taskElapsed(task)}`);
  return parts.join(' · ');
}

function taskDetail(task) {
  return {
    file: `${task.output_filename}.mp4`,
    status: task.status,
    taskId: task.remote_task_id || null,
    remoteStatus: task.remote_status || null,
    pollCount: Number(task.poll_count || 0),
    lastPolledAt: task.last_polled_at || null,
    nextPollAt: task.next_poll_at || null,
    videoUrl: task.video_url || null,
    videoCandidates: task.video_urls || [],
    downloadPath: task.download_path || null,
    downloadAttempts: Number(task.download_attempts || 0),
    errorCode: task.error_code || null,
    errorMessage: task.error_message || task.download_error || null,
    prompt: task.prompt_raw,
    imageAssetIds: task.asset_ids || [],
    mediaRefs: task.media_refs || [],
    duration: task.duration_seconds,
    createdAt: task.created_at || null,
    firstSubmittedAt: task.first_submitted_at || null,
    submittedAt: task.submitted_at || null,
    failedAt: task.failed_at || null,
    completedAt: task.completed_at || null,
    retryCount: Number(task.retry_count || 0),
    retryLimit: Number(task.retry_limit || 0),
    elapsed: taskElapsed(task)
  };
}

function openTaskPrompt(taskId) {
  const task = state.tasks.find(item => item.id === taskId);
  if (!task) return;
  state.activeTaskPromptId = taskId;
  $('taskPromptTitle').textContent = `${task.output_filename}.mp4 的提示词`;
  $('taskPromptMeta').textContent = `${task.duration_seconds}s · ${taskStatus(task)[0]} · 重提 ${Number(task.retry_count || 0)}/${Number(task.retry_limit || 0)} · ${taskTimeSummary(task)} · taskId ${task.remote_task_id || '尚未获得'}`;
  $('taskPromptContent').textContent = task.prompt_raw || '';
  $('taskPromptDialog').showModal();
}

async function reuseActiveTaskPrompt() {
  const taskId = state.activeTaskPromptId;
  if (!taskId) return;
  const button = $('reuseTaskPromptButton');
  button.disabled = true;
  try {
    const result = await api(`/api/prompt-history/${taskId}/reuse`, { method:'POST', body:'{}' });
    await loadState({ quiet:true });
    $('taskPromptDialog').close();
    state.activeTaskPromptId = null;
    openPromptEditor(result.card.id);
    const missing = Number(result.missingAssetCount || 0);
    const missingMedia = Number(result.missingMediaCount || 0);
    toast(`已复用为新卡片${missing ? `，${missing} 张参考图需要重新选择` : ''}${missingMedia ? `，${missingMedia} 个音视频需要重新选择` : ''}。`);
  } catch (error) {
    showError(error);
  } finally {
    button.disabled = false;
  }
}

function taskGroupMeta(task) {
  const batchTasks = state.tasks
    .filter(item => item.batch_id === task.batch_id)
    .sort((a, b) => Number(a.position || 0) - Number(b.position || 0));
  const groupIds = [...new Set(batchTasks.map(item => item.prompt_card_id))];
  const groupTasks = batchTasks.filter(item => item.prompt_card_id === task.prompt_card_id);
  return {
    groupNumber: Math.max(1, groupIds.indexOf(task.prompt_card_id) + 1),
    groupCount: Math.max(1, groupIds.length),
    versionNumber: Math.max(1, groupTasks.findIndex(item => item.id === task.id) + 1),
    versionCount: Math.max(1, groupTasks.length)
  };
}

function renderTasks() {
  const list = $('taskList');
  if (!state.tasks.length) {
    list.className = 'task-list empty';
    list.textContent = '暂无任务';
    return;
  }
  list.className = 'task-list';
  list.innerHTML = state.tasks.map((task, index) => {
    const [label, cls] = taskStatus(task);
    const group = taskGroupMeta(task);
    const pollInfo = task.remote_task_id
      ? `轮询 ${Number(task.poll_count || 0)} 次${task.remote_status ? ` · ${task.remote_status}` : ''}`
      : '等待 taskId';
    const actionPoll = ['submitted','polling'].includes(task.status)
      ? `<button class="task-poll" data-id="${task.id}">立即轮询</button>` : '';
    const actionRetry = task.status === 'download_failed' && task.video_url
      ? `<button class="task-download" data-id="${task.id}">重新下载</button>` : '';
    const actionOpen = task.status === 'completed' && task.download_path
      ? `<button class="task-open" data-id="${task.id}">打开目录</button>` : '';
    const actionDelete = DELETABLE_TASK_STATUSES.has(task.status)
      ? `<button class="task-delete danger" data-id="${task.id}">删除记录</button>` : '';
    return `<article class="task-row stage3-task" data-id="${task.id}">
      <div class="num">${String(index + 1).padStart(2,'0')}</div>
      <div class="task-main"><strong>${esc(task.output_filename)}.mp4</strong><small>${task.duration_seconds}s · 组 ${group.groupNumber}/${group.groupCount} · 版本 ${group.versionNumber}/${group.versionCount} · 失败重提 ${Number(task.retry_count || 0)}/${Number(task.retry_limit || 0)} · ${esc(pollInfo)}</small><small class="task-time">${esc(taskTimeSummary(task))}</small><small title="${esc(task.download_path || '')}">${esc(task.download_path || task.video_url || '')}</small></div>
      <div><span class="pill ${cls}">${label}</span></div>
      <div class="task-id" title="${esc(task.remote_task_id || '')}">${esc(task.remote_task_id || '等待 taskId')}</div>
      <div class="task-error" title="${esc(`${task.error_code ? `[${task.error_code}] ` : ''}${task.error_message || task.download_error || ''}`)}">${esc(`${task.error_code ? `[${task.error_code}] ` : ''}${task.error_message || task.download_error || ''}`)}</div>
      <div class="task-buttons">${actionPoll}${actionRetry}${actionOpen}<button class="task-prompt" data-id="${task.id}">提示词</button><button class="task-detail" data-id="${task.id}">详情</button>${actionDelete}</div>
    </article>`;
  }).join('');

  list.querySelectorAll('.task-poll').forEach(button => button.addEventListener('click', async () => {
    try { await api(`/api/tasks/${button.dataset.id}/poll-now`, { method:'POST', body:'{}' }); toast('已请求立即轮询。'); }
    catch (error) { showError(error); }
  }));
  list.querySelectorAll('.task-download').forEach(button => button.addEventListener('click', async () => {
    try { await api(`/api/tasks/${button.dataset.id}/retry-download`, { method:'POST', body:'{}' }); toast('已重新加入下载队列。'); }
    catch (error) { showError(error); }
  }));
  list.querySelectorAll('.task-open').forEach(button => button.addEventListener('click', async () => {
    try { await api(`/api/tasks/${button.dataset.id}/open`, { method:'POST', body:'{}' }); }
    catch (error) { showError(error); }
  }));
  list.querySelectorAll('.task-delete').forEach(button => button.addEventListener('click', async () => {
    const task = state.tasks.find(item => item.id === button.dataset.id);
    if (!task) return;
    if (!confirm(`删除任务记录“${task.output_filename}.mp4”？\n仅删除工作台记录，不删除已经下载到磁盘的视频文件。`)) return;
    try {
      const result = await api(`/api/tasks/${button.dataset.id}`, { method:'DELETE' });
      await loadState({ quiet:true });
      toast(result.keptFile ? '任务记录已删除，本地视频文件已保留。' : '任务记录已删除。');
    } catch (error) { showError(error); }
  }));
  list.querySelectorAll('.task-prompt').forEach(button => button.addEventListener('click', () => openTaskPrompt(button.dataset.id)));
  list.querySelectorAll('.task-detail').forEach(button => button.addEventListener('click', () => {
    const task = state.tasks.find(item => item.id === button.dataset.id);
    $('taskDetailContent').textContent = JSON.stringify(taskDetail(task), null, 2);
    $('taskDialog').showModal();
  }));
}

function renderResults() {
  const list = $('resultList');
  const results = state.results || [];
  if (!results.length) {
    list.className = 'result-grid empty';
    list.textContent = '暂无视频结果';
    return;
  }
  list.className = 'result-grid';
  list.innerHTML = results.map(result => {
    const task = state.tasks.find(item => item.id === result.task_id);
    const prompt = String(task?.prompt_raw || '');
    return `
    <article class="result-card">
      <video controls preload="none" src="/api/tasks/${result.task_id}/video"></video>
      <div class="result-body">
        <strong title="${esc(result.output_filename)}.mp4">${esc(result.output_filename)}.mp4</strong>
        <small>${result.duration_seconds}s · ${(Number(result.byte_size || 0) / 1024 / 1024).toFixed(1)} MB</small>
        <p title="${esc(result.local_path)}">${esc(result.local_path)}</p>
        <div class="result-prompt-preview" title="${esc(prompt)}">${esc(prompt || '没有提示词快照')}</div>
        <div class="result-actions">
          <button class="result-open" data-id="${result.task_id}">打开目录</button>
          <button class="result-copy" data-url="${esc(result.video_url)}">复制链接</button>
          <button class="result-prompt" data-id="${result.task_id}">提示词</button>
          <button class="result-detail" data-id="${result.task_id}">详情</button>
        </div>
      </div>
    </article>`;
  }).join('');
  list.querySelectorAll('.result-open').forEach(button => button.addEventListener('click', async () => {
    try { await api(`/api/tasks/${button.dataset.id}/open`, { method:'POST', body:'{}' }); }
    catch (error) { showError(error); }
  }));
  list.querySelectorAll('.result-copy').forEach(button => button.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(button.dataset.url); toast('视频链接已复制。'); }
    catch { toast(button.dataset.url, 6000); }
  }));
  list.querySelectorAll('.result-prompt').forEach(button => button.addEventListener('click', () => openTaskPrompt(button.dataset.id)));
  list.querySelectorAll('.result-detail').forEach(button => button.addEventListener('click', () => {
    const task = state.tasks.find(item => item.id === button.dataset.id);
    $('taskDetailContent').textContent = JSON.stringify(taskDetail(task), null, 2);
    $('taskDialog').showModal();
  }));
}

function historyStatusLabel(status) {
  const labels = {
    queued: '排队中', uploading_media: '上传图片', submitting: '提交中', retry_wait: '等待重提',
    submitted: '已提交', polling: '生成中', video_ready: '视频就绪', downloading: '下载中',
    download_retry: '等待重下', completed: '已完成', submit_failed: '提交失败',
    remote_failed: '生成失败', download_failed: '下载失败'
  };
  return labels[status] || status || '未知';
}

function formatHistoryTime(value) {
  if (!value) return '时间未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}

async function loadPromptHistory() {
  const result = await api('/api/prompt-history?limit=300');
  state.promptHistory = result.history || [];
  renderPromptHistory();
}

function renderPromptHistory() {
  const query = $('promptHistorySearch').value.trim().toLowerCase();
  const history = state.promptHistory.filter(item => {
    const haystack = `${item.prompt} ${item.filename} ${item.remoteTaskId} ${item.status}`.toLowerCase();
    return !query || haystack.includes(query);
  });
  $('promptHistorySummary').textContent = `共 ${state.promptHistory.length} 条历史提示词${query ? `，当前匹配 ${history.length} 条` : ''}`;
  const list = $('promptHistoryList');
  if (!history.length) {
    list.innerHTML = '<div class="empty prompt-history-empty">没有匹配的历史提示词</div>';
    return;
  }
  list.innerHTML = history.map(item => {
    const assetText = item.sourceAssetCount
      ? `参考图 ${item.reusableAssetCount}/${item.sourceAssetCount} 可恢复${item.missingAssetCount ? ` · ${item.missingAssetCount} 张需重选` : ''}`
      : '无参考图';
    const mediaText = item.sourceMediaCount
      ? `音视频 ${item.reusableMediaCount}/${item.sourceMediaCount} 可恢复`
      : '无音视频';
    return `<article class="prompt-history-item" data-id="${item.id}">
      <div class="prompt-history-meta">
        <div><span class="pill">${esc(historyStatusLabel(item.status))}</span><strong>${esc(item.filename || '未命名视频')}</strong></div>
        <small>${esc(formatHistoryTime(item.submittedAt || item.createdAt))} · ${item.duration}s · 生成 ${Number(item.generationCount || 1)} 条 · ${esc(assetText)} · ${esc(mediaText)}</small>
        <small class="history-task-id" title="${esc(item.remoteTaskId)}">${esc(item.remoteTaskId || '未获得 taskId')}</small>
      </div>
      <pre>${esc(item.prompt)}</pre>
      <div class="prompt-history-actions">
        <button class="history-reuse primary" data-id="${item.id}">复用为新卡片</button>
      </div>
    </article>`;
  }).join('');
  list.querySelectorAll('.history-reuse').forEach(button => button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const result = await api(`/api/prompt-history/${button.dataset.id}/reuse`, { method:'POST', body:'{}' });
      await loadState({ quiet:true });
      $('promptHistoryDialog').close();
      const missing = Number(result.missingAssetCount || 0);
      const missingMedia = Number(result.missingMediaCount || 0);
      toast(`历史提示词已复用为新卡片${missing ? `，${missing} 张参考图需重选` : ''}${missingMedia ? `，${missingMedia} 个音视频需重选` : ''}。`);
      document.querySelector('.cards-panel')?.scrollIntoView({ behavior:'smooth', block:'start' });
    } catch (error) {
      button.disabled = false;
      showError(error);
    }
  }));
}

function switchMonitorTab(tab) {
  state.monitorTab = tab;
  $('tasksTab').classList.toggle('active', tab === 'tasks');
  $('resultsTab').classList.toggle('active', tab === 'results');
  $('tasksView').classList.toggle('active', tab === 'tasks');
  $('resultsView').classList.toggle('active', tab === 'results');
}

async function selectNativeFolder(kind) {
  const dialog = await api('/api/dialog/select-folder', { method:'POST', body:JSON.stringify({ kind }) });
  return dialog.canceled ? '' : dialog.folderPath;
}

function bindEvents() {
  $('cookieImportButton').addEventListener('click', () => $('cookieFileInput').click());
  $('cookieFileInput').addEventListener('change', async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    clearError();
    try {
      const content = await file.text();
      await api('/api/cookies/import', { method:'POST', body:JSON.stringify({ name:file.name.replace(/\.[^.]+$/,''), content }) });
      event.target.value = '';
      await loadState({ quiet:true });
      toast('Cookie 已加密保存，请点击验证。');
    } catch (error) { showError(error); }
  });

  $('cookieValidateButton').addEventListener('click', async () => {
    const cookie = activeCookie();
    if (!cookie) return;
    clearError();
    $('cookieValidateButton').disabled = true;
    try {
      await api(`/api/cookies/${cookie.id}/validate`, { method:'POST', body:'{}' });
      await loadState({ quiet:true });
      toast('Cookie 验证通过。');
    } catch (error) { showError(error); await loadState({ quiet:true }); }
  });

  $('networkDiagnosticsButton').addEventListener('click', async () => {
    clearError();
    const button = $('networkDiagnosticsButton');
    button.disabled = true;
    const original = button.textContent;
    button.textContent = '检测中…';
    try {
      const result = await api('/api/network/diagnostics');
      const modeLabels = { system: 'Windows 系统代理', environment: '环境变量代理', direct: '直连' };
      const lines = [
        `网络模式：${modeLabels[result.proxyMode] || result.proxyMode}`,
        `代理地址：${result.proxy || 'DIRECT'}`,
        `广告后台：${result.reachable ? `可连接（HTTP ${result.status}）` : '连接失败'}`,
        `耗时：${result.elapsedMs} ms`
      ];
      if (result.error) lines.push(`错误：${result.error}`);
      alert(lines.join('\n'));
    } catch (error) {
      showError(error);
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  });

  $('submitConcurrency').addEventListener('change', async event => {
    clearError();
    const value = Number(event.target.value);
    if (!Number.isInteger(value) || value < 1 || value > 99) {
      event.target.value = Number(state.settings.submitConcurrency || 5);
      return showError(new Error('HTTP 提交并发数必须是 1–99 整数。'));
    }
    try {
      await api('/api/settings/submit-concurrency', { method:'POST', body:JSON.stringify({ value }) });
      state.settings.submitConcurrency = value;
      toast(`提交并发数已设置为 ${value}。`);
    } catch (error) { showError(error); }
  });

  $('outputFolderButton').addEventListener('click', async () => {
    clearError();
    try {
      const folderPath = await selectNativeFolder('output');
      if (!folderPath) return;
      await api('/api/settings/output-directory', { method:'POST', body:JSON.stringify({ folderPath }) });
      await loadState({ quiet:true });
    } catch (error) { showError(error); }
  });

  $('assetFolderButton').addEventListener('click', async () => {
    clearError();
    try {
      const folderPath = await selectNativeFolder('assets');
      if (!folderPath) return;
      try {
        await api('/api/assets/scan', { method:'POST', body:JSON.stringify({ folderPath, force:false }) });
      } catch (error) {
        if (error.code !== 'ASSET_FOLDER_REPLACE_REQUIRES_CONFIRM') throw error;
        if (!confirm(`当前素材被 ${error.details?.referenced || 0} 张卡片引用。更换后会解除旧图片绑定，继续？`)) return;
        await api('/api/assets/scan', { method:'POST', body:JSON.stringify({ folderPath, force:true }) });
      }
      await loadState({ quiet:true });
      toast(`已扫描图片文件夹。`);
    } catch (error) { showError(error); }
  });

  document.querySelectorAll('.asset-library-tab').forEach(button => button.addEventListener('click', () => switchAssetLibraryTab(button.dataset.tab)));
  $('assetSearch').addEventListener('input', renderAssets);
  $('videoLibrarySearch').addEventListener('input', renderReferenceLibraries);
  $('audioLibrarySearch').addEventListener('input', renderReferenceLibraries);
  $('importVideoLibraryButton').addEventListener('click', () => importMediaFiles('video', { selectForCard:false }));
  $('importAudioLibraryButton').addEventListener('click', () => importMediaFiles('audio', { selectForCard:false }));
  $('dialogSearch').addEventListener('input', renderDialogAssets);
  $('confirmAssetsButton').addEventListener('click', confirmAssetSelection);
  document.querySelectorAll('.media-dialog-tab').forEach(button => button.addEventListener('click', () => setMediaDialogTab(button.dataset.tab)));
  $('mediaSearch').addEventListener('input', renderMediaDialogList);
  $('importMediaButton').addEventListener('click', () => importMediaFiles(state.mediaDialogTab, { selectForCard:true }));
  $('confirmMediaButton').addEventListener('click', confirmMediaSelection);
  $('closeMediaDialogButton').addEventListener('click', () => {
    $('mediaDialog').close();
    state.activeMediaPickerCardId = null;
  });
  $('closeMediaSegmentButton').addEventListener('click', () => {
    $('mediaSegmentDialog').close();
    state.activeMediaSegment = null;
  });
  $('mediaSegmentStartRange').addEventListener('input', event => {
    $('mediaSegmentStartInput').value = Number(event.target.value).toFixed(1);
    updateMediaSegmentSummary();
  });
  $('mediaSegmentEndRange').addEventListener('input', event => {
    $('mediaSegmentEndInput').value = Number(event.target.value).toFixed(1);
    updateMediaSegmentSummary();
  });
  $('mediaSegmentStartInput').addEventListener('input', updateMediaSegmentSummary);
  $('mediaSegmentEndInput').addEventListener('input', updateMediaSegmentSummary);
  $('mediaSegmentStartInput').addEventListener('change', normalizeMediaSegmentInputs);
  $('mediaSegmentEndInput').addEventListener('change', normalizeMediaSegmentInputs);
  $('previewMediaSegmentButton').addEventListener('click', previewMediaSegment);
  $('saveMediaSegmentButton').addEventListener('click', saveMediaSegment);
  $('addCardButton').addEventListener('click', async () => {
    try { await api('/api/cards', { method:'POST', body:'{}' }); await loadState({ quiet:true }); }
    catch (error) { showError(error); }
  });
  $('bulkPromptButton').addEventListener('click', openBulkPromptDialog);
  $('bulkPromptTextarea').addEventListener('input', updateBulkPromptPreview);
  $('bulkGenerationCount').addEventListener('input', updateBulkPromptPreview);
  $('importBulkPromptButton').addEventListener('click', importBulkPrompts);
  $('closeBulkPromptButton').addEventListener('click', () => $('bulkPromptDialog').close());
  $('cancelBulkPromptButton').addEventListener('click', () => $('bulkPromptDialog').close());
  $('applyGlobalGenerationCountButton').addEventListener('click', applyGlobalGenerationCount);
  $('bulkRenameButton').addEventListener('click', openBulkRenameDialog);
  ['bulkRenamePrefix','bulkRenameStart','bulkRenamePadding'].forEach(id => $(id).addEventListener('input', updateBulkRenamePreview));
  $('applyBulkRenameButton').addEventListener('click', applyBulkRename);
  $('closeBulkRenameButton').addEventListener('click', () => $('bulkRenameDialog').close());
  $('cancelBulkRenameButton').addEventListener('click', () => $('bulkRenameDialog').close());
  $('promptHistoryButton').addEventListener('click', async () => {
    clearError();
    $('promptHistorySearch').value = '';
    $('promptHistorySummary').textContent = '加载中…';
    $('promptHistoryList').innerHTML = '<div class="empty prompt-history-empty">正在读取历史提示词…</div>';
    $('promptHistoryDialog').showModal();
    try { await loadPromptHistory(); }
    catch (error) { $('promptHistoryDialog').close(); showError(error); }
  });
  $('promptHistorySearch').addEventListener('input', renderPromptHistory);
  $('closePromptHistoryButton').addEventListener('click', () => $('promptHistoryDialog').close());
  $('tasksTab').addEventListener('click', () => switchMonitorTab('tasks'));
  $('resultsTab').addEventListener('click', () => switchMonitorTab('results'));
  $('closeTaskDialogButton').addEventListener('click', () => $('taskDialog').close());

  const closePromptEditor = () => {
    $('promptEditorDialog').close();
    state.activePromptEditorCardId = null;
    hidePromptEditorMentionMenu();
  };
  $('closePromptEditorButton').addEventListener('click', closePromptEditor);
  $('cancelPromptEditorButton').addEventListener('click', closePromptEditor);
  $('savePromptEditorButton').addEventListener('click', savePromptEditor);
  $('promptEditorTextarea').addEventListener('input', event => {
    $('promptEditorCount').textContent = `${event.target.value.length.toLocaleString()} 字符`;
    refreshPromptEditorMentionMenu();
  });
  $('promptEditorTextarea').addEventListener('click', refreshPromptEditorMentionMenu);
  $('promptEditorTextarea').addEventListener('keyup', event => {
    if (event.key === 'Escape') hidePromptEditorMentionMenu();
    else refreshPromptEditorMentionMenu();
  });
  $('promptEditorTextarea').addEventListener('blur', () => setTimeout(hidePromptEditorMentionMenu, 120));

  $('closeTaskPromptButton').addEventListener('click', () => {
    $('taskPromptDialog').close();
    state.activeTaskPromptId = null;
  });
  $('copyTaskPromptButton').addEventListener('click', async () => {
    const task = state.tasks.find(item => item.id === state.activeTaskPromptId);
    if (!task) return;
    try { await navigator.clipboard.writeText(task.prompt_raw || ''); toast('提示词已复制。'); }
    catch { toast('复制失败，请在弹窗中手动选择。'); }
  });
  $('reuseTaskPromptButton').addEventListener('click', reuseActiveTaskPrompt);
  $('exportFailedPromptsButton').addEventListener('click', openFailedPromptExportDialog);
  $('confirmExportFailedPromptsButton').addEventListener('click', exportFailedPromptsByDate);
  $('closeExportFailedPromptsButton').addEventListener('click', () => $('exportFailedPromptsDialog').close());
  $('cancelExportFailedPromptsButton').addEventListener('click', () => $('exportFailedPromptsDialog').close());
  $('exportPromptsByDateButton').addEventListener('click', openPromptsByDateDialog);
  $('confirmExportPromptsByDateButton').addEventListener('click', exportPromptsByDate);
  $('closeExportPromptsByDateButton').addEventListener('click', () => $('exportPromptsByDateDialog').close());
  $('cancelExportPromptsByDateButton').addEventListener('click', () => $('exportPromptsByDateDialog').close());
  $('runLifecycleButton').addEventListener('click', async () => {
    try {
      await api('/api/lifecycle/run', { method:'POST', body:'{}' });
      toast('已触发轮询与下载检查。');
      setTimeout(() => loadState({ quiet:true }), 800);
    } catch (error) { showError(error); }
  });
  $('clearFinishedTasksButton').addEventListener('click', async () => {
    const deletable = state.tasks.filter(task => DELETABLE_TASK_STATUSES.has(task.status));
    const active = state.tasks.length - deletable.length;
    if (!deletable.length) return toast('当前没有可删除的已结束任务记录。');
    const message = `一键删除 ${deletable.length} 条已结束任务记录？${active ? `\n另外 ${active} 条正在处理的任务会保留。` : ''}\n已下载到磁盘的视频文件不会删除。`;
    if (!confirm(message)) return;
    try {
      const result = await api('/api/tasks', { method:'DELETE' });
      await loadState({ quiet:true });
      toast(`已删除 ${result.deleted || 0} 条任务记录${result.skippedActive ? `，保留 ${result.skippedActive} 条进行中任务` : ''}。`);
    } catch (error) { showError(error); }
  });
  $('submitButton').addEventListener('click', async () => {
    clearError();
    const overVideoCards = state.cards
      .map(card => ({ card, validation: validateCard(card) }))
      .filter(item => Number(item.validation.review?.videoCount || 0) > 3);
    if (overVideoCards.length) {
      return showError(Object.assign(new Error('提交已阻止：Seedance 2.0 单个任务最多参考 3 个视频，请先移除第 4 个及更多视频。'), {
        details: overVideoCards.map(item => ({ id:item.card.id, title:item.card.title, errors:item.validation.errors }))
      }));
    }
    const validCards = state.cards.filter(card => validateCard(card).errors.length === 0);
    const invalidCount = state.cards.length - validCards.length;
    if (!validCards.length) return showError(new Error('当前没有可提交的有效卡片。'));
    const expectedTasks = validCards.reduce((sum, card) => sum + Number(card.generationCount || 1), 0);
    const message = invalidCount
      ? `提交 ${validCards.length} 张有效卡片并创建 ${expectedTasks} 条视频任务？另外 ${invalidCount} 张未完成卡片将保留在输入区。`
      : `提交 ${validCards.length} 张有效卡片并创建 ${expectedTasks} 条视频任务？提交后这些卡片将移入任务中心。`;
    if (!confirm(message)) return;
    try {
      await flushCardSaves();
      const result = await api('/api/batches/submit', {
        method:'POST',
        body:JSON.stringify({ cookieProfileId:activeCookie()?.id, cardIds:validCards.map(card => card.id) })
      });
      const skipped = Number(result.skippedCount || 0);
      toast(`已创建 ${result.taskCount} 条任务${skipped ? `，保留 ${skipped} 张未完成卡片` : ''}。`);
      await loadState({ quiet:true });
      switchMonitorTab('tasks');
    } catch (error) { showError(error); }
  });
}

function connectEvents() {
  const source = new EventSource('/api/events');
  const refresh = () => loadState({ quiet:true });
  ['task_updated','task_deleted','tasks_deleted','batch_created','batch_updated','result_created','card_restored','prompt_history_reused','cards_bulk_created','cards_generation_count_updated','cards_filenames_updated'].forEach(name => source.addEventListener(name, refresh));
  source.onerror = () => setTimeout(() => loadState({ quiet:true }), 3000);
}

bindEvents();
loadState();
connectEvents();
setInterval(() => loadState({ quiet:true }), 10000);
