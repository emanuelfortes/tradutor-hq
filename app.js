/* Tradutor de HQ: lê o texto das páginas (OCR com PaddleOCR, no aparelho) e traduz para português por cima da imagem. */
'use strict';

const $ = (id) => document.getElementById(id);
const EXT_IMAGEM = /\.(jpe?g|jfif|png|webp|gif|bmp|avif)$/i;

// Idiomas do quadrinho: código do OCR -> código do Google e do tradutor offline do navegador.
// escrita: 'latina' (palavras separadas por espaço), 'coreana' (espaço entre blocos de sílabas), 'chinesa' (sem espaço)
const IDIOMAS = {
  eng:     { google: 'en',    local: 'en',      nome: 'Inglês',              escrita: 'latina' },
  spa:     { google: 'es',    local: 'es',      nome: 'Espanhol',            escrita: 'latina' },
  kor:     { google: 'ko',    local: 'ko',      nome: 'Coreano',             escrita: 'coreana' },
  chi_sim: { google: 'zh-CN', local: 'zh',      nome: 'Chinês simplificado', escrita: 'chinesa' },
  chi_tra: { google: 'zh-TW', local: 'zh-Hant', nome: 'Chinês tradicional',  escrita: 'chinesa' },
};
// Idiomas para os quais dá para traduzir
const DESTINOS = { pt: 'Português', es: 'Espanhol', en: 'Inglês' };
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u; // escritas sem espaço entre palavras
const JAMO = /[ㄱ-ㆎ]/g;  // pedaços soltos de letra coreana: sinal de leitura errada

// ------------------------------------------------------------ configurações
const PADRAO = { origem: 'eng', destino: 'pt', motor: 'google', maiusculas: true, ajuste: 'auto' };
let cfg = { ...PADRAO };
try { Object.assign(cfg, JSON.parse(localStorage.getItem('cfg') || '{}')); } catch (_) {}
if (!IDIOMAS[cfg.origem]) cfg.origem = PADRAO.origem;
if (!DESTINOS[cfg.destino]) cfg.destino = PADRAO.destino;
if (!['auto', 'inteira', 'largura'].includes(cfg.ajuste)) cfg.ajuste = PADRAO.ajuste;
const salvarCfg = () => { try { localStorage.setItem('cfg', JSON.stringify(cfg)); } catch (_) {} };
const assinaturaCfg = () => `${cfg.origem}|${cfg.destino}|${cfg.motor}`;

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
  ajusteManual = null;
  $('vazio').hidden = true;
  $('palco').hidden = false;
  $('base').hidden = false;
  irPara(0);
}

// ------------------------------------------------------------ leitor de texto (PaddleOCR no aparelho)
// Modelo de reconhecimento de cada idioma (o chinês simplificado e o tradicional usam o mesmo)
const MODELO_IDIOMA = { eng: 'eng', spa: 'spa', kor: 'kor', chi_sim: 'chi', chi_tra: 'chi' };
let leitor = null, leitorIdioma = null;
let ocrFila = Promise.resolve();

/** Baixa um arquivo mostrando o progresso (o sw.js guarda no aparelho; da 2ª vez vem na hora). */
async function baixar(url, rotulo) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`não consegui baixar ${url.split('/').pop()} (${r.status})`);
  const total = +r.headers.get('content-length') || 0;
  if (!r.body || !total) return new Uint8Array(await r.arrayBuffer());
  const leitorRede = r.body.getReader();
  const partes = [];
  let recebido = 0, ultimo = -1;
  for (;;) {
    const { done, value } = await leitorRede.read();
    if (done) break;
    partes.push(value); recebido += value.length;
    const pct = Math.floor((recebido / total) * 100);
    if (pct !== ultimo && pct < 100) { ultimo = pct; status(`${rotulo}… ${pct}%`); }
  }
  const tudo = new Uint8Array(recebido);
  let pos = 0;
  for (const p of partes) { tudo.set(p, pos); pos += p.length; }
  return tudo;
}

// Só é chamado de dentro da fila do OCR, então nunca carrega dois leitores ao mesmo tempo.
async function obterLeitor(idioma) {
  const modelo = MODELO_IDIOMA[idioma];
  if (leitor && leitorIdioma === modelo) return leitor;
  leitor = null; leitorIdioma = null;
  const nome = IDIOMAS[idioma].nome;
  ort.env.wasm.wasmPaths = new URL('vendor/', location.href).href;
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  ort.env.logLevel = 'error';
  const base = new URL('modelos/', location.href).href;
  const carregar = (async () => {
    const det = await baixar(base + 'det.onnx', 'Baixando leitor de texto (só na 1ª vez)');
    const rec = await baixar(base + modelo + '.onnx', `Baixando idioma ${nome} (só na 1ª vez)`);
    const dicionario = new TextDecoder().decode(await baixar(base + modelo + '.txt', `Baixando idioma ${nome}`));
    status('Iniciando leitor de texto…');
    return PaddleOCR.criar({
      ort, det, rec, dicionario,
      fazerCanvas: (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; },
    });
  })();
  // se travar (internet ruim), não deixa o app parado para sempre
  let relogio;
  const limite = new Promise((_, falhar) => {
    relogio = setTimeout(() => falhar(new Error(
      `o idioma ${nome} não terminou de carregar. Confira a internet e troque de página para tentar de novo.`)), 180000);
  });
  try {
    leitor = await Promise.race([carregar, limite]);
  } finally {
    clearTimeout(relogio);
  }
  leitorIdioma = modelo;
  return leitor;
}

/** Lê o texto da página toda (na fila: um de cada vez). */
function lerTexto(bitmap, idioma, aviso) {
  const tarefa = ocrFila.then(async () => {
    const l = await obterLeitor(idioma);
    return l.ler(bitmap, bitmap.width, bitmap.height, aviso);
  });
  ocrFila = tarefa.catch(() => {});
  return tarefa;
}

function contarLetras(texto) { return (texto.match(/\p{L}/gu) || []).length; }

function textoValido(texto, confianca) {
  const letras = contarLetras(texto);
  const asiatico = /[\p{Script=Han}\p{Script=Hangul}]/u.test(texto);
  if (letras < (asiatico ? 1 : 2)) return false;
  if (letras === 1 && confianca < 75) return false;          // um caractere solto costuma ser ruído
  if (confianca < (asiatico ? 40 : 50)) return false;
  if ((texto.match(JAMO) || []).length / letras > 0.15) return false;
  // pelo menos metade do que sobra (sem espaços e sem pontuação comum, como "...") tem que ser letra
  const resto = texto.replace(/[\s.,!?…~♥'"“”‘’¡¿！？。，、]/g, '').length;
  return resto > 0 && letras / resto >= 0.5;
}

function limparTexto(texto, idioma) {
  let t = texto.replace(JAMO, '').replace(/\s+/g, ' ').trim()
    // aspa ou risco solto (sem palavra grudada) é sujeira da borda do balão
    .replace(/(^|\s)['"`‘’“”]+(?=\s|$)/g, '$1').replace(/\s+/g, ' ').trim()
    // em HQ o "!" no fim de palavra em maiúsculas costuma ser lido como "l" ou "|"
    .replace(/(\p{Lu}{2,})[l|](?=\s|$)/gu, '$1!')
    // reticências lidas como ". .", ".…", "…." etc.
    .replace(/\s*[.…](?:\s?[.…])+/g, '...')
    // coração depois de uma palavra: o OCR lê como "#"
    .replace(/([\p{L}!?.…~,])\s?[#♡❤](?!\d)/gu, '$1♥')
    // o OCR às vezes põe espaço entre ideogramas chineses; o chinês não usa espaço
    .replace(/([\p{Script=Han}，。！？、：；…])\s+(?=[\p{Script=Han}，。！？、：；…])/gu, '$1');
  const escrita = IDIOMAS[idioma]?.escrita;
  if (escrita === 'latina') {
    t = t.replace(/(^|\s)\|(?=\s|$)/g, '$1I')          // "|" sozinho é o pronome "I" (ou "I" de "¡")
      .replace(/\s+([!?.,…])(?=\s|$)/g, '$1');        // "WHAT ?" -> "WHAT?"
  }
  if (idioma === 'spa') {
    // o "¡" e o "¿" do começo da frase costumam virar "i", "j", "l" ou "1"
    // (vira "¿" se a frase termina em "?", senão "¡")
    t = t.replace(/(^|[\s"“])[ijl1|](?=\p{Lu}(?:\p{Lu}|\s\p{Lu}))/gu, (m, antes, pos, todo) => {
      const fim = todo.slice(pos + m.length).match(/[?!]/);
      return antes + (fim && fim[0] === '?' ? '¿' : '¡');
    });
  }
  if (escrita === 'coreana') {
    // pontuação colada na sílaba anterior, como o coreano escreve
    t = t.replace(/(\p{Script=Hangul})\s+([!?.,…~]+)/gu, '$1$2')
      .replace(/([,…?!])(?=[가-힣])/g, '$1 ');       // "으,으응" -> "으, 으응"
  }
  return t;
}

/** Junta linhas em um texto só (sem espaço no chinês, desfazendo hifenização). */
function juntarLinhas(linhas) {
  let texto = '';
  for (const l of linhas) {
    if (!l) continue;
    // "PALA-" + "VRA" = "PALAVRA"; mas "ESPERA--" + "NÃO" continua com o travessão
    if (/\p{L}-$/u.test(texto) && /^\p{Ll}|^\p{Lu}{2}/u.test(l)) texto = texto.slice(0, -1) + l;
    else if (CJK.test(texto.slice(-1)) && CJK.test(l[0])) texto += l;
    else texto += (texto ? ' ' : '') + l;
  }
  return texto;
}

/**
 * No modo "texto espalhado" o OCR às vezes corta uma linha em pedaços lado a lado.
 * Aqui eles são colados de volta numa linha só (senão cada pedaço vira um balão separado).
 */
function juntarPedacos(linhas, idioma) {
  const sep = IDIOMAS[idioma]?.escrita === 'chinesa' ? '' : ' ';
  const ordem = linhas.slice().sort((a, b) => a.x0 - b.x0);
  const res = [];
  for (const l of ordem) {
    const h = l.y1 - l.y0;
    const par = res.find((m) => {
      const hm = m.y1 - m.y0;
      if (Math.max(h, hm) > Math.min(h, hm) * 1.6) return false;                 // tamanhos de letra diferentes
      const sobreV = Math.min(l.y1, m.y1) - Math.max(l.y0, m.y0);
      if (sobreV < Math.min(h, hm) * 0.6) return false;                          // não estão na mesma altura
      const dist = l.x0 - m.x1;
      return dist > -Math.min(h, hm) && dist < Math.max(h, hm) * 1.1;            // estão encostados
    });
    if (par) {
      par.texto = limparTexto(par.texto + sep + l.texto, idioma);
      const n1 = contarLetras(par.texto), n2 = contarLetras(l.texto);
      par.conf = (par.conf * Math.max(1, n1 - n2) + l.conf * Math.max(1, n2)) / Math.max(1, n1);
      par.x0 = Math.min(par.x0, l.x0); par.x1 = Math.max(par.x1, l.x1);
      par.y0 = Math.min(par.y0, l.y0); par.y1 = Math.max(par.y1, l.y1);
    } else {
      res.push({ ...l });
    }
  }
  return res;
}

const ordemLeitura = (a, b) => {
  const mesmaFaixa = Math.abs(a.y0 - b.y0) < Math.min(a.y1 - a.y0, b.y1 - b.y0) * 0.5;
  return mesmaFaixa ? a.x0 - b.x0 : a.y0 - b.y0;
};

/** Junta as linhas lidas em blocos (um por balão/legenda), na ordem de leitura. */
function agruparLinhas(linhasBrutas, idioma) {
  const linhas = juntarPedacos(linhasBrutas, idioma).sort((a, b) => a.y0 - b.y0);
  let grupos = [];
  const caixaDe = (g) => {
    g.x0 = Math.min(...g.linhas.map((l) => l.x0)); g.y0 = Math.min(...g.linhas.map((l) => l.y0));
    g.x1 = Math.max(...g.linhas.map((l) => l.x1)); g.y1 = Math.max(...g.linhas.map((l) => l.y1));
    return g;
  };
  for (const l of linhas) {
    const h = l.y1 - l.y0, cx = (l.x0 + l.x1) / 2;
    let alvo = null;
    for (const g of grupos) {
      const u = g.linhas[g.linhas.length - 1];
      const hm = Math.max(h, u.y1 - u.y0);
      if (Math.max(h, u.y1 - u.y0) > Math.min(h, u.y1 - u.y0) * 2) continue;  // letra muito maior: outro balão
      const gap = l.y0 - u.y1;
      const largura = Math.max(l.x1 - l.x0, u.x1 - u.x0);
      const sobreH = Math.min(l.x1, u.x1) - Math.max(l.x0, u.x0);
      if (gap > -hm * 0.5 && gap < hm * 0.9 &&
          (Math.abs(cx - (u.x0 + u.x1) / 2) < largura * 0.6 || sobreH > Math.min(l.x1 - l.x0, u.x1 - u.x0) * 0.5)) { alvo = g; break; }
    }
    if (alvo) { alvo.linhas.push(l); caixaDe(alvo); }
    else grupos.push(caixaDe({ linhas: [l] }));
  }
  // grupos cujas caixas se cruzam são o mesmo balão (acontece quando as linhas vieram fora de ordem)
  let mudou = true;
  while (mudou) {
    mudou = false;
    for (let i = 0; i < grupos.length && !mudou; i++) {
      for (let j = i + 1; j < grupos.length && !mudou; j++) {
        const a = grupos[i], b = grupos[j];
        const m = Math.min(a.linhas[0].y1 - a.linhas[0].y0, b.linhas[0].y1 - b.linhas[0].y0) * 0.2;
        if (a.x0 < b.x1 + m && b.x0 < a.x1 + m && a.y0 < b.y1 + m && b.y0 < a.y1 + m) {
          a.linhas.push(...b.linhas); caixaDe(a); grupos.splice(j, 1); mudou = true;
        }
      }
    }
  }
  const res = grupos.map((g) => {
    const ls = g.linhas.slice().sort(ordemLeitura);
    const letras = ls.reduce((s, l) => s + Math.max(1, contarLetras(l.texto)), 0);
    return {
      x0: g.x0, y0: g.y0, x1: g.x1, y1: g.y1,
      original: juntarLinhas(ls.map((l) => l.texto)),
      conf: ls.reduce((s, l) => s + l.conf * Math.max(1, contarLetras(l.texto)), 0) / letras,
      alturaLinha: ls.reduce((s, l) => s + (l.y1 - l.y0), 0) / ls.length,
    };
  });
  // ordem de leitura: de cima para baixo; balões na mesma altura, da esquerda para a direita
  return res.sort(ordemLeitura);
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

/**
 * Acha o balão em volta de um texto: pinta, a partir da borda do texto, toda a área contínua
 * com a cor do fundo dele. Se a área for fechada (um balão), devolve o contorno dela, linha por linha.
 * Se "vazar" (texto solto em cima do desenho, ou balão aberto num fundo da mesma cor), devolve null.
 * rotulos marca os pixels já visitados: >0 = balão já achado, -1 = área aberta.
 */
function detectarBalao(a, g, rotulos, baloes) {
  const lh = Math.max(1, g.alturaLinha * a.s);
  const m = Math.max(2, Math.round(lh * 0.5));
  const bx0 = Math.max(0, Math.floor(g.x0 * a.s) - m), by0 = Math.max(0, Math.floor(g.y0 * a.s) - m);
  const bx1 = Math.min(a.w - 1, Math.ceil(g.x1 * a.s) + m), by1 = Math.min(a.h - 1, Math.ceil(g.y1 * a.s) + m);
  const cor = corDeFundo(a, bx0, by0, bx1, by1);
  // sementes: pixels da moldura em volta do texto com a cor do fundo
  const sementes = [];
  let moldura = 0;
  const olhar = (x, y) => {
    moldura++;
    const i = y * a.w + x;
    if (distCor(a.px, i * 4, cor) < 50) sementes.push(i);
  };
  for (let x = bx0; x <= bx1; x++) { olhar(x, by0); olhar(x, by1); }
  for (let y = by0 + 1; y < by1; y++) { olhar(bx0, y); olhar(bx1, y); }
  if (sementes.length < moldura * 0.5) return null;       // o texto não está num fundo liso
  for (const i of sementes) {
    if (rotulos[i] > 0) return baloes[rotulos[i] - 1];
    if (rotulos[i] < 0) return null;
  }
  const id = baloes.length + 1;
  const limite = Math.min(a.w * a.h * 0.35, Math.max(5000, (bx1 - bx0 + 1) * (by1 - by0 + 1) * 60));
  const min = new Int32Array(a.h).fill(a.w), max = new Int32Array(a.h).fill(-1);
  const pilha = sementes.slice(), pintados = [];
  for (const i of sementes) rotulos[i] = id;
  let vazou = false;
  while (pilha.length) {
    const i = pilha.pop();
    pintados.push(i);
    if (pintados.length > limite) { vazou = true; break; }
    const x = i % a.w, y = (i - x) / a.w;
    if (x < min[y]) min[y] = x;
    if (x > max[y]) max[y] = x;
    if (x > 0) vizinho(i - 1);
    if (x < a.w - 1) vizinho(i + 1);
    if (y > 0) vizinho(i - a.w);
    if (y < a.h - 1) vizinho(i + a.w);
  }
  function vizinho(n) {
    if (rotulos[n] || distCor(a.px, n * 4, cor) >= 70) return;
    rotulos[n] = id; pilha.push(n);
  }
  let y0 = a.h, y1 = -1, x0 = a.w, x1 = -1;
  if (!vazou) for (let y = 0; y < a.h; y++) if (max[y] >= 0) {
    if (y < y0) y0 = y;
    y1 = y;
    if (min[y] < x0) x0 = min[y];
    if (max[y] > x1) x1 = max[y];
  }
  if (vazou || x1 - x0 > a.w * 0.95) {
    for (const i of pintados) rotulos[i] = -1;
    for (const i of pilha) rotulos[i] = -1;
    return null;
  }
  const balao = { id, s: a.s, cor, x0, y0, x1, y1, min: min.slice(y0, y1 + 1), max: max.slice(y0, y1 + 1) };
  baloes.push(balao);
  return balao;
}

/** Grupos de texto que estão no mesmo balão viram um só (a 1ª leitura às vezes separa). */
function juntarPorBalao(grupos, amostra) {
  const rotulos = new Int32Array(amostra.w * amostra.h);
  const baloes = [];
  const res = [];
  for (const g of grupos) {
    g.balao = detectarBalao(amostra, g, rotulos, baloes);
    const igual = g.balao && res.find((o) => o.balao === g.balao);
    if (!igual) { res.push(g); continue; }
    const [p, q] = ordemLeitura(igual, g) <= 0 ? [igual, g] : [g, igual];
    igual.original = juntarLinhas([p.original, q.original]);
    igual.conf = (igual.conf + g.conf) / 2;
    igual.alturaLinha = (igual.alturaLinha + g.alturaLinha) / 2;
    igual.x0 = Math.min(igual.x0, g.x0); igual.y0 = Math.min(igual.y0, g.y0);
    igual.x1 = Math.max(igual.x1, g.x1); igual.y1 = Math.max(igual.y1, g.y1);
  }
  return res;
}

/** Depois da releitura, dois grupos podem ter lido o mesmo texto: fica o que leu mais. */
function tirarRepetidos(grupos) {
  const area = (g) => Math.max(1, (g.x1 - g.x0) * (g.y1 - g.y0));
  return grupos.filter((g, i) => !grupos.some((o, j) => {
    if (i === j) return false;
    const sx = Math.min(g.x1, o.x1) - Math.max(g.x0, o.x0), sy = Math.min(g.y1, o.y1) - Math.max(g.y0, o.y0);
    if (sx <= 0 || sy <= 0 || sx * sy < Math.min(area(g), area(o)) * 0.5) return false;
    const ng = contarLetras(g.original), no = contarLetras(o.original);
    return no > ng || (no === ng && j < i);
  }));
}

async function lerPagina(blob, idioma, aviso) {
  const bitmap = await createImageBitmap(blob);
  try {
    const W = bitmap.width, H = bitmap.height;
    const linhas = [];
    for (const l of await lerTexto(bitmap, idioma, aviso)) {
      const texto = limparTexto(l.texto, idioma);
      if (textoValido(texto, l.conf)) linhas.push({ ...l, texto });
    }
    const amostra = amostraColorida(bitmap);
    const grupos = tirarRepetidos(juntarPorBalao(agruparLinhas(linhas, idioma), amostra)).sort(ordemLeitura);
    grupos.forEach((g) => { g.caixa = ajustarAoBalao(g, amostra, W, H); delete g.balao; });
    return { W, H, grupos };
  } finally {
    bitmap.close && bitmap.close();
  }
}

// ------------------------------------------------------------ tradução com contexto
/** TEXTO TODO EM MAIÚSCULAS -> "Texto em frase normal": tradutores erram menos assim. */
function paraFraseNormal(t, idioma) {
  const latinas = t.match(/\p{Script=Latin}/gu) || [];
  if (latinas.length < 3) return t;
  const maiusculas = latinas.filter((c) => c !== c.toLowerCase()).length;
  if (maiusculas / latinas.length < 0.8) return t;
  let r = t.toLowerCase()
    .replace(/(^|[.!?…]\s*|[¡¿"“]\s*)(\p{L})/gu, (_, a, b) => a + b.toUpperCase());
  if (idioma === 'eng') r = r.replace(/(^|[^\p{L}])i(?=$|[^\p{L}])/gu, '$1I'); // pronome "I" (também em "I'm")
  return r;
}
const primeiraMaiuscula = (t) => {
  const m = t && t.match(/^([¡¿"“'‘(\-–—\s]*)(\p{L})/u);
  return m ? m[1] + m[2].toLocaleUpperCase() + t.slice(m[0].length) : t;
};
// o Google às vezes devolve aspas e apóstrofos como código HTML (&#39; &quot;)
const desfazerHtml = (t) => String(t ?? '')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

async function traduzirGoogle(textos, de, para) {
  // vários textos numa chamada; cada um volta separado
  const url = `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=${de}&tl=${para}&` +
    textos.map((t) => 'q=' + encodeURIComponent(t)).join('&');
  let r;
  try { r = await fetch(url); } catch (_) {
    throw new Error('sem internet para traduzir. Conecte-se, ou escolha o tradutor "No aparelho" nas configurações.');
  }
  if (!r.ok) throw new Error(r.status === 429 ? 'Google limitou os pedidos; espere uns minutos.' : 'Google respondeu ' + r.status);
  const json = await r.json();
  const lista = Array.isArray(json) ? json : [json];
  return lista.map((item) => desfazerHtml(Array.isArray(item) ? item[0] : item));
}

let tradutorLocal = null, tradutorLocalChave = '';
const suportaLocal = () => 'Translator' in self;

async function traduzirLocal(textos, de, para) {
  if (!suportaLocal()) throw new Error('este navegador não tem tradutor no aparelho');
  const opcoes = { sourceLanguage: de, targetLanguage: para };
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

async function chamarTradutor(textos, op) {
  const idioma = IDIOMAS[op.origem];
  if (op.motor === 'local') {
    try { return await traduzirLocal(textos, idioma.local, op.destino); }
    catch (e) { status('Offline falhou (' + e.message + '); usando Google.'); }
  }
  return traduzirGoogle(textos, idioma.google, op.destino);
}

/**
 * Traduz os balões de uma página juntos, um por linha, na ordem de leitura,
 * com os últimos balões da página anterior na frente como contexto.
 * Assim o tradutor entende a conversa (quem fala, gênero, tempo verbal),
 * em vez de traduzir cada frase solta.
 */
async function traduzirPagina(textos, contexto, op) {
  if (!textos.length) return [];
  const prep = (t) => paraFraseNormal(t, op.origem).replace(/\s*\n\s*/g, ' ').trim();
  // o idioma do quadrinho já é o idioma escolhido: nada a traduzir
  if (IDIOMAS[op.origem].google.split('-')[0] === op.destino) return textos.map(prep);
  const resultado = [];
  // divide em pedaços que cabem numa chamada, sempre levando contexto
  let i = 0;
  while (i < textos.length) {
    const ctx = (i === 0 ? contexto : textos.slice(Math.max(0, i - 3), i)).map(prep).filter(Boolean);
    const pedaco = [];
    let tamanho = encodeURIComponent(ctx.join('\n')).length;
    while (i < textos.length && (!pedaco.length || tamanho + encodeURIComponent(prep(textos[i])).length < 1700)) {
      pedaco.push(prep(textos[i])); tamanho += encodeURIComponent(pedaco[pedaco.length - 1]).length + 3; i++;
    }
    let saida = null;
    try {
      const [junto] = await chamarTradutor([[...ctx, ...pedaco].join('\n')], op);
      const partes = junto.split('\n').map((s) => s.trim()).filter(Boolean);
      if (partes.length === ctx.length + pedaco.length) saida = partes.slice(ctx.length);
    } catch (e) {
      if (/limitou|sem internet/.test(e.message)) throw e;
    }
    // se o tradutor misturou as linhas, traduz balão por balão (sem perder nenhum)
    if (!saida) saida = await chamarTradutor(pedaco, op);
    resultado.push(...saida.map((t, k) => primeiraMaiuscula(t || pedaco[k])));
  }
  return resultado;
}

// ------------------------------------------------------------ processar uma página
function processar(indice) {
  const p = paginas[indice];
  if (!p) return null;
  const assinatura = assinaturaCfg();
  if (p.trabalho && p.assinatura === assinatura) return p.trabalho;
  const op = { origem: cfg.origem, destino: cfg.destino, motor: cfg.motor }; // fixa as opções deste trabalho
  p.assinatura = assinatura;
  p.resultado = null;
  // identifica este trabalho; criado antes de começar, porque o início do trabalho roda na hora
  const vez = {};
  p.vez = vez;
  const atualizado = () => p.vez === vez; // as opções não mudaram desde que este trabalho começou
  const trabalho = (async () => {
    const aviso = (t) => { if (indice === atual && atualizado()) status(t); };
    aviso('Procurando os balões…');
    const r = await lerPagina(await p.obterBlob(), op.origem, aviso);
    aviso(r.grupos.length ? `Traduzindo ${r.grupos.length} balão(ões)…` : 'Nenhum texto encontrado.');
    const ant = paginas[indice - 1];
    const contexto = ant?.resultado && ant.assinatura === assinatura ? ant.resultado.grupos.slice(-3).map((g) => g.original) : [];
    const traducoes = await traduzirPagina(r.grupos.map((g) => g.original), contexto, op);
    r.grupos.forEach((g, i) => { g.traducao = traducoes[i] || g.original; });
    if (atualizado()) p.resultado = r; // só guarda se as opções não mudaram no meio
    return r;
  })();
  p.trabalho = trabalho;
  trabalho.catch(() => { if (atualizado()) p.trabalho = null; });
  return trabalho;
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
  let tamanho = Math.min(40, Math.max(8, parseFloat(div.dataset.alturaLinha) * larguraImg * 0.9));
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
// ------------------------------------------------------------ enquadramento
/**
 * 'inteira' = a página toda cabe na tela (nada cortado); 'largura' = ocupa a largura e rola para baixo.
 * No automático, tiras compridas (webtoon) vão pela largura, senão ficariam minúsculas.
 */
let ajusteManual = null; // escolhido no botão: vale até abrir outro capítulo
function modoEfetivo() {
  const img = $('imagem');
  if (ajusteManual) return ajusteManual;
  if (cfg.ajuste !== 'auto') return cfg.ajuste;
  return img.naturalWidth && img.naturalHeight / img.naturalWidth > 2.2 ? 'largura' : 'inteira';
}
function enquadrar() {
  const img = $('imagem'), visor = $('visor');
  if (!img.naturalWidth || $('palco').hidden) return;
  const proporcao = img.naturalWidth / img.naturalHeight;
  const modo = modoEfetivo();
  const largura = modo === 'inteira' ? Math.min(visor.clientWidth, visor.clientHeight * proporcao) : visor.clientWidth;
  $('palco').style.width = Math.max(50, Math.floor(largura)) + 'px';
  const btn = $('btnAjuste');
  btn.textContent = modo === 'inteira' ? '↔' : '⤢';
  btn.title = modo === 'inteira' ? 'Ocupar a largura da tela' : 'Mostrar a página inteira';
  btn.setAttribute('aria-label', btn.title);
}
$('btnAjuste').onclick = () => {
  ajusteManual = modoEfetivo() === 'inteira' ? 'largura' : 'inteira';
  enquadrar();
};
$('imagem').addEventListener('load', () => { enquadrar(); ajustarTodas(); });
new ResizeObserver(enquadrar).observe($('visor'));
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
  $('cfgDestino').value = cfg.destino;
  $('cfgMotor').value = cfg.motor;
  $('cfgMaiusculas').checked = cfg.maiusculas;
  $('cfgAjuste').value = cfg.ajuste;
  $('infoLocal').textContent = suportaLocal()
    ? 'Este navegador tem tradutor no aparelho: na primeira vez ele baixa o idioma, depois funciona sem internet.'
    : 'Este navegador não tem tradutor no aparelho; o modo offline vai usar o Google como reserva.';
  $('config').showModal();
};
$('config').addEventListener('close', () => {
  if ($('config').returnValue !== 'ok') return;
  cfg = {
    origem: $('cfgOrigem').value, destino: $('cfgDestino').value,
    motor: $('cfgMotor').value, maiusculas: $('cfgMaiusculas').checked,
    ajuste: $('cfgAjuste').value,
  };
  ajusteManual = null; // a escolha das configurações passa a valer
  salvarCfg();
  enquadrar();
  if (paginas.length) irPara(atual); // refaz com as novas opções
});

// funciona offline e pode ser instalado
if ('serviceWorker' in navigator && !new URLSearchParams(location.search).has('semsw')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
