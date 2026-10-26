"use client";

import { forwardRef, useEffect, useRef, useState } from "react";

/**
 * Mapa da jornada: da compra à minuta, em quatro etapas ao redor de um núcleo.
 *
 * Substitui a lista de treze cartões retangulares que existia aqui. A lista era
 * correta e ilegível ao mesmo tempo: treze retângulos iguais não dizem o que é
 * pré-requisito, o que é trabalho da IA e o que é entrega — o leitor tinha de
 * montar essa hierarquia de cabeça.
 *
 * ── Decisões que não se deduzem do código ────────────────────────────────────
 *
 * 1. ÍCONES DESENHADOS AQUI, sem biblioteca nova. O projeto não tem lucide nem
 *    heroicons instalados e desenha SVG inline em todo lugar (logo, tema, canais
 *    de atendimento). Acrescentar dependência a uma aplicação que está no ar
 *    processando pagamento, por treze ícones, é custo sem contrapartida. Os
 *    traçados seguem a mesma gramática do Lucide (24x24, traço 1.8, pontas
 *    arredondadas), então trocar por lucide-react depois é substituir este mapa.
 *
 * 2. O MAPA SEGUE O TEMA, e chegou aqui pelo caminho errado. Primeiro ele era um
 *    painel sempre escuro; depois o fundo virou transparente para o relógio da
 *    marca aparecer, e no tema claro o painel ficou com um véu escuro próprio
 *    para o texto branco não sumir. O resultado foi o defeito que o dono
 *    apontou: acionar o modo claro deixava o site claro e o mapa escuro.
 *    Agora cada cor tem variante clara — texto marinho, cartão de vidro branco,
 *    ícone em azul da marca — e o fundo é transparente NOS DOIS temas.
 *
 * 3. HOVER NÃO REVELA CONTEÚDO — só levanta o cartão e acende o ícone. É o que
 *    mantém a seção acessível sem transformar cartão informativo em elemento
 *    focável: quem navega por teclado não perde informação nenhuma, porque não
 *    há informação escondida atrás do ponteiro.
 *
 * 4. AS LINHAS SÃO SVG COM pathLength=1. Normalizar o comprimento permite animar
 *    o traço com dasharray/dashoffset sem medir caminho em JavaScript, e o
 *    vectorEffect mantém a espessura constante mesmo com o viewBox esticado.
 *
 * ── Duas travas herdadas da versão anterior desta página ─────────────────────
 * Vieram com o texto e continuam valendo, porque as duas já foram erro publicado:
 *
 *  • "Envio do processo" diz PDF, e só PDF. O sistema não lê DOCX; a extração de
 *    texto o recusa. Prometer formato que o envio rejeita é publicidade que
 *    vincula o fornecedor (arts. 30 e 37 do CDC).
 *  • Nenhum passo nomeia provedor de IA. Quem trata os documentos do cliente é
 *    informação da Política de Privacidade, não de página comercial — foi de lá
 *    que saiu a antiga menção a um serviço de IA de terceiro.
 *
 * "Escolha da matéria" também fala em SELECIONAR uma: cada análise responde à
 * matéria escolhida no envio, e não examina as três de uma vez.
 */

type NomeIcone =
  | "cartao"
  | "confirmacao"
  | "usuario"
  | "email"
  | "cadeado"
  | "entrar"
  | "balanca"
  | "alvo"
  | "upload"
  | "formulario"
  | "ia"
  | "acompanhamento"
  | "relatorio"
  | "minuta";

/** Traçados no estilo Lucide: 24x24, sem preenchimento, traço arredondado. */
const TRACADOS: Record<NomeIcone, React.ReactNode> = {
  cartao: (
    <>
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <path d="M2 10h20" />
    </>
  ),
  confirmacao: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12.5 2.5 2.5 4.5-5" />
    </>
  ),
  usuario: (
    <>
      <path d="M15 20v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1" />
      <circle cx="8.5" cy="7" r="4" />
      <path d="m16 11 2 2 4-4" />
    </>
  ),
  email: (
    <>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m2 7 10 6 10-6" />
    </>
  ),
  cadeado: (
    <>
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
      <path d="M12 15v2" />
    </>
  ),
  entrar: (
    <>
      <path d="M14 3h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5" />
      <path d="M3 12h12" />
      <path d="m11 8 4 4-4 4" />
    </>
  ),
  balanca: (
    <>
      <path d="M12 3v18" />
      <path d="M7 21h10" />
      <path d="M5 7h14" />
      <path d="m5 7-3 6h6Z" />
      <path d="m19 7-3 6h6Z" />
    </>
  ),
  /* A balança ficou reservada ao núcleo. Aqui o gesto é ESCOLHER uma das três
     matérias, e o alvo diz isso sem repetir o símbolo do centro do mapa. */
  alvo: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="4.5" />
      <circle cx="12" cy="12" r="1" />
    </>
  ),
  upload: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5" />
      <path d="M12 18v-6" />
      <path d="m9.5 14.5 2.5-2.5 2.5 2.5" />
    </>
  ),
  formulario: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M8 8h8" />
      <path d="M8 12h8" />
      <path d="M8 16h4" />
    </>
  ),
  ia: (
    <>
      <rect x="7" y="7" width="10" height="10" rx="2" />
      <path d="M10.5 10.5h3v3h-3z" />
      <path d="M9 3v4M15 3v4M9 17v4M15 17v4M3 9h4M3 15h4M17 9h4M17 15h4" />
    </>
  ),
  acompanhamento: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  relatorio: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5" />
      <path d="M9 17v-3" />
      <path d="M12 17v-6" />
      <path d="M15 17v-4" />
    </>
  ),
  minuta: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h4" />
      <path d="M14 3v5h5" />
      <path d="M20.5 13.5 15 19l-2.5.5.5-2.5 5.5-5.5a1.4 1.4 0 0 1 2 2Z" />
    </>
  ),
};

function Icone({ nome, className }: { nome: NomeIcone; className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {TRACADOS[nome]}
    </svg>
  );
}

interface Passo {
  n: number;
  titulo: string;
  descricao: string;
  icone: NomeIcone;
}

interface Grupo {
  etapa: number;
  titulo: string;
  passos: Passo[];
}

const GRUPOS: Grupo[] = [
  {
    etapa: 1,
    titulo: "Acesso à plataforma",
    passos: [
      { n: 1, titulo: "Compra do acesso", descricao: "Escolha o plano e realize o pagamento por cartão, boleto ou PIX.", icone: "cartao" },
      { n: 2, titulo: "Confirmação", descricao: "O pagamento é confirmado automaticamente pela plataforma.", icone: "confirmacao" },
      { n: 3, titulo: "Conta liberada", descricao: "Sua conta é criada e o plano contratado é vinculado automaticamente.", icone: "usuario" },
      { n: 4, titulo: "E-mail de acesso", descricao: "Você recebe por e-mail as instruções para ativar sua conta.", icone: "email" },
      { n: 5, titulo: "Criação de senha", descricao: "Defina sua senha e ative os recursos de segurança da conta.", icone: "cadeado" },
      { n: 6, titulo: "Login", descricao: "Acesse a plataforma pelo navegador utilizando seu e-mail e senha.", icone: "entrar" },
    ],
  },
  {
    etapa: 2,
    titulo: "Configuração da análise",
    passos: [
      { n: 7, titulo: "Escolha da matéria", descricao: "Selecione prescrição ordinária, prescrição intercorrente ou decadência.", icone: "alvo" },
      { n: 8, titulo: "Envio do processo", descricao: "Anexe o processo em PDF para leitura e organização dos documentos.", icone: "upload" },
      { n: 9, titulo: "Informações complementares", descricao: "Adicione datas ou informações que não estejam disponíveis nos autos.", icone: "formulario" },
    ],
  },
  {
    etapa: 3,
    titulo: "Processamento pela IA",
    passos: [
      { n: 10, titulo: "Análise pela IA", descricao: "A inteligência artificial identifica os atos, organiza a linha do tempo e aplica os critérios jurídicos.", icone: "ia" },
      { n: 11, titulo: "Acompanhamento", descricao: "Acompanhe o processamento da análise diretamente pela plataforma.", icone: "acompanhamento" },
    ],
  },
  {
    etapa: 4,
    titulo: "Resultado",
    passos: [
      { n: 12, titulo: "Relatório", descricao: "Receba um relatório estruturado com fundamentos, conclusão e grau de confiança.", icone: "relatorio" },
      { n: 13, titulo: "Minuta", descricao: "Quando aplicável, receba uma sugestão de minuta jurídica para revisão profissional.", icone: "minuta" },
    ],
  },
];

/**
 * Curvas do núcleo até cada grupo, em coordenadas relativas ao viewBox.
 *
 * O mapa NÃO usa quatro quadrantes. A primeira tentativa fez isso e o resultado
 * está registrado aqui para não se repetir: com o núcleo no meio de uma grade de
 * três colunas, cada grupo cabia em um terço da largura, e o grupo de seis passos
 * precisava de duas colunas internas — cartões de 180px, com o texto quebrando a
 * duas palavras por linha.
 *
 * O desenho atual usa a contagem real dos passos: 6 de um lado (Acesso) contra
 * 3+2+2 = 7 do outro (Configuração, Processamento e Resultado empilhados). As duas
 * colunas ficam equilibradas em altura E largas o bastante para o texto respirar.
 */
/**
 * Vão entre o núcleo e as colunas, em pixels. Vale para o espaçamento da grade E
 * para o desenho das conexões — por isso mora aqui, e não escrito duas vezes.
 */
const VAO_COLUNAS = 56;

/**
 * Caminhos do núcleo até cada grupo, a partir das BORDAS do núcleo.
 *
 * Sair do centro do cartão parecia natural no código e sumia na tela: o trecho
 * inicial de cada curva ficava atrás do próprio cartão, que é opaco, e o que
 * restava era um toco de linha. As medidas vêm do DOM (o cartão muda de tamanho
 * com a fonte e com a largura da coluna), não de porcentagens chutadas.
 */
function conexoes(
  mapa: { largura: number; altura: number },
  nucleo: { x: number; y: number; largura: number; altura: number },
): string[] {
  const meioY = nucleo.y + nucleo.altura / 2;
  const saidaEsq = nucleo.x;
  const saidaDir = nucleo.x + nucleo.largura;
  // O vão é o espaço da curva, e é o MESMO valor do gap da grade (VAO_COLUNAS).
  // Calcular por proporção da largura deu 28px onde o gap era 56 e a linha da
  // esquerda virou um risco; os dois números têm de sair da mesma fonte.
  const vao = VAO_COLUNAS;
  const destinoEsq = Math.max(8, saidaEsq - vao);
  const destinoDir = Math.min(mapa.largura - 8, saidaDir + vao);

  const curvaDireita = (destinoY: number) =>
    `M ${saidaDir} ${meioY} C ${saidaDir + vao * 0.6} ${meioY}, ${destinoDir - vao * 0.6} ${destinoY}, ${destinoDir} ${destinoY}`;

  return [
    `M ${saidaEsq} ${meioY} C ${saidaEsq - vao * 0.5} ${meioY}, ${destinoEsq + vao * 0.5} ${meioY}, ${destinoEsq} ${meioY}`,
    curvaDireita(mapa.altura * 0.18),
    curvaDireita(meioY),
    curvaDireita(mapa.altura * 0.82),
  ];
}

export function MapaJornada() {
  const secaoRef = useRef<HTMLElement>(null);
  const mapaRef = useRef<HTMLDivElement>(null);
  const [visivel, setVisivel] = useState(false);
  /**
   * Tamanho real da área do mapa, em pixels.
   *
   * O SVG das conexões precisa de um viewBox do TAMANHO da área, e não de um
   * quadrado esticado com preserveAspectRatio="none". Esticar deformava as duas
   * coisas de que a animação depende: a espessura do traço (larga na horizontal,
   * fina na vertical) e o cálculo do tracejado — com `vectorEffect`, o navegador
   * passa a medir o dash em pixels de tela e ignora o pathLength normalizado, e o
   * que devia ser uma linha sendo desenhada virava linha pontilhada parada.
   */
  const [area, setArea] = useState({ largura: 0, altura: 0 });
  const [nucleo, setNucleo] = useState({ x: 0, y: 0, largura: 0, altura: 0 });
  const nucleoRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mapa = mapaRef.current;
    const centro = nucleoRef.current;
    if (!mapa || !centro) return;

    const medir = () => {
      const rMapa = mapa.getBoundingClientRect();
      const rNucleo = centro.getBoundingClientRect();
      setArea({ largura: mapa.clientWidth, altura: mapa.clientHeight });
      setNucleo({
        x: rNucleo.left - rMapa.left,
        y: rNucleo.top - rMapa.top,
        largura: rNucleo.width,
        altura: rNucleo.height,
      });
    };
    medir();

    // Observa os dois: o mapa muda com a janela, e o núcleo muda quando o texto
    // reflui (zoom do navegador, fonte maior no sistema).
    const observador = new ResizeObserver(medir);
    observador.observe(mapa);
    observador.observe(centro);
    return () => observador.disconnect();
  }, []);

  useEffect(() => {
    const alvo = secaoRef.current;
    if (!alvo) return;

    // Movimento reduzido: aparece pronto, sem entrada progressiva. A decisão é
    // tomada aqui e não no CSS porque o mesmo estado governa o atraso escalonado
    // de cada cartão — zerar por classe deixaria o escalonamento rodando.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setVisivel(true);
      return;
    }

    const observador = new IntersectionObserver(
      ([entrada]) => {
        // Uma vez visível, para de observar: a entrada é um efeito de chegada,
        // não algo para repetir a cada rolagem.
        if (entrada?.isIntersecting) {
          setVisivel(true);
          observador.disconnect();
        }
      },
      { rootMargin: "-10% 0px -10% 0px" },
    );
    observador.observe(alvo);

    /*
      Rede de segurança, e não excesso de zelo: TODO o conteúdo desta seção parte
      de opacity-0 e só aparece quando o observador avisa. Se o observador não
      responder, a seção inteira — treze passos da jornada — fica invisível para
      sempre, e o defeito é mudo: nada quebra, nada aparece no console, a página
      só some com a informação.
      Não é hipótese: no painel embutido em que este componente foi conferido, o
      IntersectionObserver não dispara. Navegador antigo, aba em segundo plano ou
      extensão que mexe no observador produzem o mesmo efeito. Passado o prazo,
      o conteúdo aparece de qualquer jeito — sem animação, que é o que se perde,
      em vez do conteúdo, que é o que importa.
    */
    const rede = setTimeout(() => setVisivel(true), 1500);
    return () => {
      observador.disconnect();
      clearTimeout(rede);
    };
  }, []);

  return (
    <section
      ref={secaoRef}
      id="mapa-jornada"
      aria-labelledby="mapa-jornada-titulo"
      /* scroll-mt: o cabeçalho é sticky com 65px de altura; sem esta margem, um
         link para #mapa-jornada encostaria o título embaixo dele. */
      /*
        Fundo transparente para o relógio da marca aparecer atrás do mapa — a não
        ser no TEMA CLARO, onde ele fica com um véu escuro próprio. Motivo: no
        claro, o véu do site é quase opaco (0,965) e o relógio não passa; sem o
        véu daqui, o texto branco do mapa cairia sobre fundo claro e sumiria.
        No escuro, que é onde o relógio de fato aparece, o painel não pinta nada.
      */
      /* Sem contorno: com o fundo transparente, a moldura arredondada delimitava
         um painel que não existe mais e cortava o relógio ao meio. O que ainda
         tem borda é o cartão, onde ela separa conteúdo de fundo. */
      className="relative isolate mt-10 scroll-mt-24 overflow-hidden rounded-3xl px-5 py-12 sm:px-8 lg:px-12 lg:py-16"
      style={{ ["--vao-colunas" as string]: `${VAO_COLUNAS}px` }}
    >

      <header className="text-center">
        <span className="badge bg-marca-50 text-marca-700 ring-1 ring-inset ring-marca-200 dark:bg-marca-500/15 dark:text-marca-200 dark:ring-marca-400/30">
          Passo a passo
        </span>
        {/* h1 da página: o mapa é o conteúdo principal de /como-funciona, e a
            página não tem outro título. Um h1 por documento. */}
        <h1 id="mapa-jornada-titulo" className="mt-4 text-3xl text-marinho-700 dark:text-white sm:text-4xl">
          Da compra à análise jurídica
        </h1>
        <p className="mx-auto mt-4 max-w-3xl hyphens-auto text-justify leading-relaxed text-neutro-600 dark:text-white/70 sm:text-center">
          Uma jornada segura, organizada e transparente. A inteligência artificial analisa os documentos dentro da
          infraestrutura da plataforma, preservando a confidencialidade das informações.
        </p>
        <p className="mt-5 inline-flex items-center gap-2 rounded-full border border-marca-200 bg-marca-50 px-4 py-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-marca-700 dark:border-white/10 dark:bg-white/5 dark:text-ciano-300">
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-ciano-500" />
          Veja como funciona em 4 etapas
        </p>
      </header>

      <div ref={mapaRef} className="relative mt-12">
        {/* Conexões do núcleo aos grupos. Só em telas largas: no empilhado, quem
            liga os passos é o trilho vertical dentro de cada grupo. */}
        {area.largura > 0 && nucleo.largura > 0 && (
          <svg
            aria-hidden
            viewBox={`0 0 ${area.largura} ${area.altura}`}
            className="pointer-events-none absolute inset-0 hidden h-full w-full lg:block"
          >
            {conexoes(area, nucleo).map((d, i) => (
              <path
                key={d}
                d={d}
                pathLength={1}
                fill="none"
                stroke="url(#tracoMapa)"
                strokeWidth={1.5}
                strokeLinecap="round"
                className="transition-[stroke-dashoffset] duration-[1400ms] ease-out motion-reduce:transition-none"
                style={{
                  strokeDasharray: 1,
                  strokeDashoffset: visivel ? 0 : 1,
                  transitionDelay: `${200 + i * 160}ms`,
                }}
              />
            ))}
            <defs>
              <linearGradient id="tracoMapa" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#4f7cff" stopOpacity="0.9" />
                <stop offset="100%" stopColor="#26d5ee" stopOpacity="0.35" />
              </linearGradient>
            </defs>
          </svg>
        )}

        {/*
          Três colunas em telas largas: Acesso à esquerda, núcleo no meio, e as
          outras três etapas empilhadas à direita. No empilhado (celular e tablet)
          a ordem do DOM já é a ordem da jornada, então basta deixar cair.
        */}
        {/* O gap horizontal é o vão onde as conexões são desenhadas: vem de
            VAO_COLUNAS para não divergir do cálculo das curvas. */}
        {/*
          Três formas do mesmo conteúdo, sem duplicar marcação:
            celular  — coluna única, núcleo no topo e trilho vertical ligando os passos;
            tablet   — núcleo em faixa no topo e os grupos em duas colunas;
            desktop  — mapa radial: Acesso à esquerda, núcleo ao centro, o resto à direita.
        */}
        <div
          /* items-start, e o núcleo se centraliza sozinho (lg:self-center): com
             items-center a coluna mais curta descia para o meio e abria um vão
             no alto do tablet, onde as duas colunas deviam começar juntas. */
          className="grid items-start gap-8 md:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(200px,240px)_minmax(0,1fr)]"
          style={{ columnGap: `var(--vao-colunas)` }}
        >
          <GrupoDaJornada
            grupo={GRUPOS[0]!}
            visivel={visivel}
            ordem={0}
            className="md:col-start-1 md:row-start-2 lg:col-start-1 lg:row-start-1"
          />
          <Nucleo ref={nucleoRef} visivel={visivel} />
          <div className="grid gap-8 md:col-start-2 md:row-start-2 lg:col-start-3 lg:row-start-1">
            {GRUPOS.slice(1).map((grupo, i) => (
              <GrupoDaJornada key={grupo.etapa} grupo={grupo} visivel={visivel} ordem={i + 1} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * Núcleo do mapa: o que todas as etapas alimentam ou recebem.
 *
 * Encaminha a ref porque as conexões são desenhadas a partir das bordas REAIS
 * deste cartão, medidas no DOM.
 */
const Nucleo = forwardRef<HTMLDivElement, { visivel: boolean }>(function Nucleo({ visivel }, ref) {
  return (
    <div
      ref={ref}
      /* order-first no empilhado: sem isto o núcleo caía entre o passo 06 e o 07,
         partindo a contagem no meio. Empilhado ele abre a seção, como o resumo
         do que os treze passos alimentam; em telas largas volta ao centro. */
      className={`relative z-10 order-first flex flex-col items-center justify-center rounded-2xl border border-marca-200 bg-white/70 p-6 text-center backdrop-blur transition-all duration-700 ease-out motion-reduce:transition-none dark:border-marca-400/30 dark:bg-white/[0.06] md:col-span-2 md:row-start-1 md:flex-row md:gap-5 md:text-left lg:order-none lg:col-span-1 lg:col-start-2 lg:row-start-1 lg:flex-col lg:self-center lg:text-center ${
        visivel ? "opacity-100" : "translate-y-3 opacity-0"
      }`}
    >
      <span aria-hidden className="absolute inset-0 -z-10 rounded-2xl bg-marca-500/10 blur-xl motion-safe:animate-pulse" />
      <span
        aria-hidden
        className="flex h-16 w-16 items-center justify-center rounded-2xl bg-[linear-gradient(135deg,#4f7cff_0%,#26d5ee_100%)] text-[#04122e] shadow-[0_0_28px_-4px_rgba(79,124,255,0.7)]"
      >
        <Icone nome="balanca" className="h-8 w-8" />
      </span>
      {/* h2, e não h3: a página vai do h1 do mapa para as seções. Pular nível
          quebra a navegação por títulos de quem usa leitor de tela. */}
      <h2 className="mt-4 text-base font-bold leading-snug text-marinho-700 dark:text-white">
        Análise jurídica com inteligência artificial
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-neutro-600 dark:text-white/60">
        O núcleo que recebe o processo, organiza os atos e devolve a conclusão fundamentada.
      </p>
    </div>
  );
});

function GrupoDaJornada({
  grupo,
  visivel,
  ordem,
  className = "",
}: {
  grupo: Grupo;
  visivel: boolean;
  ordem: number;
  className?: string;
}) {
  return (
    <div
      className={`relative ${className} transition-all duration-700 ease-out motion-reduce:transition-none ${
        visivel ? "opacity-100" : "translate-y-4 opacity-0"
      }`}
      style={{ transitionDelay: `${120 + ordem * 140}ms` }}
    >
      <div className="mb-4 flex items-center gap-3">
        <span
          aria-hidden
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-marca-200 bg-marca-50 font-display text-sm font-bold text-marca-700 dark:border-marca-400/40 dark:bg-marca-500/15 dark:text-marca-200"
        >
          {grupo.etapa}
        </span>
        <h2 className="text-sm font-bold uppercase tracking-[0.12em] text-marinho-700 dark:text-white/85">
          {grupo.titulo}
        </h2>
      </div>

      {/* Trilho vertical ligando os passos do grupo. É ele que faz o papel das
          curvas do núcleo quando a tela estreita e o mapa vira linha do tempo. */}
      <ol className="relative grid gap-3 before:absolute before:bottom-5 before:left-[19px] before:top-5 before:w-px before:bg-gradient-to-b before:from-marca-500/50 before:to-ciano-500/10 before:content-['']">
        {grupo.passos.map((passo, i) => (
          <CartaoPasso key={passo.n} passo={passo} visivel={visivel} atraso={200 + ordem * 140 + i * 70} />
        ))}
      </ol>
    </div>
  );
}

function CartaoPasso({ passo, visivel, atraso }: { passo: Passo; visivel: boolean; atraso: number }) {
  return (
    <li
      className={`group relative flex gap-3 rounded-xl border border-neutro-200 bg-white/70 p-3.5 backdrop-blur-sm transition-all duration-500 ease-out hover:-translate-y-1 hover:border-marca-400 hover:bg-white hover:shadow-[0_10px_30px_-12px_rgba(79,124,255,0.55)] motion-reduce:transition-none motion-reduce:hover:translate-y-0 dark:border-white/10 dark:bg-white/[0.04] dark:hover:border-marca-400/40 dark:hover:bg-white/[0.07] ${
        visivel ? "opacity-100" : "translate-y-3 opacity-0"
      }`}
      style={{ transitionDelay: `${atraso}ms` }}
    >
      <span
        aria-hidden
        className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-marca-200 bg-marca-50 text-marca-600 transition group-hover:border-ciano-500 group-hover:text-marca-700 group-hover:shadow-[0_0_16px_-2px_rgba(38,213,238,0.6)] dark:border-marca-400/30 dark:bg-[#0b1428] dark:text-marca-200 dark:group-hover:border-ciano-500/50 dark:group-hover:text-ciano-300"
      >
        <Icone nome={passo.icone} className="h-[18px] w-[18px]" />
      </span>
      <div className="min-w-0">
        <p className="flex items-baseline gap-1.5 font-display text-sm font-semibold text-marinho-700 dark:text-white">
          <span aria-hidden className="text-[11px] font-bold text-marca-600 dark:text-marca-300">
            {String(passo.n).padStart(2, "0")}
          </span>
          {passo.titulo}
        </p>
        <p className="mt-1 hyphens-auto text-justify text-[13px] leading-relaxed text-neutro-600 dark:text-white/60">
          {passo.descricao}
        </p>
      </div>
    </li>
  );
}
