/**
 * Canais de atendimento, fonte única para o site público e a área do cliente.
 *
 * `whatsapp` é o número em formato internacional, sem máscara, usado no link
 * wa.me. `numero` é como o número aparece para o usuário.
 */
export type CanalAtendimento = {
  rotulo: string;
  numero: string;
  whatsapp: string;
  horario: string;
};

export const ATENDIMENTO: readonly CanalAtendimento[] = [
  {
    rotulo: "SAC",
    numero: "(82) 3024-5837",
    whatsapp: "558230245837",
    horario: "Segunda a sexta-feira, das 08:00 às 18:00",
  },
  {
    rotulo: "WhatsApp",
    numero: "(82) 9 0000-0000",
    whatsapp: "5582900000000", // número fictício nesta versão pública
    horario: "Sábado e domingo, das 08:00 às 12:00",
  },
];

/**
 * Canal oficial de SAC: o número fixo, atendido por WhatsApp.
 *
 * Fica isolado numa constante própria porque é o canal com obrigação de
 * divulgação nos documentos legais (termos e políticas), e não pode depender da
 * ordem do array acima, que muda por motivo comercial.
 */
export const SAC: CanalAtendimento = ATENDIMENTO[0]!;

export function linkWhatsApp(canal: CanalAtendimento): string {
  return `https://wa.me/${canal.whatsapp}`;
}
