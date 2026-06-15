// Disable alert/confirm/prompt to prevent page JS from blocking extension
(function() {
  const _log = console.log.bind(console);
  function toast(type: string, msg: unknown): void {
    _log('[BROWSER-PILOT] ' + type + ' suppressed:', msg);
    try {
      const d = document.createElement('div');
      d.textContent = '[' + type + '] ' + msg;
      Object.assign(d.style, {
        position:'fixed', top:'12px', right:'12px', zIndex:'2147483647',
        background:'#222', color:'#fff', padding:'10px 18px', borderRadius:'8px',
        fontSize:'14px', maxWidth:'420px', wordBreak:'break-all',
        boxShadow:'0 4px 16px rgba(0,0,0,.3)', opacity:'1',
        transition:'opacity .5s', pointerEvents:'none'
      });
      (document.body || document.documentElement).appendChild(d);
      setTimeout(() => { d.style.opacity = '0'; }, 3000);
      setTimeout(() => { d.remove(); }, 3600);
    } catch (_error) {
      /* best-effort toast rendering */
    }
  }
  function promptAcceptedValue(args: unknown[]): string {
    return args.length > 1 ? String(args[1]) : '';
  }
  window.alert = function(msg?: unknown): void { toast('alert', msg); };
  window.confirm = function(msg?: string): boolean { toast('confirm', msg); return true; };
  window.prompt = function(...args: unknown[]): string {
    toast('prompt', args[0]);
    return promptAcceptedValue(args);
  };
})();

export {};
