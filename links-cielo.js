// Links de pagamento da Cielo de cada escola, entre aspas.
// cartao = link do cartão de crédito | pix = link do PIX. Deixe '' enquanto não tiver o link.
// Depois de salvar, faça o deploy/reinicie o servidor para valer.
module.exports = {
  'fundamental':   { cartao: 'https://cielolink.com.br/4zyRPzp', pix: 'https://cielolink.com.br/4AeIQTL' },
  'cariacica':     { cartao: 'https://cielolink.com.br/48JnrGt', pix: 'https://cielolink.com.br/4C64njx' }, // confira: o link do cartão é igual ao do Brilho de Sol
  'brilho-de-sol': { cartao: 'https://cielolink.com.br/48JnrGt', pix: 'https://cielolink.com.br/4zsJop5' },
  'salve-rainha':  { cartao: 'https://cielolink.com.br/4j16ayt', pix: 'https://cielolink.com.br/4z1GQx5' },
};