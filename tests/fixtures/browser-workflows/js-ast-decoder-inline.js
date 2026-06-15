const table = ['zero','one','two'];
function dec(i){ return table[i]; }
const alias = dec;
const msg = alias(1) + '-' + alias(2);
