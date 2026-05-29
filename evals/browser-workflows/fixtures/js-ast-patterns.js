const table = ['x','y','z'];
function dec(i){ return table[i]; }
const alias = dec;
const dispatch = {
  ok: () => alias(0),
  fail: () => alias(1),
  retry: () => alias(2),
};
function run(k){ return dispatch[k](); }
