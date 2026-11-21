/* Tradutor de HQ: lê o texto das páginas (OCR com Tesseract, no aparelho) e traduz para português por cima da imagem. */
'use strict';

const $ = (id) => document.getElementById(id);
const EXT_IMAGEM = /\.(jpe?g|jfif|png|webp|gif|bmp|avif)$/i;
const DESTINO = 'pt';
const LARGURA_OCR = 1500;   // largura em que a página é lida (bom equilíbrio entre precisão e velocidade)

// Idiomas do quadrinho: código do OCR -> código do Google e do tradutor offline do navegador
const IDIOMAS = {
  eng:     { google: 'en',    local: 'en',      nome: 'Inglês' },
  kor:     { google: 'ko',    local: 'ko',      nome: 'Coreano' },
  chi_sim: { google: 'zh-CN', local: 'zh',      nome: 'Chinês simplificado' },
  chi_tra: { google: 'zh-TW', local: 'zh-Hant', nome: 'Chinês tradicional' },
};
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u; // escritas sem espaço entre palavras
const JAMO = /[ㄱ-ㆎ]/g;  // pedaços soltos de letra coreana: sinal de leitura errada

// ------------------------------------------------------------ configurações
const PADRAO = { origem: 'eng', motor: 'google', maiusculas: true };
let cfg = { ...PADRAO };
try { Object.assign(cfg, JSON.parse(localStorage.getItem('cfg') || '{}')); } catch (_) {}
if (!IDIOMAS[cfg.origem]) cfg.origem = 'eng';
const salvarCfg = () => { try { localStorage.setItem('cfg', JSON.stringify(cfg)); } catch (_) {} };
const assinaturaCfg = () => `${cfg.origem}|${cfg.motor}`;

// ------------------------------------------------------------ estado
let paginas = [];      // { nome, obterBlob(), url, trabalho, resultado, assinatura }
let atual = 0;
let mostrarOriginal = false;

const ordemNatural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
function status(texto) { $('status').textContent = texto || ''; }

// ------------------------------------------------------------ abrir arquivos
async function abrirArquivos(lista) {
  const novas = [];
  const temZip = [...lista].some((a) => /\.(cbz|zip)$/i.test(a.name));
  for (const arq of lista) {
    if (/\.(cbz|zip)$/i.test(arq.name)) {
      status('Abrindo ' + arq.name + '…');
      const zip = await JSZip.loadAsync(arq);
      const entradas = Object.values(zip.files)
        .filter((e) => !e.dir && EXT_IMAGEM.test(e.name) && !e.name.startsWith('__MACOSX'))
        .sort((a, b) => ordemNatural(a.name, b.name));
      for (const e of entradas) novas.push({ nome: e.name.split('/').pop(), obterBlob: () => e.async('blob') });
    } else if (arq.type.startsWith('image/') || EXT_IMAGEM.test(arq.name)) {
      novas.push({ nome: arq.name, obterBlob: async () => arq });
    }
  }
  if (!novas.length) { status('Nenhuma imagem encontrada.'); return; }
  if (!temZip) novas.sort((a, b) => ordemNatural(a.nome, b.nome)); // pag2 antes de pag10
  paginas.forEach((p) => p.url && URL.revokeObjectURL(p.url));
  paginas = novas;
  $('vazio').hidden = true;
  $('palco').hidden = false;
  $('base').hidden = false;
  irPara(0);
}

// ------------------------------------------------------------ OCR
let ocrWorker = null, ocrIdioma = null, ocrModo = null;
let ocrFila = Promise.resolve();

async function obterOcr() {
  if (ocrWorker && ocrIdioma === cfg.origem) return ocrWorker;
  if (ocrWorker) { await ocrWorker.terminate(); ocrWorker = null; }
  const base = new URL('vendor/', location.href).href;
  status('Preparando leitor de texto (só demora na 1ª vez)…');
  ocrWorker = await Tesseract.createWorker(cfg.origem, 1, {
    workerPath: base + 'worker.min.js',
    corePath: base,
    workerBlobURL: false,
    logger: (m) => {
      if (m.status === 'loading language traineddata' && m.progress < 1) {
        status(`Baixando idioma ${IDIOMAS[cfg.origem].nome}… ${Math.round(m.progress * 100)}%`);
      }
    },
  });
  await ocrWorker.setParameters({ preserve_interword_spaces: '1' });
  ocrIdioma = cfg.origem;
  ocrModo = null;
  return ocrWorker;
}

/**
 * Lê uma imagem. modo '11' = texto espalhado (acha os balões na página);
 * modo '6' = bloco de texto (relê um balão já encontrado, com mais precisão).
 */
async function reconhecer(canvas, modo) {
  const worker = await obterOcr();
  const tarefa = ocrFila.then(async () => {
    if (ocrModo !== modo) { await worker.setParameters({ tessedit_pageseg_mode: modo }); ocrModo = modo; }
    return (await worker.recognize(canvas)).data;
  });
  ocrFila = tarefa.catch(() => {});
  return tarefa;
}

/**
 * Recorta um pedaço da página, deixa em preto e branco (contraste automático de Otsu)
 * e apaga linhas retas compridas (bordas de quadro e de legenda atrapalham o OCR).
 */
function prepararRecorte(bitmap, sx, sy, sw, sh, escala) {
  const w = Math.max(1, Math.round(sw * escala)), h = Math.max(1, Math.round(sh * escala));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const px = img.data;
  const cinza = new Uint8Array(w * h);
  const hist = new Uint32Array(256);
  for (let i = 0, j = 0; j < cinza.length; i += 4, j++) {
    const v = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000 | 0;
    cinza[j] = v; hist[v]++;
  }
  const total = w * h;
  let soma = 0; for (let t = 0; t < 256; t++) soma += t * hist[t];
  let somaB = 0, pesoB = 0, melhor = 0, limiar = 128;
  for (let t = 0; t < 256; t++) {
    pesoB += hist[t]; if (!pesoB) continue;
    const pesoF = total - pesoB; if (!pesoF) break;
    somaB += t * hist[t];
    const mB = somaB / pesoB, mF = (soma - somaB) / pesoF;
    const entre = pesoB * pesoF * (mB - mF) * (mB - mF);
    if (entre > melhor) { melhor = entre; limiar = t; }
  }
  const preto = new Uint8Array(w * h);
  for (let j = 0; j < preto.length; j++) preto[j] = cinza[j] <= limiar ? 1 : 0;

  // linhas retas: sequências de pixels pretos maiores que qualquer traço de letra
  const L = Math.max(60, Math.round(LARGURA_OCR * 0.06));
  const apagar = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let x = 0;
    while (x < w) {
      if (!preto[y * w + x]) { x++; continue; }
      const ini = x; while (x < w && preto[y * w + x]) x++;
      if (x - ini >= L) for (let k = ini; k < x; k++) apagar[y * w + k] = 1;
    }
  }
  for (let x = 0; x < w; x++) {
    let y = 0;
    while (y < h) {
      if (!preto[y * w + x]) { y++; continue; }
      const ini = y; while (y < h && preto[y * w + x]) y++;
      if (y - ini >= L) for (let k = ini; k < y; k++) apagar[k * w + x] = 1;
    }
  }
  for (let i = 0, j = 0; j < preto.length; i += 4, j++) {
    const v = preto[j] && !apagar[j] ? 0 : 255;
    px[i] = px[i + 1] = px[i + 2] = v; px[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function contarLetras(texto) { return (texto.match(/\p{L}/gu) || []).length; }

function textoValido(texto, confianca) {
  const letras = contarLetras(texto);
  const asiatico = /[\p{Script=Han}\p{Script=Hangul}]/u.test(texto);
  if (letras < (asiatico ? 1 : 2)) return false;
  if (letras === 1 && confianca < 75) return false;          // um caractere solto costuma ser ruído
  if (confianca < (asiatico ? 40 : 50)) return false;
  if ((texto.match(JAMO) || []).length / letras > 0.15) return false;
  return letras / texto.replace(/\s/g, '').length >= 0.5;
}

function limparTexto(texto) {
  return texto.replace(JAMO, '').replace(/\s+/g, ' ').trim()
    // em HQ o "!" no fim de palavra em maiúsculas costuma ser lido como "l" ou "|"
    .replace(/(\p{Lu}{2,})[l|](?=\s|$)/gu, '$1!')
    // o OCR às vezes põe espaço entre ideogramas chineses; o chinês não usa espaço
    .replace(/([\p{Script=Han}，。！？、：；…])\s+(?=[\p{Script=Han}，。！？、：；…])/gu, '$1');
}

/** Junta linhas em um texto só (sem espaço no chinês, desfazendo hifenização). */
function juntarLinhas(linhas) {
  let texto = '';
  for (const l of linhas) {
    if (!l) continue;
    if (texto.endsWith('-') && /^\p{L}/u.test(l)) texto = texto.slice(0, -1) + l;
    else if (CJK.test(texto.slice(-1)) && CJK.test(l[0])) texto += l;
    else texto += (texto ? ' ' : '') + l;
  }
  return texto;
}

/** 1ª leitura: acha as linhas de texto da página. Imagens altas (webtoon) são lidas em fatias. */
async function acharLinhas(bitmap, escala, aviso) {
  const W = bitmap.width, H = bitmap.height;
  const alturaFatia = Math.round(2600 / escala);
  const sobra = Math.round(250 / escala);
  const fatias = [];
  for (let y = 0; y < H; y += alturaFatia - sobra) {
    fatias.push({ y, h: Math.min(alturaFatia, H - y) });
    if (y + alturaFatia >= H) break;
  }
  const linhas = [];
  for (let i = 0; i < fatias.length; i++) {
    const f = fatias[i];
    if (fatias.length > 1) aviso(`Procurando os balões… parte ${i + 1} de ${fatias.length}`);
    const data = await reconhecer(prepararRecorte(bitmap, 0, f.y, W, f.h, escala), '11');
    // cada linha pertence à fatia que contém o seu centro (evita repetir o que está na sobreposição)
    const iniDono = i === 0 ? 0 : f.y + sobra / 2;
    const fimDono = i === fatias.length - 1 ? H : f.y + f.h - sobra / 2;
    for (const l of data.lines || []) {
      const texto = limparTexto(l.text);
      if (!textoValido(texto, l.confidence)) continue;
      const b = { x0: l.bbox.x0 / escala, x1: l.bbox.x1 / escala, y0: l.bbox.y0 / escala + f.y, y1: l.bbox.y1 / escala + f.y };
      const cy = (b.y0 + b.y1) / 2;
      if (cy >= iniDono && cy < fimDono) linhas.push({ texto, conf: l.confidence, ...b });
    }
  }
  return linhas;
}

/** Junta as linhas lidas em blocos (um por balão/legenda), na ordem de leitura. */
function agruparLinhas(linhas) {
  linhas.sort((a, b) => a.y0 - b.y0);
  const grupos = [];
  for (const l of linhas) {
    const h = l.y1 - l.y0, cx = (l.x0 + l.x1) / 2;
    let alvo = null;
    for (const g of grupos) {
      const u = g.linhas[g.linhas.length - 1];
      const hm = Math.max(h, u.y1 - u.y0);
      const gap = l.y0 - u.y1;
      const largura = Math.max(l.x1 - l.x0, u.x1 - u.x0);
      if (gap > -hm * 0.5 && gap < hm * 0.9 && Math.abs(cx - (u.x0 + u.x1) / 2) < largura * 0.6) { alvo = g; break; }
    }
    if (alvo) {
      alvo.linhas.push(l);
      alvo.x0 = Math.min(alvo.x0, l.x0); alvo.y0 = Math.min(alvo.y0, l.y0);
      alvo.x1 = Math.max(alvo.x1, l.x1); alvo.y1 = Math.max(alvo.y1, l.y1);
    } else {
      grupos.push({ linhas: [l], x0: l.x0, y0: l.y0, x1: l.x1, y1: l.y1 });
    }
  }
  const res = grupos.map((g) => ({
    x0: g.x0, y0: g.y0, x1: g.x1, y1: g.y1,
    original: juntarLinhas(g.linhas.map((l) => l.texto)),
    conf: g.linhas.reduce((s, l) => s + l.conf, 0) / g.linhas.length,
    alturaLinha: g.linhas.reduce((s, l) => s + (l.y1 - l.y0), 0) / g.linhas.length,
  }));
  // ordem de leitura: de cima para baixo; balões na mesma altura, da esquerda para a direita
  return res.sort((a, b) => {
    const mesmaFaixa = Math.abs(a.y0 - b.y0) < Math.min(a.y1 - a.y0, b.y1 - b.y0) * 0.5;
    return mesmaFaixa ? a.x0 - b.x0 : a.y0 - b.y0;
  });
}

/** 2ª leitura: relê cada balão recortado, no modo "bloco de texto", que é mais preciso. */
async function relerBalao(bitmap, g, escala) {
  const lh = g.alturaLinha;
  const x0 = Math.max(0, g.x0 - lh * 1.5), y0 = Math.max(0, g.y0 - lh * 0.6);
  const x1 = Math.min(bitmap.width, g.x1 + lh * 1.5), y1 = Math.min(bitmap.height, g.y1 + lh * 0.6);
  const data = await reconhecer(prepararRecorte(bitmap, x0, y0, x1 - x0, y1 - y0, escala), '6');
  const linhas = [];
  let somaConf = 0, nPalavras = 0;
  for (const l of data.lines || []) {
    const boas = (l.words || [])
      .filter((w) => (w.confidence >= 30 && /[\p{L}\d]/u.test(w.text)) || /^[!?.,…！？。，、]+$/.test(w.text.trim()))
      .sort((a, b) => a.bbox.x0 - b.bbox.x0);
    let linha = '';
    boas.forEach((w, k) => {
      somaConf += w.confidence; nPalavras++;
      // espaço só onde há distância de verdade entre as palavras (o coreano vem sílaba por sílaba)
      const ant = boas[k - 1];
      const espaco = ant && (w.bbox.x0 - ant.bbox.x1) > (ant.bbox.y1 - ant.bbox.y0) * 0.3;
      linha += (espaco ? ' ' : '') + w.text;
    });
    linhas.push(limparTexto(linha));
  }
  const texto = juntarLinhas(linhas);
  const conf = nPalavras ? somaConf / nPalavras : 0;
  // usa a releitura só quando a 1ª leitura perdeu texto e a releitura é confiável
  if (conf >= 60 && textoValido(texto, conf) && contarLetras(texto) > contarLetras(g.original) * 1.1) g.original = texto;
}

// ------------------------------------------------------------ cor do fundo e tamanho do balão
/** Cópia pequena e colorida da página, para descobrir a cor do balão. */
function amostraColorida(bitmap) {
  const s = Math.min(1, 700 / bitmap.width, 16000 / bitmap.height);
  const w = Math.max(1, Math.round(bitmap.width * s)), h = Math.max(1, Math.round(bitmap.height * s));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  return { s, w, h, px: ctx.getImageData(0, 0, w, h).data };
}

const distCor = (px, i, c) => Math.abs(px[i] - c[0]) + Math.abs(px[i + 1] - c[1]) + Math.abs(px[i + 2] - c[2]);

/** Cor mais comum dentro da área (o fundo do balão; o texto ocupa a menor parte). */
function corDeFundo(a, x0, y0, x1, y1) {
  const cont = new Map();
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = (y * a.w + x) * 4;
    const k = (a.px[i] >> 4) << 8 | (a.px[i + 1] >> 4) << 4 | (a.px[i + 2] >> 4);
    const v = cont.get(k);
    if (v) { v.n++; v.r += a.px[i]; v.g += a.px[i + 1]; v.b += a.px[i + 2]; }
    else cont.set(k, { n: 1, r: a.px[i], g: a.px[i + 1], b: a.px[i + 2] });
  }
  let top = null;
  for (const v of cont.values()) if (!top || v.n > top.n) top = v;
  return top ? [top.r / top.n, top.g / top.n, top.b / top.n] : [255, 255, 255];
}

/** Proporção de pixels de uma faixa parecidos com a cor do fundo. */
function faixaLimpa(a, cor, x0, y0, x1, y1) {
  let ok = 0, tot = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    tot++; if (distCor(a.px, (y * a.w + x) * 4, cor) < 60) ok++;
  }
  return tot ? ok / tot : 0;
}

/**
 * Descobre a cor do balão e aumenta a caixa até perto da borda dele,
 * para a tradução (que costuma ser maior que o original) ter espaço.
 */
function ajustarAoBalao(g, a, W, H) {
  const folga = g.alturaLinha * 0.3;
  let x0 = Math.max(0, Math.floor((g.x0 - folga) * a.s)), y0 = Math.max(0, Math.floor((g.y0 - folga) * a.s));
  let x1 = Math.min(a.w - 1, Math.ceil((g.x1 + folga) * a.s)), y1 = Math.min(a.h - 1, Math.ceil((g.y1 + folga) * a.s));
  const cor = corDeFundo(a, x0, y0, x1, y1);
  const limX = (x1 - x0) * 0.6, limY = (y1 - y0) * 0.8;  // cresce no máximo isso de cada lado
  let cresceu = true, ex = 0, ey = 0;
  while (cresceu) {
    cresceu = false;
    if (ex < limX && x0 > 0 && x1 < a.w - 1 &&
        faixaLimpa(a, cor, x0 - 1, y0, x0 - 1, y1) > 0.92 && faixaLimpa(a, cor, x1 + 1, y0, x1 + 1, y1) > 0.92) {
      x0--; x1++; ex++; cresceu = true;
    }
    if (ey < limY && y0 > 0 && y1 < a.h - 1 &&
        faixaLimpa(a, cor, x0, y0 - 1, x1, y0 - 1) > 0.92 && faixaLimpa(a, cor, x0, y1 + 1, x1, y1 + 1) > 0.92) {
      y0--; y1++; ey++; cresceu = true;
    }
  }
  const lum = (cor[0] * 299 + cor[1] * 587 + cor[2] * 114) / 1000;
  return {
    x0: Math.max(0, x0 / a.s), y0: Math.max(0, y0 / a.s),
    x1: Math.min(W, (x1 + 1) / a.s), y1: Math.min(H, (y1 + 1) / a.s),
    fundo: `rgb(${cor.map(Math.round).join(',')})`,
    tinta: lum > 140 ? '#111' : '#fff',
  };
}

async function lerPagina(blob, aviso) {
  const bitmap = await createImageBitmap(blob);
  try {
    const W = bitmap.width, H = bitmap.height;
    const escala = Math.min(2, Math.max(0.4, LARGURA_OCR / W));
    const grupos = agruparLinhas(await acharLinhas(bitmap, escala, aviso));
    for (let i = 0; i < grupos.length; i++) {
      aviso(`Lendo balão ${i + 1} de ${grupos.length}…`);
      await relerBalao(bitmap, grupos[i], escala);
    }
    const amostra = amostraColorida(bitmap);
    grupos.forEach((g) => { g.caixa = ajustarAoBalao(g, amostra, W, H); });
    return { W, H, grupos };
  } finally {
    bitmap.close && bitmap.close();
  }
}

// ------------------------------------------------------------ tradução com contexto
/** TEXTO TODO EM MAIÚSCULAS -> "Texto em frase normal": tradutores erram menos assim. */
function paraFraseNormal(t) {
  const latinas = t.match(/\p{Script=Latin}/gu) || [];
  if (latinas.length < 3) return t;
  const maiusculas = latinas.filter((c) => c !== c.toLowerCase()).length;
  if (maiusculas / latinas.length < 0.8) return t;
  return t.toLowerCase()
    .replace(/(^|[.!?…]\s+)(\p{L})/gu, (_, a, b) => a + b.toUpperCase())
    .replace(/\bi\b/g, 'I');
}
const primeiraMaiuscula = (t) => t ? t.charAt(0).toLocaleUpperCase('pt-BR') + t.slice(1) : t;

async function traduzirGoogle(textos, de) {
  // vários textos numa chamada; cada um volta separado
  const url = `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=${de}&tl=${DESTINO}&` +
    textos.map((t) => 'q=' + encodeURIComponent(t)).join('&');
  const r = await fetch(url);
  if (!r.ok) throw new Error(r.status === 429 ? 'Google limitou os pedidos; espere uns minutos.' : 'Google respondeu ' + r.status);
  return (await r.json()).map((item) => (Array.isArray(item) ? item[0] : item));
}

let tradutorLocal = null, tradutorLocalChave = '';
const suportaLocal = () => 'Translator' in self;

async function traduzirLocal(textos, de) {
  if (!suportaLocal()) throw new Error('este navegador não tem tradutor no aparelho');
  const opcoes = { sourceLanguage: de, targetLanguage: DESTINO };
  const chave = JSON.stringify(opcoes);
  if (!tradutorLocal || tradutorLocalChave !== chave) {
    const disp = await Translator.availability(opcoes);
    if (disp === 'unavailable') throw new Error('idioma não disponível offline neste aparelho');
    tradutorLocal = await Translator.create({
      ...opcoes,
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => status(`Baixando tradutor offline… ${Math.round(e.loaded * 100)}%`));
      },
    });
    tradutorLocalChave = chave;
  }
  const saida = [];
  for (const t of textos) saida.push(await tradutorLocal.translate(t));
  return saida;
}

async function chamarTradutor(textos) {
  const idioma = IDIOMAS[cfg.origem];
  if (cfg.motor === 'local') {
    try { return await traduzirLocal(textos, idioma.local); }
    catch (e) { status('Offline falhou (' + e.message + '); usando Google.'); }
  }
  return traduzirGoogle(textos, idioma.google);
}

/**
 * Traduz os balões de uma página juntos, um por linha, na ordem de leitura,
 * com os últimos balões da página anterior na frente como contexto.
 * Assim o tradutor entende a conversa (quem fala, gênero, tempo verbal),
 * em vez de traduzir cada frase solta.
 */
async function traduzirPagina(textos, contexto) {
  if (!textos.length) return [];
  const prep = (t) => paraFraseNormal(t).replace(/\n/g, ' ');
  const resultado = [];
  // divide em pedaços que cabem numa chamada, sempre levando contexto
  let i = 0;
  while (i < textos.length) {
    const ctx = (i === 0 ? contexto : textos.slice(Math.max(0, i - 3), i)).map(prep);
    const pedaco = [];
    let tamanho = encodeURIComponent(ctx.join('\n')).length;
    while (i < textos.length && (!pedaco.length || tamanho + encodeURIComponent(prep(textos[i])).length < 1700)) {
      pedaco.push(prep(textos[i])); tamanho += encodeURIComponent(pedaco[pedaco.length - 1]).length + 3; i++;
    }
    let saida = null;
    try {
      const [junto] = await chamarTradutor([[...ctx, ...pedaco].join('\n')]);
      const partes = junto.split('\n').map((s) => s.trim());
      if (partes.length === ctx.length + pedaco.length) saida = partes.slice(ctx.length);
    } catch (e) {
      if (/limitou/.test(e.message)) throw e;
    }
    // se o tradutor misturou as linhas, traduz balão por balão (sem perder nenhum)
    if (!saida) saida = await chamarTradutor(pedaco);
    resultado.push(...saida.map(primeiraMaiuscula));
  }
  return resultado;
}

// ------------------------------------------------------------ processar uma página
function processar(indice) {
  const p = paginas[indice];
  if (!p) return null;
  if (p.trabalho && p.assinatura === assinaturaCfg()) return p.trabalho;
  p.assinatura = assinaturaCfg();
  p.resultado = null;
  p.trabalho = (async () => {
    const aviso = (t) => { if (indice === atual) status(t); };
    aviso('Procurando os balões…');
    const r = await lerPagina(await p.obterBlob(), aviso);
    aviso(r.grupos.length ? `Traduzindo ${r.grupos.length} balão(ões)…` : 'Nenhum texto encontrado.');
    const anterior = paginas[indice - 1]?.resultado;
    const contexto = anterior ? anterior.grupos.slice(-3).map((g) => g.original) : [];
    const traducoes = await traduzirPagina(r.grupos.map((g) => g.original), contexto);
    r.grupos.forEach((g, i) => { g.traducao = traducoes[i] || g.original; });
    p.resultado = r;
    return r;
  })();
  p.trabalho.catch(() => { p.trabalho = null; });
  return p.trabalho;
}

// ------------------------------------------------------------ exibir
async function irPara(indice) {
  if (indice < 0 || indice >= paginas.length) return;
  atual = indice;
  const p = paginas[indice];
  $('contador').textContent = `Página ${indice + 1} de ${paginas.length}`;
  $('btnAnt').disabled = indice === 0;
  $('btnProx').disabled = indice === paginas.length - 1;
  $('camada').innerHTML = '';
  paginas.forEach((q, i) => { if (q.url && Math.abs(i - indice) > 2) { URL.revokeObjectURL(q.url); q.url = null; } });
  if (!p.url) p.url = URL.createObjectURL(await p.obterBlob());
  if (indice !== atual) return;
  $('imagem').src = p.url;
  $('visor').scrollTop = 0;

  try {
    const r = await processar(indice);
    if (indice !== atual) return;
    desenhar(r);
    status(r.grupos.length ? '' : 'Nenhum texto encontrado nesta página.');
  } catch (e) {
    if (indice === atual) status('Erro: ' + e.message);
    console.error(e);
  }
  // já adianta a próxima página enquanto você lê
  if (indice + 1 < paginas.length) processar(indice + 1)?.catch(() => {});
}

function desenhar(r) {
  const camada = $('camada');
  camada.innerHTML = '';
  for (const g of r.grupos) {
    const c = g.caixa;
    const div = document.createElement('div');
    div.className = 'caixa' + (cfg.maiusculas ? ' maiusculas' : '');
    Object.assign(div.style, {
      left: (c.x0 / r.W * 100) + '%',
      top: (c.y0 / r.H * 100) + '%',
      width: ((c.x1 - c.x0) / r.W * 100) + '%',
      height: ((c.y1 - c.y0) / r.H * 100) + '%',
      background: c.fundo,
      color: c.tinta,
    });
    div.textContent = g.traducao;
    div.dataset.alturaLinha = g.alturaLinha / r.W; // relativo à largura da imagem
    div.title = g.original;
    div.addEventListener('click', () => {
      const original = div.classList.toggle('original');
      div.textContent = original ? g.original : g.traducao;
      ajustarFonte(div);
    });
    camada.appendChild(div);
  }
  ajustarTodas();
}

function ajustarFonte(div) {
  const larguraImg = $('imagem').clientWidth;
  if (!larguraImg) return;
  let tamanho = Math.min(40, Math.max(8, parseFloat(div.dataset.alturaLinha) * larguraImg * 1.05));
  div.style.fontSize = tamanho + 'px';
  while ((div.scrollHeight > div.clientHeight + 1 || div.scrollWidth > div.clientWidth + 1) && tamanho > 6) {
    tamanho -= 0.5;
    div.style.fontSize = tamanho + 'px';
  }
}
const ajustarTodas = () => document.querySelectorAll('.caixa').forEach(ajustarFonte);

// ------------------------------------------------------------ eventos
function abrirSeletor() { $('arquivos').click(); }
$('btnAbrir').onclick = abrirSeletor;
$('btnAbrirGrande').onclick = abrirSeletor;
$('arquivos').onchange = (e) => { if (e.target.files.length) abrirArquivos(e.target.files); e.target.value = ''; };
$('btnAnt').onclick = () => irPara(atual - 1);
$('btnProx').onclick = () => irPara(atual + 1);
$('btnOriginal').onclick = () => {
  mostrarOriginal = !mostrarOriginal;
  $('camada').classList.toggle('oculta', mostrarOriginal);
  $('btnOriginal').classList.toggle('ativo', mostrarOriginal);
  $('btnOriginal').textContent = mostrarOriginal ? 'Ver tradução' : 'Ver original';
};
$('imagem').addEventListener('load', ajustarTodas);
new ResizeObserver(ajustarTodas).observe($('palco'));

document.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight') irPara(atual + 1);
  if (e.key === 'ArrowLeft') irPara(atual - 1);
});

// deslizar para trocar de página (ignora quando está com zoom)
let toque = null;
$('visor').addEventListener('touchstart', (e) => {
  toque = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
}, { passive: true });
$('visor').addEventListener('touchend', (e) => {
  if (!toque || !paginas.length) return;
  const dx = e.changedTouches[0].clientX - toque.x, dy = e.changedTouches[0].clientY - toque.y;
  const comZoom = window.visualViewport && window.visualViewport.scale > 1.05;
  if (!comZoom && Math.abs(dx) > 70 && Math.abs(dy) < 60) irPara(atual + (dx < 0 ? 1 : -1));
  toque = null;
});

// configurações
$('btnConfig').onclick = () => {
  $('cfgOrigem').value = cfg.origem;
  $('cfgMotor').value = cfg.motor;
  $('cfgMaiusculas').checked = cfg.maiusculas;
  $('infoLocal').textContent = suportaLocal()
    ? 'Este navegador tem tradutor no aparelho: na primeira vez ele baixa o idioma, depois funciona sem internet.'
    : 'Este navegador não tem tradutor no aparelho; o modo offline vai usar o Google como reserva.';
  $('config').showModal();
};
$('config').addEventListener('close', () => {
  if ($('config').returnValue !== 'ok') return;
  cfg = { origem: $('cfgOrigem').value, motor: $('cfgMotor').value, maiusculas: $('cfgMaiusculas').checked };
  salvarCfg();
  if (paginas.length) irPara(atual); // refaz com as novas opções
});

// funciona offline e pode ser instalado
if ('serviceWorker' in navigator && !new URLSearchParams(location.search).has('semsw')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
