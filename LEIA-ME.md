# Tradutor de HQ (PWA)

App para celular: você abre as páginas, ele lê o texto dos balões e mostra a tradução por cima da imagem. Depois é só passar para a próxima página.

- **Idiomas do quadrinho:** inglês, espanhol, coreano (manhwa/webtoon), chinês simplificado e chinês tradicional. **Tradução para:** português (padrão), espanhol ou inglês.
- **Leitura do texto (OCR):** feita no próprio celular, com os modelos do [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) (PP-OCRv5). Lê bem letra de quadrinho, coreano e chinês, e também balão escuro com letra clara. Suas imagens nunca saem do aparelho.
- **Balões inteiros:** o app acha a borda de cada balão, junta as linhas dele e cobre o balão todo com a tradução.
- **Tradução com contexto:** os balões da página vão juntos para o Google Tradutor, na ordem de leitura e com o fim da página anterior. Assim ele entende a conversa em vez de traduzir frases soltas. É gratuito e sem chave, e só o texto é enviado.
- **Visual:** a tradução pega a cor do balão e ocupa o espaço dele.
- **Arquivos aceitos:** um ZIP/CBZ com as páginas numeradas (PNG, WEBP, JPG/JPEG), ou várias imagens soltas. A ordem é a numérica (2 antes de 10).
- **Webtoon:** tiras longas são lidas em partes.
- **Velocidade:** cada página leva poucos segundos, e enquanto você lê uma página ele já traduz a próxima.
- **Em pé ou deitado:** a página aparece inteira na tela. Tiras de webtoon vão pela largura. O botão ↔ / ⤢ troca entre os dois.

## Colocar no celular

Para ser instalado, um PWA precisa estar num endereço **https**. O jeito mais fácil, grátis e sem programar:

1. No PC, entre em https://app.netlify.com/drop e crie uma conta grátis.
2. Arraste a pasta `tradutor-hq` inteira para a página.
3. Ele gera um link do tipo `https://nome-aleatorio.netlify.app`.
4. Abra esse link no **Chrome do celular**, toque em ⋮ e depois em **Adicionar à tela inicial** (ou "Instalar app").

Na primeira vez ele baixa o leitor de texto (~14 MB) e o idioma escolhido (8 a 17 MB). Fica tudo guardado no celular; depois disso, só a tradução pelo Google precisa de internet.

## Como usar

- **📂** abre as páginas. Dá para selecionar várias imagens de uma vez na galeria.
- **Deslizar para os lados**, ou ◀ ▶, troca de página.
- **Tocar num balão** alterna entre a tradução e o texto original.
- **Ver original** esconde todas as traduções.
- **↔ / ⤢** alterna entre a página inteira na tela e a página na largura da tela.
- **⚙️** escolhe o idioma do quadrinho, o idioma para o qual traduzir e o tradutor.

## Limitações

- O OCR erra mais com letra muito estilizada ou escrita à mão, texto torto e onomatopeias desenhadas.
- Pontinhos soltos (como "..." no fim da linha) às vezes não são lidos; isso quase nunca muda a tradução.
- O Google Tradutor com contexto acerta a maior parte, mas não é um tradutor humano: gírias e piadas podem sair literais. Toque no balão para conferir o original.
- O endereço gratuito do Google não é oficial. Se você traduzir muita coisa de uma vez, ele pode limitar os pedidos por alguns minutos.

## Créditos

- Leitura de texto: modelos PP-OCRv5 do PaddleOCR (licença Apache 2.0), rodando com o ONNX Runtime Web (licença MIT).
- Arquivos ZIP/CBZ: JSZip.
