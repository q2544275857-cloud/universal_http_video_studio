import { app, BrowserWindow } from 'electron';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  try {
    await window.loadURL('http://127.0.0.1:4174');
    await sleep(1200);
    const result = await window.webContents.executeJavaScript(`
      (async () => {
        const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
        const card = document.querySelector('.prompt-card');
        const preview = document.querySelector('.prompt-preview');
        const editButton = document.querySelector('.edit-prompt');
        if (!card || !preview || !editButton) throw new Error('提示词卡或编辑按钮不存在');
        editButton.click();
        await wait(120);
        const dialog = document.querySelector('#promptEditorDialog');
        const textarea = document.querySelector('#promptEditorTextarea');
        if (!dialog?.open || !textarea) throw new Error('独立提示词编辑器未打开');
        const original = textarea.value;
        textarea.value = original + '\\n@';
        textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(120);
        const optionAliases = [...document.querySelectorAll('#promptEditorMentionMenu .mention-option b')]
          .map(node => node.textContent.replace(/^@/, ''));
        const attachmentAliases = [...document.querySelectorAll('#promptEditorAttachments .prompt-editor-attachment span')]
          .map(node => node.textContent.replace(/^@/, ''));
        const onlyAttachments = optionAliases.every(alias => attachmentAliases.includes(alias));
        const dialogCard = document.querySelector('.prompt-editor-dialog-card');
        const attachments = document.querySelector('#promptEditorAttachments');
        const footer = dialogCard?.querySelector('.dialog-footer');
        const editorOverflow = {
          dialogClientWidth: dialog.clientWidth,
          dialogScrollWidth: dialog.scrollWidth,
          cardClientWidth: dialogCard?.clientWidth || 0,
          cardScrollWidth: dialogCard?.scrollWidth || 0,
          textareaClientWidth: textarea.clientWidth,
          textareaScrollWidth: textarea.scrollWidth,
          attachmentsClientWidth: attachments?.clientWidth || 0,
          attachmentsScrollWidth: attachments?.scrollWidth || 0,
          footerBottom: footer ? Math.round(footer.getBoundingClientRect().bottom) : 0,
          viewportHeight: window.innerHeight
        };
        document.querySelector('#cancelPromptEditorButton').click();
        await wait(80);
        const taskPromptButton = document.querySelector('.task-prompt');
        if (taskPromptButton) taskPromptButton.click();
        await wait(100);
        const taskDialog = document.querySelector('#taskPromptDialog');
        const taskPromptLength = document.querySelector('#taskPromptContent')?.textContent.length || 0;
        if (taskDialog?.open) document.querySelector('#closeTaskPromptButton').click();
        document.querySelector('#resultsTab')?.click();
        await wait(100);
        const resultCard = document.querySelector('.result-card');
        return {
          cardHeight: Math.round(card.getBoundingClientRect().height),
          previewClientHeight: preview.clientHeight,
          previewScrollHeight: preview.scrollHeight,
          previewScrollable: preview.scrollHeight > preview.clientHeight,
          editorOpen: dialog.open === false,
          attachmentCount: attachmentAliases.length,
          mentionOptionCount: optionAliases.length,
          mentionOnlyUsesAttachments: onlyAttachments,
          editorOverflow,
          resultCardHeight: resultCard ? Math.round(resultCard.getBoundingClientRect().height) : null,
          taskPromptButtonPresent: Boolean(taskPromptButton),
          taskPromptContentLength: taskPromptLength
        };
      })()
    `);
    const ok = result.cardHeight === 610
      && result.previewScrollable
      && result.mentionOnlyUsesAttachments
      && result.editorOverflow.dialogScrollWidth <= result.editorOverflow.dialogClientWidth
      && result.editorOverflow.cardScrollWidth <= result.editorOverflow.cardClientWidth
      && result.editorOverflow.textareaScrollWidth <= result.editorOverflow.textareaClientWidth
      && result.editorOverflow.attachmentsScrollWidth <= result.editorOverflow.attachmentsClientWidth
      && result.editorOverflow.footerBottom <= result.editorOverflow.viewportHeight
      && result.taskPromptButtonPresent
      && result.taskPromptContentLength > 0
      && (result.resultCardHeight == null || result.resultCardHeight === 500);
    console.log(JSON.stringify({ ok, ...result }, null, 2));
    app.exit(ok ? 0 : 1);
  } catch (error) {
    console.error(error.stack || error.message || String(error));
    app.exit(1);
  }
});
