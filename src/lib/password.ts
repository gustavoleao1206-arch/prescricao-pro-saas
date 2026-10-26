import bcrypt from "bcryptjs";

/**
 * Hashing de senhas com bcrypt (custo 12). Senhas jamais são armazenadas em
 * texto aberto nem registradas em logs.
 */
const COST = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, COST);
}

export async function verifyPassword(plain: string, hash: string | null): Promise<boolean> {
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}

/**
 * Política mínima de senha. Retorna lista de problemas (vazia = válida).
 */
export function validatePasswordStrength(password: string): string[] {
  const problems: string[] = [];
  if (password.length < 10) problems.push("A senha deve ter ao menos 10 caracteres.");
  if (!/[a-z]/.test(password)) problems.push("Inclua ao menos uma letra minúscula.");
  if (!/[A-Z]/.test(password)) problems.push("Inclua ao menos uma letra maiúscula.");
  if (!/[0-9]/.test(password)) problems.push("Inclua ao menos um número.");
  if (!/[^A-Za-z0-9]/.test(password)) problems.push("Inclua ao menos um símbolo.");
  return problems;
}
