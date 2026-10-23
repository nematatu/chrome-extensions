// Loopback fixture only. The worker is real; native Chrome APIs use a Node adapter.
const fixtureListeners = [];
const fixtureApiSuffix = new URLSearchParams(location.search).get('hls') === '1' ? '?hls=1' : '';
window.chrome = {runtime: {id:'test-extension-id', onMessage:{addListener(listener) {fixtureListeners.push(listener);}},
  async sendMessage(message) {
    const response = await fetch('/api/message' + fixtureApiSuffix, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(message)});
    const result = await response.json();
    if (result.batch) for (const item of result.batch.items) {
      const previews = {'sample.webm':'geometry.png','geometry.png':'geometry.png','colors.jpg':'colors.jpg'};
      item.thumbnail = previews[item.name] ? '/fixtures/' + previews[item.name] : null;
    }
    return result;
  },
}};
for (const [id, action] of [['progress-demo','progress'],['fail-demo','fail'],['complete-demo','complete'],['scan-error-demo','scan-error']]) {
  document.getElementById(id).addEventListener('click', async () => {
    await fetch('/api/demo' + fixtureApiSuffix, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action})});
    for (const listener of fixtureListeners) listener({type:'page-media-bulk:updated'});
  });
}
