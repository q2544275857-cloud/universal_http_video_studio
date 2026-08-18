(() => {
  const state = {
    cookie: { file: null, status: 'missing' },
    saveDirectory: '',
    assetFolderName: '',
    assets: [],
    cards: [],
    tasks: [],
    activeTab: 'tasks',
    pickerCardId: null,
    pickerSelection: new Set(),
    taskSequence: 0
  };

  const el = id => document.getElementById(id);
  const uid = prefix => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const illegalFilename = /[\\/:*?"<>|]/;

  function normalizeAlias(value, fallback = '图片') {
    return String(value || fallback)
      .replace(/\.[^.]+$/, '')
      .trim()
      .replace(/\s+/g, '_')
      .replace(/[@\\/:*?"<>|，。,.!?；;：:]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 36) || fallback;
  }

  function escapeHtml(value = '') {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function toast(message, type = 'info') {
    const node = document.createElement('div');
    node.className = `toast ${type}`;
    node.textContent = message;
    el('toastRegion').appendChild(node);
    setTimeout(() => node.remove(), 3600);
  }

  function assetById(assetId) {
    return state.assets.find(asset => asset.id === assetId);
  }

  function cardById(cardId) {
    return state.cards.find(card => card.id === cardId);
  }

  function newCard(source = null) {
    const index = state.cards.length + 1;
    const card = {
      id: uid('card'),
      title: `提示词卡 ${index}`,
      assetIds: source ? [...source.assetIds] : [],
      prompt: source ? source.prompt : '',
      duration: source ? source.duration : 15,
      filename: source?.filename ? `${source.filename}_copy` : '',
      retryLimit: source ? source.retryLimit : 0,
      mentions: source ? source.mentions.map(item => ({ ...item })) : [],
      touched: false
    };
    state.cards.push(card);
    renderCards();
    updateGlobalState();
    setTimeout(() => {
      document.querySelector(`[data-card-id="${card.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 50);
  }

  function deleteCard(cardId) {
    const card = cardById(cardId);
    if (!card) return;
    if (!window.confirm(`删除“${card.title}”？已生成的历史任务不会被删除。`)) return;
    state.cards = state.cards.filter(item => item.id !== cardId);
    state.cards.forEach((item, index) => item.title = `提示词卡 ${index + 1}`);
    if (!state.cards.length) newCard();
    renderAssets();
    renderCards();
    updateGlobalState();
  }

  function referenceCount(assetId) {
    return state.cards.filter(card => card.assetIds.includes(assetId)).length;
  }

  async function handleAssetFolder(fileList) {
    const allFiles = [...fileList];
    const files = allFiles.filter(file => /\.(png|jpe?g|webp)$/i.test(file.name));
    if (!files.length) {
      toast('所选文件夹中没有 PNG、JPG、JPEG 或 WEBP 图片。', 'error');
      return;
    }

    if (state.assets.length) {
      const referenced = state.assets.filter(asset => referenceCount(asset.id) > 0).length;
      const message = referenced
        ? `重新选择文件夹会替换当前素材库，并解除 ${referenced} 张已引用图片的卡片绑定；提示词原文会保留。继续吗？`
        : '重新选择文件夹会替换当前素材库。继续吗？';
      if (!window.confirm(message)) return;
    }

    state.assets.forEach(asset => URL.revokeObjectURL(asset.url));
    state.cards.forEach(card => {
      card.assetIds = [];
      card.mentions = [];
    });
    state.assets = [];

    const firstRelativePath = files[0].webkitRelativePath || files[0].name;
    state.assetFolderName = firstRelativePath.includes('/')
      ? firstRelativePath.split('/')[0]
      : '已选择文件夹';

    const usedAliases = new Set();
    for (const file of files) {
      const url = URL.createObjectURL(file);
      const dimensions = await readImageDimensions(url);
      const baseAlias = normalizeAlias(file.name, `图片${state.assets.length + 1}`);
      let alias = baseAlias;
      let suffix = 2;
      while (usedAliases.has(alias.toLowerCase())) {
        alias = `${baseAlias}_${suffix++}`;
      }
      usedAliases.add(alias.toLowerCase());
      state.assets.push({
        id: uid('asset'),
        name: file.name,
        alias,
        relativePath: file.webkitRelativePath || file.name,
        size: file.size,
        type: file.type || 'image/unknown',
        url,
        width: dimensions.width,
        height: dimensions.height
      });
    }

    renderAssets();
    renderCards();
    updateGlobalState();
    toast(`已扫描“${state.assetFolderName}”，载入 ${state.assets.length} 张图片。`, 'success');
  }

  function readImageDimensions(url) {
    return new Promise(resolve => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => resolve({ width: 0, height: 0 });
      image.src = url;
    });
  }

  function renderAssets() {
    el('assetFolderStatus').textContent = state.assetFolderName
      ? `当前文件夹：${state.assetFolderName}`
      : '先选择图片文件夹';
    el('assetCount').textContent = state.assetFolderName
      ? `${state.assetFolderName} · ${state.assets.length} 张素材`
      : '0 张素材';
    const list = el('assetList');
    if (!state.assets.length) {
      list.className = 'asset-list empty-state';
      list.innerHTML = '<div class="empty-illustration">▧</div><p>尚未选择图片文件夹</p><span>选择文件夹后，提示词卡可从扫描结果中选图</span>';
      return;
    }

    list.className = 'asset-list';
    list.innerHTML = '';
    state.assets.forEach(asset => {
      const item = document.createElement('article');
      item.className = 'asset-item';
      item.innerHTML = `
        <img class="asset-thumb" src="${asset.url}" alt="${escapeHtml(asset.alias)}" />
        <button class="asset-delete" title="从本次素材库移除，不删除源文件">×</button>
        <div class="asset-info">
          <input class="asset-alias" value="${escapeHtml(asset.alias)}" title="点击修改素材别名" />
          <div class="asset-meta" title="${escapeHtml(asset.relativePath || asset.name)}">
            <span>${asset.width || '?'}×${asset.height || '?'}</span>
            <span>引用 ${referenceCount(asset.id)} 次</span>
          </div>
        </div>`;

      item.querySelector('.asset-delete').addEventListener('click', () => {
        const refs = referenceCount(asset.id);
        if (refs > 0) {
          toast(`该素材被 ${refs} 张提示词卡引用，请先从卡片移除。`, 'error');
          return;
        }
        URL.revokeObjectURL(asset.url);
        state.assets = state.assets.filter(item => item.id !== asset.id);
        renderAssets();
        renderCards();
        updateGlobalState();
      });

      item.querySelector('.asset-alias').addEventListener('change', event => {
        const nextAlias = normalizeAlias(event.target.value, asset.alias);
        if (!String(event.target.value || '').trim()) {
          event.target.value = asset.alias;
          toast('素材别名不能为空。', 'error');
          return;
        }
        const oldAlias = asset.alias;
        asset.alias = nextAlias;
        state.cards.forEach(card => {
          card.prompt = card.prompt.replaceAll(`@${oldAlias}`, `@${nextAlias}`);
          card.mentions.forEach(mention => {
            if (mention.assetId === asset.id) mention.label = nextAlias;
          });
        });
        renderAssets();
        renderCards();
      });

      list.appendChild(item);
    });
  }

  function validateCard(card) {
    const errors = {};
    if (!card.assetIds.length) errors.assets = '请至少选择 1 张参考图。';
    if (!String(card.prompt || '').trim()) errors.prompt = '提示词不能为空。';

    const duration = Number(card.duration);
    if (!Number.isInteger(duration) || duration < 5 || duration > 15) {
      errors.duration = '时长必须是 5–15 秒的整数。';
    }

    const retryLimit = Number(card.retryLimit);
    if (!Number.isInteger(retryLimit) || retryLimit < 0 || retryLimit > 5) {
      errors.retry = '重新提交次数必须是 0–5 的整数。';
    }

    if (card.filename && illegalFilename.test(card.filename)) {
      errors.filename = '文件名不能包含 \\ / : * ? " < > |。';
    }

    const selectedAliases = card.assetIds.map(id => assetById(id)?.alias).filter(Boolean);
    let mentionScan = String(card.prompt || '').replace(/\\@/g, '');
    selectedAliases.forEach(alias => {
      mentionScan = mentionScan.replaceAll(`@${alias}`, '');
    });
    const unresolved = [...mentionScan.matchAll(/@([^\s，。,.!?；;：:\n]*)/g)]
      .map(match => match[1])
      .filter((value, index, list) => list.indexOf(value) === index);
    if (unresolved.length) {
      const labels = unresolved.map(value => value ? `@${value}` : '未完成的 @ 引用');
      errors.prompt = `存在未绑定图片引用：${labels.join('、')}`;
    }

    return errors;
  }

  function compilePrompt(card) {
    let compiled = String(card.prompt || '').replace(/\\@/g, '__ESCAPED_AT__');
    card.assetIds.forEach((assetId, index) => {
      const asset = assetById(assetId);
      if (!asset) return;
      compiled = compiled.replaceAll(`@${asset.alias}`, `<|media:${index}|>`);
    });
    return compiled.replace(/__ESCAPED_AT__/g, '@');
  }

  function renderCards() {
    const list = el('promptCardList');
    list.innerHTML = '';

    state.cards.forEach((card, cardIndex) => {
      const fragment = el('promptCardTemplate').content.cloneNode(true);
      const node = fragment.querySelector('.prompt-card');
      node.dataset.cardId = card.id;
      node.querySelector('.card-index').textContent = String(cardIndex + 1).padStart(2, '0');
      node.querySelector('.card-title').textContent = card.title;

      const errors = validateCard(card);
      const valid = Object.keys(errors).length === 0;
      const status = node.querySelector('.card-status');
      if (valid) {
        node.classList.add('ready');
        status.textContent = '可提交';
        status.classList.add('ready-text');
      } else if (card.touched) {
        node.classList.add('invalid');
        status.textContent = '需要补充';
        status.classList.add('invalid-text');
      }

      node.querySelector('.duplicate-card').addEventListener('click', () => newCard(card));
      node.querySelector('.delete-card').addEventListener('click', () => deleteCard(card.id));

      renderSelectedAssets(node, card);
      node.querySelector('.select-assets-button').addEventListener('click', () => openAssetPicker(card.id));

      const promptInput = node.querySelector('.prompt-input');
      promptInput.value = card.prompt;
      node.querySelector('.character-count').textContent = `${card.prompt.length} 字`;
      updateMentionSummary(node, card);

      promptInput.addEventListener('input', event => {
        card.prompt = event.target.value;
        card.touched = true;
        node.querySelector('.character-count').textContent = `${card.prompt.length} 字`;
        maybeOpenMentionMenu(node, card, event.target);
        refreshCardValidation(node, card);
        updateMentionSummary(node, card);
        updateGlobalState();
      });
      promptInput.addEventListener('click', () => maybeOpenMentionMenu(node, card, promptInput));
      promptInput.addEventListener('blur', () => setTimeout(() => node.querySelector('.mention-menu').classList.add('hidden'), 180));

      const durationInput = node.querySelector('.duration-input');
      durationInput.value = card.duration;
      durationInput.addEventListener('input', event => {
        card.duration = Number(event.target.value);
        card.touched = true;
        refreshCardValidation(node, card);
        updateGlobalState();
      });

      const filenameInput = node.querySelector('.filename-input');
      filenameInput.value = card.filename;
      filenameInput.addEventListener('input', event => {
        card.filename = event.target.value.replace(/\.mp4$/i, '');
        event.target.value = card.filename;
        card.touched = true;
        refreshCardValidation(node, card);
        updateGlobalState();
      });

      const retryInput = node.querySelector('.retry-input');
      retryInput.value = card.retryLimit;
      retryInput.addEventListener('input', event => {
        card.retryLimit = Number(event.target.value);
        card.touched = true;
        refreshCardValidation(node, card);
        updateGlobalState();
      });

      if (valid && card.prompt.includes('@')) {
        const preview = node.querySelector('.compiled-preview');
        preview.classList.remove('hidden');
        preview.querySelector('code').textContent = compilePrompt(card);
      }

      writeFieldErrors(node, card.touched ? errors : {});
      list.appendChild(fragment);
    });
  }

  function renderSelectedAssets(node, card) {
    const holder = node.querySelector('.selected-assets');
    holder.innerHTML = '';
    card.assetIds.forEach((assetId, index) => {
      const asset = assetById(assetId);
      if (!asset) return;
      const chip = document.createElement('div');
      chip.className = 'selected-asset-chip';
      chip.draggable = true;
      chip.dataset.assetId = asset.id;
      chip.innerHTML = `
        <img src="${asset.url}" alt="${escapeHtml(asset.alias)}" />
        <span class="media-index">media:${index}</span>
        <button title="从本卡移除">×</button>
        <span title="${escapeHtml(asset.alias)}">${escapeHtml(asset.alias)}</span>`;
      chip.querySelector('button').addEventListener('click', () => {
        card.assetIds = card.assetIds.filter(id => id !== asset.id);
        card.mentions = card.mentions.filter(item => item.assetId !== asset.id);
        card.touched = true;
        renderAssets();
        renderCards();
        updateGlobalState();
      });
      chip.addEventListener('dragstart', event => event.dataTransfer.setData('text/plain', asset.id));
      chip.addEventListener('dragover', event => event.preventDefault());
      chip.addEventListener('drop', event => {
        event.preventDefault();
        const draggedId = event.dataTransfer.getData('text/plain');
        const from = card.assetIds.indexOf(draggedId);
        const to = card.assetIds.indexOf(asset.id);
        if (from < 0 || to < 0 || from === to) return;
        card.assetIds.splice(from, 1);
        card.assetIds.splice(to, 0, draggedId);
        renderCards();
      });
      holder.appendChild(chip);
    });
  }

  function writeFieldErrors(node, errors) {
    node.querySelector('.reference-field .field-error').textContent = errors.assets || '';
    node.querySelector('.prompt-field .field-error').textContent = errors.prompt || '';
    node.querySelector('.duration-field .field-error').textContent = errors.duration || '';
    node.querySelector('.filename-field .field-error').textContent = errors.filename || '';
    node.querySelector('.retry-field .field-error').textContent = errors.retry || '';
  }

  function refreshCardValidation(node, card) {
    const errors = validateCard(card);
    const valid = Object.keys(errors).length === 0;
    node.classList.toggle('invalid', card.touched && !valid);
    node.classList.toggle('ready', valid);
    const status = node.querySelector('.card-status');
    status.className = 'card-status';
    if (valid) {
      status.textContent = '可提交';
      status.classList.add('ready-text');
    } else if (card.touched) {
      status.textContent = '需要补充';
      status.classList.add('invalid-text');
    } else {
      status.textContent = '草稿';
    }
    writeFieldErrors(node, errors);
    const preview = node.querySelector('.compiled-preview');
    if (valid && card.prompt.includes('@')) {
      preview.classList.remove('hidden');
      preview.querySelector('code').textContent = compilePrompt(card);
    } else {
      preview.classList.add('hidden');
    }
  }

  function updateMentionSummary(node, card) {
    const labels = card.assetIds
      .map(id => assetById(id))
      .filter(Boolean)
      .filter(asset => card.prompt.includes(`@${asset.alias}`))
      .map(asset => `@${asset.alias}`);
    const summary = node.querySelector('.mention-summary');
    if (labels.length) {
      summary.textContent = `已引用 ${labels.length} 张图片：${labels.join('、')}`;
      summary.classList.add('has-mentions');
    } else {
      summary.textContent = '尚未使用 @ 图片引用';
      summary.classList.remove('has-mentions');
    }
  }

  function maybeOpenMentionMenu(node, card, textarea) {
    const beforeCursor = textarea.value.slice(0, textarea.selectionStart);
    const menu = node.querySelector('.mention-menu');
    if (!beforeCursor.endsWith('@')) {
      menu.classList.add('hidden');
      return;
    }
    menu.innerHTML = '';
    if (!card.assetIds.length) {
      menu.innerHTML = '<div class="mention-empty">请先为当前卡选择参考图。</div>';
    } else {
      card.assetIds.forEach(assetId => {
        const asset = assetById(assetId);
        if (!asset) return;
        const button = document.createElement('button');
        button.type = 'button';
        button.innerHTML = `<img src="${asset.url}" alt="" /><span>${escapeHtml(asset.alias)}</span>`;
        button.addEventListener('mousedown', event => {
          event.preventDefault();
          const cursor = textarea.selectionStart;
          const prefix = textarea.value.slice(0, cursor - 1);
          const suffix = textarea.value.slice(cursor);
          textarea.value = `${prefix}@${asset.alias} ${suffix}`;
          card.prompt = textarea.value;
          if (!card.mentions.some(item => item.assetId === asset.id)) {
            card.mentions.push({ assetId: asset.id, label: asset.alias });
          }
          textarea.focus();
          textarea.selectionStart = textarea.selectionEnd = prefix.length + asset.alias.length + 2;
          menu.classList.add('hidden');
          node.querySelector('.character-count').textContent = `${card.prompt.length} 字`;
          updateMentionSummary(node, card);
          refreshCardValidation(node, card);
          updateGlobalState();
        });
        menu.appendChild(button);
      });
    }
    menu.classList.remove('hidden');
  }

  function openAssetPicker(cardId) {
    if (!state.assets.length) {
      toast('请先在左侧素材库上传参考图片。', 'error');
      el('assetDropzone').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const card = cardById(cardId);
    state.pickerCardId = cardId;
    state.pickerSelection = new Set(card.assetIds);
    renderAssetPicker();
    el('assetPickerModal').classList.remove('hidden');
    el('assetPickerModal').setAttribute('aria-hidden', 'false');
  }

  function closeAssetPicker() {
    el('assetPickerModal').classList.add('hidden');
    el('assetPickerModal').setAttribute('aria-hidden', 'true');
    state.pickerCardId = null;
    state.pickerSelection.clear();
  }

  function renderAssetPicker() {
    const grid = el('assetPickerGrid');
    grid.innerHTML = '';
    state.assets.forEach(asset => {
      const selected = state.pickerSelection.has(asset.id);
      const node = document.createElement('button');
      node.className = `picker-asset ${selected ? 'selected' : ''}`;
      node.innerHTML = `
        <img src="${asset.url}" alt="${escapeHtml(asset.alias)}" />
        <span>${escapeHtml(asset.alias)}</span>
        <i class="picker-check">✓</i>`;
      node.addEventListener('click', () => {
        if (state.pickerSelection.has(asset.id)) {
          state.pickerSelection.delete(asset.id);
        } else if (state.pickerSelection.size >= 8) {
          toast('每张提示词卡最多选择 8 张参考图。', 'error');
          return;
        } else {
          state.pickerSelection.add(asset.id);
        }
        renderAssetPicker();
      });
      grid.appendChild(node);
    });
    el('assetPickerSelectionText').textContent = `已选择 ${state.pickerSelection.size} 张，最多 8 张`;
  }

  function confirmAssetPicker() {
    const card = cardById(state.pickerCardId);
    if (!card) return closeAssetPicker();
    const previousOrder = card.assetIds.filter(id => state.pickerSelection.has(id));
    const appended = state.assets.map(asset => asset.id).filter(id => state.pickerSelection.has(id) && !previousOrder.includes(id));
    card.assetIds = [...previousOrder, ...appended];
    card.mentions = card.mentions.filter(mention => card.assetIds.includes(mention.assetId));
    card.touched = true;
    closeAssetPicker();
    renderAssets();
    renderCards();
    updateGlobalState();
  }

  function validateGlobal(markTouched = false) {
    if (markTouched) state.cards.forEach(card => card.touched = true);
    const errors = [];
    if (state.cookie.status !== 'valid') errors.push('请上传并验证广告后台 Cookie。');
    if (!state.saveDirectory) errors.push('请选择视频保存目录。');
    if (!state.cards.length) errors.push('请至少新增一张提示词卡。');
    state.cards.forEach((card, index) => {
      const cardErrors = validateCard(card);
      Object.values(cardErrors).forEach(message => errors.push(`提示词卡 ${index + 1}：${message}`));
    });
    return errors;
  }

  function updateGlobalState() {
    const validCards = state.cards.filter(card => Object.keys(validateCard(card)).length === 0).length;
    const running = state.tasks.filter(task => !['completed', 'failed'].includes(task.status)).length;
    const completed = state.tasks.filter(task => task.status === 'completed').length;
    el('validCardCount').textContent = validCards;
    el('runningTaskCount').textContent = running;
    el('completedTaskCount').textContent = completed;
    el('taskTabCount').textContent = state.tasks.length;
    el('resultTabCount').textContent = completed;
    el('submitAllButton').disabled = validateGlobal(false).length > 0;
  }

  function showValidation(errors) {
    const banner = el('globalValidationBanner');
    if (!errors.length) {
      banner.classList.add('hidden');
      return;
    }
    banner.innerHTML = `<strong>提交前需要处理 ${errors.length} 个问题：</strong><br>${errors.slice(0, 6).map(escapeHtml).join('<br>')}${errors.length > 6 ? `<br>还有 ${errors.length - 6} 项……` : ''}`;
    banner.classList.remove('hidden');
    banner.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function submitAllCards() {
    const errors = validateGlobal(true);
    renderCards();
    showValidation(errors);
    if (errors.length) {
      toast('提交被阻止，请修正高亮字段。', 'error');
      return;
    }

    el('globalValidationBanner').classList.add('hidden');
    const timestamp = new Date();
    state.cards.forEach((card, index) => {
      state.taskSequence += 1;
      const filename = sanitizeFilename(card.filename) || autoFilename(timestamp, index + 1);
      const task = {
        id: uid('task'),
        number: state.taskSequence,
        cardId: card.id,
        cardTitle: card.title,
        assetIds: [...card.assetIds],
        promptRaw: card.prompt,
        promptCompiled: compilePrompt(card),
        duration: Number(card.duration),
        filename,
        retryLimit: Number(card.retryLimit),
        retryCount: 0,
        status: 'queued',
        progress: 4,
        detail: '等待上传参考图',
        taskId: '',
        videoUrl: '',
        downloadPath: '',
        error: ''
      };
      state.tasks.unshift(task);
      simulateTask(task);
    });

    renderTasks();
    switchTab('tasks');
    updateGlobalState();
    toast(`已创建 ${state.cards.length} 个模拟生成任务。`, 'success');
  }

  function sanitizeFilename(value) {
    return String(value || '')
      .replace(/\.mp4$/i, '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/[. ]+$/g, '')
      .trim()
      .slice(0, 120);
  }

  function autoFilename(date, index) {
    const pad = value => String(value).padStart(2, '0');
    return `video_${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}_${String(index).padStart(2, '0')}`;
  }

  function simulateTask(task) {
    const stages = [
      [350, 'uploading', 18, '正在上传或复用图片 CDN 资源'],
      [950, 'submitting', 32, '正在提交 HTTP 生成请求'],
      [1550, 'submitted', 43, '已获得 taskId，准备轮询'],
      [2350, 'polling', 58, '持续轮询远端任务状态'],
      [3500, 'polling', 68, '远端生成中，尚未出现视频链接'],
      [4700, 'video_ready', 82, '已发现视频链接'],
      [5350, 'downloading', 92, `正在下载到 ${state.saveDirectory}`],
      [6300, 'completed', 100, '下载完成并通过文件校验']
    ];

    stages.forEach(([delay, status, progress, detail]) => {
      setTimeout(() => {
        task.status = status;
        task.progress = progress;
        task.detail = detail;
        if (status === 'submitted') task.taskId = `task_${Math.random().toString(36).slice(2, 13)}`;
        if (status === 'video_ready') task.videoUrl = `https://example.invalid/video/${task.taskId}.mp4`;
        if (status === 'completed') task.downloadPath = `${state.saveDirectory}\\${task.filename}.mp4`;
        renderTasks();
        renderResults();
        updateGlobalState();
      }, delay);
    });
  }

  function taskStatusMeta(task) {
    const map = {
      queued: ['等待中', ''],
      uploading: ['上传素材', 'running'],
      submitting: ['提交中', 'running'],
      submitted: ['已提交', 'running'],
      polling: ['轮询中', 'running'],
      video_ready: ['视频就绪', 'running'],
      downloading: ['下载中', 'running'],
      completed: ['已完成', 'complete'],
      failed: ['失败', 'failed']
    };
    return map[task.status] || [task.status, ''];
  }

  function renderTasks() {
    const list = el('taskList');
    if (!state.tasks.length) {
      list.className = 'task-list empty-state horizontal-empty';
      list.innerHTML = '<div class="empty-illustration">◎</div><div><p>暂无生成任务</p><span>完成 Cookie、目录、素材和提示词卡配置后提交。</span></div>';
      return;
    }
    list.className = 'task-list';
    list.innerHTML = '';

    state.tasks.forEach(task => {
      const [label, type] = taskStatusMeta(task);
      const row = document.createElement('article');
      row.className = 'task-row';
      const mediaHtml = task.assetIds.slice(0, 4).map(id => {
        const asset = assetById(id);
        return asset ? `<img src="${asset.url}" title="${escapeHtml(asset.alias)}" alt="" />` : '';
      }).join('');
      const identifier = task.taskId || '等待 taskId';
      row.innerHTML = `
        <div class="task-number">${String(task.number).padStart(2, '0')}</div>
        <div class="task-name">
          <strong>${escapeHtml(task.filename)}.mp4</strong>
          <span>${escapeHtml(task.cardTitle)} · ${task.duration}s · 重提 ${task.retryLimit} 次</span>
          <div class="task-progress"><span style="width:${task.progress}%"></span></div>
        </div>
        <div class="task-media">${mediaHtml}</div>
        <div><span class="status-pill ${type}">${label}</span></div>
        <div class="task-detail" title="${escapeHtml(task.detail)}">${escapeHtml(task.detail)}<br>${escapeHtml(identifier)}</div>
        <div class="task-actions">
          <button class="task-detail-button">详情</button>
          ${task.status === 'failed' ? '<button class="task-retry-button">重试</button>' : ''}
        </div>`;
      row.querySelector('.task-detail-button').addEventListener('click', () => {
        window.alert([
          `文件：${task.filename}.mp4`,
          `状态：${label}`,
          `taskId：${task.taskId || '尚未生成'}`,
          `参考图：${task.assetIds.length} 张`,
          `原始提示词：${task.promptRaw}`,
          `编译提示词：${task.promptCompiled}`,
          `视频链接：${task.videoUrl || '尚未出现'}`,
          `保存路径：${task.downloadPath || '尚未下载'}`,
          `错误：${task.error || '无'}`
        ].join('\n\n'));
      });
      list.appendChild(row);
    });
  }

  function renderResults() {
    const results = state.tasks.filter(task => task.status === 'completed');
    const list = el('resultList');
    if (!results.length) {
      list.className = 'result-grid empty-state horizontal-empty';
      list.innerHTML = '<div class="empty-illustration">▶</div><div><p>暂无视频结果</p><span>获取视频链接并完成下载后显示在这里。</span></div>';
      return;
    }
    list.className = 'result-grid';
    list.innerHTML = '';
    results.forEach(task => {
      const card = document.createElement('article');
      card.className = 'result-card';
      card.innerHTML = `
        <div class="result-preview"><span class="result-duration">${task.duration}s</span></div>
        <div class="result-body">
          <strong title="${escapeHtml(task.filename)}.mp4">${escapeHtml(task.filename)}.mp4</strong>
          <p>${escapeHtml(task.cardTitle)} · ${task.assetIds.length} 张参考图</p>
          <p title="${escapeHtml(task.downloadPath)}">${escapeHtml(task.downloadPath)}</p>
          <div class="result-actions">
            <button class="open-result-button">打开目录</button>
            <button class="copy-link-button">复制链接</button>
          </div>
        </div>`;
      card.querySelector('.open-result-button').addEventListener('click', () => toast(`原型演示：打开 ${state.saveDirectory}`));
      card.querySelector('.copy-link-button').addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(task.videoUrl);
          toast('视频链接已复制。', 'success');
        } catch {
          toast(`视频链接：${task.videoUrl}`);
        }
      });
      list.appendChild(card);
    });
  }

  function switchTab(tabName) {
    state.activeTab = tabName;
    document.querySelectorAll('.tab').forEach(tab => tab.classList.toggle('active', tab.dataset.tab === tabName));
    el('tasksView').classList.toggle('active', tabName === 'tasks');
    el('resultsView').classList.toggle('active', tabName === 'results');
  }

  function bindEvents() {
    el('cookieUploadButton').addEventListener('click', () => el('cookieFileInput').click());
    el('cookieFileInput').addEventListener('change', event => {
      const file = event.target.files?.[0];
      if (!file) return;
      state.cookie.file = file;
      state.cookie.status = 'pending';
      el('cookieStatus').className = 'setting-status status-warn';
      el('cookieStatus').textContent = `${file.name} · 待验证`;
      el('verifyCookieButton').disabled = false;
      updateGlobalState();
    });

    el('verifyCookieButton').addEventListener('click', () => {
      if (!state.cookie.file) return;
      state.cookie.status = 'validating';
      el('cookieStatus').className = 'setting-status status-warn';
      el('cookieStatus').textContent = '正在验证登录状态……';
      el('verifyCookieButton').disabled = true;
      updateGlobalState();
      setTimeout(() => {
        state.cookie.status = 'valid';
        el('cookieStatus').className = 'setting-status status-good';
        el('cookieStatus').textContent = `${state.cookie.file.name} · 有效`;
        el('verifyCookieButton').disabled = false;
        updateGlobalState();
        toast('Cookie 验证通过（原型模拟）。', 'success');
      }, 800);
    });

    el('selectDirectoryButton').addEventListener('click', async () => {
      try {
        if ('showDirectoryPicker' in window) {
          const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
          state.saveDirectory = `已授权目录\\${handle.name}`;
        } else {
          const value = window.prompt('原型环境无法调用系统目录选择器，请输入演示保存路径：', 'D:\\VideoOutput');
          if (!value) return;
          state.saveDirectory = value;
        }
        el('directoryStatus').className = 'setting-status status-good';
        el('directoryStatus').textContent = state.saveDirectory;
        updateGlobalState();
      } catch (error) {
        if (error?.name !== 'AbortError') toast(`目录选择失败：${error.message}`, 'error');
      }
    });

    el('assetFolderButton').addEventListener('click', () => el('assetFolderInput').click());
    el('assetDropzone').addEventListener('click', () => el('assetFolderInput').click());
    el('assetDropzone').addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') el('assetFolderInput').click();
    });
    el('assetFolderInput').addEventListener('change', async event => {
      await handleAssetFolder(event.target.files);
      event.target.value = '';
    });

    el('clearUnusedAssetsButton').addEventListener('click', () => {
      const unused = state.assets.filter(asset => referenceCount(asset.id) === 0);
      if (!unused.length) return toast('没有可移除的未引用素材。');
      if (!window.confirm(`从本次素材库移除 ${unused.length} 张未引用素材？源文件不会被删除。`)) return;
      unused.forEach(asset => URL.revokeObjectURL(asset.url));
      state.assets = state.assets.filter(asset => referenceCount(asset.id) > 0);
      renderAssets();
      renderCards();
      updateGlobalState();
    });

    el('addPromptCardButton').addEventListener('click', () => newCard());
    el('closeAssetPickerButton').addEventListener('click', closeAssetPicker);
    el('confirmAssetPickerButton').addEventListener('click', confirmAssetPicker);
    el('assetPickerModal').addEventListener('click', event => {
      if (event.target === el('assetPickerModal')) closeAssetPicker();
    });
    el('submitAllButton').addEventListener('click', submitAllCards);

    document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));
    el('clearCompletedButton').addEventListener('click', () => {
      if (!state.tasks.length) return;
      if (!window.confirm('清除当前原型中的任务和结果记录？')) return;
      state.tasks = [];
      renderTasks();
      renderResults();
      updateGlobalState();
    });
  }

  function init() {
    bindEvents();
    newCard();
    renderAssets();
    renderTasks();
    renderResults();
    updateGlobalState();
  }

  init();
})();