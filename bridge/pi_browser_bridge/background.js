// background.js - Pi Browser Bridge service worker bootstrap.
try {
  importScripts('config.js', 'protocol.js', 'cdp.js', 'runtime.js', 'wait.js', 'network.js', 'hook.js', 'evidence.js', 'frame.js', 'html.js', 'screenshot.js', 'transfer.js', 'bridge_info.js', 'core_commands.js', 'exec.js', 'router.js', 'tab_sync.js', 'transport.js');
} catch (e) {
  console.error('[PI-BROWSER] bridge bootstrap failed:', e && e.message ? e.message : e);
}
