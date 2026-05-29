const dispatch = {
  ok: () => 'done',
  fail: () => 'stop',
  retry: () => 'again'
};
const value = dispatch['ok']();
