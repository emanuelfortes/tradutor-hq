# Tradutor de HQ (PWA)

App para celular: você abre as páginas, ele lê o texto dos balões e mostra a tradução por cima da imagem. Depois é só passar para a próxima página.

- **Idiomas:** inglês, coreano (manhwa/webtoon), chinês simplificado e chinês tradicional, sempre traduzindo para português.
- **Leitura do texto (OCR):** feita no próprio celular, com o Tesseract. Suas imagens nunca saem do aparelho.
- **Tradução com contexto:** os balões da página vão juntos para o Google Tradutor, na ordem de leitura e com o fim da página anterior. Assim ele entende a conversa em vez de traduzir frases soltas. É gratuito e sem chave, e só o texto é enviado.
- **Visual:** a tradução pega a cor do balão e ocupa o espaço dele.
- **Arquivos aceitos:** um ZIP/CBZ com as páginas numeradas (PNG, WEBP, JPG/JPEG), ou várias imagens soltas. A ordem é a numérica (2 antes de 10).
- **Webtoon:** tiras longas são lidas em partes.
- **Velocidade:** enquanto você lê uma página, ele já traduz a próxima.

## Colocar no celular

Para ser instalado, um PWA precisa estar num endereço **https**. O jeito mais fácil, grátis e sem programar:

1. No PC, entre em https://app.netlify.com/drop e crie uma conta grátis.
2. Arraste a pasta `tradutor-hq` inteira para a página.
3. Ele gera um link do tipo `https://nome-aleatorio.netlify.app`.
4. Abra esse link no **Chrome do celular**, toque em ⋮ e depois em **Adicionar à tela inicial** (ou "Instalar app").

Na primeira abertura ele baixa o leitor de texto (~8 MB) e o idioma escolhido (~10 MB). Depois disso, só a tradução pelo Google precisa de internet.

## Como usar

- **📂** abre as páginas. Dá para selecionar várias imagens de uma vez na galeria.
- **Deslizar para os lados**, ou ◀ ▶, troca de página.
- **Tocar num balão** alterna entre a tradução e o texto original.
- **Ver original** esconde todas as traduções.
- **⚙️** escolhe o idioma do quadrinho, o idioma de destino e o tradutor.

## Limitações

- O OCR acerta bem letra impressa. Erra mais com letra muito estilizada, texto torto, onomatopeias e balões escritos à mão. No coreano, às vezes não lê alguma sílaba mais complexa, e esse trecho aparece sem tradução.
- Chinês escrito na vertical (comum em manhua antigo) não é bem lido.
- O Google Tradutor com contexto acerta a maior parte, mas não é um tradutor humano: gírias e piadas podem sair literais. Toque no balão para conferir o original.
- O endereço gratuito do Google não é oficial. Se você traduzir muita coisa de uma vez, ele pode limitar os pedidos por alguns minutos.
