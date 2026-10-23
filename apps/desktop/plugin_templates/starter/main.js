'use strict';

async function start() {
  await GuziPlugin.ready();
  const saved = await GuziPlugin.storage.get('note');
  document.getElementById('note').value = saved || '';
  document.getElementById('status').textContent = '已连接谷子';
  document.getElementById('save').addEventListener('click', async () => {
    await GuziPlugin.storage.set('note', document.getElementById('note').value);
    GuziPlugin.ui.toast('已保存');
  });
}

start().catch((error) => {
  document.getElementById('status').textContent = error.message;
  console.error(error);
});
