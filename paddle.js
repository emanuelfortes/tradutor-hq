/*
 * Leitor de texto PaddleOCR (PP-OCR), rodando no aparelho com o onnxruntime.
 * 1) "detecção": um modelo marca onde há texto na página (mapa de probabilidade -> caixas de linha);
 * 2) "reconhecimento": outro modelo lê cada linha recortada (CTC com o dicionário do idioma).
 * Funciona no navegador e no Node (para testes): recebe o onnxruntime e uma função que cria canvas.
 */
'use strict';
(function (raiz) {
  const MEDIA = [0.485, 0.456, 0.406], DESVIO = [0.229, 0.224, 0.225]; // normalização da detecção
  const ALTURA_REC = 48;        // altura da linha que o modelo de reconhecimento espera (PP-OCRv5)
  const LIMIAR = 0.3;           // pixel é "texto" acima disso
  const LIMIAR_CAIXA = 0.55;    // média mínima da caixa para valer
  const EXPANDIR = 1.6;         // o modelo marca o miolo do texto; a caixa é aumentada nessa proporção
  const DX = 0.3;               // e dos lados um pouco mais (pega "..." e "," nas pontas); testado com balões reais

  /**
   * opcoes: { ort, fazerCanvas(w,h), det: ArrayBuffer|Uint8Array|url, rec: idem, dicionario: string }
   */
  async function criar(opcoes) {
    const { ort, fazerCanvas } = opcoes;
    const sessao = (m) => ort.InferenceSession.create(m, {
      executionProviders: ['wasm'], graphOptimizationLevel: 'all',
      logSeverityLevel: 3, // só erros (os modelos convertidos geram muitos avisos inofensivos)
    });
    const [det, rec] = [await sessao(opcoes.det), await sessao(opcoes.rec)];
    const chars = opcoes.dicionario.replace(/\r/g, '').split('\n');
    if (chars[chars.length - 1] === '') chars.pop();
    const tensor = (dados, forma) => new ort.Tensor('float32', dados, forma);

    function pixels(fonte, sx, sy, sw, sh, w, h) {
      const c = fazerCanvas(w, h);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(fonte, sx, sy, sw, sh, 0, 0, w, h);
      return ctx.getImageData(0, 0, w, h).data;
    }

    /** Acha as linhas de texto num pedaço da imagem. Devolve caixas nas coordenadas da imagem. */
    async function detectar(fonte, sx, sy, sw, sh, escala) {
      const w = Math.max(32, Math.round(sw * escala / 32) * 32), h = Math.max(32, Math.round(sh * escala / 32) * 32);
      const px = pixels(fonte, sx, sy, sw, sh, w, h);
      const n = w * h, dados = new Float32Array(3 * n);
      for (let i = 0, j = 0; j < n; i += 4, j++) {
        // o PaddleOCR foi treinado com a imagem em BGR
        dados[j] = (px[i + 2] / 255 - MEDIA[0]) / DESVIO[0];
        dados[n + j] = (px[i + 1] / 255 - MEDIA[1]) / DESVIO[1];
        dados[2 * n + j] = (px[i] / 255 - MEDIA[2]) / DESVIO[2];
      }
      const saida = await det.run({ [det.inputNames[0]]: tensor(dados, [1, 3, h, w]) });
      const mapa = saida[det.outputNames[0]].data; // [1,1,h,w]
      const fx = sw / w, fy = sh / h;
      return componentes(mapa, w, h).map((c) => {
        // aumenta a caixa (o modelo marca só o miolo das letras)
        const bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1;
        const d = (bw * bh * EXPANDIR) / (2 * (bw + bh));
        // dos lados cresce mais: pontinhos ("...", ",") nas pontas às vezes ficam fora do que o modelo marca;
        // em cima e embaixo cresce pouco, para não pegar pedaço da linha vizinha
        const dx = d + (bh + 2 * d) * DX;
        return {
          x0: sx + Math.max(0, c.x0 - dx) * fx, y0: sy + Math.max(0, c.y0 - d) * fy,
          x1: sx + Math.min(w, c.x1 + 1 + dx) * fx, y1: sy + Math.min(h, c.y1 + 1 + d) * fy,
          nota: c.media,
        };
      });
    }

    /** Regiões ligadas de pixels "texto" no mapa (cada uma é uma linha). */
    function componentes(mapa, w, h) {
      const marca = new Int32Array(w * h);
      const res = [];
      const pilha = [];
      for (let i0 = 0; i0 < w * h; i0++) {
        if (marca[i0] || mapa[i0] <= LIMIAR) continue;
        let x0 = w, y0 = h, x1 = -1, y1 = -1, soma = 0, qtd = 0;
        marca[i0] = 1; pilha.push(i0);
        while (pilha.length) {
          const i = pilha.pop();
          const x = i % w, y = (i - x) / w;
          soma += mapa[i]; qtd++;
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const k = ny * w + nx;
            if (!marca[k] && mapa[k] > LIMIAR) { marca[k] = 1; pilha.push(k); }
          }
        }
        const media = soma / qtd;
        if (Math.min(x1 - x0, y1 - y0) < 2 || qtd < 10 || media < LIMIAR_CAIXA) continue;
        res.push({ x0, y0, x1, y1, media });
      }
      return res;
    }

    /** Lê o texto de uma caixa (uma linha). Linha em pé (texto vertical) é girada antes. */
    async function reconhecer(fonte, caixa) {
      const sw = caixa.x1 - caixa.x0, sh = caixa.y1 - caixa.y0;
      const vertical = sh >= sw * 1.5 && sh > 2 * ALTURA_REC * 0.3;
      const altura = ALTURA_REC;
      let w, px;
      if (!vertical) {
        w = Math.max(16, Math.min(3200, Math.round(altura * sw / sh)));
        px = pixels(fonte, caixa.x0, caixa.y0, sw, sh, w, altura);
      } else {
        // gira 90° no sentido anti-horário: o texto de cima para baixo vira da esquerda para a direita
        w = Math.max(16, Math.min(3200, Math.round(altura * sh / sw)));
        const em = pixels(fonte, caixa.x0, caixa.y0, sw, sh, altura, w); // largura=altura, altura=w
        px = new Uint8ClampedArray(w * altura * 4);
        for (let y = 0; y < w; y++) for (let x = 0; x < altura; x++) {
          const o = (y * altura + x) * 4, d = ((altura - 1 - x) * w + y) * 4;
          px[d] = em[o]; px[d + 1] = em[o + 1]; px[d + 2] = em[o + 2]; px[d + 3] = 255;
        }
      }
      const n = w * altura, dados = new Float32Array(3 * n);
      for (let i = 0, j = 0; j < n; i += 4, j++) {
        dados[j] = px[i + 2] / 127.5 - 1;
        dados[n + j] = px[i + 1] / 127.5 - 1;
        dados[2 * n + j] = px[i] / 127.5 - 1;
      }
      const saida = (await rec.run({ [rec.inputNames[0]]: tensor(dados, [1, 3, altura, w]) }))[rec.outputNames[0]];
      const [, passos, classes] = saida.dims;
      const p = saida.data;
      let texto = '', soma = 0, qtd = 0, ant = -1;
      for (let t = 0; t < passos; t++) {
        let melhor = 0, max = -Infinity;
        for (let c = 0; c < classes; c++) { const v = p[t * classes + c]; if (v > max) { max = v; melhor = c; } }
        // CTC: 0 = "nada"; repetição seguida da mesma letra conta uma vez
        if (melhor !== 0 && melhor !== ant) {
          texto += melhor - 1 < chars.length ? chars[melhor - 1] : ' ';
          soma += max; qtd++;
        }
        ant = melhor;
      }
      return { texto: texto.trim(), nota: qtd ? soma / qtd : 0 };
    }

    /**
     * Lê uma imagem inteira. Imagens altas (webtoon) são processadas em fatias.
     * Devolve linhas { texto, conf (0-100), x0, y0, x1, y1 } nas coordenadas da imagem.
     */
    async function ler(fonte, largura, altura, aviso) {
      const escala = Math.min(2, Math.max(0.5, 1024 / largura));
      const alturaFatia = Math.round(1536 / escala), sobra = Math.round(160 / escala);
      const fatias = [];
      for (let y = 0; y < altura; y += alturaFatia - sobra) {
        fatias.push({ y, h: Math.min(alturaFatia, altura - y) });
        if (y + alturaFatia >= altura) break;
      }
      const caixas = [];
      for (let i = 0; i < fatias.length; i++) {
        const f = fatias[i];
        if (aviso && fatias.length > 1) aviso(`Procurando os balões… parte ${i + 1} de ${fatias.length}`);
        const iniDono = i === 0 ? 0 : f.y + sobra / 2, fimDono = i === fatias.length - 1 ? altura : f.y + f.h - sobra / 2;
        for (const c of await detectar(fonte, 0, f.y, largura, f.h, escala)) {
          const cy = (c.y0 + c.y1) / 2;
          if (cy >= iniDono && cy < fimDono) caixas.push(c);
        }
      }
      const linhas = [];
      for (let i = 0; i < caixas.length; i++) {
        if (aviso && i % 4 === 0) aviso(`Lendo o texto… ${Math.round((i / caixas.length) * 100)}%`);
        const c = caixas[i];
        const r = await reconhecer(fonte, c);
        if (r.texto) linhas.push({ texto: r.texto, conf: r.nota * 100, x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 });
      }
      return linhas;
    }

    return { ler, detectar, reconhecer };
  }

  const api = { criar };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else raiz.PaddleOCR = api;
})(typeof self !== 'undefined' ? self : this);
