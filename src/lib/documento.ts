/**
 * CPF e CNPJ: normalização e validação pelos dígitos verificadores.
 *
 * ── Por que validar aqui ──────────────────────────────────────────────────────
 * O boleto exige `cpfCnpj` na criação do cliente no Asaas. Sem conferir antes, um
 * dígito trocado só falha lá — e o cliente recebe de volta um erro cru de
 * provedor, no meio da compra, sem saber que errou o próprio documento. Validar
 * localmente devolve "CPF inválido" na hora, no campo certo.
 *
 * A validação é pelos dígitos verificadores, não por formato: `111.111.111-11` tem
 * o formato perfeito e é inválido. Conferir só a máscara daria falsa segurança.
 *
 * ⚠️ Isto NÃO diz que o documento existe ou pertence a quem digitou — só que é
 * matematicamente bem formado. Verificação de titularidade é outro assunto, e o
 * Asaas faz a dele.
 */

/** Só os dígitos, para comparar e enviar ao provedor sem depender de máscara. */
export function apenasDigitos(valor: string): string {
  return valor.replace(/\D+/g, "");
}

export type TipoDocumento = "CPF" | "CNPJ";

export function validarCPF(valor: string): boolean {
  const d = apenasDigitos(valor);
  if (d.length !== 11) return false;
  // Todos os dígitos iguais passam na conta dos verificadores, mas não existem.
  if (/^(\d)\1{10}$/.test(d)) return false;

  const digito = (ate: number): number => {
    let soma = 0;
    let peso = ate + 1;
    for (let i = 0; i < ate; i++) soma += Number(d[i]) * peso--;
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  return digito(9) === Number(d[9]) && digito(10) === Number(d[10]);
}

export function validarCNPJ(valor: string): boolean {
  const d = apenasDigitos(valor);
  if (d.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(d)) return false;

  const digito = (ate: number): number => {
    // Pesos do CNPJ: começam em 2 no dígito mais à direita da parte considerada e
    // sobem até 9, recomeçando em 2.
    let soma = 0;
    let peso = 2;
    for (let i = ate - 1; i >= 0; i--) {
      soma += Number(d[i]) * peso;
      peso = peso === 9 ? 2 : peso + 1;
    }
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  return digito(12) === Number(d[12]) && digito(13) === Number(d[13]);
}

/** Valida e diz o tipo. Devolve nulo quando o documento não é válido. */
export function validarCpfCnpj(valor: string): { digitos: string; tipo: TipoDocumento } | null {
  const digitos = apenasDigitos(valor);
  if (digitos.length === 11) return validarCPF(digitos) ? { digitos, tipo: "CPF" } : null;
  if (digitos.length === 14) return validarCNPJ(digitos) ? { digitos, tipo: "CNPJ" } : null;
  return null;
}

/** Formata para exibição: 000.000.000-00 ou 00.000.000/0000-00. */
export function formatarCpfCnpj(valor: string): string {
  const d = apenasDigitos(valor);
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
  return valor;
}
